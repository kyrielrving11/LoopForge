/** The runtime's submission boundary — every check a submission must pass
 *  before a round may advance.
 *
 *  v3.8.1: it lives here, not in the MCP tool handler. `SessionManager` is the
 *  runtime's public entry point (`index.ts` exports it) and `RoundLifecycle`
 *  is internal, so a boundary in the transport meant a library caller, a
 *  future CLI command, or any direct `mgr.advance()` got NONE of it. The
 *  handler now only maps the result onto its tool envelope.
 *
 *  The placement is also what makes the ordering invariants hold. AGENTS.md:
 *  an invalid evaluation is handled BEFORE `RoundLifecycle.advance()` and
 *  "must not save session state, write the Vault, run verification or
 *  enforcement gates, increment rejection state, or record metrics". So it
 *  runs before the session queue and before the lease heartbeat — renewing a
 *  lease writes the session document, which would be a durable effect of a
 *  payload that was never accepted. It is judged before the session is even
 *  resolved, because a malformed evaluation is a payload defect whatever the
 *  session's state, and answering `session_not_found` for it would send the
 *  agent after the wrong problem.
 *
 *  This module also owns the compile context the boundary reads, because the
 *  sub-goal reference space IS the compiled set the prompt carried — the
 *  session's own projection reads the same function, so the two cannot
 *  disagree about it.
 */

import type { LoopStore, VaultEntry } from "../loop-store.js";
import { queryLoopEntries } from "../loop-store.js";
import type { LoopForgeRequest, LoopForgeResponse, SubGoal } from "../protocol.js";
import { Mode } from "../protocol.js";
import { LoopForgeEngine } from "../engine.js";
import type { ActiveContractView } from "../round-contract.js";
import { deriveActiveRoundContract } from "../round-contract.js";
import { derivationRounds } from "../committed-round.js";
import {
  buildSelfEvaluation,
  parseSubGoalUpdates,
  validateContractShape,
  validateCoreSelfEvaluation,
  validateSubGoalUpdatesShape,
} from "../self-eval.js";
import type { ContractValidationError } from "../self-eval.js";
import { deriveEmergedItems, validateSubGoalUpdates } from "../subgoal-state.js";
import { isConfiguredCommand } from "../policy.js";
import { scopeEntryDetail } from "../workspace.js";
import { isRecord } from "../token-utils.js";
import type { AdvanceResult } from "./round-lifecycle.js";

/** What `compileSessionContext` needs from a session. Structural, so both the
 *  session manager and the boundary can pass their own view of it. */
export interface CompileContextSession {
  loopId: string;
  task: string;
  maxRounds: number;
  currentRound: number;
  lastCompileResponse?: LoopForgeResponse | null;
  roundSnapshot?: { roundId: string } | null;
  engine: LoopForgeEngine;
}

/** The compile response this round's prompt came from.
 *
 *  Cached-when-fresh (the artifact's deterministic roundId guards against
 *  stale reuse), recompiled otherwise with `persistLineage: false` so it never
 *  writes the Vault, and null when it cannot be observed. Callers fail OPEN:
 *  an unobservable reference space must not become a rejection. */
export function compileSessionContext(
  session: CompileContextSession,
): LoopForgeResponse | null {
  const cached = session.lastCompileResponse;
  const expectedRoundId = session.roundSnapshot?.roundId
    ?? `loop:${session.loopId}:round:${session.currentRound}`;
  if (cached?.prompt_artifact && cached.prompt_artifact.roundId === expectedRoundId) {
    return cached;
  }
  try {
    const request: LoopForgeRequest = {
      task: session.task,
      mode: Mode.LOOP_COMPILE,
      feedback: null,
      skill_name: null,
      task_id: null,
      loop_id: session.loopId,
      round: session.currentRound,
      max_rounds: session.maxRounds,
      verification_flags: [],
    };
    const compiled = session.engine.invokeLoopCompile(request, undefined, { persistLineage: false });
    return compiled.response ?? null;
  } catch {
    return null; // projection / boundary degrades gracefully
  }
}

/** The sub-goal set an agent may legitimately reference: the compiled set the
 *  prompt carried, PLUS this submission's own `emerged_subtasks` — a sub-goal
 *  may be created and referenced (or transitioned) in one round. Null when it
 *  cannot be observed. */
export function knownSubGoalsFor(
  session: CompileContextSession,
  emerged: string[],
): SubGoal[] | null {
  const response = compileSessionContext(session);
  if (!response?.sub_goals) return null;
  const known = [...response.sub_goals];
  for (const item of deriveEmergedItems(session.loopId, session.currentRound, emerged)) {
    if (!known.some((subGoal) => subGoal.id === item.id)) {
      known.push({
        id: item.id,
        description: item.description,
        status: "pending",
        declared_at_round: session.currentRound,
        status_changed_at_round: session.currentRound,
        priority: known.length,
      });
    }
  }
  return known;
}

/** The ACTIVE Round Contract governing a session's next round — ONE
 *  derivation, shared by the session's public view and the boundary. */
export function activeContractOf(
  store: LoopStore,
  session: { loopId: string; currentRound: number },
): ActiveContractView | null {
  const prefix = `loop:${session.loopId}:`;
  const entries: VaultEntry[] = [
    ...queryLoopEntries(store, session.loopId, { prefix }),
    ...queryLoopEntries(store, session.loopId, { prefix, feedbackOnly: true }),
  ];
  return deriveActiveRoundContract(
    derivationRounds(entries, session.currentRound),
  );
}

/** The boundary's outcome. `submissionError` is shaped for `AdvanceResult` so
 *  a caller maps it straight onto its error envelope. */
export type SubmissionBoundary =
  | { ok: true; evaluation: ReturnType<typeof buildSelfEvaluation> }
  | {
      ok: false;
      stopDetail: string;
      submissionError: NonNullable<AdvanceResult["submissionError"]>;
    };

const EVALUATION_REQUIRED =
  "A structured evaluation object is required. Resubmit the same roundId " +
  "with success, output_summary, constraint_violations, and should_continue.";

/** THE submission boundary. Five checks, in this order, all of them before
 *  anything durable happens.
 *
 *  Two are STRUCTURAL boundaries that REJECT rather than normalize:
 *  `subgoal_updates` (machine-processable state transitions) and the Round
 *  Contract declaration together with its item claims. Everything else about
 *  an evaluation is normalized leniently by `buildSelfEvaluation` instead of
 *  rejecting a round over a reporting detail — that split is deliberate and is
 *  the whole of the strict/lenient contract.
 *
 *  The reference spaces (active item ids, known sub-goal ids) are facts about
 *  the loop, not properties of the payload, so each is `null` — fail open,
 *  shape checks still strict — when it cannot be observed. An unobserved
 *  session is different from a session with no active contract: the latter is
 *  an observed EMPTY space and an item claim in it is false. */
export function validateSubmission(
  store: LoopStore,
  session: CompileContextSession | undefined,
  submission: unknown,
): SubmissionBoundary {
  if (!isRecord(submission)) {
    return {
      ok: false,
      stopDetail: EVALUATION_REQUIRED,
      submissionError: {
        code: "evaluation_invalid",
        details: {
          missing: ["evaluation"],
          invalid: [{ field: "evaluation", expected: "object" }],
        },
      },
    };
  }
  const core = validateCoreSelfEvaluation(submission);
  if (core.missing.length > 0 || core.invalid.length > 0) {
    return {
      ok: false,
      stopDetail: EVALUATION_REQUIRED,
      submissionError: { code: "evaluation_invalid", details: { ...core } },
    };
  }
  // The emerged set is part of BOTH referential spaces below.
  const emerged = Array.isArray(submission.emerged_subtasks)
    ? (submission.emerged_subtasks as unknown[])
        .filter((value): value is string => typeof value === "string")
        .map((value) => value.slice(0, 500))
    : [];
  const subgoalShapeErrors = validateSubGoalUpdatesShape(submission);
  if (subgoalShapeErrors.length > 0) {
    return {
      ok: false,
      stopDetail: "subgoal_updates is malformed. Fix the entries and resubmit the same roundId.",
      submissionError: {
        code: "evaluation_invalid",
        details: { missing: [], invalid: [], subgoal_errors: subgoalShapeErrors },
      },
    };
  }
  const known = session ? knownSubGoalsFor(session, emerged) : null;
  const updates = parseSubGoalUpdates(submission.subgoal_updates);
  if (updates.length > 0 && known) {
    const referentialErrors = validateSubGoalUpdates(known, updates).map((error) => ({
      field: "subgoal_updates",
      reason: error.reason,
      detail: `${error.reason.replace(/_/g, " ")}: ${error.id}`,
    }));
    if (referentialErrors.length > 0) {
      return {
        ok: false,
        stopDetail:
          "subgoal_updates references a sub-goal this loop does not have, a " +
          "terminal one, or an illegal transition. Fix the entries and " +
          "resubmit the same roundId.",
        submissionError: {
          code: "evaluation_invalid",
          details: { missing: [], invalid: [], subgoal_errors: referentialErrors },
        },
      };
    }
  }
  const contractErrors = contractShapeErrors(store, session, submission, known);
  if (contractErrors.length > 0) {
    return {
      ok: false,
      stopDetail:
        "The Round Contract declaration or its item claims are malformed. " +
        "Fix them and resubmit the same roundId.",
      submissionError: {
        code: "contract_invalid",
        details: { missing: [], invalid: [], contract_errors: contractErrors },
      },
    };
  }
  return { ok: true, evaluation: buildSelfEvaluation(submission) };
}

function contractShapeErrors(
  store: LoopStore,
  session: CompileContextSession | undefined,
  submission: Record<string, unknown>,
  knownSubGoals: SubGoal[] | null,
): ContractValidationError[] {
  const active = session ? activeContractOf(store, session) : null;
  return validateContractShape(submission, {
    activeItemIds: session
      ? new Set((active?.items ?? []).map((item) => item.id))
      : null,
    knownSubGoalIds: knownSubGoals
      ? new Set(knownSubGoals.map((subGoal) => subGoal.id))
      : null,
    isConfiguredCommand,
    checkScopeEntry: scopeEntryDetail,
  });
}
