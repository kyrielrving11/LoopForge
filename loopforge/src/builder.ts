/** LoopForge Agent — Technique router.
 *
 * Pure-function technique selection via keyword heuristic with tier gating.
 * Tier 1 (zero-shot / few-shot / CoT): always available.
 * Tier 2 (step-back / least-to-most / ToT): checkpoint boundaries or
 * after consecutive failures only.
 */

import { getPolicy } from "./policy.js";
import { logEvent } from "./observability.js";
import {
  makeAnalysis,
  Technique,
  type Analysis,
} from "./protocol.js";

// ═══════════════════════════════════════════════════════════════════════════
// Routing table
// ═══════════════════════════════════════════════════════════════════════════

const ROUTING_TABLE: Record<string, Technique> = {
  continuous_low: Technique.ZERO_SHOT,
  independent_low: Technique.ZERO_SHOT,
  continuous_medium: Technique.FEW_SHOT,
  independent_medium: Technique.ZERO_SHOT_COT,
  continuous_high: Technique.FEW_SHOT_COT,
  independent_high: Technique.TREE_OF_THOUGHT,
};

const RATIONALE: Record<string, string> = {
  [Technique.ZERO_SHOT]: "Low load — direct instruction suffices.",
  [Technique.FEW_SHOT]:
    "Fixed I/O pattern expected — examples anchor output format.",
  [Technique.ZERO_SHOT_COT]:
    "Multi-step reasoning needed, no examples provided.",
  [Technique.FEW_SHOT_COT]:
    "Complex reasoning with provided examples — relay pattern.",
  [Technique.STEP_BACK]:
    "Vague or legacy — abstract to principles first.",
  [Technique.LEAST_TO_MOST]:
    "Decomposable into ordered subproblems.",
  [Technique.TREE_OF_THOUGHT]:
    "High risk, multi-path — explore + evaluate + prune.",
};

export const TECHNIQUE_REFERENCE: Record<string, string> = {
  "zero-shot": "loopforge/skills/prompt-techniques/references/zero-shot.md",
  "few-shot": "loopforge/skills/prompt-techniques/references/few-shot.md",
  "zero-shot-cot": "loopforge/skills/prompt-techniques/references/chain-of-thought.md",
  "few-shot-cot": "loopforge/skills/prompt-techniques/references/chain-of-thought.md",
  "step-back": "loopforge/skills/prompt-techniques/references/step-back.md",
  "least-to-most": "loopforge/skills/prompt-techniques/references/least-to-most.md",
  "tree-of-thought": "loopforge/skills/prompt-techniques/references/tree-of-thought.md",
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

export function routeTechnique(task: string): Analysis {
  const taskLower = task.toLowerCase();

  // Independence — check if any continuous word appears in task
  const continuous = [...CONTINUOUS_WORDS].some((w) => taskLower.includes(w));
  const independence = continuous ? "continuous" : "independent";

  // Cognitive load — check keyword presence
  let load: string;
  if ([...HIGH_LOAD_WORDS].some((w) => taskLower.includes(w))) {
    load = "high";
  } else if ([...LOW_LOAD_WORDS].some((w) => taskLower.includes(w))) {
    load = "low";
  } else {
    load = task.split(/\s+/).length > 8 ? "medium" : "low";
  }

  let technique = ROUTING_TABLE[`${independence}_${load}`] ?? Technique.ZERO_SHOT;

  // v1.1: Keyword overrides for specialist techniques
  if ([...STEP_BACK_WORDS].some((w) => taskLower.includes(w))) {
    technique = Technique.STEP_BACK;
    load = "high";
  } else if ([...LEAST_TO_MOST_WORDS].some((w) => taskLower.includes(w))) {
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
// Tier definitions
// ═══════════════════════════════════════════════════════════════════════════

const TIER_1_TECHNIQUES: Set<string> = new Set([
  Technique.ZERO_SHOT,
  Technique.FEW_SHOT,
  Technique.ZERO_SHOT_COT,
  Technique.FEW_SHOT_COT,
]);

const TIER_2_TECHNIQUES: Set<string> = new Set([
  Technique.STEP_BACK,
  Technique.LEAST_TO_MOST,
  Technique.TREE_OF_THOUGHT,
]);

function isTier2Technique(t: string): boolean {
  return TIER_2_TECHNIQUES.has(t);
}

// Downgrade map: Tier 2 → nearest Tier 1 equivalent
const DOWNGRADE_TIER2_TO_TIER1: Record<string, string> = {
  [Technique.STEP_BACK]: Technique.FEW_SHOT_COT,
  [Technique.LEAST_TO_MOST]: Technique.ZERO_SHOT_COT,
  [Technique.TREE_OF_THOUGHT]: Technique.FEW_SHOT_COT,
};

function downgradeToTier1(technique: string): string {
  return DOWNGRADE_TIER2_TO_TIER1[technique] ?? Technique.FEW_SHOT;
}

// ═══════════════════════════════════════════════════════════════════════════
// Consecutive failure detection
// ═══════════════════════════════════════════════════════════════════════════

function countConsecutiveFailures(
  loopId: string,
  vaultContext: Record<string, unknown> | null,
): number {
  if (vaultContext === null) return 0;

  const results = (vaultContext.results as Record<string, unknown>[]) || [];
  if (!results.length) return 0;

  // Collect rounds with success field from feedback entries
  const rounds: { round: number; success: boolean }[] = [];
  for (const r of results) {
    const lineage = (r.loop_lineage || r.lineage || {}) as Record<string, unknown>;
    if (lineage.loop_id !== loopId) continue;
    const success = r.success !== undefined
      ? (r.success as boolean)
      : (lineage.success as boolean);
    if (success === undefined) continue; // lineage entries without merged feedback — skip
    rounds.push({
      round: (lineage.round as number) ?? 0,
      success,
    });
  }
  rounds.sort((a, b) => b.round - a.round);

  let count = 0;
  for (const rnd of rounds) {
    if (rnd.success === false) {
      count++;
    } else {
      break;
    }
  }
  return count;
}

// ═══════════════════════════════════════════════════════════════════════════
// Keyword routing restricted to a subset of techniques
// ═══════════════════════════════════════════════════════════════════════════

function keywordRouteRestricted(
  task: string,
  allowedTechniques: string[],
): Analysis {
  // Run full keyword routing first
  const full = routeTechnique(task);
  const technique = full.technique;

  // If the keyword result is already in the allowed set, use it
  if (allowedTechniques.includes(technique)) return full;

  // If it's Tier 2 downgraded to Tier 1, map to the nearest Tier 1
  if (isTier2Technique(technique)) {
    const downgraded = downgradeToTier1(technique);
    if (allowedTechniques.includes(downgraded)) {
      return makeAnalysis({
        technique: downgraded,
        rationale: `${full.rationale} [DOWNGRADED: ${technique} → ${downgraded} — Tier 2 not available this round]`,
        independence: full.independence,
        cognitive_load: full.cognitive_load,
        reference_file: TECHNIQUE_REFERENCE[downgraded] ?? full.reference_file,
      });
    }
  }

  // Fallback: pick the first technique in the allowed set
  const fallback = allowedTechniques[0];
  return makeAnalysis({
    technique: fallback,
    rationale: `${RATIONALE[fallback] ?? "Tier-restricted route."} [RESTRICTED: keyword ${technique} not in allowed set [${allowedTechniques.join(", ")}]]`,
    independence: full.independence,
    cognitive_load: full.cognitive_load,
    reference_file: TECHNIQUE_REFERENCE[fallback] ?? "",
  });
}

// ═══════════════════════════════════════════════════════════════════════════
// Tier-gated technique router (v4.0)
// ═══════════════════════════════════════════════════════════════════════════

export function routeTechniqueAdaptive(
  task: string,
  vaultContext: Record<string, unknown> | null = null,
  loopId = "",
  isCheckpoint = false,
): Analysis {
  // Step 1: Full keyword routing over all 7 techniques
  const keyword = routeTechnique(task);
  const technique = keyword.technique;

  // Step 2: Determine which tier is allowed this round
  const policy = getPolicy();
  const tier2Failures = policy.technique.tier2_escalation_failures ?? 3;

  const consecutiveFailures = vaultContext && loopId
    ? countConsecutiveFailures(loopId, vaultContext)
    : 0;

  let allowedTechniques: string[];
  let tierLabel: string;

  if (isCheckpoint) {
    // Checkpoint boundary: full access to all 7 techniques
    allowedTechniques = [
      Technique.ZERO_SHOT, Technique.FEW_SHOT,
      Technique.ZERO_SHOT_COT, Technique.FEW_SHOT_COT,
      Technique.STEP_BACK, Technique.LEAST_TO_MOST, Technique.TREE_OF_THOUGHT,
    ];
    tierLabel = "checkpoint";
  } else if (consecutiveFailures >= tier2Failures) {
    // Escalation: Tier 2 only
    allowedTechniques = [
      Technique.STEP_BACK, Technique.LEAST_TO_MOST, Technique.TREE_OF_THOUGHT,
    ];
    tierLabel = `escalated (${consecutiveFailures} consecutive failures)`;
    logEvent("tier2_escalation", {
      loopId,
      consecutiveFailures,
      keywordTechnique: technique,
    });
  } else {
    // Normal: Tier 1 only
    allowedTechniques = [
      Technique.ZERO_SHOT, Technique.FEW_SHOT,
      Technique.ZERO_SHOT_COT, Technique.FEW_SHOT_COT,
    ];
    tierLabel = "default";
  }

  // Step 3: Apply gate — if keyword result is in allowed set, use it
  if (allowedTechniques.includes(technique)) {
    if (tierLabel === "default") return keyword; // Most common path — no overhead

    const label = tierLabel === "checkpoint"
      ? `${keyword.rationale} [CHECKPOINT: full technique access]`
      : `${keyword.rationale} [ESCALATED: Tier 2 — ${consecutiveFailures} consecutive failures]`;

    return makeAnalysis({
      technique,
      rationale: label,
      independence: keyword.independence,
      cognitive_load: keyword.cognitive_load,
      reference_file: keyword.reference_file,
    });
  }

  // Step 4: Keyword result outside allowed set — downgrade or restrict
  return keywordRouteRestricted(task, allowedTechniques);
}

