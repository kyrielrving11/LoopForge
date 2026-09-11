/** LoopForge cognitive-state compiler.
 *
 * The compiler evolves structured state and renders one prompt artifact.
 * L0/L1/L2 control state density only; the external Agent owns reasoning.
 */
import { createHash } from "node:crypto";
import { getPolicy } from "./policy.js";
import { AgentStatus, makeLoopCompileResponse, makeLoopHealth, makeLoopObjective, makeConstraintMeta, makeMilestoneSummary, makeRollingSummary, makeTaskAlignment, } from "./protocol.js";
import { createCanonicalLoopState, renderCanonicalStateMarkdown, } from "./canonical-state.js";
import { decodeRound, entryLineage, entryCriteriaMet, entryCriteriaRemaining, entryActiveConstraints, entryRetractedConstraints, entryProgressEstimate, machineGitMotionSeries, mergedRoundsFromEntries, } from "./committed-round.js";
import { deriveActiveRoundContract } from "./round-contract.js";
import { deriveSubGoals, possibleDuplicateSubGoals } from "./subgoal-state.js";
import { deriveVerifiedSubGoals } from "./cognitive-facts.js";
import { deriveContractItemStatuses, } from "./contract-items.js";
import { claimedMetCriteria, claimedRemainingCriteria } from "./self-eval.js";
import { assemblePromptArtifact } from "./prompt-assembler.js";
import { decidePromptLevel, } from "./prompt-policy.js";
import { deriveItemId, jaccardSimilarity, unique, entryRound } from "./token-utils.js";
function contextEntries(context) {
    if (!context || !Array.isArray(context.results))
        return [];
    return context.results.filter((value) => value !== null && typeof value === "object" && !Array.isArray(value));
}
function loopEntries(loopId, context) {
    return contextEntries(context)
        .filter((entry) => entry.loop_id === loopId || entryLineage(entry).loop_id === loopId)
        .sort((a, b) => entryRound(a) - entryRound(b));
}
/** v3.3.1: The canonical entry for a round — its compile-time lineage entry
 *  (task_type "loop_lineage"; engine hydration merges the committed
 *  decision into it, so one round = one merged lineage entry in the
 *  compiler's view). Event/journal entries (delegation journals, gate
 *  records) share lineage.round with the round but carry none of its
 *  compile-time fields; round-level consumers that matched on the round
 *  number alone could hit them first (they sort after the lineage entry of
 *  the same round), producing an empty goal_id / task / constraints_active
 *  and forcing spurious L2 recovery. A direct :feedback entry is accepted
 *  when the caller supplies a raw committed view instead of hydration. */
function roundCanonicalEntry(entries, round) {
    const candidates = entries.filter((entry) => entryRound(entry) === round);
    return (candidates.find((entry) => entry.task_type === "loop_lineage") ??
        candidates.find((entry) => String(entry.task_id ?? "").endsWith(":feedback")) ??
        // Untyped compiler inputs are treated as round views, not events. Known event
        // types (delegation journals, gate records) are excluded explicitly so
        // they can never shadow a round again.
        candidates.find((entry) => {
            const type = String(entry.task_type ?? "");
            return type === "" || (!type.startsWith("delegation") && !type.endsWith("journal"));
        }) ??
        null);
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
/** v3.2: Read the previous round's persisted L1 presentation snapshot — the
 *  diff baseline for L1 collapse. Returns null when the previous round's
 *  lineage entry lacks the three presented_* fields (as on L0/L2 compiles),
 *  so callers render the full L1 state. */
export function readPresentedBaseline(loopId, round, context) {
    const entry = roundCanonicalEntry(loopEntries(loopId, context), round - 1);
    if (!entry)
        return null;
    const data = entryLineage(entry);
    const constraintIds = data.presented_constraint_ids;
    const subGoals = data.presented_subgoals;
    const milestoneRanges = data.presented_milestone_ranges;
    if (!Array.isArray(constraintIds) || !constraintIds.every((v) => typeof v === "string") ||
        !Array.isArray(subGoals) || !subGoals.every((v) => Array.isArray(v) && v.length === 2 &&
        typeof v[0] === "string" && typeof v[1] === "string") ||
        !Array.isArray(milestoneRanges) || !milestoneRanges.every((v) => Array.isArray(v) && v.length === 2 &&
        typeof v[0] === "number" && typeof v[1] === "number")) {
        return null;
    }
    return {
        round: round - 1,
        constraintIds: constraintIds,
        subGoals: subGoals,
        milestoneRanges: milestoneRanges,
    };
}
export function getPreviousRound(loopId, round, context) {
    const entry = roundCanonicalEntry(loopEntries(loopId, context), round);
    if (!entry)
        return null;
    const data = entryLineage(entry);
    return {
        round,
        goal_id: typeof data.goal_id === "string" ? data.goal_id : "",
        goal_text_hash: typeof data.goal_text_hash === "string" ? data.goal_text_hash : "",
        success: typeof entry.success === "boolean"
            ? entry.success
            : typeof data.success === "boolean" ? data.success : false,
        task: typeof data.task === "string"
            ? data.task
            : typeof entry.task === "string" ? entry.task : "",
        constraints_active: Array.isArray(data.constraints_active)
            ? data.constraints_active.filter((value) => typeof value === "string")
            : [],
        output_summary: typeof entry.output_summary === "string"
            ? entry.output_summary
            : typeof data.output_summary === "string" ? data.output_summary : "",
    };
}
function latestObjective(loopId, context) {
    const candidates = loopEntries(loopId, context).reverse();
    for (const entry of candidates) {
        const raw = entry.loop_objective;
        if (!raw || typeof raw !== "object" || Array.isArray(raw))
            continue;
        const value = raw;
        return makeLoopObjective({
            objective: typeof value.objective === "string" ? value.objective : "",
            success_criteria: Array.isArray(value.success_criteria)
                ? value.success_criteria.filter((item) => typeof item === "string")
                : [],
            hard_constraints: Array.isArray(value.hard_constraints)
                ? value.hard_constraints.filter((item) => typeof item === "string")
                : [],
            created_at_round: typeof value.created_at_round === "number" ? value.created_at_round : 1,
            loop_id: loopId,
            version: typeof value.version === "number" ? value.version : 1,
            refinement_history: Array.isArray(value.refinement_history)
                ? value.refinement_history.filter((item) => typeof item === "string")
                : [],
        });
    }
    return null;
}
function evolveObjective(request, context) {
    const current = request.loop_objective ?? latestObjective(request.loop_id, context) ??
        makeLoopObjective({
            objective: request.task,
            success_criteria: ["Task goal achieved with verifiable evidence"],
            hard_constraints: unique(request.constraints_from_plan),
            created_at_round: 1,
            loop_id: request.loop_id,
        });
    const last = request.last_round_result;
    const history = [...(current.refinement_history ?? [])];
    let objective = current.objective || request.task;
    let version = current.version ?? 1;
    if (last?.objective_refinement?.trim()) {
        const refinement = last.objective_refinement.trim();
        // M5: fold each refinement exactly once per persisted objective state.
        // A retry recompiles the same round against the same committed
        // last_round_result; without this guard every retry attempt re-appends
        // the refinement and inflates the version — the objective text and the
        // state file grew "Refinement: X" once per attempt.
        if (!history.includes(refinement)) {
            history.push(refinement);
            objective = `${objective}\nRefinement: ${refinement}`;
            version++;
        }
    }
    const revisions = new Map((last?.revised_success_criteria ?? []).map((item) => [item.old, item.new]));
    return makeLoopObjective({
        ...current,
        objective,
        version,
        refinement_history: history.slice(-getPolicy().evolution.max_objective_versions),
        success_criteria: unique(current.success_criteria.map((item) => revisions.get(item) ?? item)),
        hard_constraints: unique(current.hard_constraints),
        loop_id: request.loop_id,
    });
}
function evolveConstraints(request, objective, previous, context) {
    const retired = unique(request.last_round_result?.retracted_constraints ?? []);
    const retiredSet = new Set(retired);
    const discovered = unique(request.last_round_result?.discovered_constraints ?? [])
        .slice(0, getPolicy().evolution.max_discovered_constraints_per_round);
    // v2.14: agent-declared retractions of plan/hard/criteria constraints
    // persist for constraints.retire_window rounds (they are re-merged from
    // the request/objective every round, so without this the documented
    // "Removed from the active constraint set" never held for them). The
    // retraction rounds are derived from vault entries — no new persistence
    // format. After the window the constraint returns (hard/plan/criteria
    // constraints never auto-decay — only agent action removes them, and the
    // action's memory expires).
    const window = getPolicy().constraints.retire_window;
    const lastRetractedRound = new Map();
    if (window > 0) {
        for (const entry of loopEntries(request.loop_id, context)) {
            const retractedList = entryLineage(entry).retracted_constraints;
            if (!Array.isArray(retractedList))
                continue;
            const rnd = entryRound(entry);
            for (const text of retractedList) {
                if (typeof text !== "string" || !text)
                    continue;
                const prev = lastRetractedRound.get(text);
                if (prev === undefined || rnd > prev)
                    lastRetractedRound.set(text, rnd);
            }
        }
    }
    const active = unique([
        ...(previous?.constraints_active ?? []),
        ...request.constraints_from_plan,
        ...objective.hard_constraints,
        ...objective.success_criteria,
        ...discovered,
    ]).filter((item) => {
        if (retiredSet.has(item))
            return false;
        const retractedRound = lastRetractedRound.get(item);
        if (retractedRound !== undefined && request.round - retractedRound < window) {
            return false;
        }
        return true;
    }).slice(0, getPolicy().evolution.max_active_constraints);
    return { active, retired };
}
// ═══════════════════════════════════════════════════════════════════════════
// Hierarchical Summary (v2.1)
// ═══════════════════════════════════════════════════════════════════════════
/** v3.2: Deterministic lessons learned — constraints violated repeatedly or
 *  verification checks failing repeatedly across rounds (full history, unlike
 *  the enforcement gate's R2 3-round window). Presentation only: the output
 *  never feeds enforcement decisions. */
export function deriveLessons(loopId, context, currentRound) {
    const entries = loopEntries(loopId, context).filter((entry) => entryRound(entry) >= 1 && entryRound(entry) < currentRound);
    const violations = new Map();
    const errors = new Map();
    const warns = new Map();
    for (const entry of entries) {
        const rnd = entryRound(entry);
        const view = decodeRound(entry);
        const viols = view
            ? view.constraintViolations ?? []
            : Array.isArray(entry.constraint_violations)
                ? entry.constraint_violations.filter((v) => typeof v === "string")
                : [];
        for (const text of viols) {
            const list = violations.get(text) ?? [];
            list.push(rnd);
            violations.set(text, list);
        }
        const flags = view
            ? view.verificationFlags
            : Array.isArray(entry.verification_flags) ? entry.verification_flags : [];
        for (const flag of flags) {
            const target = flag.severity === "error"
                ? errors
                : flag.severity === "warn" ? warns : null;
            if (!target)
                continue;
            const list = target.get(flag.check) ?? [];
            list.push(rnd);
            target.set(flag.check, list);
        }
    }
    const lessons = [];
    for (const [text, rounds] of violations) {
        if (rounds.length >= 2) {
            lessons.push({ text, kind: "constraint_violation", count: rounds.length, rounds });
        }
    }
    for (const [text, rounds] of errors) {
        if (rounds.length >= 2) {
            lessons.push({ text, kind: "verification_error", count: rounds.length, rounds });
        }
    }
    for (const [text, rounds] of warns) {
        if (rounds.length >= 2) {
            lessons.push({ text, kind: "verification_warning", count: rounds.length, rounds });
        }
    }
    return lessons.sort((a, b) => b.count - a.count);
}
/** v3.3: Derive display-only round statistics over the last `window`
 *  committed rounds — files changed, rejected attempts (snapshot.attempt
 *  minus one: the successful commit's attempt counts the redo), and the
 *  self-reported progress delta vs the previous round. One row per round,
 *  preferring the :feedback entry when both lineage and feedback entries
 *  exist. Zero persistence — re-derived from committed entries. */
function deriveRoundStats(rounds, window = 5) {
    const stats = [];
    let prevProgress = null;
    for (const round of rounds.slice(-window)) {
        const ev = round.executionReport;
        const files = ev?.files_changed;
        const rawProgress = ev?.progress_estimate;
        const progress = typeof rawProgress === "number" ? rawProgress : null;
        stats.push({
            round: round.round,
            filesChangedCount: Array.isArray(files) ? files.length : null,
            rejectedAttempts: round.attempt >= 1 ? round.attempt - 1 : null,
            progressDelta: progress !== null && prevProgress !== null
                ? Number((progress - prevProgress).toFixed(3))
                : null,
        });
        if (progress !== null)
            prevProgress = progress;
    }
    return stats;
}
/** v3.3: Machine git-motion cross-check over the last 3 committed rounds
 *  (the R4 window). Undefined when no committed rounds carry git snapshots
 *  — the dashboard then shows no machine row. Display-only companion to the
 *  R4/R5 exculpatory signal. */
function deriveMachineStatus(rounds, currentRound) {
    const series = machineGitMotionSeries(rounds, currentRound, 3);
    if (series === null)
        return undefined;
    const motionRounds = series.filter(Boolean).length;
    return { windowRounds: 3, gitMotion: motionRounds > 0, motionRounds };
}
/** v3.4: ACTIVE Round Contract for the compile round — derived from the
 *  committed evals of earlier rounds only, never from request data. Reads
 *  the hydrated merged lineage entries (one per round; a committed decision
 *  is merged onto the round's lineage entry with `committed_action` set),
 *  skipping rounds whose committed action was "backtrack" (a roll-back
 *  directive, not an executed round). Because it runs identically on every
 *  compile path — including rejection retries and resume / unpause /
 *  backtrack compiles that carry no last_round_result — a contract round's
 *  re-compiles keep showing its contract as the Current Task. Null when no
 *  active contract: the Current Task falls back to the original task text. */
function deriveActiveContract(loopId, context, currentRound) {
    const entries = loopEntries(loopId, context);
    const canonical = Array.from({ length: Math.max(0, currentRound - 1) }, (_, index) => roundCanonicalEntry(entries, index + 1)).filter((entry) => entry !== null);
    return deriveActiveRoundContract(mergedRoundsFromEntries(canonical, currentRound));
}
/** v3.2: Derive per-criterion status — the "goal → criteria → evidence"
 *  vertical view. Each objective criterion gets: met/remaining/unknown
 *  (from per-round criterion_claims, ID-first
 *  matching), the round it was first reported met, and any sub-goals whose
 *  description matches it (Jaccard). Zero persistence — re-derived from the
 *  vault every compile. */
export function deriveCriterionStatuses(loopId, context, objective, currentRound, subGoals, lastRoundResult,
/** v3.8: the ACTIVE contract and its derived item statuses. A criterion is
 *  `verified` / `contradicted` / `insufficient` only through an item that
 *  references it — a claim alone can never reach `verified`. */
verification) {
    if (!objective || objective.success_criteria.length === 0)
        return [];
    const entries = loopEntries(loopId, context).filter((entry) => entryRound(entry) >= 1 && entryRound(entry) < currentRound);
    // The current round's report lives in last_round_result (the vault only
    // gains it on commit); treat it as the report for round currentRound - 1.
    const lastEv = lastRoundResult?.execution_report;
    const lastMet = claimedMetCriteria(lastEv);
    const lastRemaining = claimedRemainingCriteria(lastEv);
    const lastEntry = entries[entries.length - 1] ?? null;
    const lastEntryRemaining = lastEntry ? entryCriteriaRemaining(lastEntry) : [];
    const matchThreshold = getPolicy().evolution.subgoal_match_threshold;
    const itemStatusByCriterion = new Map();
    const activeContract = verification?.activeContract ?? null;
    if (activeContract) {
        for (const item of activeContract.items) {
            const status = verification?.itemStatuses.items
                .find((entry) => entry.itemId === item.id)?.status;
            // `pending` is "no claim yet" — it says nothing about the criterion, so
            // the criterion keeps its own claim-derived status.
            if (!status || status === "pending")
                continue;
            for (const ref of item.criterion_refs) {
                const criterionId = isCriterionId(ref) ? ref : deriveCriterionId(ref);
                const existing = itemStatusByCriterion.get(criterionId);
                // Machine facts outrank each other by strength; a claim never
                // weakens a machine verdict about the same criterion.
                itemStatusByCriterion.set(criterionId, strongestStatus(existing, status));
            }
        }
    }
    return objective.success_criteria.map((text) => {
        let metAtRound = null;
        for (const entry of entries) {
            const rnd = entryRound(entry);
            if (entryCriteriaMet(entry).some((met) => criteriaMatch(met, text))) {
                metAtRound = rnd;
                break; // first report wins — chronological scan
            }
        }
        if (metAtRound === null && lastMet.some((met) => criteriaMatch(met, text))) {
            metAtRound = currentRound - 1;
        }
        // v3.8: a claim reaches `claimed` at most. Only a machine fact about a
        // contract item that references this criterion can go further.
        const claimedStatus = metAtRound !== null
            ? "claimed"
            : lastRemaining.some((remaining) => criteriaMatch(remaining, text)) ||
                lastEntryRemaining.some((remaining) => criteriaMatch(remaining, text))
                ? "remaining"
                : "unknown";
        const machineStatus = itemStatusByCriterion.get(deriveCriterionId(text));
        const status = machineStatus ?? claimedStatus;
        return {
            id: deriveCriterionId(text),
            text,
            status,
            ...(metAtRound !== null ? { met_at_round: metAtRound } : {}),
            related_subgoal_ids: subGoals
                .filter((sg) => jaccardSimilarity(text, sg.description) >= matchThreshold)
                .map((sg) => sg.id),
        };
    });
}
/** v3.8: Rank item statuses so the strongest machine fact wins when several
 *  items reference the same criterion. */
function strongestStatus(left, right) {
    const rank = {
        contradicted: 3,
        verified: 2,
        insufficient: 1,
    };
    if (!left)
        return right;
    return rank[right] > rank[left] ? right : left;
}
/** v2.11: Match two criterion references for deduplication.
 *  If either is a criterion ID (cr-XXXXXXXX), uses exact ID comparison.
 *  Otherwise falls back to Jaccard similarity.
 *  v3.3: exported for the verification gate's windowed criteria-completion
 *  scan (R4/R5 exculpatory cross-check). */
export function criteriaMatch(a, b) {
    const aIsId = isCriterionId(a);
    const bIsId = isCriterionId(b);
    // Both are IDs — exact string comparison
    if (aIsId && bIsId)
        return a === b;
    // One is an ID — derive ID from the other and compare
    if (aIsId)
        return a === deriveCriterionId(b);
    if (bIsId)
        return deriveCriterionId(a) === b;
    // Neither is an ID — Jaccard fallback
    return jaccardSimilarity(a, b) >= getPolicy().evolution.criteria_dedup_threshold;
}
/** Detect newly met criteria by comparing the current entry's
 *  met criterion_claims against the previous entry's.
 *  v2.11: ID-first matching (cr-XXXXXXXX) with Jaccard similarity
 *  fallback for natural-language references.
 *  Returns empty array when there is no previous entry — the first
 *  entry's criteria are the baseline, not a "new" event. */
function detectNewCriteria(current, previous) {
    const currMet = entryCriteriaMet(current);
    if (currMet.length === 0)
        return [];
    if (!previous) {
        // First round with criteria is the baseline — not a milestone trigger.
        return [];
    }
    const prevMet = entryCriteriaMet(previous);
    if (prevMet.length === 0)
        return currMet;
    return currMet.filter((curr) => prevMet.every((prev) => !criteriaMatch(curr, prev)));
}
/** Build a single MilestoneSummary from a range of completed round entries. */
function buildMilestoneFromEntries(phaseEntries, startRound, endRound, label, kind) {
    const last = phaseEntries.at(-1);
    const lastView = last ? decodeRound(last) : null;
    const outcomeRaw = lastView
        ? (lastView.outputSummary ?? "")
        : last && typeof last.output_summary === "string" ? last.output_summary : "";
    const outcomeMax = getPolicy().checkpoint.outcome_max_chars;
    const outcome = outcomeRaw.length > outcomeMax
        ? outcomeRaw.slice(0, outcomeMax) + "…"
        : outcomeRaw;
    const carried = last ? entryActiveConstraints(last) : [];
    const resolved = unique(phaseEntries.flatMap((e) => entryRetractedConstraints(e)));
    const progress = last ? entryProgressEstimate(last) : 0;
    return makeMilestoneSummary({
        label,
        round_range: { start: startRound, end: endRound },
        outcome,
        carried_constraints: carried,
        resolved_constraints: resolved,
        progress_at_boundary: progress,
        kind,
        generated_at_round: endRound,
    });
}
/** v3.0.1: Evenly sample `budget` entries from `mid`, preferring
 *  agent_declared milestones (human/agent-labeled anchors) first and filling
 *  the remainder at even time positions. The caller guarantees
 *  `mid.length > budget`. */
function sampleMiddleMilestones(mid, budget) {
    if (budget <= 0)
        return [];
    if (mid.length <= budget)
        return mid;
    const chosen = [];
    const used = new Set();
    for (const m of mid) {
        if (m.kind === "agent_declared") {
            chosen.push(m);
            used.add(m);
            if (chosen.length >= budget)
                return chosen;
        }
    }
    const rest = mid.filter((m) => !used.has(m));
    const need = budget - chosen.length;
    for (let i = 0; i < need; i++) {
        const idx = Math.floor(((i + 0.5) * rest.length) / need);
        chosen.push(rest[idx]);
    }
    return chosen;
}
/** v3.0.1: L1 milestone sampling — when milestones exceed max_milestones,
 *  keep the oldest `milestone_head_count` (history anchors), the newest
 *  `milestone_tail_count` (current progress), and an even sample of the
 *  middle. L2 (full rehydration) is never sampled: the recovery view keeps
 *  every milestone as the loop's memory skeleton. */
function sampleMilestones(milestones, policy, level) {
    if (level === "l2")
        return milestones;
    if (milestones.length <= policy.max_milestones)
        return milestones;
    const head = Math.max(0, policy.milestone_head_count);
    const tail = Math.max(0, policy.milestone_tail_count);
    const midBudget = Math.max(0, policy.max_milestones - head - tail);
    if (midBudget === 0)
        return milestones.slice(0, head).concat(milestones.slice(milestones.length - tail));
    const mid = milestones.slice(head, milestones.length - tail);
    return [
        ...milestones.slice(0, head),
        ...sampleMiddleMilestones(mid, midBudget),
        ...milestones.slice(milestones.length - tail),
    ];
}
export function buildRollingSummary(loopId, currentRound, context, sinceRound = 0, level) {
    const policy = getPolicy().summary;
    const allEntries = loopEntries(loopId, context);
    // ── Phase 1: Recent Window (preserves existing behavior) ──
    const windowEntries = allEntries
        .filter((entry) => {
        const round = entryRound(entry);
        return round >= sinceRound && round < currentRound;
    })
        .slice(-policy.window);
    const outcomes = [];
    const issues = [];
    for (const entry of windowEntries) {
        const view = decodeRound(entry);
        const data = entryLineage(entry);
        const round = entryRound(entry);
        const success = view ? view.success : entry.success ?? data.success;
        const summary = view
            ? view.outputSummary ?? ""
            : typeof entry.output_summary === "string"
                ? entry.output_summary
                : typeof data.output_summary === "string" ? data.output_summary : "";
        // v2.12: Declared outcome wins the label; the default wording stays
        // "accepted" for zero regression on existing loop output.
        const declared = view ? view.outcome : entry.outcome;
        const outcomeLabel = declared === "success" || declared === "partial" ||
            declared === "failed" || declared === "blocked"
            ? declared
            : success === false ? "failed" : "accepted";
        if (summary)
            outcomes.push(`[R${round}] ${outcomeLabel}: ${summary}`);
        const violations = view
            ? view.constraintViolations ?? []
            : Array.isArray(entry.constraint_violations)
                ? entry.constraint_violations
                : Array.isArray(data.constraint_violations) ? data.constraint_violations : [];
        issues.push(...violations.filter((item) => typeof item === "string"));
    }
    // ── Phase 2: Milestone Accumulation ──
    // Scan all completed entries in round order. For each entry, check three
    // trigger signals in priority order: agent_declared > criteria_milestone > auto.
    const completedEntries = allEntries.filter((entry) => entryRound(entry) >= 1 && entryRound(entry) < currentRound);
    const milestones = [];
    let lastMilestoneRound = 0;
    for (let i = 0; i < completedEntries.length; i++) {
        const entry = completedEntries[i];
        const rnd = entryRound(entry);
        const lin = entryLineage(entry);
        // Signal 1: Agent-declared checkpoint
        const isAgentCheckpoint = lin.compression_checkpoint === true;
        // Signal 2: New criteria met (compare with previous vault entry)
        const prev = i > 0 ? completedEntries[i - 1] : null;
        const newCriteria = detectNewCriteria(entry, prev);
        if (isAgentCheckpoint || newCriteria.length > 0) {
            const startRound = lastMilestoneRound + 1;
            const phaseEntries = completedEntries.filter((e) => {
                const er = entryRound(e);
                return er >= startRound && er <= rnd;
            });
            const kind = isAgentCheckpoint
                ? "agent_declared"
                : "criteria_milestone";
            const label = isAgentCheckpoint
                ? (typeof lin.checkpoint_label === "string" && lin.checkpoint_label.trim()
                    ? lin.checkpoint_label.trim()
                    : `Round ${rnd}`)
                : `Completed: ${newCriteria.join(", ")}`;
            milestones.push(buildMilestoneFromEntries(phaseEntries, startRound, rnd, label, kind));
            lastMilestoneRound = rnd;
        }
    }
    // Signal 3: Safety net — auto milestone when gap exceeds milestone_interval.
    // v3.3.1: the policy contract (milestone_interval: "only fires when no
    // agent_declared or criteria_milestone has been created for this many
    // rounds") includes loops that NEVER created a milestone — but the guard
    // `lastMilestoneRound > 0` made the gap start from the (nonexistent) first
    // milestone, so a checkpoint-less loop could run forever with an empty
    // Phase History and no memory skeleton. With lastMilestoneRound == 0 the
    // gap is measured from round 1 and the safety net fires from the very
    // first interval.
    const gapSinceLast = (currentRound - 1) - lastMilestoneRound;
    if (gapSinceLast >= policy.milestone_interval &&
        completedEntries.length > 0) {
        const startRound = lastMilestoneRound + 1;
        const endRound = currentRound - 1;
        const phaseEntries = completedEntries.filter((e) => {
            const er = entryRound(e);
            return er >= startRound && er <= endRound;
        });
        if (phaseEntries.length > 0) {
            milestones.push(buildMilestoneFromEntries(phaseEntries, startRound, endRound, `Rounds ${startRound}–${endRound}`, "auto"));
        }
    }
    // v3.0.1: L1 keeps head anchors + newest tail + an even middle sample;
    // L2 (full rehydration) keeps every milestone — the recovery view is the
    // loop's memory skeleton and must not be truncated.
    const cappedMilestones = sampleMilestones(milestones, policy, level);
    if (windowEntries.length === 0 && cappedMilestones.length === 0)
        return null;
    return makeRollingSummary({
        key_outcomes: unique(outcomes),
        recurring_issues: unique(issues),
        rounds_sampled: windowEntries.length,
        generated_at_round: currentRound,
        failed_patterns: [],
        milestones: cappedMilestones,
    });
}
// ═══════════════════════════════════════════════════════════════════════════
// Sub-Goal Structured Tracking (v2.2)
// ═══════════════════════════════════════════════════════════════════════════
/** v2.11: Derive a stable constraint ID from its text hash (c-XXXXXXXX).
 *  Same hash strategy as SubGoal — deterministic across rounds. */
export function deriveConstraintId(text) {
    return "c-" + deriveItemId(text);
}
/** v2.11: Derive a stable criterion ID from its text hash (cr-XXXXXXXX).
 *  Same hash strategy as SubGoal — deterministic across rounds. */
export function deriveCriterionId(text) {
    return "cr-" + deriveItemId(text);
}
/** v2.11: Check whether a user-provided reference looks like a criterion ID.
 *  Matches the pattern cr-XXXXXXXX where X is a hex digit. Module-local:
 *  consumers with the same need (round-contract.ts) keep their own copy to
 *  avoid an import cycle. */
function isCriterionId(ref) {
    return /^cr-[a-f0-9]{8}$/.test(ref);
}
// ═══════════════════════════════════════════════════════════════════════════
// Time-Aware Constraint Management (v2.3)
// ═══════════════════════════════════════════════════════════════════════════
/** Determine the source of a constraint by matching against known sources. */
function constraintSource(text, objective, constraintsFromPlan) {
    const norm = text.toLowerCase().trim();
    if (objective.hard_constraints.some((c) => c.toLowerCase().trim() === norm))
        return "hard";
    if (constraintsFromPlan.some((c) => c.toLowerCase().trim() === norm))
        return "plan";
    if (objective.success_criteria.some((c) => c.toLowerCase().trim() === norm))
        return "criteria";
    return "discovered";
}
/** Find the latest round a constraint was violated by scanning vault entries.
 *  v2.11: ID-first matching. Checks exact constraint ID match (c-XXXXXXXX)
 *  against the derived ID of each vault entry's constraint_violations, then
 *  falls back to Jaccard similarity on text. Returns 0 if never violated. */
/** True when a reported violation text matches a constraint text — same
 *  ID-first + Jaccard fallback matching as findLastViolatedRound. */
function matchesConstraintText(text, violation) {
    const targetId = deriveConstraintId(text);
    if (violation === targetId || deriveConstraintId(violation) === targetId) {
        return true;
    }
    return jaccardSimilarity(text, violation) >=
        getPolicy().evolution.constraint_match_threshold;
}
function findLastViolatedRound(text, vaultEntries) {
    let latest = 0;
    for (const entry of vaultEntries) {
        const rnd = entryRound(entry);
        if (rnd < 1)
            continue;
        const view = decodeRound(entry);
        const violations = view
            ? view.constraintViolations ?? []
            : Array.isArray(entry.constraint_violations)
                ? entry.constraint_violations.filter((v) => typeof v === "string")
                : [];
        for (const v of violations) {
            if (matchesConstraintText(text, v)) {
                if (rnd > latest)
                    latest = rnd;
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
function manageConstraintLifecycle(active, objective, constraintsFromPlan, vaultContext, currentRound, lastRoundViolations = []) {
    const allEntries = loopEntries(objective.loop_id || "", vaultContext);
    const completedEntries = allEntries.filter((e) => entryRound(e) >= 1 && entryRound(e) < currentRound);
    const metadata = [];
    for (const text of active) {
        const source = constraintSource(text, objective, constraintsFromPlan);
        // v3.2.1: a violation reported in THIS round (last_round_result) counts
        // as a violation at currentRound — the previous rounds' scan cannot see
        // it (this round is not committed yet). This makes the L1 collapse
        // render "(violated this round)" (diffConstraints compares
        // last_violated_at_round === round).
        const violatedThisRound = lastRoundViolations.some((v) => matchesConstraintText(text, v));
        // v3.3.1: one text, one identity — a success-criterion text that also
        // lives in the merged active set belongs to the cr-XXXXXXXX namespace
        // (its own Success Criteria section and the verification gate's
        // criteriaMatch are ID-first on cr-). Rendering it under c-XXXXXXXX in
        // the active list meant the same text carried two IDs in one prompt,
        // and an agent echoing the active-list ID into its criterion claims
        // could never match.
        metadata.push(makeConstraintMeta({
            id: source === "criteria" ? deriveCriterionId(text) : deriveConstraintId(text),
            text,
            last_violated_at_round: violatedThisRound
                ? currentRound
                : findLastViolatedRound(text, completedEntries),
            source,
        }));
    }
    return { active, metadata };
}
export function alignTask(proposedTask, request, context) {
    const objective = request.loop_objective ?? latestObjective(request.loop_id, context);
    if (!objective)
        return makeTaskAlignment();
    // v2.14: threshold is policy-driven (evolution.progress_mismatch_threshold)
    const threshold = getPolicy().evolution.progress_mismatch_threshold;
    const score = jaccardSimilarity(proposedTask, [objective.objective, ...objective.success_criteria, ...objective.hard_constraints].join(" "));
    return makeTaskAlignment({
        is_aligned: score >= threshold,
        alignment_score: Number(score.toFixed(2)),
        warning: score < threshold ? "Current task may be drifting from the loop objective." : "",
        escalation: score < threshold ? "warn" : "none",
    });
}
export function checkLoopHealth(loopId, request, context) {
    const previous = getPreviousRound(loopId, request.round - 1, context);
    const alignment = alignTask(request.task, request, context);
    const violations = request.last_round_result?.constraint_violations.length ?? 0;
    const integrity = Math.max(0, 1 - violations * 0.2);
    const continuity = previous ? jaccardSimilarity(previous.task, request.task) : 1;
    // v2.14: thresholds are policy-driven
    const drift = alignment.alignment_score < getPolicy().evolution.progress_mismatch_threshold ||
        continuity < getPolicy().evolution.task_continuity_threshold;
    return makeLoopHealth({
        goal_alignment: alignment.alignment_score,
        constraint_integrity: integrity,
        drift_detected: drift,
        strategy_stability: true,
        task_continuity: Number(continuity.toFixed(2)),
        escalation_recommended: drift || integrity < 0.6 ? "l2" : "none",
    });
}
function levelDecision(request, context) {
    const previous = getPreviousRound(request.loop_id, request.round - 1, context);
    const last = request.last_round_result;
    const hasNewInformation = Boolean(request.new_since_last_round.trim() ||
        last?.discovered_constraints?.length ||
        last?.objective_refinement?.trim() ||
        last?.emerged_subtasks?.length ||
        last?.retracted_constraints?.length ||
        last?.revised_success_criteria?.length ||
        last?.wrong_assumptions?.length);
    const lastFullRound = loopEntries(request.loop_id, context)
        .filter((entry) => entryLineage(entry).recompile_level === "l2")
        .map(entryRound)
        .filter((round) => round < request.round)
        .at(-1) ?? 1;
    // v2.14: a backtrack committed for this round means the loop is
    // re-walking restored state — the recovery boundary forces L2
    // rehydration (the decidePromptLevel recovery_boundary branch existed
    // but no caller ever set it).
    const recoveryBoundary = loopEntries(request.loop_id, context)
        .some((entry) => entryLineage(entry).committed_action === "backtrack" &&
        entryRound(entry) === request.round);
    return decidePromptLevel({
        round: request.round,
        attempt: request.attempt,
        forceLevel: request.force_level,
        hasPlanSource: Boolean(request.plan_source),
        recoveryBoundary,
        checkpointBoundary: last?.compression_checkpoint === true,
        goalChanged: previous !== null && previous.goal_id !== deriveGoalId(request.loop_id, request.task, request.goal_id),
        previousStateMissing: request.round > 1 && previous === null,
        previousFailedWithoutNewInformation: last?.success === false && !hasNewInformation,
        verificationContradicted: (request.verification_flags ?? [])
            .some((flag) => flag.severity === "error"),
        consecutiveRejections: request.consecutive_rejections,
        fullRefreshInterval: getPolicy().prompt.full_refresh_interval,
        lastFullRound,
    });
}
export function decideLevel(request, context) {
    return levelDecision(request, context).level;
}
export function buildSelfEvalBlock(round,
/** v2.12: L0 is the minimal retry template — the v2.12 declarative fields
 *  (outcome/blocker/retroactiveClaims) are L1/L2 additions so the retry
 *  prompt stays within its tight budget. */
level,
/** v3.3/v3.4: Whether this round's Current Task IS the ACTIVE Round
 *  Contract (derived from committed rounds — compileLoop passes
 *  `activeContract != null`). Only then does the template ask the agent
 *  to restate/propose it — a generic empty contract template would invite
 *  placeholder submissions that trigger round_underspecified noise. */
hasContract = false,
/** v3.5: L2-only prose suggesting a Round Contract declaration when the
 *  Current Task is NOT one (contract_nudge_on_l2 policy, computed at the
 *  compileLoop call site). Mutually exclusive with hasContract. The prose
 *  must never contain the JSON key name `round_contract` — contract-less
 *  L2 tests assert its lowercase absence. */
proposalNudge = false) {
    const declareOutcome = level !== "l0";
    const restateContract = hasContract && declareOutcome;
    const evalObj = {
        success: false,
        output_summary: `<verified result of round ${round}>`,
        constraint_violations: ["<c-XXXXXXXX or text>"],
        should_continue: true,
        discovered_constraints: ["<new constraint>"],
        emerged_subtasks: [],
        execution_report: {
            files_changed: [],
            tests_reported: { passed: 0, failed: 0, skipped: 0 },
            // The contract claim is functional (it is what advances an item), so it
            // stays at every level. The advisory criterion claim is an L1/L2
            // addition — the L0 retry template is a lean delta kept under budget.
            contract_item_claims: [
                { item_id: "<rci-XXXXXXXX from the Current Task>", outcome: "met" },
            ],
            progress_estimate: 0,
        },
        wrong_assumptions: [],
        subgoal_updates: [
            { id: "<sg-XXXXXXXX from the Sub-Goal Dashboard>", status: "done" },
        ],
    };
    // v2.12: Declarative tri-state outcome (L1/L2 only — keeps L0 retry lean)
    if (declareOutcome) {
        evalObj.outcome = "<success|partial|failed|blocked>";
        evalObj.blocker = "<required only when outcome=blocked>";
        evalObj.retroactiveClaims = [];
        // v3.8: the advisory criterion claim rides with the other L1/L2 additions.
        evalObj.execution_report.criterion_claims = [
            { criterion_id: "<cr-XXXXXXXX or text>", outcome: "met" },
        ];
    }
    // v3.3/v3.4: Round Contract proposal template (L1/L2, active-contract
    // rounds only — L0 retry stays lean, and rounds without an active
    // contract never see the template). When the prompt's Current Task IS the
    // ACTIVE contract, the agent restates it unchanged as its proposal; when
    // the active contract's done_when are all satisfied (or the round is
    // blocked), a NEW contract is declared for the next round instead.
    if (restateContract) {
        evalObj.round_contract = {
            work_item: "<this round's focus, or empty>",
            done_when: [],
            verification_plan: [],
            scope: [],
        };
    }
    const lines = [
        "### LoopForge Evaluation (Required)",
        "",
        `After completing Round ${round}, replace the placeholder values below`,
        "with your actual results and pass this object as `loopforge_next.evaluation`.",
    ];
    lines.push("```json");
    lines.push(JSON.stringify(evalObj, null, 2));
    lines.push("```");
    lines.push("");
    lines.push("IMPORTANT: Replace every <placeholder> with your actual data.");
    lines.push("Set success=true only when the full goal and ALL hard constraints are verified.");
    lines.push("Use IDs for exact matching: c-XXXXXXXX, cr-XXXXXXXX, sg-XXXXXXXX.");
    lines.push("Sub-goal changes go through `subgoal_updates` (active sub-goal IDs only;");
    lines.push("done/canceled are terminal — reopen via `emerged_subtasks`; bad IDs reject).");
    // v3.5: L2 contract-less nudge (prose only — never the JSON key name, so
    // contract-less rounds keep their template-lean assertions).
    if (proposalNudge) {
        lines.push("", "If the remaining work will span several rounds, consider declaring a", "Round Contract for the next round — list its done_when items, the", "verification_plan commands that will back them, and the scope. This", "keeps each round's boundary machine-checkable.");
    }
    if (restateContract) {
        lines.push("Round Contract: restate the Current Task's contract UNCHANGED in", "`round_contract` (work_item/items/scope) and run each item's Verify", "commands; claim the items you completed in", "`execution_report.contract_item_claims` using the `rci-XXXXXXXX` ids", "the Current Task renders. An item only becomes verified when its bound", "command is observed passing — a claim alone leaves it insufficient.", "When every item is verified, or the round is blocked (outcome=blocked", "+ blocker), declare the NEXT round's contract instead (or omit", "`round_contract` when the whole task is done — the Current Task", "reverts to the original task).");
    }
    return lines.join("\n");
}
// v2.5: checkpoint() removed — agent_declared milestones from
// compression_checkpoint supersede the separate CheckpointSummary.
// See buildRollingSummary() signal 1.
/** v3.7.1: Derived Recovery Brief for the state-file Recent tier. Present
 *  ONLY while a committed backtrack decision is the current round's record
 *  (the recovery window); the redo commit replaces that record, so the
 *  brief exits the projection by construction. Sources are the committed
 *  rollback decision's own fields — no new persistence, no rejected
 *  payloads. */
function committedBacktrackBrief(loopId, round, context) {
    const entry = loopEntries(loopId, context).find((e) => entryLineage(e).committed_action === "backtrack" && entryRound(e) === round);
    if (!entry)
        return undefined;
    // Read the facts the engine stamped onto the merged lineage entry from
    // the committed rollback decision (engine.ts mergeCommittedRound).
    const lineage = entryLineage(entry);
    const asStrings = (value) => Array.isArray(value) ? value.filter((v) => typeof v === "string") : [];
    const asNumbers = (value) => Array.isArray(value) ? value.filter((v) => typeof v === "number") : [];
    const failedRounds = asNumbers(lineage.backtrackFailedRounds);
    const approaches = asStrings(lineage.backtrackApproaches).slice(0, 6);
    const assumptions = asStrings(lineage.backtrackWrongAssumptions).slice(0, 5);
    const target = typeof lineage.backtrackTarget === "number" ? lineage.backtrackTarget : 0;
    const trigger = typeof lineage.backtrackTriggerRule === "string"
        ? lineage.backtrackTriggerRule
        : "unknown";
    const lines = [
        `- **Trigger**: ${trigger}`,
        `- **Restored to round**: ${target} (redo round ${target + 1})`,
    ];
    if (failedRounds.length > 0)
        lines.push(`- **Failed rounds**: ${failedRounds.join(", ")}`);
    for (const approach of approaches)
        lines.push(`  - Failed approach: ${approach}`);
    if (assumptions.length > 0) {
        lines.push("- **Falsified assumptions** (do not rebuild on these):");
        for (const assumption of assumptions)
            lines.push(`  - ${assumption}`);
    }
    return lines;
}
export function compileLoop(request, context) {
    const decision = levelDecision(request, context);
    const previous = getPreviousRound(request.loop_id, request.round - 1, context);
    const objective = evolveObjective(request, context);
    const constraints = evolveConstraints(request, objective, previous, context);
    const constraintLifecycle = manageConstraintLifecycle(constraints.active, objective, request.constraints_from_plan, context, request.round, request.last_round_result?.constraint_violations ?? []);
    const rolling = buildRollingSummary(request.loop_id, request.round, context, 0, decision.level);
    // v3.8: ONE committed-round derivation feeds every projection below
    // (sub-goals, the active contract, its item statuses, criteria).
    const derivationRounds = mergedRoundsFromEntries(loopEntries(request.loop_id, context), request.round);
    // v3.8: sub-goal lifecycle lives in subgoal-state.ts and consumes the
    // shared committed-round view — one history interpretation.
    const subGoals = deriveSubGoals({
        loopId: request.loop_id,
        currentRound: request.round,
        rounds: derivationRounds,
        currentReport: request.last_round_result
            ? {
                round: request.last_round_result.round || (request.round - 1),
                emergedSubtasks: request.last_round_result.emerged_subtasks ?? [],
                subgoalUpdates: request.last_round_result.subgoal_updates ?? [],
            }
            : null,
    });
    // v3.4/v3.8: the ACTIVE Round Contract and its derived item statuses for
    // this compile. Derived from committed rounds, so rejection retries, resume,
    // unpause and backtrack compiles (which carry no last_round_result) keep
    // showing the same contract, and a verified or blocked contract stops being
    // shown. The compile path has no in-flight observations of its own.
    const activeContract = deriveActiveRoundContract(derivationRounds);
    const contractItemStatuses = deriveContractItemStatuses({
        contract: activeContract,
        rounds: derivationRounds,
        currentRound: request.round,
        currentReport: null,
        currentObservations: [],
        commands: getPolicy().evidence.commands ?? [],
    });
    // v3.8: derived from the committed history, not from `activeContract` — a
    // verified item stays proven after its contract closes.
    const verifiedSubGoals = deriveVerifiedSubGoals({
        subGoals,
        rounds: derivationRounds,
        commands: getPolicy().evidence.commands ?? [],
    });
    // v3.2: Goal → criteria → evidence vertical view (derived, zero persistence).
    const criterionStatuses = deriveCriterionStatuses(request.loop_id, context, objective, request.round, subGoals, request.last_round_result, { activeContract, itemStatuses: contractItemStatuses });
    // v3.2: Lessons learned — repeated violations / verification failures.
    const lessons = deriveLessons(request.loop_id, context, request.round);
    const alignment = alignTask(request.task, request, context);
    const health = checkLoopHealth(request.loop_id, { ...request, loop_objective: objective }, context);
    // v3.8: Jaccard similarity is DIAGNOSTIC ONLY for sub-goals — it never
    // merges or blocks a declaration, and it never creates a second history
    // interpretation (the set below is the same derived set everything else
    // consumes).
    const duplicateSubGoals = possibleDuplicateSubGoals(subGoals, getPolicy().evolution.subgoal_dedup_threshold);
    const warnings = unique([
        alignment.warning,
        health.escalation_recommended !== "none"
            ? `Loop health recommends ${health.escalation_recommended}.`
            : "",
        ...duplicateSubGoals.map((pair) => `possible_duplicate_subgoal: ${pair.left} ~ ${pair.right} ` +
            `(${(pair.score * 100).toFixed(0)}% similar) — consider consolidating them.`),
    ]);
    // ── v2.5: Agent trust score ──────────────────────────────────────────
    const flags = request.verification_flags ?? [];
    const errors = flags.filter((f) => f.severity === "error").length;
    const warns = flags.filter((f) => f.severity === "warn").length;
    const trustScore = Math.max(0, Math.min(1, 1.0 - (errors * 0.15) - (warns * 0.03)));
    // Trend — derive from vault entries (violation counts per round as proxy).
    // No new persistence; reconstructed same as milestones/sub-goals.
    const completedEntries = loopEntries(request.loop_id, context)
        .filter((e) => entryRound(e) >= 1 && entryRound(e) < request.round);
    const committedRounds = mergedRoundsFromEntries(completedEntries, request.round);
    const trend = [];
    for (const round of committedRounds.slice(-10)) {
        const viols = round.evaluation?.constraint_violations ?? [];
        // Simple proxy: no violations = perfect trust, each violation = -0.1
        const score = Math.max(0, 1.0 - viols.length * 0.1);
        trend.push(Number(score.toFixed(2)));
    }
    // v3.3: Round stats + machine git-motion status (display-only, derived).
    const roundStats = deriveRoundStats(committedRounds);
    const machineStatus = deriveMachineStatus(committedRounds, request.round);
    const response = makeLoopCompileResponse({
        status: AgentStatus.OK,
        recompile_level: decision.level,
        diff_from_previous: decision.reasons.join(","),
        lineage: [`${request.loop_id}:r${request.round}`],
        constraints_active: constraintLifecycle.active,
        constraints_retired: constraints.retired,
        constraint_metadata: constraintLifecycle.metadata,
        loop_id: request.loop_id,
        round: request.round,
        goal_id: deriveGoalId(request.loop_id, request.task, request.goal_id),
        goal_text_hash: computeGoalTextHash(request.task),
        loop_objective: objective,
        loop_health: health,
        task_alignment: alignment,
        rolling_summary: rolling,
        sub_goals: subGoals,
        criterion_statuses: criterionStatuses,
        lessons,
        agent_trust_score: request.round > 1 ? Number(trustScore.toFixed(2)) : undefined,
        agent_trust_trend: request.round > 1 ? trend : [],
        suggested_next_task: request.last_round_result?.emerged_subtasks?.[0] || "",
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
    const state = createCanonicalLoopState(request, response, statePath, {
        roundStats,
        machineStatus,
        // v3.4: derived active contract — the Current Task's source of truth.
        roundContract: activeContract,
        // v3.8: the verification view of that contract, its derived sub-goal
        // facts, and the static capability — all derived, all in the hash.
        contractItemStatuses,
        verifiedSubGoals,
    });
    const markdown = renderCanonicalStateMarkdown(state, {
        // v3.7.1: retry attempts are marked in the derived view (attempt is
        // request context, not a committed fact). The Recovery Brief renders in
        // the Recent tier only while a committed backtrack decision is this
        // round's record; the redo commit removes it by construction.
        attempt: request.attempt,
        recoveryBrief: committedBacktrackBrief(request.loop_id, request.round, context),
    });
    // v2.4–v2.5: Adaptive L2 budget — scales with loop complexity
    const adaptiveL2 = policy.prompt.l2_adaptive_enabled
        ? Math.min(policy.prompt.l2_max_chars
            + (request.round * policy.prompt.l2_adaptive_round_factor)
            + ((rolling?.milestones?.length ?? 0) * policy.prompt.l2_adaptive_milestone_factor)
            + (subGoals.length * policy.prompt.l2_adaptive_subgoal_factor), policy.prompt.l2_adaptive_max_chars)
        : policy.prompt.l2_max_chars;
    // v2.8: L2 pointer mode — when enabled, skip the monolithic markdown blob.
    // Structured L2 sections (milestones, sub-goals, trust, progress) still
    // render. The state file on disk is the durable source of truth.
    // L7: pointer mode REQUIRES the file — with state_file disabled it would
    // silently drop the full state from L2 prompts and point at nothing.
    const l2Pointer = policy.state_file.enabled &&
        policy.prompt.l2_pointer_enabled && decision.level === "l2";
    const artifact = assemblePromptArtifact({
        state,
        level: decision.level,
        reasons: decision.reasons,
        budgets: {
            l0: policy.prompt.l0_max_chars,
            l1: policy.prompt.l1_max_chars,
            l2: adaptiveL2,
        },
        attempt: request.attempt,
        selfEvaluationBlock: buildSelfEvalBlock(request.round, decision.level,
        // v3.4: restate the contract only when this prompt's Current Task IS
        // the ACTIVE contract (derived — not the previous submission's field,
        // which is a proposal and may differ from what this round executes).
        activeContract != null,
        // v3.5: L2-only declaration nudge when nothing is active (policy-gated;
        // mutually exclusive with the restate template above).
        decision.level === "l2" && activeContract === null &&
            getPolicy().prompt.contract_nudge_on_l2),
        fullStateMarkdown: l2Pointer ? undefined : markdown,
        // v2.9: Model's information needs from the previous round's SelfEvaluation
        promptRequests: request.last_round_result?.prompt_requests,
        // v3.2: Previous L1 presentation as the collapse diff baseline.
        presentedBaseline: readPresentedBaseline(request.loop_id, request.round, context),
    });
    response.prompt = artifact.renderedPrompt;
    response.prompt_artifact = artifact;
    response.state_file_content = policy.state_file.enabled ? markdown : undefined;
    return response;
}
//# sourceMappingURL=loop-compiler.js.map