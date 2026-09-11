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
import type { LoopStore } from "../loop-store.js";
import type { LoopForgeResponse, SubGoal } from "../protocol.js";
import { LoopForgeEngine } from "../engine.js";
import type { ActiveContractView } from "../round-contract.js";
import { buildSelfEvaluation } from "../self-eval.js";
import type { AdvanceResult } from "./round-lifecycle.js";
/** What `compileSessionContext` needs from a session. Structural, so both the
 *  session manager and the boundary can pass their own view of it. */
export interface CompileContextSession {
    loopId: string;
    task: string;
    maxRounds: number;
    currentRound: number;
    lastCompileResponse?: LoopForgeResponse | null;
    roundSnapshot?: {
        roundId: string;
    } | null;
    engine: LoopForgeEngine;
}
/** The compile response this round's prompt came from.
 *
 *  Cached-when-fresh (the artifact's deterministic roundId guards against
 *  stale reuse), recompiled otherwise with `persistLineage: false` so it never
 *  writes the Vault, and null when it cannot be observed. Callers fail OPEN:
 *  an unobservable reference space must not become a rejection. */
export declare function compileSessionContext(session: CompileContextSession): LoopForgeResponse | null;
/** The sub-goal set an agent may legitimately reference: the compiled set the
 *  prompt carried, PLUS this submission's own `emerged_subtasks` — a sub-goal
 *  may be created and referenced (or transitioned) in one round. Null when it
 *  cannot be observed. */
export declare function knownSubGoalsFor(session: CompileContextSession, emerged: string[]): SubGoal[] | null;
/** The ACTIVE Round Contract governing a session's next round — ONE
 *  derivation, shared by the session's public view and the boundary. */
export declare function activeContractOf(store: LoopStore, session: {
    loopId: string;
    currentRound: number;
}): ActiveContractView | null;
/** The boundary's outcome. `submissionError` is shaped for `AdvanceResult` so
 *  a caller maps it straight onto its error envelope. */
export type SubmissionBoundary = {
    ok: true;
    evaluation: ReturnType<typeof buildSelfEvaluation>;
} | {
    ok: false;
    stopDetail: string;
    submissionError: NonNullable<AdvanceResult["submissionError"]>;
};
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
export declare function validateSubmission(store: LoopStore, session: CompileContextSession | undefined, submission: unknown): SubmissionBoundary;
//# sourceMappingURL=submission-boundary.d.ts.map