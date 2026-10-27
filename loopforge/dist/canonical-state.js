/** Canonical cognitive state used to render both prompts and state projections.
 *
 * The canonical state is data, not Markdown. Prompt and state-file renderers
 * consume the same value so they cannot silently drift apart.
 */
import { createHash } from "node:crypto";
import { deriveCriterionId, deriveItemId, normalizeText, STABLE_ID_RE, unique, uniqueNormalized, } from "./token-utils.js";
import { claimedMetCriteria, claimedRemainingCriteria } from "./self-eval.js";
import { getPolicy } from "./policy.js";
import { deriveConfiguredCapability } from "./policy.js";
import { formatWorkingMemoryState, hasWorkingMemoryContent, } from "./working-memory.js";
export const CANONICAL_STATE_SCHEMA_VERSION = 6;
/** v3.7.1: Presentation view of sub-goals shared by prompts and the state
 *  file (one derivation, no second copy). Only ACTIVE items render as rows
 *  — pending/in_progress/blocked — ordered blocked → in_progress → pending
 *  (priority ascending, then most recently changed first) and trimmed to
 *  `cap`. done/canceled never render as items: they stay in the vault, in
 *  replay, and in these counts. */
export function activeSubGoalView(subGoals, cap) {
    const rank = (s) => s.status === "blocked" ? 0 : s.status === "in_progress" ? 1 : 2;
    const active = subGoals
        .filter((s) => s.status !== "done" && s.status !== "canceled")
        .sort((a, b) => rank(a) - rank(b) ||
        a.priority - b.priority ||
        b.status_changed_at_round - a.status_changed_at_round ||
        (a.id < b.id ? -1 : 1));
    return {
        active: active.slice(0, cap),
        activeTotal: active.length,
        done: subGoals.filter((s) => s.status === "done").length,
        canceled: subGoals.filter((s) => s.status === "canceled").length,
        total: subGoals.length,
    };
}
export function partitionActiveConstraints(state) {
    const criteriaKeys = new Set(state.successCriteria.map((text) => normalizeText(text)));
    const hardKeys = new Set(state.hardConstraints.map((text) => normalizeText(text)));
    const hard = [];
    const other = [];
    for (const text of state.activeConstraints) {
        const key = normalizeText(text);
        if (criteriaKeys.has(key))
            continue;
        if (hardKeys.has(key))
            hard.push(text);
        else
            other.push(text);
    }
    return { criteria: [...state.successCriteria], hard, other };
}
function criterionIcon(status) {
    switch (status) {
        case "verified": return "✅";
        case "claimed": return "🟡";
        case "insufficient": return "🟠";
        case "contradicted": return "⛔";
        case "remaining": return "⬜";
        default: return "❔";
    }
}
/** v3.9.4: the ONE criterion row renderer for the normative prompt section.
 *  It consumes the same `successCriteria`/`criterionStatuses` pair the state
 *  file and submission boundary use, and reports the exact ids it emitted so
 *  prompt coverage can prove them. */
export function formatCriterionRows(statuses, successCriteria) {
    const byText = new Map(statuses.map((status) => [normalizeText(status.text), status]));
    const seen = new Set();
    const lines = [];
    const ids = [];
    for (const text of successCriteria) {
        const status = byText.get(normalizeText(text));
        const id = status?.id ?? deriveCriterionId(text);
        if (seen.has(id))
            continue;
        seen.add(id);
        ids.push(id);
        lines.push(`- ${criterionIcon(status?.status ?? "unknown")} [\`${id}\`] ${text}`);
    }
    return { lines, ids };
}
/** v3.9.4: the ONE active-sub-goal formatter shared by the prompt and the
 *  state file. Rows past `cap` lose their descriptions but NEVER their ids:
 *  the overflow line lists every remaining `sg-*`. */
export function formatActiveSubGoals(subGoals, round, cap = getPolicy().evolution.max_active_subgoals) {
    const view = activeSubGoalView([...subGoals], Number.POSITIVE_INFINITY);
    const visible = view.active;
    const shown = visible.slice(0, Math.max(0, cap));
    const hidden = visible.slice(shown.length);
    const lines = [];
    for (const sg of shown) {
        const statusIcon = sg.status === "in_progress" ? "🔄" :
            sg.status === "blocked" ? "🚫" : "⏳";
        const stale = sg.status === "pending" &&
            round - sg.declared_at_round >= 10 ? " ⚠️ stale" : "";
        const detail = sg.status === "in_progress"
            ? ` (since R${sg.status_changed_at_round})`
            : sg.status === "pending"
                ? ` (since R${sg.declared_at_round})`
                : ` (blocked R${sg.status_changed_at_round})`;
        lines.push(`- ${statusIcon} [\`${sg.id}\`] ${sg.description}${detail}${stale}`);
    }
    if (hidden.length > 0) {
        lines.push(`- also active (ids only): ${hidden.map((sg) => `\`${sg.id}\``).join(", ")}`);
    }
    lines.push(`> ${view.total} total · ${view.activeTotal} active · ` +
        `${view.done} done · ${view.canceled} canceled`);
    return { lines, ids: visible.map((sg) => sg.id) };
}
// unique() imported from token-utils.ts
/** Deterministic JSON serialization used by state and prompt hashes. */
export function stableStringify(value) {
    if (value === null || typeof value !== "object") {
        return JSON.stringify(value);
    }
    if (Array.isArray(value)) {
        return `[${value.map((item) => stableStringify(item)).join(",")}]`;
    }
    const record = value;
    const keys = Object.keys(record).sort();
    return `{${keys.map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`).join(",")}}`;
}
export function hashCanonicalState(state) {
    return createHash("sha256").update(stableStringify(state)).digest("hex");
}
/** v3.8.1: how many recurring flags the state file lists before folding the
 *  rest into a count. The prompt keeps its own, smaller cap (Active Warnings)
 *  over a different slice of the same list. */
const RECURRING_RENDER_CAP = 8;
/** v3.8.1: the state file's recurring slice — only facts that actually
 *  RECURRED (present in >= 2 rounds). The prompt shows the recent tail
 *  instead; both read the same `RecurringFlag` list. */
function recurringOnly(flags) {
    return flags.filter((flag) => flag.rounds.length >= 2);
}
function addList(lines, title, values) {
    if (values.length === 0)
        return;
    lines.push(`## ${title}`, "");
    for (const value of values)
        lines.push(`- ${value}`);
    lines.push("");
}
/** v2.11: Derive a stable 8-char hex ID from text using SHA-256.
 *  Same hash strategy as computeGoalTextHash in loop-compiler.ts. */
/** v2.11: Render a list with ID prefixes. Each item gets a
 *  [prefix-XXXXXXXX] tag derived from its text hash. Items that already look
 *  like IDs (e.g. "cr-a3f2b1c0") are rendered as-is.
 *  v3.8.1: IDs are always rendered — the `constraint_id_enabled` escape hatch
 *  was deleted (it never switched the MATCHING strategy, only the rendering,
 *  so it could only ever produce a prompt whose items the agent could not
 *  name). */
function addListWithIds(lines, title, values, prefix) {
    if (values.length === 0)
        return;
    lines.push(`## ${title}`, "");
    for (const value of values) {
        const trimmed = value.trim();
        if (!trimmed)
            continue;
        // If the value is already an ID, render it as-is
        if (STABLE_ID_RE.test(trimmed)) {
            lines.push(`- [\`${trimmed}\`] ${trimmed}`);
        }
        else {
            lines.push(`- [\`${prefix}-${deriveItemId(trimmed)}\`] ${trimmed}`);
        }
    }
    lines.push("");
}
/** v3.3.1: Identity-aware variant of addListWithIds for the merged active
 *  constraint set (hard/plan/criteria/discovered texts together). Each
 *  item's ID comes from constraint metadata — criteria texts keep their
 *  cr-XXXXXXXX identity, matching the Success Criteria section and the
 *  verification gate's ID-first criterion matching. Keeps the state file in
 *  the same identity namespace as the prompts (module contract: both
 *  renderers cannot drift apart). */
function addListWithIdentities(lines, title, values, metadata) {
    if (values.length === 0)
        return;
    const metaByText = new Map(metadata.map((meta) => [meta.text, meta]));
    lines.push(`## ${title}`, "");
    for (const value of values) {
        const trimmed = value.trim();
        if (!trimmed)
            continue;
        const meta = metaByText.get(trimmed);
        if (STABLE_ID_RE.test(trimmed)) {
            lines.push(`- [\`${trimmed}\`] ${trimmed}`);
        }
        else {
            const id = meta?.id ?? `c-${deriveItemId(trimmed)}`;
            const provenance = constraintProvenanceLabel(meta);
            lines.push(`- [\`${id}\`] ${trimmed}${provenance}`);
        }
    }
    lines.push("");
}
/** v3.9.7: the ONE constraint provenance label shared by the state file and
 *  the prompt. A discovered/preserved constraint is an Agent report, never a
 *  machine-verified fact. */
export function constraintProvenanceLabel(meta) {
    if (!meta)
        return "";
    const round = meta.source_round !== undefined && meta.source_round >= 1
        ? ` R${meta.source_round}`
        : "";
    switch (meta.source) {
        case "discovered":
            return ` (Agent-declared${round}; report, not machine-verified)`;
        case "preserved":
            return ` (Agent discovery preserved by rollback${round}; report)`;
        case "plan":
            return ` (plan/carried${round})`;
        case "unrecorded":
            return " (origin not recorded in committed rounds)";
        default:
            return "";
    }
}
export function formatRoundContractWithIds(contract,
/** v3.8: the derived item statuses. When given, each item renders with its
 *  machine status — the agent sees the verification debt in its own task. */
statuses) {
    const lines = [];
    const emittedIds = [contract.id];
    const heading = contract.work_item?.trim();
    lines.push(`**${heading || "Round Contract"}** (${contract.id})`);
    const statusById = new Map((statuses?.items ?? []).map((item) => [item.itemId, item]));
    const items = contract.items;
    if (items.length > 0) {
        lines.push("- Acceptance conditions:");
    }
    for (const item of items) {
        emittedIds.push(item.id);
        const machine = statusById.get(item.id);
        const mark = machine?.status === "verified" ? "✅"
            : machine?.status === "insufficient" ? "🟠"
                : machine?.status === "contradicted" ? "⛔"
                    : machine?.status === "pending" ? "⬜"
                        : "";
        const status = machine ? ` — ${machine.status}` : "";
        lines.push(`  - ${mark ? `${mark} ` : ""}[\`${item.id}\`] ${item.description}${status}`);
        if (item.verify_with.length > 0) {
            lines.push(`    - Verify via: ${item.verify_with.join(", ")}`);
        }
        if (item.criterion_refs.length > 0) {
            lines.push(`    - Criteria: ${item.criterion_refs.join(", ")}`);
        }
        if (machine?.reasons.length) {
            lines.push(`    - Unverified because: ${machine.reasons[0]}`);
        }
    }
    if (contract.scope.length > 0) {
        // v3.9.9: scope is the Agent's declared intent, not a permission.
        lines.push("- Declared scope (Agent report; not enforced):");
        for (const entry of contract.scope) {
            lines.push(`  - ${entry}`);
        }
    }
    return { text: lines.join("\n"), emittedIds };
}
/** Backwards-compatible text-only view used by the state file. */
export function formatRoundContract(contract, statuses) {
    return formatRoundContractWithIds(contract, statuses).text;
}
const STATE_SECTION_TIER = {
    // Current — what the next round must hold in working memory.
    "Loop Objective": "Current",
    "Current Task": "Current",
    "Success Criteria": "Current",
    "Hard Constraints": "Current",
    "Active Constraints": "Current",
    Remaining: "Current",
    Blockers: "Current",
    "Sub-Goal Dashboard": "Current",
    // v3.8.1: the one-line phase position (the only fact the deleted Roadmap
    // section carried that no other section renders). It is orientation for the
    // NEXT round, so it belongs with the working-memory tier — and it must be
    // listed here at all: an unlisted title is not a heading, so `## Phase` was
    // absorbed into whatever section happened to precede it (its body even kept
    // a raw `## ` line) and inherited that section's tier.
    // Recent — this round's boundary facts (and, in a recovery window, the
    // derived Recovery Brief injected at the top of this tier).
    "Progress Dashboard": "Recent",
    Verification: "Recent",
    // v4.0.2: bounded committed working memory. It replaces the former
    // Corrections/Discoveries sections; discovered constraints remain visible
    // through active-constraint provenance.
    "Working Memory": "Recent",
    // Historical Summary — the loop's memory skeleton, kept under existing
    // milestone/window caps.
    "Goal → Criteria": "Historical Summary",
    "Recurring Flags": "Historical Summary",
    "Retired Constraints": "Historical Summary",
};
const STATE_TIER_ORDER = ["Current", "Recent", "Historical Summary"];
/** Human/Agent-readable materialized view. It is always reproducible from the
 *  canonical state and is never consulted as transaction truth.
 *
 *  v3.8.1: this is where the diagnostics live — the progress dashboard, the
 *  criterion list, round stats, the FULL recurring-flag history and the phase
 *  history. The prompt carries only what the next round needs. */
export function renderCanonicalStateMarkdown(state, options) {
    const preamble = [
        `# LoopForge State — ${state.loopId}`,
        "",
        `**Schema**: ${state.schemaVersion}`,
        `**Round**: ${state.round}/${state.maxRounds}`,
        `**Goal ID**: ${state.goalId}`,
        "**Derived**: true",
        `**Source**: round ${state.round} (attempt ${options?.attempt ?? 1})`,
        "**Authority**: committed typed rounds are the factual source; this file is a derived view.",
        "**Agent reports**: summaries below are claims, not machine evidence.",
        "**Working memory**: recent committed reports only; older history via replay/explain.",
        `**State hash**: ${hashCanonicalState(state).slice(0, 12)}`,
        "",
    ];
    const sections = flatStateSections(state);
    const recoveryBrief = state.recoveryBrief ?? options?.recoveryBrief;
    if (recoveryBrief && recoveryBrief.length > 0) {
        sections.unshift({ title: "Recovery Brief", body: recoveryBrief });
    }
    const byTier = new Map();
    for (const tier of STATE_TIER_ORDER)
        byTier.set(tier, []);
    for (const section of sections) {
        const tier = STATE_SECTION_TIER[section.title] ?? "Recent";
        byTier.get(tier).push(section);
    }
    const out = [...preamble];
    for (const tier of STATE_TIER_ORDER) {
        const tierSections = byTier.get(tier);
        if (tierSections.length === 0)
            continue;
        out.push(`## ${tier}`, "");
        for (const section of tierSections) {
            out.push(`### ${section.title}`, "");
            for (const line of section.body)
                out.push(line);
            out.push("");
        }
    }
    return out.join("\n").trimEnd() + "\n";
}
/** Render the flat section list (title + body) that the tier wrapper
 *  groups. Each builder keeps its original heading text; only the heading
 *  level is demoted by the wrapper. */
function flatStateSections(state) {
    const lines = [];
    lines.push("## Loop Objective", "", state.objective, "", "## Current Task", "", state.currentTask);
    // v2.11: Success Criteria and Constraints render with stable IDs for exact
    // agent matching. v3.9.4: the three groups are the SAME mutually exclusive
    // partition the prompt uses, so one text never appears with two prefixes.
    const constraintPartition = partitionActiveConstraints(state);
    addListWithIds(lines, "Success Criteria", constraintPartition.criteria, "cr");
    addListWithIdentities(lines, "Hard Constraints", constraintPartition.hard, state.constraintMetadata);
    addListWithIdentities(lines, "Active Constraints", constraintPartition.other, state.constraintMetadata);
    if (hasWorkingMemoryContent(state.workingMemory)) {
        lines.push("## Working Memory", "", ...formatWorkingMemoryState(state.workingMemory), "");
    }
    if (state.progress.criteriaMet.length > 0 ||
        state.progress.criteriaRemaining.length > 0 ||
        state.progress.filesChanged.length > 0 ||
        state.progress.tests !== null ||
        state.machineStatus !== undefined) {
        const total = state.progress.criteriaMet.length + state.progress.criteriaRemaining.length;
        lines.push("## Progress Dashboard", "");
        if (total > 0) {
            lines.push(`**Criteria**: ${state.progress.criteriaMet.length}/${total}`);
        }
        // v3.3: machine side of the comparison — git motion over committed rounds
        // (v3.6: the object always carries definite values — no "unavailable" arm).
        if (state.machineStatus) {
            const ms = state.machineStatus;
            const providers = ms.providers.length > 0
                ? ` (providers: ${ms.providers.join(", ")})`
                : "";
            const progress = ms.machineProgress === "changed"
                ? `changes observed in ${ms.changedRounds}/${ms.windowRounds} recent committed rounds${providers}`
                : ms.machineProgress === "unknown"
                    ? `not observable in the last ${ms.windowRounds} committed rounds${providers}`
                    : `no machine-observed progress in the last ${ms.windowRounds} committed rounds${providers}`;
            lines.push(`**Machine progress**: ${progress}`);
        }
        if (state.criterionStatuses.length > 0) {
            const metCount = state.criterionStatuses.filter((cs) => cs.status === "verified" || cs.status === "claimed").length;
            lines.push(`**Machine (criteria)**: ${metCount}/${state.criterionStatuses.length} met across committed rounds`);
        }
        if (state.progress.tests) {
            lines.push(`**Tests**: ${state.progress.tests.passed} passed, ` +
                `${state.progress.tests.failed} failed, ${state.progress.tests.skipped} skipped`);
        }
        if (state.progress.filesChanged.length > 0) {
            lines.push("", "**Files Changed**:");
            for (const file of state.progress.filesChanged)
                lines.push(`- ${file}`);
        }
        lines.push("");
    }
    // v3.2: Goal → criteria → evidence vertical view. IDs are always rendered.
    if (state.criterionStatuses.length > 0) {
        lines.push("## Goal → Criteria", "");
        for (const cs of state.criterionStatuses) {
            const icon = cs.status === "verified" ? "✅"
                : cs.status === "claimed" ? "🟡"
                    : cs.status === "insufficient" ? "🟠"
                        : cs.status === "contradicted" ? "⛔"
                            : cs.status === "remaining" ? "⬜" : "❔";
            const idTag = ` [\`${cs.id}\`]`;
            const met = cs.met_at_round !== undefined ? ` (met R${cs.met_at_round})` : "";
            lines.push(`- ${icon}${idTag} ${cs.text}${met}`);
        }
        lines.push("");
    }
    addListWithIds(lines, "Remaining", state.remainingCriteria, "cr");
    addList(lines, "Blockers", state.blockers);
    const recurring = recurringOnly(state.recurringFlags);
    // v3.8.1: ONE recurring-facts section. "Recurring Issues" (the last 5
    // rounds' raw violations, no threshold) and "Lessons Learned" (the whole
    // history, count >= 2) were two windows over one fact set rendered as two
    // headings. The state file keeps the genuinely recurring set; the prompt
    // shows the recent tail of the same derivation.
    if (recurring.length > 0) {
        lines.push("## Recurring Flags", "");
        for (const flag of recurring.slice(0, RECURRING_RENDER_CAP)) {
            const icon = flag.kind === "constraint_violation"
                ? "🚫"
                : flag.kind === "verification_error" ? "⚠️" : "ℹ️";
            const subject = flag.ref ? `${flag.subject} [${flag.ref}]` : flag.subject;
            lines.push(`- ${icon} ${subject} — ${flag.count}× (R${flag.rounds.join(", R")})`);
        }
        if (recurring.length > RECURRING_RENDER_CAP) {
            lines.push(`- ... and ${recurring.length - RECURRING_RENDER_CAP} more`);
        }
        lines.push("");
    }
    addList(lines, "Retired Constraints", state.retiredConstraints);
    if (state.verificationFlags.length > 0) {
        lines.push("## Verification", "");
        for (const flag of state.verificationFlags) {
            lines.push(`- [${flag.severity}] [${flag.check}] \`${flag.field}\` — ${flag.detail}` +
                (flag.ref ? ` [ref: \`${flag.ref}\`]` : ""));
        }
        lines.push("");
    }
    if (state.subGoals.length > 0) {
        // v3.9.4: the SAME formatter the prompt uses. Rows past the display cap
        // keep their ids in an overflow line, so the state file's active id set
        // can never be narrower than the prompt's.
        // L8: the heading is emitted whenever sub-goals exist — with every
        // sub-goal terminal (0 active rows) the counts line must still live
        // under its own section instead of leaking into the previous one.
        lines.push("## Sub-Goal Dashboard", "");
        lines.push(...formatActiveSubGoals(state.subGoals, state.round).lines, "");
    }
    // Split the flat markdown into titled sections for tier grouping. Every
    // builder above emits `## <Title>` headings over their content — but only
    // the KNOWN section titles are headings. Free-text bodies (objective,
    // external context, milestone outcomes) may contain their own markdown
    // lines starting with "## "; splitting on any such line would cut the
    // body into a phantom section and re-tier everything that follows.
    const knownSectionTitles = new Set([
        ...Object.keys(STATE_SECTION_TIER),
        "Recovery Brief",
    ]);
    const sections = [];
    let current = null;
    let inBody = false;
    for (const line of lines) {
        const heading = /^## (.+)$/.exec(line);
        if (heading && knownSectionTitles.has(heading[1])) {
            current = { title: heading[1], body: [] };
            sections.push(current);
            inBody = false;
            continue;
        }
        if (!current)
            continue;
        if (!inBody) {
            if (line.trim() === "")
                continue; // drop leading blanks after the heading
            inBody = true;
        }
        current.body.push(line);
    }
    for (const section of sections) {
        while (section.body.length > 0 && section.body[section.body.length - 1] === "") {
            section.body.pop();
        }
    }
    return sections;
}
export function createCanonicalLoopState(request, response, stateFilePath,
/** v3.3: Display-only derived data. Optional 4th param — callers that
 *  predate v3.3 stay on 3-arg calls. */
derived) {
    const last = derived?.previousRound?.result ?? null;
    const objective = response.loop_objective;
    const verificationFlags = derived?.previousRound?.verificationFlags ??
        request.verification_flags ?? [];
    // v3.9.5: only committed previous-round reports enter the projection. The
    // compiler no longer has an uncommitted fallback at all.
    const committed = derived?.previousRound?.committed === true;
    // Keep the report projection behind the same boundary as corrections and
    // blockers.  The fallback result may still be consumed by compiler
    // evolution, but an uncommitted/rejected attempt cannot become durable
    // progress, discovery, or criterion state.
    const executionReport = committed ? last?.execution_report : undefined;
    const blockers = unique([
        ...(committed ? (last?.constraint_violations ?? []) : []),
        ...response.warnings,
    ]);
    // v3.4: The ACTIVE Round Contract (derived — loop-compiler computes it
    // from committed rounds) drives the Current Task — the contract IS "what
    // to do this round"; the original objective stays in the Objective
    // section above. No active contract → the original task text is used,
    // byte-identical to pre-v3.3 behavior.
    const roundContract = derived?.roundFacts?.activeContract ?? null;
    // v3.9.4: the rendered criterion/hard sets are ACTIVE sets. The compile
    // response's `criterion_statuses` is the active criterion reference space
    // (loop-compiler filters it); `constraints_active` is the active constraint
    // set. A direct caller that omits `criterion_statuses` gets the objective
    // fallback so library-level state construction still works.
    const activeConstraints = uniqueNormalized(response.constraints_active);
    const activeConstraintKeys = new Set(activeConstraints.map((text) => normalizeText(text)));
    const observedCompile = response.criterion_statuses !== undefined;
    const successCriteria = observedCompile
        ? uniqueNormalized(response.criterion_statuses.map((criterion) => criterion.text))
        : uniqueNormalized(objective?.success_criteria ?? []);
    const criteriaKeys = new Set(successCriteria.map((text) => normalizeText(text)));
    const hardConstraints = uniqueNormalized(objective?.hard_constraints ?? [])
        .filter((text) => {
        const key = normalizeText(text);
        return !criteriaKeys.has(key) &&
            (!observedCompile || activeConstraintKeys.has(key));
    });
    return {
        schemaVersion: CANONICAL_STATE_SCHEMA_VERSION,
        loopId: response.loop_id || request.loop_id,
        round: response.round || request.round,
        maxRounds: request.max_rounds ?? getPolicy().engine.max_rounds,
        goalId: response.goal_id,
        objective: objective?.objective || request.task,
        currentTask: roundContract
            ? formatRoundContract(roundContract, derived?.roundFacts?.itemStatuses ?? null)
            : request.task,
        successCriteria,
        hardConstraints,
        activeConstraints,
        retiredConstraints: unique(response.constraints_retired),
        constraintMetadata: response.constraint_metadata ?? [],
        rejectionNotice: request.rejection_notice.trim() ? request.rejection_notice : null,
        remainingCriteria: unique(claimedRemainingCriteria(executionReport)),
        blockers,
        verificationFlags,
        // v4.0.2: conditional presence — no committed working memory, no key.
        ...(hasWorkingMemoryContent(derived?.workingMemory)
            ? { workingMemory: derived.workingMemory }
            : {}),
        subGoals: response.sub_goals ?? [],
        criterionStatuses: response.criterion_statuses ?? [],
        recurringFlags: response.recurring_flags ?? [],
        stateFilePath,
        progress: {
            criteriaMet: unique(claimedMetCriteria(executionReport)),
            criteriaRemaining: unique(claimedRemainingCriteria(executionReport)),
            filesChanged: unique(executionReport?.files_changed ?? []),
            tests: executionReport?.tests_reported ?? null,
        },
        // v3.3: Conditional presence — empty/absent derived data must not add
        // keys, or every state hash would change for rounds without it.
        ...(derived?.recoveryBrief && derived.recoveryBrief.length > 0
            ? { recoveryBrief: [...derived.recoveryBrief] }
            : {}),
        ...(derived?.machineStatus ? { machineStatus: derived.machineStatus } : {}),
        // v3.3: Conditional presence — no contract, no key (hash stability).
        ...(roundContract ? { roundContract } : {}),
        ...(derived?.roundFacts?.itemStatuses
            ? { contractItemStatuses: derived.roundFacts.itemStatuses }
            : {}),
        capability: deriveConfiguredCapability(getPolicy()),
    };
}
//# sourceMappingURL=canonical-state.js.map