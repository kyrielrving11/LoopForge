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
 *  This module derives the reference spaces the boundary reads from the same
 *  committed history window the prompt was compiled from, so the prompt, the
 *  boundary and `submission_guidance` cannot disagree about them.
 */
import { queryLoopEntries } from "../loop-store.js";
import { deriveActiveRoundContract } from "../round-contract.js";
import { derivationRounds } from "../committed-round.js";
import { boundedEmergedSubtasks, normalizeSelfEvaluation, parseSubGoalUpdates, validateContractShape, validateCoreSelfEvaluation, validateSubGoalUpdatesShape, } from "../self-eval.js";
import { deriveEmergedItems, deriveSubGoals, validateSubGoalUpdates, } from "../subgoal-state.js";
import { isConfiguredCommand } from "../policy.js";
import { scopeEntryDetail } from "../workspace.js";
import { deriveCriterionId, isRecord, normalizeText, uniqueNormalized, } from "../token-utils.js";
import { deriveConstraintId, latestObjective } from "../loop-compiler.js";
function referenceFactsFor(store, session) {
    try {
        const prefix = `loop:${session.loopId}:`;
        const entries = queryLoopEntries(store, session.loopId, { prefix });
        const allEntries = [
            ...entries,
            ...queryLoopEntries(store, session.loopId, { prefix, feedbackOnly: true }),
        ];
        const subGoals = deriveSubGoals({
            loopId: session.loopId,
            currentRound: session.currentRound,
            rounds: derivationRounds(allEntries, session.currentRound),
        });
        // v3.9.6: the held acceptance is the operator fact. Committed objective
        // lineage is the fallback for a snapshot that predates it — never a
        // second compile of mutable session state.
        let criteriaTexts = session.roundSnapshot?.operatorAcceptance?.success_criteria ?? null;
        if (criteriaTexts === null) {
            criteriaTexts = latestObjective(session.loopId, { results: entries }, session.currentRound, session.currentRound === 1 && (session.roundSnapshot?.attempt ?? 1) > 1)?.success_criteria ?? null;
        }
        const criteria = criteriaTexts === null
            ? null
            : uniqueNormalized([...criteriaTexts]).map((text) => ({
                id: deriveCriterionId(text),
                text,
            }));
        return { subGoals, criteria };
    }
    catch {
        return { subGoals: null, criteria: null }; // projection degrades gracefully
    }
}
/** The sub-goal set an agent may legitimately reference: the committed set the
 *  prompt carried, PLUS this submission's own `emerged_subtasks` — a sub-goal
 *  may be created and referenced (or transitioned) in one round. Null when it
 *  cannot be observed. */
export function knownSubGoalsFor(session, emerged, knownSubGoals) {
    if (!knownSubGoals)
        return null;
    const known = [...knownSubGoals];
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
export function activeContractOf(store, session) {
    const prefix = `loop:${session.loopId}:`;
    const entries = [
        ...queryLoopEntries(store, session.loopId, { prefix }),
        ...queryLoopEntries(store, session.loopId, { prefix, feedbackOnly: true }),
    ];
    return deriveActiveRoundContract(derivationRounds(entries, session.currentRound));
}
/** Map a strict boundary error onto the same diagnostic vocabulary, without
 *  persisting it. Strict failures are returned only for that attempt. */
function rejectedDiagnostic(path, code, detail) {
    return { path, code, handling: "rejected", detail };
}
const EVALUATION_REQUIRED = "A structured evaluation object is required. Resubmit the same roundId " +
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
export function validateSubmission(store, session, submission) {
    if (!isRecord(submission)) {
        return {
            ok: false,
            stopDetail: EVALUATION_REQUIRED,
            submissionError: {
                code: "evaluation_invalid",
                details: {
                    missing: ["evaluation"],
                    invalid: [{ field: "evaluation", expected: "object" }],
                    diagnostics: [
                        rejectedDiagnostic("evaluation", "invalid_value", "expected an evaluation object"),
                    ],
                },
            },
        };
    }
    const core = validateCoreSelfEvaluation(submission);
    if (core.missing.length > 0 || core.invalid.length > 0) {
        return {
            ok: false,
            stopDetail: EVALUATION_REQUIRED,
            submissionError: {
                code: "evaluation_invalid",
                details: {
                    ...core,
                    diagnostics: [
                        ...core.missing.map((field) => rejectedDiagnostic(field, "required", "core field is required")),
                        ...core.invalid.map((item) => rejectedDiagnostic(item.field, "invalid_value", `expected ${item.expected}`)),
                    ],
                },
            },
        };
    }
    // The emerged set is part of BOTH referential spaces below. It goes through
    // the SAME normalization the committed evaluation uses: the sub-goal ids are
    // derived by ORDINAL over this list, so bounding it differently here let the
    // boundary accept a transition to a sub-goal the prompt never carried.
    const emerged = boundedEmergedSubtasks(submission.emerged_subtasks);
    const subgoalShapeErrors = validateSubGoalUpdatesShape(submission);
    if (subgoalShapeErrors.length > 0) {
        return {
            ok: false,
            stopDetail: "subgoal_updates is malformed. Fix the entries and resubmit the same roundId.",
            submissionError: {
                code: "evaluation_invalid",
                details: {
                    missing: [],
                    invalid: [],
                    subgoal_errors: subgoalShapeErrors,
                    diagnostics: subgoalShapeErrors.map((error) => rejectedDiagnostic(error.field, error.reason, error.detail)),
                },
            },
        };
    }
    const facts = session ? referenceFactsFor(store, session) : null;
    const known = session ? knownSubGoalsFor(session, emerged, facts?.subGoals ?? null) : null;
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
                stopDetail: "subgoal_updates references a sub-goal this loop does not have, a " +
                    "terminal one, or an illegal transition. Fix the entries and " +
                    "resubmit the same roundId.",
                submissionError: {
                    code: "evaluation_invalid",
                    details: {
                        missing: [],
                        invalid: [],
                        subgoal_errors: referentialErrors,
                        diagnostics: referentialErrors.map((error) => rejectedDiagnostic(error.field, error.reason, error.detail)),
                    },
                },
            };
        }
    }
    const retractionErrors = immutableRetractionErrors(store, session, submission);
    if (retractionErrors.length > 0) {
        return {
            ok: false,
            stopDetail: "retracted_constraints may only name Agent-discovered constraints; " +
                "operator criteria and hard constraints are immutable. Remove them and resubmit the same roundId.",
            submissionError: {
                code: "evaluation_invalid",
                details: {
                    missing: [],
                    invalid: [],
                    retraction_errors: retractionErrors,
                    diagnostics: retractionErrors.map((error) => rejectedDiagnostic(error.field, error.reason, error.detail)),
                },
            },
        };
    }
    const contractErrors = contractShapeErrors(store, session, submission, facts?.subGoals ?? null, facts?.criteria ?? null);
    if (contractErrors.length > 0) {
        return {
            ok: false,
            stopDetail: "The Round Contract declaration or its item claims are malformed. " +
                "Fix them and resubmit the same roundId.",
            submissionError: {
                code: "contract_invalid",
                details: {
                    missing: [],
                    invalid: [],
                    contract_errors: contractErrors,
                    diagnostics: contractErrors.map((error) => rejectedDiagnostic(error.field, error.reason, error.detail)),
                },
            },
        };
    }
    return {
        ok: true,
        ...normalizeSelfEvaluation(submission, {
            knownCriterionRefs: facts?.criteria ?? null,
        }),
    };
}
function immutableRetractionErrors(store, session, submission) {
    if (!session || !Array.isArray(submission.retracted_constraints))
        return [];
    const acceptance = session.roundSnapshot?.operatorAcceptance ?? null;
    let hardTexts = acceptance?.hard_constraints ?? [];
    let criterionTexts = acceptance?.success_criteria ?? [];
    if (!acceptance) {
        const prefix = `loop:${session.loopId}:`;
        const entries = queryLoopEntries(store, session.loopId, { prefix });
        const objective = latestObjective(session.loopId, { results: entries }, session.currentRound, session.currentRound === 1);
        if (!objective)
            return [];
        hardTexts = objective.hard_constraints;
        criterionTexts = objective.success_criteria;
    }
    const hard = new Set(hardTexts.map((text) => normalizeText(text)));
    const criteria = new Set(criterionTexts.map((text) => normalizeText(text)));
    const hardIds = new Set(hardTexts.map((text) => deriveConstraintId(text)));
    const criterionIds = new Set(criterionTexts.map((text) => deriveCriterionId(text)));
    const errors = [];
    for (const raw of submission.retracted_constraints) {
        if (typeof raw !== "string")
            continue;
        const key = normalizeText(raw);
        const operatorOwned = hard.has(key) || criteria.has(key) ||
            hardIds.has(raw) || criterionIds.has(raw);
        if (!operatorOwned)
            continue;
        errors.push({
            field: "retracted_constraints",
            reason: "immutable_constraint",
            detail: `${raw} belongs to the operator acceptance surface; only Agent-discovered constraints may be retracted`,
        });
    }
    return errors;
}
function contractShapeErrors(store, session, submission, subGoals, criteria) {
    const active = session ? activeContractOf(store, session) : null;
    // v3.9.4: contract refs can only cite what the prompt actually displays.
    // Same-round emerged sub-goals are deliberately excluded; they are not in
    // the prompt and become referenceable in the NEXT round.
    const displayedSubGoals = subGoals
        ? new Set(subGoals
            .filter((subGoal) => subGoal.status !== "done" && subGoal.status !== "canceled")
            .map((subGoal) => subGoal.id))
        : null;
    return validateContractShape(submission, {
        activeItemIds: session
            ? new Set((active?.items ?? []).map((item) => item.id))
            : null,
        knownCriterionIds: criteria
            ? new Set(criteria.map((criterion) => criterion.id))
            : null,
        displayedSubGoalIds: displayedSubGoals,
        isConfiguredCommand,
        checkScopeEntry: scopeEntryDetail,
    });
}
//# sourceMappingURL=submission-boundary.js.map