/** LoopForge Agent — Technique router + quality scoring.
 *
 * Two pure-function responsibilities:
 *   1. Technique selection — keyword heuristic, fast + zero-cost
 *   2. Quality scoring — deterministic 1-5 from feedback signals
 */
import { getPolicy } from "./policy.js";
import { makeAnalysis, Technique, } from "./protocol.js";
// ═══════════════════════════════════════════════════════════════════════════
// Routing table
// ═══════════════════════════════════════════════════════════════════════════
const ROUTING_TABLE = {
    continuous_low: Technique.ZERO_SHOT,
    independent_low: Technique.ZERO_SHOT,
    continuous_medium: Technique.FEW_SHOT,
    independent_medium: Technique.ZERO_SHOT_COT,
    continuous_high: Technique.FEW_SHOT_COT,
    independent_high: Technique.TREE_OF_THOUGHT,
};
const RATIONALE = {
    [Technique.ZERO_SHOT]: "Low load — direct instruction suffices.",
    [Technique.FEW_SHOT]: "Fixed I/O pattern expected — examples anchor output format.",
    [Technique.ZERO_SHOT_COT]: "Multi-step reasoning needed, no examples provided.",
    [Technique.FEW_SHOT_COT]: "Complex reasoning with provided examples — relay pattern.",
    [Technique.STEP_BACK]: "Vague or legacy — abstract to principles first.",
    [Technique.LEAST_TO_MOST]: "Decomposable into ordered subproblems.",
    [Technique.TREE_OF_THOUGHT]: "High risk, multi-path — explore + evaluate + prune.",
};
export const TECHNIQUE_REFERENCE = {
    "zero-shot": "skills/prompt-techniques/references/zero-shot.md",
    "few-shot": "skills/prompt-techniques/references/few-shot.md",
    "zero-shot-cot": "skills/prompt-techniques/references/chain-of-thought.md",
    "few-shot-cot": "skills/prompt-techniques/references/chain-of-thought.md",
    "step-back": "skills/prompt-techniques/references/step-back.md",
    "least-to-most": "skills/prompt-techniques/references/least-to-most.md",
    "tree-of-thought": "skills/prompt-techniques/references/tree-of-thought.md",
};
// Keyword sets for heuristic classification
const HIGH_LOAD_WORDS = new Set([
    "security", "audit", "crypto", "encrypt", "concurrent",
    "thread", "transaction", "rollback", "compile", "protocol",
    "安全", "审计", "加密", "并发", "签名", "校验", "默克尔",
    "assembly", "重放攻击", "共识", "虚拟机", "字节码",
]);
const LOW_LOAD_WORDS = new Set([
    "rename", "format", "comment", "config", "readme", "simple", "basic",
]);
const CONTINUOUS_WORDS = new Set([
    "fix", "modify", "update", "change", "refactor", "extend",
    "add", "improve", "debug",
]);
// v1.1: Keywords that trigger specialist techniques (override routing table)
const STEP_BACK_WORDS = new Set([
    "重构", "排查", "legacy", "原则", "抽象", "根本原因", "root cause",
    "报错", "逻辑混乱", "含糊", "vague", "审计方法", "底层",
]);
const LEAST_TO_MOST_WORDS = new Set([
    "逐步", "搭建", "实现系统", "build system", "pipeline", "编译器",
    "逐步求解", "有序", "从简单到复杂", "数据采集", "完整模块",
    "多步骤", "部署流程", "子问题",
]);
// ═══════════════════════════════════════════════════════════════════════════
// Keyword heuristic router
// ═══════════════════════════════════════════════════════════════════════════
export function routeTechnique(task) {
    const taskLower = task.toLowerCase();
    // Independence — check if any continuous word appears in task
    const continuous = [...CONTINUOUS_WORDS].some((w) => taskLower.includes(w));
    const independence = continuous ? "continuous" : "independent";
    // Cognitive load — check keyword presence
    let load;
    if ([...HIGH_LOAD_WORDS].some((w) => taskLower.includes(w))) {
        load = "high";
    }
    else if ([...LOW_LOAD_WORDS].some((w) => taskLower.includes(w))) {
        load = "low";
    }
    else {
        load = task.split(/\s+/).length > 8 ? "medium" : "low";
    }
    let technique = ROUTING_TABLE[`${independence}_${load}`] ?? Technique.ZERO_SHOT;
    // v1.1: Keyword overrides for specialist techniques
    if ([...STEP_BACK_WORDS].some((w) => taskLower.includes(w))) {
        technique = Technique.STEP_BACK;
        load = "high";
    }
    else if ([...LEAST_TO_MOST_WORDS].some((w) => taskLower.includes(w))) {
        technique = Technique.LEAST_TO_MOST;
        load = "high";
    }
    return makeAnalysis({
        technique: technique,
        rationale: RATIONALE[technique] ?? "Default route.",
        independence,
        cognitive_load: load,
        reference_file: TECHNIQUE_REFERENCE[technique] ?? "",
    });
}
// ═══════════════════════════════════════════════════════════════════════════
// Quality scoring
// ═══════════════════════════════════════════════════════════════════════════
export function scoreQuality(feedback) {
    if (feedback === null)
        return 0;
    const success = feedback.success;
    const violations = feedback.constraint_violations ?? [];
    const fixes = feedback.manual_fixes_needed ?? "";
    if (success && violations.length === 0 && !fixes)
        return 5;
    if (success && violations.length === 0)
        return 4;
    if (success)
        return 3;
    if (violations.length > 0)
        return 2;
    return 1;
}
// ═══════════════════════════════════════════════════════════════════════════
// Adaptive routing (v3.5)
// ═══════════════════════════════════════════════════════════════════════════
function countConsecutiveLowQuality(technique, loopId, vaultContext) {
    if (vaultContext === null)
        return 0;
    const results = vaultContext.results || [];
    if (!results.length)
        return 0;
    const policy = getPolicy();
    const threshold = policy.technique.adaptive_quality_threshold;
    // Filter to this loop, sort by round descending
    const rounds = [];
    for (const r of results) {
        const lineage = (r.loop_lineage || r.lineage || {});
        if (lineage.loop_id !== loopId)
            continue;
        rounds.push({
            round: lineage.round ?? 0,
            quality_score: r.quality_score ?? lineage.quality_score ?? 0,
            technique_used: r.technique_used ?? r.skill_used ?? "",
        });
    }
    rounds.sort((a, b) => b.round - a.round);
    let count = 0;
    for (const rnd of rounds) {
        if (rnd.technique_used && rnd.technique_used !== technique)
            break;
        if (rnd.quality_score > 0 && rnd.quality_score < threshold) {
            count++;
        }
        else {
            break;
        }
    }
    return count;
}
export function routeTechniqueAdaptive(task, vaultContext = null, loopId = "") {
    // Step 1: Keyword heuristic (always)
    const analysis = routeTechnique(task);
    if (!vaultContext || !loopId)
        return analysis;
    // Step 2: Check if current technique needs rotation
    const technique = analysis.technique;
    const policy = getPolicy();
    const lowCount = countConsecutiveLowQuality(technique, loopId, vaultContext);
    if (lowCount < policy.technique.adaptive_consecutive_rounds) {
        return analysis;
    }
    // Step 3: Rotate
    const fallback = policy.technique.fallback_chain[technique] ?? technique;
    if (fallback === technique)
        return analysis; // Already at ceiling
    const originalTechnique = technique;
    const originalRationale = analysis.rationale;
    return makeAnalysis({
        technique: fallback,
        rationale: `${originalRationale} [ROTATED: ${originalTechnique} → ${fallback} — ` +
            `${lowCount} consecutive low-quality rounds (score < ${policy.technique.adaptive_quality_threshold})]`,
        independence: analysis.independence,
        cognitive_load: fallback === "tree-of-thought" || fallback === "few-shot-cot"
            ? "high"
            : fallback === "zero-shot-cot" || fallback === "least-to-most"
                ? "medium"
                : analysis.cognitive_load,
        reference_file: TECHNIQUE_REFERENCE[fallback] ?? analysis.reference_file,
        was_rotated: true,
    });
}
// ═══════════════════════════════════════════════════════════════════════════
// Global constraints extraction
// ═══════════════════════════════════════════════════════════════════════════
export function extractGlobalConstraints(hydrateResults) {
    const constraints = [];
    if (!hydrateResults)
        return constraints;
    const globalEntries = hydrateResults.global_entries || [];
    for (const entry of globalEntries) {
        const added = entry.hard_constraints_added || [];
        for (const c of added) {
            if (!constraints.includes(c)) {
                constraints.push(c);
            }
        }
    }
    return constraints;
}
//# sourceMappingURL=builder.js.map