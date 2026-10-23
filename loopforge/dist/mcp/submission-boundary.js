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
import { derivationRounds, pendingRollbackDirective } from "../committed-round.js";
import { boundedEmergedSubtasks, normalizeSelfEvaluation, parseSubGoalUpdates, validateContractShape, validateContractTransition, validateCoreSelfEvaluation, validateSubGoalUpdatesShape, } from "../self-eval.js";
import { deriveEmergedItems, deriveSubGoals, validateSubGoalUpdates, } from "../subgoal-state.js";
import { isConfiguredCommand } from "../policy.js";
import { canonicalContractItemText, deriveCriterionId, entryRound, isRecord, uniqueNormalized, } from "../token-utils.js";
import { latestObjective } from "../loop-compiler.js";
import { deriveConstraintProvenance, resolveConstraintRetractions, } from "../constraint-lifecycle.js";
import { getPolicy } from "../policy.js";
function referenceFactsFor(store, session) {
    try {
        const prefix = `loop:${session.loopId}:`;
        const entries = queryLoopEntries(store, session.loopId, { prefix });
        const allEntries = [
            ...entries,
            ...queryLoopEntries(store, session.loopId, { prefix, feedbackOnly: true }),
        ];
        const windowRounds = derivationRounds(allEntries, session.currentRound);
        const subGoals = deriveSubGoals({
            loopId: session.loopId,
            currentRound: session.currentRound,
            rounds: windowRounds,
        });
        // v3.9.6: the held acceptance is the operator fact. Committed objective
        // lineage is the fallback for a snapshot that predates it — never a
        // second compile of mutable session state.
        const objective = session.roundSnapshot?.operatorAcceptance
            ? {
                objective: session.roundSnapshot.operatorAcceptance.task,
                success_criteria: session.roundSnapshot.operatorAcceptance.success_criteria,
                hard_constraints: session.roundSnapshot.operatorAcceptance.hard_constraints,
                created_at_round: 1,
                loop_id: session.loopId,
            }
            : latestObjective(session.loopId, { results: entries }, session.currentRound, session.currentRound === 1 && (session.roundSnapshot?.attempt ?? 1) > 1);
        const criteriaTexts = objective?.success_criteria ?? null;
        const criteria = criteriaTexts === null
            ? null
            : uniqueNormalized([...criteriaTexts]).map((text) => ({
                id: deriveCriterionId(text),
                text,
            }));
        // The current round's compile stamped the active set it rendered. This is
        // the same text set the prompt carried; provenance is re-derived from the
        // committed window, never from a second ledger.
        const currentLineage = entries.find((entry) => entryRound(entry) === session.currentRound &&
            entry.task_type === "loop_lineage");
        const lineage = isRecord(currentLineage?.loop_lineage)
            ? currentLineage.loop_lineage
            : {};
        const rawActive = Array.isArray(lineage.constraints_active)
            ? lineage.constraints_active.filter((item) => typeof item === "string")
            : null;
        const pending = pendingRollbackDirective(allEntries, session.currentRound);
        const preservedDiscoveries = pending?.recovery &&
            getPolicy().engine.backtrack_preserve_discoveries
            ? pending.recovery.skipped_discoveries
            : [];
        const roundOnePlan = session.currentRound === 1
            ? objective?.hard_constraints ?? []
            : [];
        const constraints = rawActive === null
            ? null
            : uniqueNormalized(rawActive).map((text) => ({
                text,
                provenance: deriveConstraintProvenance({
                    text,
                    objective,
                    windowRounds,
                    roundOnePlan,
                    preservedDiscoveries,
                    preservedRound: pending?.round,
                }),
            }));
        const previouslyRetired = uniqueNormalized(windowRounds.flatMap((round) => round.retractedConstraints ?? []));
        return { subGoals, criteria, constraints, previouslyRetired };
    }
    catch {
        return {
            subGoals: null,
            criteria: null,
            constraints: null,
            previouslyRetired: [],
        }; // projection degrades gracefully
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
    const retraction = resolveSubmissionRetractions(facts, submission);
    if (retraction.errors.length > 0) {
        return {
            ok: false,
            stopDetail: "retracted_constraints may only name active Agent-discovered constraints; " +
                "operator criteria/hard constraints and plan constraints are not retractable. " +
                "Remove them and resubmit the same roundId.",
            submissionError: {
                code: "evaluation_invalid",
                details: {
                    missing: [],
                    invalid: [],
                    retraction_errors: retraction.errors,
                    diagnostics: retraction.errors.map((error) => rejectedDiagnostic(error.field, error.reason, error.detail)),
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
    const normalized = normalizeSelfEvaluation(submission, {
        knownCriterionRefs: facts?.criteria ?? null,
        maxDiscoveredConstraints: getPolicy().evolution.max_discovered_constraints_per_round,
    });
    return {
        ok: true,
        evaluation: normalized.evaluation,
        // No-op retractions are visible as diagnostics; they never reject and
        // never appear as effective effects.
        diagnostics: [
            ...retraction.noopDiagnostics,
            ...normalized.diagnostics,
        ],
        submittedFields: normalized.submittedFields,
    };
}
function resolveSubmissionRetractions(facts, submission) {
    const targets = Array.isArray(submission.retracted_constraints)
        ? submission.retracted_constraints.filter((item) => typeof item === "string")
        : [];
    if (targets.length === 0 || !facts?.constraints) {
        return { errors: [], noopDiagnostics: [] };
    }
    const newDiscoveries = Array.isArray(submission.discovered_constraints)
        ? submission.discovered_constraints.filter((item) => typeof item === "string")
        : [];
    const resolved = resolveConstraintRetractions({
        targets,
        active: facts.constraints,
        newDiscoveries,
        previouslyRetired: facts.previouslyRetired,
    });
    return {
        errors: resolved.errors.map((error) => ({
            field: "retracted_constraints",
            reason: error.reason,
            detail: error.detail,
        })),
        noopDiagnostics: resolved.noops.map((noop) => ({
            path: "retracted_constraints",
            code: noop.reason,
            handling: "dropped",
            detail: `${noop.target}: ${noop.reason.replace(/_/g, " ")}`,
        })),
    };
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
    const shapeErrors = validateContractShape(submission, {
        activeItemIds: session
            ? new Set((active?.items ?? []).map((item) => item.id))
            : null,
        knownCriterionIds: criteria
            ? new Set(criteria.map((criterion) => criterion.id))
            : null,
        displayedSubGoalIds: displayedSubGoals,
        isConfiguredCommand,
    });
    // v3.9.9: the transition is a STRUCTURAL boundary like the contract itself.
    // Target identity and "successor content actually changed" are checked only
    // when the active contract was observable; structure stays strict either way.
    const transitionErrors = validateContractTransition(submission, {
        observed: session !== undefined,
        activeContractId: active?.id ?? null,
        activeItemIdentities: active
            ? new Set(active.items.map((item) => canonicalContractItemText(item)))
            : null,
    });
    return [...shapeErrors, ...transitionErrors];
}
//# sourceMappingURL=submission-boundary.js.map