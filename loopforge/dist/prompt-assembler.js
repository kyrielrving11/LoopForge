/** Single-pass renderer for v3 plan and evidence prompts. */
import { createHash } from "node:crypto";
import { formatCompilationContext, hashCanonicalState } from "./canonical-state.js";
import { LOOPFORGE_VERSION } from "./version.js";
export const PROMPT_ARTIFACT_SCHEMA_VERSION = 1;
export const BASE_PROMPT_VERSION = LOOPFORGE_VERSION;
export const DEFAULT_PROMPT_BUDGETS = { l0: 3000, l1: 7000, l2: 18000 };
function section(title, body) {
    return body.trim() ? `### ${title}\n${body.trim()}\n\n` : "";
}
function bullets(values) {
    return values.map((value) => `- ${value}`).join("\n");
}
function coreSections(state) {
    return [
        section("Objective", state.objective),
        section("Assigned Plan Step", formatCompilationContext(state.compilationContext, state.currentTask)),
        section("Hard Constraints", bullets(state.hardConstraints)),
        section("Evidence Gaps", bullets(state.evidence.evidenceGaps)),
        section("Verification Findings", bullets(state.verificationFlags.map((flag) => `[${flag.severity}] ${flag.check}: ${flag.detail}`))),
    ];
}
function detailSections(state, level) {
    if (level === "l0") {
        return [
            section("Retry Delta", bullets([...state.blockers, ...state.changesSinceLastRound])),
        ];
    }
    const common = [
        graphSliceSection(state, level),
        section("Active Constraints", bullets(state.activeConstraints)),
        section("Last Evidence", bullets([
            ...state.evidence.coveredClaims.map((item) => `claim ${item}`),
            ...state.evidence.files.map((item) => `file ${item}`),
            ...state.evidence.checks.map((item) => `check ${item.name}: ${item.status}`),
        ])),
        section("Discoveries", bullets(state.discoveries)),
        section("Recent Outcomes", bullets(state.rollingOutcomes)),
    ];
    if (level === "l1")
        return common;
    return [
        ...common,
        section("Success Criteria", bullets(state.successCriteria)),
        section("Phase History", bullets(state.milestones.map((item) => `${item.label} (R${item.round_range.start}-R${item.round_range.end}): ${item.outcome}`))),
        section("Loop Summary", state.loopSynthesis),
        section("External Context", state.externalContext),
    ];
}
function graphSliceSection(state, level) {
    const graph = state.graphSlice;
    if (!graph || level === "l0")
        return "";
    const values = [
        `Plan version: ${graph.planVersion ?? "none"}`,
        `Active step: ${graph.activeStepId ?? "final audit"}`,
        graph.parentOutlineId ? `Refined from: ${graph.parentOutlineId}` : "",
        ...graph.dependencySummaries.map((item) => `Dependency: ${item}`),
        graph.relevantConstraintIds.length ? `Relevant constraints: ${graph.relevantConstraintIds.join(", ")}` : "",
        graph.requiredClaimIds.length ? `Required claims: ${graph.requiredClaimIds.join(", ")}` : "",
        graph.uncoveredClaimIds.length ? `Uncovered claims: ${graph.uncoveredClaimIds.join(", ")}` : "Uncovered claims: none",
        graph.regressionGapIds?.length ? `Regression gaps: ${graph.regressionGapIds.join(", ")}` : "Regression gaps: none",
        graph.priorAttemptSummary ? `Prior attempt: ${graph.priorAttemptSummary}` : "",
        `Blocked descendants: ${graph.blockedDescendantCount}`,
    ].filter(Boolean);
    return section("Active Graph Slice", bullets(values));
}
function contextSections(request, state, level) {
    if (!request || level === "l0")
        return [];
    const sections = [];
    if (request.confusion_points?.length) {
        sections.push(section("Context Questions", bullets(request.confusion_points)));
    }
    if (request.emphasize?.length) {
        const corpus = [
            ...state.activeConstraints,
            ...state.discoveries,
            ...state.blockers,
            ...state.evidence.evidenceGaps,
        ];
        const matched = corpus.filter((item) => request.emphasize.some((needle) => item.toLowerCase().includes(needle.toLowerCase()) || needle.toLowerCase().includes(item.toLowerCase())));
        sections.push(section("Requested Context", bullets(matched.slice(0, level === "l2" ? 5 : 3))));
    }
    return sections;
}
function fit(sections, budget) {
    let text = "";
    const included = [];
    for (let index = 0; index < sections.length; index++) {
        const value = sections[index];
        if (!value)
            continue;
        if (text.length + value.length > budget && text.length > 0)
            break;
        text += value;
        included.push(`section_${index + 1}`);
    }
    return { text, included };
}
export function assemblePromptArtifact(input) {
    const budgets = { ...DEFAULT_PROMPT_BUDGETS, ...input.budgets };
    const budget = budgets[input.level];
    const stateHash = hashCanonicalState(input.state);
    const attempt = Math.max(1, input.attempt ?? 1);
    const header = [
        `## LoopForge Round ${input.state.round}`,
        `Mode: ${input.reportMode} | Level: ${input.level.toUpperCase()} | Attempt: ${attempt}`,
        `State: ${stateHash.slice(0, 12)}`,
        input.state.stateFilePath ? `State projection: \`${input.state.stateFilePath}\`` : "",
        "",
    ].filter(Boolean).join("\n") + "\n";
    const mandatory = coreSections(input.state).join("");
    const footer = [
        input.reportInstructions.trim(),
        "",
        "Execute only the assigned work. Submit the exact sessionId, roundId, and factual report to `loopforge_next`.",
    ].join("\n");
    const available = Math.max(0, budget - header.length - mandatory.length - footer.length);
    const graphLimit = Math.max(0, input.graphSliceMaxChars ?? 3000);
    const graphSection = graphSliceSection(input.state, input.level).slice(0, graphLimit);
    const details = fit([
        ...contextSections(input.contextRequest, input.state, input.level),
        graphSection,
        ...detailSections(input.state, input.level).filter((item) => !item.startsWith("### Active Graph Slice")),
    ], available);
    const renderedPrompt = header + mandatory + details.text + footer + "\n";
    return {
        schemaVersion: PROMPT_ARTIFACT_SCHEMA_VERSION,
        roundId: input.roundId ?? `loop:${input.state.loopId}:round:${input.state.round}`,
        attempt,
        level: input.level,
        levelReasons: [...input.reasons],
        renderedPrompt,
        promptHash: createHash("sha256").update(renderedPrompt).digest("hex"),
        stateHash,
        basePromptVersion: BASE_PROMPT_VERSION,
        includedSections: [
            "objective", "assigned_plan_step", "hard_constraints", "evidence_gaps",
            ...(renderedPrompt.includes("### Active Graph Slice") ? ["graph_slice"] : []),
            ...details.included, "round_report",
        ],
        budgetChars: budget,
        charCount: renderedPrompt.length,
        budgetExceeded: renderedPrompt.length > budget,
        generatedAt: Date.now(),
    };
}
//# sourceMappingURL=prompt-assembler.js.map