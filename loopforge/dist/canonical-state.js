/** Canonical cognitive state used to render both prompts and state projections.
 *
 * The canonical state is data, not Markdown. Prompt and state-file renderers
 * consume the same value so they cannot silently drift apart.
 */
import { createHash } from "node:crypto";
import { deriveItemId, STABLE_ID_RE, unique } from "./token-utils.js";
import { claimedMetCriteria, claimedRemainingCriteria } from "./self-eval.js";
import { getPolicy } from "./policy.js";
import { deriveConfiguredCapability } from "./policy.js";
export const CANONICAL_STATE_SCHEMA_VERSION = 1;
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
    const idByText = new Map(metadata.map((meta) => [meta.text, meta.id]));
    lines.push(`## ${title}`, "");
    for (const value of values) {
        const trimmed = value.trim();
        if (!trimmed)
            continue;
        if (STABLE_ID_RE.test(trimmed)) {
            lines.push(`- [\`${trimmed}\`] ${trimmed}`);
        }
        else {
            const id = idByText.get(trimmed) ?? `c-${deriveItemId(trimmed)}`;
            lines.push(`- [\`${id}\`] ${trimmed}`);
        }
    }
    lines.push("");
}
/** v3.8.1: the one-line phase position — which phase the loop is in, and how
 *  far the next boundary is.
 *
 *  This is all that survives of v3.3's "roadmap": of its four lines, three
 *  (met/remaining criteria with ids, sub-goal activity) were already rendered
 *  in full by the sections that own them. Returns "" when no milestone exists,
 *  so the caller renders no section at all — bare position is already in the
 *  prompt header.
 *
 *  Shared by the state-file and prompt renderers so they cannot drift apart
 *  (module contract above). Presentation only; never feeds enforcement. */
export function buildPhaseLine(state) {
    const lastMilestone = state.milestones.length > 0
        ? state.milestones[state.milestones.length - 1]
        : null;
    // No phase boundary yet → no phase to report. Position alone ("round 3/200")
    // is already in the prompt header, so rendering it again would be noise.
    if (!lastMilestone)
        return "";
    const roundsSince = lastMilestone.round_range.end <= state.round
        ? state.round - lastMilestone.round_range.end
        : null;
    const parts = [
        `phase "${lastMilestone.label}"`,
        `round ${state.round}/${state.maxRounds}`,
    ];
    if (roundsSince !== null) {
        parts.push(`${roundsSince} round${roundsSince === 1 ? "" : "s"} since the last boundary`);
    }
    return parts.join(" · ");
}
/** v3.3/v3.4: Render the ACTIVE Round Contract as the Current Task section
 *  body — the single formatting source shared by prompts and the state
 *  file (module contract above). The original objective is NOT here: it
 *  lives in the Objective section. Empty arrays render no line. */
export function formatRoundContract(contract,
/** v3.8: the derived item statuses. When given, each item renders with its
 *  machine status — the agent sees the verification debt in its own task. */
statuses) {
    const lines = [];
    const heading = contract.work_item?.trim();
    lines.push(`**${heading || "Round Contract"}** (${contract.id})`);
    const statusById = new Map((statuses?.items ?? []).map((item) => [item.itemId, item]));
    for (const item of contract.items) {
        const machine = statusById.get(item.id);
        const mark = machine?.status === "verified" ? "✅"
            : machine?.status === "insufficient" ? "🟠"
                : machine?.status === "contradicted" ? "⛔"
                    : machine?.status === "pending" ? "⬜"
                        : "";
        lines.push(`- ${mark ? `${mark} ` : ""}[\`${item.id}\`] ${item.description}${machine ? ` — ${machine.status}` : ""}`);
        if (item.verify_with.length > 0) {
            lines.push(`  - Verify via: ${item.verify_with.join(", ")}`);
        }
        if (item.criterion_refs.length > 0) {
            lines.push(`  - Criteria: ${item.criterion_refs.join(", ")}`);
        }
        if (machine?.reasons.length) {
            lines.push(`  - Unverified because: ${machine.reasons[0]}`);
        }
    }
    for (const entry of contract.scope) {
        lines.push(`- Scope: ${entry}`);
    }
    return lines.join("\n");
}
// ═══════════════════════════════════════════════════════════════════════════
// v3.3.1: Shared presentation atoms
// ═══════════════════════════════════════════════════════════════════════════
/** Milestone heading line ("**🏁 Round 7** (Rounds 3–7, 60%)"). Shared by the
 *  L2 Phase History and the detailed L1 renderer; the L1 copy previously
 *  rendered the range as "R3–R7", a format only this heading used. */
export function milestoneHeading(milestone) {
    const kindIcon = milestone.kind === "agent_declared"
        ? "🏁"
        : milestone.kind === "criteria_milestone" ? "✅" : "📍";
    return `**${kindIcon} ${milestone.label}** (Rounds ${milestone.round_range.start}–${milestone.round_range.end}, ${(milestone.progress_at_boundary * 100).toFixed(0)}%)`;
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
    "External Context": "Current",
    // Recent — this round's boundary facts (and, in a recovery window, the
    // derived Recovery Brief injected at the top of this tier).
    "Progress Dashboard": "Recent",
    Verification: "Recent",
    "Changes Since Last Round": "Recent",
    Discoveries: "Recent",
    // Historical Summary — the loop's memory skeleton, kept under existing
    // milestone/window caps.
    "Goal → Criteria": "Historical Summary",
    "Cross-Round Outcomes": "Historical Summary",
    "Recurring Flags": "Historical Summary",
    "Failed Patterns": "Historical Summary",
    "Retired Constraints": "Historical Summary",
    "Phase History": "Historical Summary",
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
        `**State hash**: ${hashCanonicalState(state).slice(0, 12)}`,
        "",
    ];
    const sections = flatStateSections(state);
    if (options?.recoveryBrief && options.recoveryBrief.length > 0) {
        sections.unshift({ title: "Recovery Brief", body: options.recoveryBrief });
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
    // v2.11: Success Criteria and Constraints render with stable IDs for exact agent matching
    addListWithIds(lines, "Success Criteria", state.successCriteria, "cr");
    addListWithIds(lines, "Hard Constraints", state.hardConstraints, "c");
    addListWithIdentities(lines, "Active Constraints", state.activeConstraints, state.constraintMetadata);
    addList(lines, "Changes Since Last Round", state.changesSinceLastRound);
    if (state.progress.estimate !== null ||
        state.progress.criteriaMet.length > 0 ||
        state.progress.criteriaRemaining.length > 0 ||
        state.progress.filesChanged.length > 0 ||
        state.progress.tests !== null ||
        state.machineStatus !== undefined) {
        const total = state.progress.criteriaMet.length + state.progress.criteriaRemaining.length;
        lines.push("## Progress Dashboard", "");
        if (total > 0) {
            lines.push(`**Criteria**: ${state.progress.criteriaMet.length}/${total}`);
        }
        if (state.progress.estimate !== null) {
            lines.push(`**Estimated Completion**: ${(state.progress.estimate * 100).toFixed(0)}%`);
            // v3.3: honest labeling — the estimate is the agent's own number.
            lines.push("**Signal source**: self-reported estimate (unverified until machine-backed)");
        }
        // v3.3: machine side of the comparison — git motion over committed rounds
        // (v3.6: the object always carries definite values — no "unavailable" arm).
        if (state.machineStatus) {
            const ms = state.machineStatus;
            const motion = ms.gitMotion
                ? `changes observed in ${ms.motionRounds}/${ms.windowRounds} recent committed rounds`
                : `no git changes in the last ${ms.windowRounds} committed rounds`;
            lines.push(`**Machine (git)**: ${motion}`);
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
            const related = cs.related_subgoal_ids.length > 0
                ? ` (related: ${cs.related_subgoal_ids.join(", ")})`
                : "";
            lines.push(`- ${icon}${idTag} ${cs.text}${met}${related}`);
        }
        lines.push("");
    }
    addListWithIds(lines, "Remaining", state.remainingCriteria, "cr");
    addList(lines, "Blockers", state.blockers);
    const recurring = recurringOnly(state.recurringFlags);
    addList(lines, "Discoveries", state.discoveries);
    addList(lines, "Cross-Round Outcomes", state.rollingOutcomes);
    addList(lines, "Failed Patterns", state.failedPatterns);
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
    // v3.8.1: the Roadmap section is gone. Only its non-duplicated fact — the
    // phase position — survives, as the one-line phase line the prompts render.
    const phaseLine = buildPhaseLine(state);
    if (phaseLine) {
        lines.push("## Phase", "", `- ${phaseLine}`);
        lines.push("");
    }
    if (state.verificationFlags.length > 0) {
        lines.push("## Verification", "");
        for (const flag of state.verificationFlags) {
            lines.push(`- [${flag.severity}] [${flag.check}] ${flag.detail}`);
        }
        lines.push("");
    }
    if (state.milestones.length > 0) {
        lines.push("## Phase History", "");
        for (const m of state.milestones) {
            const kindIcon = m.kind === "agent_declared"
                ? "🏁"
                : m.kind === "criteria_milestone" ? "✅" : "📍";
            lines.push(`### ${kindIcon} ${m.label}`, `Rounds ${m.round_range.start}–${m.round_range.end} | ` +
                `Progress: ${(m.progress_at_boundary * 100).toFixed(0)}%`, "", `**Outcome**: ${m.outcome}`, "");
            if (m.carried_constraints.length > 0) {
                lines.push("**Carried Constraints**:");
                for (const c of m.carried_constraints)
                    lines.push(`- ${c}`);
                lines.push("");
            }
            if (m.resolved_constraints.length > 0) {
                lines.push("**Resolved During Phase**:");
                for (const c of m.resolved_constraints)
                    lines.push(`- ${c}`);
                lines.push("");
            }
        }
    }
    if (state.subGoals.length > 0) {
        // v3.7.1: only ACTIVE items render as rows; done/canceled survive in
        // the vault, replay, and the counts line below.
        const cap = getPolicy().evolution.max_active_subgoals;
        const view = activeSubGoalView(state.subGoals, cap);
        // L8: the heading is emitted whenever sub-goals exist — with every
        // sub-goal terminal (0 active rows) the counts line must still live
        // under its own section instead of leaking into the previous one.
        lines.push("## Sub-Goal Dashboard", "");
        if (view.active.length > 0) {
            for (const sg of view.active) {
                const statusIcon = sg.status === "in_progress" ? "🔄" :
                    sg.status === "blocked" ? "🚫" : "⏳";
                const stale = sg.status === "pending" &&
                    state.round - sg.declared_at_round >= 10 ? " ⚠️ stale" : "";
                const detail = sg.status === "in_progress"
                    ? ` (since R${sg.status_changed_at_round})`
                    : sg.status === "pending"
                        ? ` (since R${sg.declared_at_round})`
                        : ` (blocked R${sg.status_changed_at_round})`;
                lines.push(`- ${statusIcon} [\`${sg.id}\`] ${sg.description}${detail}${stale}`);
            }
            lines.push("");
        }
        lines.push(`> ${view.total} total · ${view.activeTotal} active · ` +
            `${view.done} done · ${view.canceled} canceled`, "");
    }
    if (state.externalContext) {
        lines.push("## External Context", "", state.externalContext, "");
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
    const last = request.last_round_result;
    const objective = response.loop_objective;
    const verificationFlags = request.verification_flags ?? [];
    const rolling = response.rolling_summary;
    const executionReport = last?.execution_report;
    const changes = unique([
        request.new_since_last_round,
        last?.output_summary,
        ...(last?.wrong_assumptions ?? []).map((value) => `Corrected assumption: ${value}`),
    ]);
    const discoveries = unique([
        ...(last?.discovered_constraints ?? []),
        ...(last?.emerged_subtasks ?? []),
    ]);
    const blockers = unique([
        ...(last?.constraint_violations ?? []),
        last?.manual_fixes_needed,
        request.rejection_notice,
        ...response.warnings,
    ]);
    // v3.4: The ACTIVE Round Contract (derived — loop-compiler computes it
    // from committed rounds) drives the Current Task — the contract IS "what
    // to do this round"; the original objective stays in the Objective
    // section above. No active contract → the original task text is used,
    // byte-identical to pre-v3.3 behavior.
    const roundContract = derived?.roundFacts?.activeContract ?? null;
    return {
        schemaVersion: CANONICAL_STATE_SCHEMA_VERSION,
        loopId: response.loop_id || request.loop_id,
        round: response.round || request.round,
        maxRounds: request.max_rounds ?? getPolicy().engine.max_rounds,
        goalId: response.goal_id,
        objective: objective?.objective || request.task,
        objectiveVersion: objective?.version ?? 1,
        currentTask: roundContract
            ? formatRoundContract(roundContract, derived?.roundFacts?.itemStatuses ?? null)
            : request.task,
        successCriteria: unique(objective?.success_criteria ?? []),
        hardConstraints: unique(objective?.hard_constraints ?? []),
        activeConstraints: unique(response.constraints_active),
        retiredConstraints: unique(response.constraints_retired),
        constraintMetadata: response.constraint_metadata ?? [],
        changesSinceLastRound: changes,
        remainingCriteria: unique(claimedRemainingCriteria(last?.execution_report)),
        blockers,
        verificationFlags,
        discoveries,
        rollingOutcomes: unique(rolling?.key_outcomes ?? []),
        failedPatterns: unique(rolling?.failed_patterns ?? []),
        milestones: rolling?.milestones ?? [],
        subGoals: response.sub_goals ?? [],
        criterionStatuses: response.criterion_statuses ?? [],
        recurringFlags: response.recurring_flags ?? [],
        externalContext: request.external_context?.trim() ?? "",
        stateFilePath,
        progress: {
            estimate: executionReport?.progress_estimate ?? null,
            criteriaMet: unique(claimedMetCriteria(executionReport)),
            criteriaRemaining: unique(claimedRemainingCriteria(executionReport)),
            filesChanged: unique(executionReport?.files_changed ?? []),
            tests: executionReport?.tests_reported ?? null,
        },
        // v3.3: Conditional presence — empty/absent derived data must not add
        // keys, or every state hash would change for rounds without it.
        ...(derived?.machineStatus ? { machineStatus: derived.machineStatus } : {}),
        // v3.3: Conditional presence — no contract, no key (hash stability).
        ...(roundContract ? { roundContract } : {}),
        ...(derived?.roundFacts?.itemStatuses
            ? { contractItemStatuses: derived.roundFacts.itemStatuses }
            : {}),
        ...(derived?.roundFacts?.verifiedSubGoals &&
            derived.roundFacts.verifiedSubGoals.length > 0
            ? { verifiedSubGoals: [...derived.roundFacts.verifiedSubGoals] }
            : {}),
        capability: deriveConfiguredCapability(getPolicy()),
    };
}
//# sourceMappingURL=canonical-state.js.map