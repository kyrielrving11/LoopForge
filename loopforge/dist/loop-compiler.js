/** LoopForge cognitive-state compiler.
 *
 * The compiler evolves structured state and renders one prompt artifact.
 * L0/L1/L2 control state density only; the external Agent owns reasoning.
 */
import { createHash } from "node:crypto";
import { deriveConfiguredCapability, getPolicy } from "./policy.js";
import { AgentStatus, makeLoopCompileResponse, operatorAcceptanceFromObjective, makeLoopObjective, makeConstraintMeta, } from "./protocol.js";
import { createCanonicalLoopState, renderCanonicalStateMarkdown, } from "./canonical-state.js";
import { pendingBacktrackRecord, roundResultFromCommittedRound, } from "./committed-round.js";
import { buildCommittedHistory, historyWindow, operatorAcceptanceKey, } from "./history.js";
import { LegacyHistoryError, OperatorAcceptanceConflictError } from "./errors.js";
import { deriveProgressWindow, } from "./progress.js";
import { deriveCriterionStatuses as deriveCriterionStatusesFromViews } from "./criterion-status.js";
import { derivePromptFreshness, UNKNOWN_PROMPT_FRESHNESS, } from "./prompt-freshness.js";
import { NO_IN_FLIGHT_ROUND, deriveRoundFacts } from "./round-facts.js";
import { recoveryBriefLines } from "./enforcement-gate.js";
import { deriveSubGoals, duplicateEmergedDeclarations } from "./subgoal-state.js";
import { deriveConstraintProvenance, resolveConstraintRetractions, } from "./constraint-lifecycle.js";
import { assemblePromptArtifact } from "./prompt-assembler.js";
import { renderSelfEvalBlock, } from "./submission-guidance.js";
import { decidePromptLevel, } from "./prompt-policy.js";
import { criterionRefMatches, deriveConstraintId, deriveCriterionId, normalizeText, unique, uniqueNormalized, } from "./token-utils.js";
function contextEntries(context) {
    if (!context || !Array.isArray(context.results))
        return [];
    return context.results.filter((value) => value !== null && typeof value === "object" && !Array.isArray(value));
}
export function computeGoalTextHash(text) {
    const normalized = text.trim().replace(/\s+/g, " ").toLowerCase();
    return createHash("sha256").update(normalized).digest("hex").slice(0, 12);
}
export function deriveGoalId(loopId, task, explicit = "") {
    return explicit.trim() || `${loopId}:${task.trim().toLowerCase()
        .replace(/[^a-z0-9\u4e00-\u9fff]+/g, "-")
        .replace(/^-|-$/g, "")
        .slice(0, 48) || computeGoalTextHash(task)}`;
}
export function getPreviousRound(loopId, round, context) {
    const history = buildCommittedHistory(contextEntries(context));
    return previousRoundFromWindow(historyWindow(history, Number.POSITIVE_INFINITY), round);
}
function previousRoundFromWindow(window, round) {
    const view = window.find((candidate) => candidate.round === round);
    if (!view)
        return null;
    return {
        round,
        goal_id: view.compiled?.goalId ?? "",
        success: view.success,
        task: view.compiled?.task ?? "",
        constraints_active: [...(view.activeConstraints ?? [])],
        output_summary: view.evaluation?.output_summary ?? "",
    };
}
/** The operator objective from the immutable acceptance carried by a committed
 *  evaluation or rollback directive. Acceptance is byte-identical across
 *  copies (enforced by the history loader), so it does not need a round or
 *  branch window. */
export function latestObjective(loopId, context) {
    const history = buildCommittedHistory(contextEntries(context));
    for (const view of history.views) {
        if (!view.operatorAcceptance)
            continue;
        return makeLoopObjective({
            objective: view.operatorAcceptance.task,
            success_criteria: [...view.operatorAcceptance.success_criteria],
            hard_constraints: [...view.operatorAcceptance.hard_constraints],
            created_at_round: 1,
            loop_id: loopId,
        });
    }
    return null;
}
function evolveObjective(request, context, operatorAcceptance) {
    // v3.9.7: committed acceptance is authoritative once it exists. A transient
    // request may bootstrap the objective for round 1 or a library caller with
    // no committed objective; it may not rewrite operator acceptance after a
    // committed objective exists.
    const committed = latestObjective(request.loop_id, context);
    const allowRequestObjective = request.loop_objective !== null &&
        (request.round === 1 || committed === null);
    const accepted = operatorAcceptance
        ? makeLoopObjective({
            objective: operatorAcceptance.task,
            success_criteria: [...operatorAcceptance.success_criteria],
            hard_constraints: [...operatorAcceptance.hard_constraints],
            created_at_round: 1,
            loop_id: request.loop_id,
        })
        : null;
    const current = accepted ??
        (allowRequestObjective ? request.loop_objective : null) ??
        committed ??
        makeLoopObjective({
            objective: request.task,
            success_criteria: ["Task goal achieved with verifiable evidence"],
            hard_constraints: unique(request.round === 1 || committed === null ? request.constraints_from_plan : []),
            created_at_round: 1,
            loop_id: request.loop_id,
        });
    // The operator objective is the committed acceptance; no Agent report
    // rewrites it.
    return makeLoopObjective({
        ...current,
        objective: current.objective || request.task,
        success_criteria: uniqueNormalized(current.success_criteria),
        hard_constraints: uniqueNormalized(current.hard_constraints),
        loop_id: request.loop_id,
    });
}
function evolveConstraints(request, objective, previous, windowRounds, roundOnePlan, preservedDiscoveries, preservedRound) {
    // The active set at the START of the round that produced the retraction:
    // the previous committed compile's stamped `constraints_active`.
    const carried = uniqueNormalized(previous.view?.activeConstraints ?? []);
    const activeTargets = carried.map((text) => ({
        text,
        provenance: deriveConstraintProvenance({
            text,
            objective,
            windowRounds,
            roundOnePlan,
            preservedDiscoveries,
            preservedRound,
        }),
    }));
    const previouslyRetired = unique(windowRounds.flatMap((round) => round.retractedConstraints ?? []));
    const retraction = resolveConstraintRetractions({
        targets: previous.result?.retracted_constraints ?? [],
        active: activeTargets,
        // The compiler does not see this submission's new discoveries; the
        // boundary resolves the same target set and reports same-round cases.
        newDiscoveries: [],
        previouslyRetired,
    });
    const effectiveKeys = new Set(retraction.effective.map(normalizeText));
    // Only round 1 accepts a plan input. After round 1 the active set is carried
    // from committed compile facts; a late request value is not a fact.
    const base = uniqueNormalized([
        ...carried,
        ...roundOnePlan,
        ...objective.hard_constraints,
        ...objective.success_criteria,
        ...preservedDiscoveries,
    ]).filter((text) => !effectiveKeys.has(normalizeText(text)));
    // Only the previous round's NEW discoveries are added after retraction:
    // a new declaration in the retraction round survives the retraction.
    const allDiscovered = unique(previous.result?.discovered_constraints ?? []);
    const discovered = allDiscovered
        .slice(0, getPolicy().evolution.max_discovered_constraints_per_round);
    const discoveryDropped = allDiscovered.length - discovered.length;
    const active = uniqueNormalized([...base, ...discovered]);
    const provenance = new Map();
    for (const text of active) {
        provenance.set(text, deriveConstraintProvenance({
            text,
            objective,
            windowRounds,
            roundOnePlan,
            preservedDiscoveries,
            preservedRound,
        }));
    }
    return { active, retired: retraction.effective, provenance, discoveryDropped };
}
// ═══════════════════════════════════════════════════════════════════════════
// Hierarchical Summary (v2.1)
// ═══════════════════════════════════════════════════════════════════════════
/** v3.8.1: THE recurring-fact derivation — one walk over the committed
 *  history, grouping repeated machine facts by what they are ABOUT.
 *
 *  This replaces three separate answers to "what keeps going wrong":
 *  `deriveLessons` (whole history, count >= 2, keyed by constraint text or
 *  check id), `rolling_summary.recurring_issues` (the last 5 rounds' raw
 *  violation texts, with NO threshold at all despite the name), and the L1/L2
 *  sections built on top of each. Three windows over one fact set is exactly
 *  the parallel semantics this release removes.
 *
 *  Callers FILTER this list rather than re-deriving: the state file renders
 *  the genuinely recurring set (count >= 2), the prompt renders the recent
 *  tail as Active Warnings.
 *
 *  Presentation only: the result never feeds enforcement. */
export function deriveRecurringFlags(committedRounds) {
    const byKey = new Map();
    const record = (kind, subject, ref, round) => {
        const key = JSON.stringify([kind, subject, ref]);
        const existing = byKey.get(key);
        if (existing) {
            existing.count++;
            if (!existing.rounds.includes(round))
                existing.rounds.push(round);
            return;
        }
        byKey.set(key, { subject, kind, ref, count: 1, rounds: [round] });
    };
    for (const round of committedRounds) {
        for (const text of round.constraintViolations ?? []) {
            record("constraint_violation", text, "", round.round);
        }
        for (const flag of round.verificationFlags) {
            const kind = flag.severity === "error"
                ? "verification_error"
                : flag.severity === "warn" ? "verification_warning" : null;
            if (!kind)
                continue;
            record(kind, flag.check, flag.ref ?? "", round.round);
        }
    }
    return [...byKey.values()].sort((a, b) => b.count - a.count ||
        a.subject.localeCompare(b.subject) ||
        a.ref.localeCompare(b.ref));
}
/** v3.3: Machine git-motion cross-check over the last 3 committed rounds
 *  (the R4 window). Undefined when no committed rounds carry git snapshots
 *  — the dashboard then shows no machine row. Display-only companion to the
 *  R4/R5 exculpatory signal. */
function deriveMachineStatus(rounds, currentRound) {
    // v3.9.9: the dashboard shows the SAME fact the stall rule consumes.
    const window = deriveProgressWindow(rounds, currentRound, getPolicy().engine.stall_lookback_rounds);
    if (window.incomplete || window.state === "not_applicable")
        return undefined;
    const changedRounds = window.roundStates.filter((entry) => entry.state === "changed").length;
    return {
        windowRounds: window.lookback,
        machineProgress: window.state,
        changedRounds,
        providers: window.providers,
    };
}
/** v3.2: Derive per-criterion status — the "goal → criteria → evidence"
 *  vertical view. Each objective criterion gets claimed/remaining/unknown
 *  (from per-round criterion_claims, ID-first or normalized-exact matching)
 *  and the round it was first reported met. Zero persistence — re-derived
 *  from committed rounds every compile.
 *
 *  v3.9.6: the derivation lives in `criterion-status.ts` so the submission
 *  boundary and guidance can read the same rows without importing this module
 *  (which would close the `loop-compiler → submission-guidance` cycle). */
export function deriveCriterionStatuses(loopId, context, objective, currentRound, lastRoundResult,
/** v3.8.1: the criterion machine facts from the shared bundle. A criterion
 *  is `verified` / `contradicted` / `insufficient` only through an item that
 *  references it — a claim alone can never reach `verified` — and the fact
 *  is derived over the WHOLE committed history, so it survives its contract
 *  closing (see `deriveCriterionFacts`). */
criterionFacts = []) {
    const history = buildCommittedHistory(contextEntries(context));
    return deriveCriterionStatusesFromViews({
        rounds: historyWindow(history, currentRound),
        currentRound,
        objective,
        criterionFacts,
    });
}
/** v3.8: Rank item statuses so the strongest machine fact wins when several
 *  items reference the same criterion. */
/** Match two criterion references. If either is a criterion id
 *  (cr-XXXXXXXX), compares ids; otherwise requires the two texts to be
 *  EXACTLY equal after normalization (v3.8.1 — the similarity fallback is
 *  gone, so a paraphrase is a different criterion). */
export function criteriaMatch(a, b) {
    // v3.9.2: ONE identity rule, shared with the prompt and submission boundary.
    return criterionRefMatches(a, b);
}
// ═══════════════════════════════════════════════════════════════════════════
// Sub-Goal Structured Tracking (v2.2)
// ═══════════════════════════════════════════════════════════════════════════
// v3.8.1/v3.9.7: the stable-id helpers live in token-utils.ts, where the
// criterion/constraint fact derivations can use them without an import
// cycle. Re-exported so this module's public surface is unchanged.
export { deriveConstraintId, deriveCriterionId, isCriterionId, } from "./token-utils.js";
// ═══════════════════════════════════════════════════════════════════════════
// Time-Aware Constraint Management (v2.3)
// ═══════════════════════════════════════════════════════════════════════════
/** True when a reported violation text matches a constraint text.
 *  v2.11: ID-first — an exact `c-XXXXXXXX` match against the derived id.
 *  v3.8.1: the Jaccard fallback is gone; the remaining arm requires the
 *  reported text to be EXACTLY equal to the constraint after normalization,
 *  so a reported violation can no longer attach itself to a constraint it
 *  merely resembles. */
function matchesConstraintText(text, violation) {
    const targetId = deriveConstraintId(text);
    if (violation === targetId || deriveConstraintId(violation) === targetId) {
        return true;
    }
    return normalizeText(text) === normalizeText(violation);
}
function findLastViolatedRound(text, rounds) {
    let latest = 0;
    for (const view of rounds) {
        for (const v of view.constraintViolations ?? []) {
            if (matchesConstraintText(text, v)) {
                if (view.round > latest)
                    latest = view.round;
                break;
            }
        }
    }
    return latest;
}
/**
 * Manage constraint lifecycle metadata for the active set.
 *
 * v3.7: the v2.3 time-aware decay (discovered constraints demoted to
 * inactive after N quiet rounds, auto-reactivation on a fresh violation)
 * is gone — every active constraint stays active. What remains is the
 * display metadata the v3 prompt surface needs: per-text source
 * classification (v3.3.1: criteria texts carry the cr-XXXXXXXX namespace),
 * and last_violated_at_round for the L1 collapse "(violated this round)"
 * annotation (diffConstraints compares it to the current round).
 */
function manageConstraintLifecycle(active, provenance, windowRounds) {
    const metadata = [];
    for (const text of active) {
        const source = provenance.get(text) ?? { source: "unrecorded" };
        // v3.3.1: one text, one identity — a success-criterion text that also
        // lives in the merged active set belongs to the cr-XXXXXXXX namespace
        // (its own Success Criteria section and the verification gate's
        // criteriaMatch are ID-first on cr-). Rendering it under c-XXXXXXXX in
        // the active list meant the same text carried two IDs in one prompt,
        // and an agent echoing the active-list ID into its criterion claims
        // could never match.
        metadata.push(makeConstraintMeta({
            id: source.source === "criteria" ? deriveCriterionId(text) : deriveConstraintId(text),
            text,
            last_violated_at_round: findLastViolatedRound(text, windowRounds),
            source: source.source,
            ...(source.source_round !== undefined ? { source_round: source.source_round } : {}),
        }));
    }
    return { active, metadata };
}
/** Resolve the ONE previous-round fact bundle for a compile.
 *
 *  It is built from the committed window only. A retry's verification findings
 *  are authoritative even when empty: the retry must never inherit the
 *  previous committed round's flags. */
function resolvePreviousRoundFacts(request, entries, windowRounds) {
    const view = windowRounds.find((round) => round.round === request.round - 1) ?? null;
    const recoveryBoundary = pendingBacktrackRecord(entries, request.round) !== null;
    const inFlight = (request.attempt ?? 1) > 1 || recoveryBoundary;
    return {
        view,
        result: view ? roundResultFromCommittedRound(view) : null,
        verificationFlags: inFlight
            ? (request.verification_flags ?? [])
            : (view?.verificationFlags ?? request.verification_flags ?? []),
        freshness: view ? derivePromptFreshness(view) : UNKNOWN_PROMPT_FRESHNESS,
        recoveryBoundary,
    };
}
function levelDecision(request, prior, previous) {
    return decidePromptLevel({
        round: request.round,
        attempt: request.attempt,
        forceLevel: request.force_level,
        hasPlanSource: Boolean(request.plan_source),
        recoveryBoundary: previous.recoveryBoundary,
        checkpointBoundary: previous.result?.compression_checkpoint === true,
        // An empty goal_id is unobservable, not a goal change: never fabricate L2.
        goalChanged: prior !== null && prior.goal_id !== "" &&
            prior.goal_id !== deriveGoalId(request.loop_id, request.task, request.goal_id),
        previousStateMissing: request.round > 1 && prior === null,
        previousRoundFailed: previous.view
            ? previous.view.success === false
            : previous.result?.success === false,
        previousRoundObservableNewInformation: previous.view
            ? previous.freshness.observableNewInformation
            : null,
        verificationContradicted: previous.verificationFlags
            .some((flag) => flag.severity === "error"),
        consecutiveRejections: request.consecutive_rejections,
    });
}
export function decideLevel(request, context) {
    const entries = contextEntries(context);
    const window = historyWindow(buildCommittedHistory(entries), request.round);
    const prior = previousRoundFromWindow(window, request.round - 1);
    return levelDecision(request, prior, resolvePreviousRoundFacts(request, entries, window)).level;
}
/** The prompt's evaluation block. All content (examples, contract/sub-goal
 *  guidance, flag-specific hints) comes from the one FIELD_GUIDES table in
 *  submission-guidance.ts; this function owns no second copy. */
export function buildSelfEvalBlock(ctx) {
    return renderSelfEvalBlock(ctx);
}
/** v3.7.1: Derived Recovery Brief for the state-file Recent tier. Present
 *  ONLY while a committed backtrack decision is the current round's record
 *  (the recovery window); the redo commit replaces that record, so the
 *  brief exits the projection by construction. Sources are the committed
 *  rollback decision's own fields — no new persistence, no rejected
 *  payloads. */
function committedBacktrackBrief(loopId, round, context) {
    // The SAME pending-backtrack lookup the recovery boundary uses: a deep
    // restore commits at the failed round while its redo targets
    // `backtrackTarget + 1`, so an exact-round match loses both the boundary
    // and this brief.
    const view = pendingBacktrackRecord(contextEntries(context), round);
    const record = view?.recovery;
    if (!record)
        return undefined;
    const lines = recoveryBriefLines({
        redoRound: record.target.redo_round,
        checkpointId: record.target.checkpoint_id,
        restoreVerified: true,
        triggerRule: record.origin === "machine"
            ? (record.trigger_rule ?? "machine_recovery")
            : "agent_recovery",
        origin: record.origin,
        reason: record.reason,
        ...(record.origin === "machine" && record.reason.trim()
            ? { failureReason: record.reason }
            : {}),
        failedRounds: record.failed_rounds,
        approaches: record.approaches,
        wrongAssumptions: record.wrong_assumptions,
        preservedDiscoveries: record.skipped_discoveries,
        // The redo round's stable identity is a fact the old prepended prose
        // carried; keep it inside the artifact now.
        recoveryRoundId: `loop:${loopId}:round:${record.target.redo_round}`,
    });
    if (record.skipped_files.length > 0) {
        const files = [...record.skipped_files].sort();
        const shown = files.slice(0, 15);
        lines.push("- **Files changed since the checkpoint**:");
        for (const file of shown)
            lines.push(`  - \`${file}\``);
        if (files.length > shown.length) {
            lines.push(`  - … and ${files.length - shown.length} more files`);
        }
    }
    return lines;
}
export function compileLoop(request, context, options = {}, committedHistory) {
    const operatorAcceptance = options.operatorAcceptance ?? null;
    // ONE history window and ONE previous-round fact bundle for the whole
    // compile. Every consumer below reads these values; none re-derives the
    // window with a private rule.
    const entries = contextEntries(context);
    const history = committedHistory ?? buildCommittedHistory(entries);
    if (history.legacyRounds.length > 0) {
        throw new LegacyHistoryError(request.loop_id, history.legacyRounds.map((round) => round.round));
    }
    // The operator surface is immutable. A caller-supplied copy that disagrees
    // with a committed copy is an integrity conflict — never a silent override.
    const committedAcceptance = history.views.find((view) => view.operatorAcceptance !== null)?.operatorAcceptance ?? null;
    if (operatorAcceptance && committedAcceptance &&
        operatorAcceptanceKey(operatorAcceptance) !==
            operatorAcceptanceKey(committedAcceptance)) {
        throw new OperatorAcceptanceConflictError(request.loop_id);
    }
    const windowRounds = historyWindow(history, request.round);
    const prior = previousRoundFromWindow(windowRounds, request.round - 1);
    const previous = resolvePreviousRoundFacts(request, entries, windowRounds);
    const decision = levelDecision(request, prior, previous);
    const objective = evolveObjective(request, context, operatorAcceptance);
    const pendingDirective = pendingBacktrackRecord(entries, request.round);
    const preservedDiscoveries = pendingDirective?.recovery &&
        getPolicy().engine.backtrack_preserve_discoveries
        ? pendingDirective.recovery.skipped_discoveries
        : [];
    const preservedRound = pendingDirective?.round;
    // Plan constraints are a round-1 operator/plan input, or a library
    // bootstrap when no committed round exists. Once a committed view exists,
    // the committed active set carries them and a late request is not a fact.
    const planInput = request.round === 1 || previous.view === null
        ? request.constraints_from_plan
        : [];
    const constraints = evolveConstraints(request, objective, previous, windowRounds, planInput, preservedDiscoveries, preservedRound);
    const constraintLifecycle = manageConstraintLifecycle(constraints.active, constraints.provenance, windowRounds);
    // v3.8: sub-goal lifecycle lives in subgoal-state.ts and consumes the
    // shared committed-round view — one history interpretation. The previous
    // round's report is idempotently replayed; a committed round is already in
    // the window, while the library fallback has no view.
    const subGoals = deriveSubGoals({
        loopId: request.loop_id,
        currentRound: request.round,
        rounds: windowRounds,
    });
    // v3.4/v3.8/v3.8.1: the ACTIVE Round Contract and its per-item statuses for
    // this compile — ONE `deriveRoundFacts` call, the same bundle the projection
    // consumes. Derived from committed rounds, so rejection retries, resume,
    // unpause and backtrack compiles keep showing the same contract, and a
    // verified or blocked contract stops being shown. A verified item stays
    // proven after its contract closes because the bundle reads the whole
    // history, not the active contract. The compile path has no in-flight
    // observations of its own.
    const roundFacts = deriveRoundFacts({
        rounds: windowRounds,
        currentRound: request.round,
        inFlight: NO_IN_FLIGHT_ROUND,
        commands: getPolicy().evidence.commands ?? [],
    });
    const { activeContract } = roundFacts;
    // v3.9.4: the criterion reference space is the ACTIVE criterion set, not
    // every text the objective ever carried. A retracted criterion must not be
    // claimable or contract-referenceable while the prompt does not render it.
    const activeConstraintKeys = new Set(constraintLifecycle.active.map((text) => normalizeText(text)));
    const activeCriteria = uniqueNormalized(objective.success_criteria)
        .filter((text) => activeConstraintKeys.has(normalizeText(text)));
    const criterionObjective = {
        ...objective,
        success_criteria: activeCriteria,
    };
    // v3.2: Goal → criteria → evidence vertical view (derived, zero persistence).
    const criterionStatuses = deriveCriterionStatuses(request.loop_id, context, criterionObjective, request.round, previous.result, roundFacts.criterionFacts);
    // v3.8.1: the ONE recurring-fact derivation, over the shared window. The
    // prompt renders its recent tail; the state file renders the recurring set.
    const recurringFlags = deriveRecurringFlags(windowRounds);
    // v3.8.1: a same-round exact repeat is the only sub-goal duplication the
    // runtime can state as a fact — those entries really were dropped, so the
    // agent is told. The cross-round near-duplicate similarity diagnostic is
    // gone with the rest of the fuzzy matching, and so are the task-alignment
    // and loop-health warnings: both were Jaccard scores over task/objective
    // text, never machine facts.
    // v3.9.5: only committed declarations are history. A library fallback is
    // in-flight and must not manufacture a prompt warning.
    const repeatedDeclarations = previous.view
        ? duplicateEmergedDeclarations(previous.view.emergedSubtasks ?? [])
        : [];
    const warnings = unique([
        repeatedDeclarations.length > 0
            ? `duplicate_declaration: ${repeatedDeclarations.length} sub-goal ` +
                `declaration(s) repeated an earlier entry in the same round and were ` +
                `not created: ${repeatedDeclarations.join("; ")}`
            : "",
        request.round > 1 && previous.view !== null && request.loop_objective !== null
            ? "uncommitted_objective_ignored: a committed objective exists; the request objective is ignored"
            : "",
        request.round > 1 && previous.view !== null && request.constraints_from_plan.length > 0
            ? "uncommitted_plan_ignored: a committed active set exists; request plan constraints are ignored"
            : "",
        constraints.discoveryDropped > 0
            ? `discovery_cap: ${constraints.discoveryDropped} discovered constraint(s) exceeded ` +
                `max_discovered_constraints_per_round and were not expanded`
            : "",
    ]);
    // v3.8.1: the agent trust score and trend are deleted. The score was
    // `1 - errors*0.15 - warns*0.03` — arbitrary weights with no machine
    // meaning, re-encoding flag counts that are already visible. The trend was
    // worse: `1 - violations*0.1` per round, computed from
    // `constraint_violations`, i.e. a DIFFERENT source from the score it was
    // displayed next to. "Trend" was therefore not the score's history at all.
    // Neither fed a decision.
    // v3.3/v3.8.1: machine git-motion (display-only, derived). The per-round
    // "round stats" table is deleted: its only renderer was the L2 prompt
    // section removed above, so it was computed, put into the canonical state
    // (and therefore into stateHash) and read by nothing. `windowRounds` is the
    // ONE window computed at the top of this function.
    const machineStatus = deriveMachineStatus(windowRounds, request.round);
    const response = makeLoopCompileResponse({
        status: AgentStatus.OK,
        recompile_level: decision.level,
        constraints_active: constraintLifecycle.active,
        constraints_retired: constraints.retired,
        constraint_metadata: constraintLifecycle.metadata,
        loop_id: request.loop_id,
        round: request.round,
        goal_id: deriveGoalId(request.loop_id, request.task, request.goal_id),
        loop_objective: objective,
        sub_goals: subGoals,
        criterion_statuses: criterionStatuses,
        recurring_flags: recurringFlags,
        plan_source: request.plan_source,
        warnings,
    });
    const policy = getPolicy();
    // L7 (v3.7.x): the state-file path is empty when the file is disabled —
    // prompts must never point at (or collapse content behind) a file that
    // writeStateFile will not create. An empty path propagates into the
    // assembler's pointer lines and the L1 collapse gate below.
    const statePath = policy.state_file.enabled
        ? `${policy.state_file.directory}/${request.loop_id}-state.md`
        : "";
    // The recovery brief is a current-round fact, computed once and shared by
    // the state file, the prompt and the evaluation block. It never becomes
    // prompt control state.
    const recoveryBrief = committedBacktrackBrief(request.loop_id, request.round, context);
    const state = createCanonicalLoopState(request, response, statePath, {
        machineStatus,
        // v3.4/v3.8.1: the contract-fact bundle — the Current Task's source of
        // truth, its verification view and the machine-verified sub-goal facts as
        // ONE derivation. The static capability rides on the state itself.
        roundFacts,
        // 3.9.3: the same previous-round bundle the level decision used. This is
        // what keeps corrections/blockers/remaining/progress identical on live,
        // resume, and unpause compiles.
        // v3.9.5: the committed flag is what keeps a caller fallback out of the
        // prompt/state narrative.
        previousRound: { ...previous, committed: previous.view !== null },
        recoveryBrief,
    });
    const configuredCapability = deriveConfiguredCapability(policy);
    const contractCommands = configuredCapability.commands
        .filter((command) => command.enabled)
        .map((command) => command.commandId);
    const markdown = renderCanonicalStateMarkdown(state, {
        // v3.7.1: retry attempts are marked in the derived view (attempt is
        // request context, not a committed fact). The Recovery Brief renders in
        // the Recent tier only while a committed backtrack decision is this
        // round's record; the redo commit removes it by construction.
        attempt: request.attempt,
        recoveryBrief,
    });
    // v3.8.1: the L2 budget is a FIXED ceiling. The v2.4 adaptive budget
    // scaled it by round count, milestone count and sub-goal count, which made
    // the prompt's allowed content depend on how long the loop had been running
    // rather than on the facts of this round — the same loop could render a
    // section at round 5 and silently drop it at round 50.
    //
    // v3.9.5: L2 never embeds the monolithic state markdown. The prompt is a
    // current-governance projection; full history stays in the optional state
    // file / replay / audit.
    const artifact = assemblePromptArtifact({
        state,
        level: decision.level,
        reasons: decision.reasons,
        budgets: {
            l0: policy.prompt.l0_max_chars,
            l1: policy.prompt.l1_max_chars,
            l2: policy.prompt.l2_max_chars,
        },
        attempt: request.attempt,
        selfEvaluationBlock: buildSelfEvalBlock({
            round: request.round,
            level: decision.level,
            activeContract,
            itemStatuses: roundFacts.itemStatuses,
            commands: contractCommands,
            contractVerificationAvailable: configuredCapability.contractVerificationAvailable,
            subGoals,
            verificationFlags: previous.verificationFlags,
            recovery: recoveryBrief !== undefined,
            gateEnabled: policy.gate.enabled === true,
            criteria: criterionStatuses,
        }),
        // v3.9.4: the SAME committed-backtrack facts the state file renders. The
        // recovery section is part of the artifact, so the delivered prompt is
        // exactly `artifact.renderedPrompt` (no post-compile prepend).
        recoveryBrief,
    });
    response.prompt = artifact.renderedPrompt;
    response.prompt_artifact = artifact;
    response.state_file_content = policy.state_file.enabled ? markdown : undefined;
    response.operatorAcceptance = operatorAcceptance ?? committedAcceptance ??
        operatorAcceptanceFromObjective(objective);
    response.compiled = {
        task: request.task,
        goalId: response.goal_id,
        constraintsActive: [...constraintLifecycle.active],
        constraintsRetired: [...constraints.retired],
    };
    return response;
}
//# sourceMappingURL=loop-compiler.js.map