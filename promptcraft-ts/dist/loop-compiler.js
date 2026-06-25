/** PromptCraft-loop_compile — Loop Compiler (v3.5 core).
 *
 * Pure-function module for per-loop-iteration prompt compilation.
 *
 * Two layers:
 *   Layer 1 (Hard Gates): decideLevel() — 4-gate routing that CAN change compile level.
 *   Layer 2 (Soft Advisories): computeAdvisories() — warnings/alignment/health, NEVER
 *     change compile level directly.
 *
 * Compilation: compileL0() / compileL1() / compileL2() produce the actual prompt.
 *
 * Python reference: loop_compiler.py (~1195 lines)
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { getPolicy } from "./policy.js";
import { makeLoopCompileResponse, makeLoopHealth, makeLoopObjective, makeRollingSummary, makeTaskAlignment, } from "./protocol.js";
import { routeTechniqueAdaptive } from "./builder.js";
// ═══════════════════════════════════════════════════════════════════════════
// Repair cue detection
// ═══════════════════════════════════════════════════════════════════════════
const REPAIR_CUES = [
    "fix", "repair", "revise", "correct", "polish", "bug", "error",
    "修复", "修改", "修正", "纠错", "补充", "改一下",
];
function detectsRepairSignal(request) {
    let text = (request.new_since_last_round || "").toLowerCase();
    if (request.last_round_result) {
        text += " " + (request.last_round_result.output_summary || "").toLowerCase();
        if (request.last_round_result.manual_fixes_needed) {
            text += " " + request.last_round_result.manual_fixes_needed.toLowerCase();
        }
    }
    return REPAIR_CUES.some((cue) => text.includes(cue));
}
// ═══════════════════════════════════════════════════════════════════════════
// Tokenization helpers
// ═══════════════════════════════════════════════════════════════════════════
function tokenize(text) {
    const tokens = text.split(/\s+/);
    const result = new Set();
    for (let token of tokens) {
        token = token.trim().replace(/^[.,;:!?()[\]{}'"]+|[.,;:!?()[\]{}'"]+$/g, "");
        if (token.length >= 2) {
            result.add(/^[\x00-\x7F]*$/.test(token) ? token.toLowerCase() : token);
        }
        // Add individual CJK chars as standalone tokens
        for (const ch of token) {
            if ((ch >= "一" && ch <= "鿿") ||
                (ch >= "぀" && ch <= "ヿ")) {
                result.add(ch);
            }
        }
    }
    return result;
}
function jaccard(a, b) {
    if (a.size === 0 || b.size === 0)
        return 0.0;
    let intersection = 0;
    for (const item of a) {
        if (b.has(item))
            intersection++;
    }
    const union = a.size + b.size - intersection;
    return union > 0 ? intersection / union : 0.0;
}
// ═══════════════════════════════════════════════════════════════════════════
// Goal identity
// ═══════════════════════════════════════════════════════════════════════════
export function computeGoalTextHash(task) {
    const normalized = (task || "").trim().toLowerCase().replace(/\s+/g, " ");
    return createHash("sha256").update(normalized, "utf-8").digest("hex").slice(0, 12);
}
export function deriveGoalId(loopId, task, explicitGoalId = "") {
    if (explicitGoalId)
        return explicitGoalId;
    let taskPrefix = (task || "unnamed").slice(0, 60).trim().toLowerCase();
    taskPrefix = taskPrefix.replace(/\s+/g, "-").replace(/[^a-z0-9-]/g, "");
    return loopId ? `${loopId}:${taskPrefix}` : taskPrefix;
}
function makePreviousRound() {
    return {
        goal_id: "",
        goal_text_hash: "",
        quality_score: 0,
        success: true,
        task: "",
        constraints_active: [],
        prompt_text: "",
    };
}
export function getPreviousRound(loopId, roundNum, vaultContext) {
    if (vaultContext === null)
        return null;
    const results = vaultContext.results || [];
    if (!results.length)
        return null;
    for (const r of results) {
        const lineage = (r.loop_lineage || r.lineage || {});
        if (lineage.loop_id === loopId && lineage.round === roundNum) {
            return {
                goal_id: lineage.goal_id ?? "",
                goal_text_hash: lineage.goal_text_hash ?? "",
                quality_score: lineage.quality_score ?? 0,
                success: r.success ?? true,
                task: r.task ?? r.user_intent ?? "",
                constraints_active: lineage.constraints_active ?? [],
                prompt_text: r.full_prompt ?? "",
            };
        }
    }
    return null;
}
function getRecentRounds(loopId, n, vaultContext) {
    if (vaultContext === null)
        return [];
    const results = vaultContext.results || [];
    const rounds = [];
    for (const r of results) {
        const lineage = (r.loop_lineage || r.lineage || {});
        if (lineage.loop_id === loopId) {
            rounds.push({
                quality_score: lineage.quality_score ?? 0,
                round: lineage.round ?? 0,
                goal_text_hash: lineage.goal_text_hash ?? "",
            });
        }
    }
    rounds.sort((a, b) => b.round - a.round);
    return rounds.slice(0, n);
}
function getPreviousRoundTask(loopId, roundNum, vaultContext) {
    const prev = getPreviousRound(loopId, roundNum, vaultContext);
    return prev?.task ?? "";
}
function vaultGetLoopObjective(loopId, vaultContext) {
    if (vaultContext === null)
        return null;
    // Check global entries first
    const globalEntries = vaultContext.global_entries || [];
    for (const entry of globalEntries) {
        const lo = entry.loop_objective;
        if (lo && entry.loop_id === loopId) {
            return { loop_objective: lo, loop_id: loopId };
        }
    }
    // Check results
    const results = vaultContext.results || [];
    for (const r of results) {
        const lo = r.loop_objective;
        if (lo && r.loop_id === loopId) {
            return { loop_objective: lo, loop_id: loopId };
        }
    }
    return null;
}
function countConsecutiveHashMismatches(loopId, vaultContext) {
    if (vaultContext === null)
        return 0;
    const rounds = getRecentRounds(loopId, 20, vaultContext);
    if (rounds.length < 2)
        return 0;
    let count = 0;
    for (let i = 0; i < rounds.length - 1; i++) {
        const currHash = rounds[i].goal_text_hash;
        const prevHash = rounds[i + 1].goal_text_hash;
        if (currHash && prevHash && currHash !== prevHash) {
            count++;
        }
        else {
            break;
        }
    }
    return count;
}
// ═══════════════════════════════════════════════════════════════════════════
// Strategy collapse detection
// ═══════════════════════════════════════════════════════════════════════════
function strategyCollapse(loopId, vaultContext) {
    const recent = getRecentRounds(loopId, 3, vaultContext);
    if (recent.length < 3)
        return false;
    return recent.every((r) => r.quality_score < 3);
}
// ═══════════════════════════════════════════════════════════════════════════
// Constraint Retirement (v3.5)
// ═══════════════════════════════════════════════════════════════════════════
function computeConstraintRetirement(activeConstraints, loopId, currentRound, vaultContext) {
    if (!activeConstraints.length || vaultContext === null) {
        return { active: [...activeConstraints], retired: [] };
    }
    const results = vaultContext.results || [];
    if (!results.length) {
        return { active: [...activeConstraints], retired: [] };
    }
    const policy = getPolicy();
    const window = policy.constraints.retire_window;
    const targetRounds = new Set();
    for (let r = currentRound - window; r < currentRound; r++) {
        targetRounds.add(r);
    }
    // Collect all text per target round for activity detection
    const roundTexts = new Map();
    for (const r of results) {
        const lineage = (r.loop_lineage || r.lineage || {});
        if (lineage.loop_id !== loopId)
            continue;
        const rnd = lineage.round;
        if (!targetRounds.has(rnd))
            continue;
        let text = ((r.task ?? r.user_intent ?? "") + " " +
            (lineage.task ?? "") + " " +
            (r.output_summary ?? "")).toLowerCase();
        for (const v of r.constraint_violations || []) {
            text += " " + String(v).toLowerCase();
        }
        roundTexts.set(rnd, text);
    }
    const retired = [];
    const pruned = [];
    for (const constraint of activeConstraints) {
        const cLower = constraint.toLowerCase();
        const cNormalized = cLower.replace(/-/g, " ");
        let isActive = false;
        for (const text of roundTexts.values()) {
            if (text.includes(cLower) || text.includes(cNormalized)) {
                isActive = true;
                break;
            }
        }
        if (isActive || roundTexts.size < window) {
            pruned.push(constraint);
        }
        else {
            retired.push(constraint);
        }
    }
    return { active: pruned, retired };
}
// ═══════════════════════════════════════════════════════════════════════════
// Rolling Summary (v3.5)
// ═══════════════════════════════════════════════════════════════════════════
function buildRollingSummary(loopId, currentRound, vaultContext) {
    if (vaultContext === null)
        return null;
    const results = vaultContext.results || [];
    if (!results.length)
        return null;
    const policy = getPolicy();
    const window = policy.summary.window;
    // Collect rounds matching this loop_id, excluding current
    const rounds = [];
    for (const r of results) {
        const lineage = (r.loop_lineage || r.lineage || {});
        if (lineage.loop_id !== loopId)
            continue;
        const rnd = lineage.round;
        if (rnd >= currentRound)
            continue;
        rounds.push({
            round: rnd,
            quality_score: lineage.quality_score ?? 0,
            task: r.task ?? r.user_intent ?? "",
            output_summary: r.output_summary ?? "",
            constraint_violations: r.constraint_violations || [],
            technique_used: r.technique_used ?? "",
        });
    }
    if (!rounds.length)
        return null;
    // Sort by round descending, take last N
    rounds.sort((a, b) => b.round - a.round);
    const sampled = rounds.slice(0, window).reverse(); // chronological order
    // Quality trajectory
    const trajectory = sampled.map((r) => r.quality_score);
    // Trajectory direction
    let direction = "stable";
    if (trajectory.length >= 2) {
        const diffs = trajectory.slice(1).map((v, i) => v - trajectory[i]);
        if (diffs.every((d) => d >= 0) && diffs.some((d) => d > 0)) {
            direction = "improving";
        }
        else if (diffs.every((d) => d <= 0) && diffs.some((d) => d < 0)) {
            direction = "declining";
        }
        else if (diffs.every((d) => d === 0)) {
            direction = "stable";
        }
        else {
            direction = "volatile";
        }
    }
    // What worked
    const whatWorked = [];
    for (const r of sampled) {
        if (r.quality_score >= 4 &&
            r.output_summary) {
            whatWorked.push(`R${r.round} (score=${r.quality_score}, ` +
                `${r.technique_used || "n/a"}): ${String(r.output_summary).slice(0, 150)}`);
        }
    }
    // Recurring issues
    const violationCounts = new Map();
    for (const r of sampled) {
        const seen = new Set();
        for (const v of r.constraint_violations || []) {
            const vNorm = String(v).trim().toLowerCase();
            if (vNorm && !seen.has(vNorm)) {
                violationCounts.set(vNorm, (violationCounts.get(vNorm) || 0) + 1);
                seen.add(vNorm);
            }
        }
    }
    const recurringIssues = [...violationCounts.entries()]
        .filter(([, count]) => count >= 2)
        .sort((a, b) => b[1] - a[1])
        .map(([v, count]) => `${v} (appeared in ${count} rounds)`);
    // Key lessons
    const keyLessons = [];
    for (const r of sampled) {
        if (r.quality_score >= 4 && r.output_summary) {
            keyLessons.push(`[R${r.round}] ${String(r.output_summary).slice(0, 200)}`);
        }
    }
    return makeRollingSummary({
        quality_trajectory: trajectory,
        trajectory_direction: direction,
        what_worked: whatWorked,
        recurring_issues: recurringIssues,
        key_lessons: keyLessons,
        rounds_sampled: sampled.length,
        generated_at_round: currentRound,
    });
}
function formatRollingSummaryForPrompt(rs) {
    if (rs === null || rs.rounds_sampled === 0)
        return "";
    const lines = [
        "### Cross-Round Summary (Accumulated)",
        "",
        `**Sampled**: ${rs.rounds_sampled} prior rounds | **Direction**: ${rs.trajectory_direction}`,
        `**Quality Trajectory**: [${rs.quality_trajectory.join(", ")}]`,
        "",
    ];
    if (rs.what_worked.length) {
        lines.push("**What Worked (score >= 4)**:");
        for (const w of rs.what_worked)
            lines.push(`- ${w}`);
        lines.push("");
    }
    if (rs.recurring_issues.length) {
        lines.push("**Recurring Issues (appeared 2+ times)**:");
        for (const ri of rs.recurring_issues)
            lines.push(`- ⚠️ ${ri}`);
        lines.push("");
    }
    if (rs.key_lessons.length) {
        lines.push("**Key Lessons From High-Score Rounds**:");
        for (const kl of rs.key_lessons)
            lines.push(`- ${kl}`);
        lines.push("");
    }
    return lines.join("\n");
}
// ═══════════════════════════════════════════════════════════════════════════
// LAYER 1 — Hard Gates (can change compile level)
// ═══════════════════════════════════════════════════════════════════════════
export function decideLevel(request, vaultContext) {
    // Gate 1: Explicit override (never overrides round 1 or plan_source)
    if (request.force_level !== "auto" &&
        ["l0", "l1", "l2"].includes(request.force_level)) {
        if (request.round !== 1 && !request.plan_source) {
            return request.force_level;
        }
    }
    // Gate 2: First call or explicit plan input → full rebuild
    if (request.round === 1 || request.plan_source) {
        return "l2";
    }
    // Derive goal_id
    const goalId = deriveGoalId(request.loop_id, request.task, request.goal_id);
    const prev = getPreviousRound(request.loop_id, request.round - 1, vaultContext);
    if (prev === null)
        return "l2";
    // Gate 3: goal_id stability
    if (goalId !== prev.goal_id)
        return "l2";
    // Gate 4: Explicit failures or new constraints → patch
    const hasNewConstraints = request.constraints_from_plan.length > 0;
    const hasNewFailures = request.last_round_result !== null &&
        !request.last_round_result.success;
    const hasRepair = detectsRepairSignal(request);
    if (hasNewConstraints || hasNewFailures || hasRepair)
        return "l1";
    // Nothing triggered → fast path
    return "l0";
}
// ═══════════════════════════════════════════════════════════════════════════
// LAYER 2 — Soft Advisories (NEVER change compile level)
// ═══════════════════════════════════════════════════════════════════════════
export function alignTask(proposedTask, request, vaultContext) {
    const objectiveEntry = vaultGetLoopObjective(request.loop_id, vaultContext);
    let objData = null;
    if (request.loop_objective) {
        objData = request.loop_objective;
    }
    else if (objectiveEntry) {
        const lo = objectiveEntry.loop_objective;
        if (lo && typeof lo === "object") {
            objData = lo;
        }
    }
    if (objData === null)
        return makeTaskAlignment();
    const objective = objData.objective ?? "";
    const successCriteria = objData.success_criteria ?? [];
    const hardConstraints = objData.hard_constraints ?? [];
    const proposedTokens = tokenize(proposedTask.toLowerCase());
    const objText = `${objective} ${successCriteria.join(" ")} ${hardConstraints.join(" ")}`.toLowerCase();
    const objTokens = tokenize(objText);
    const score = proposedTokens.size && objTokens.size
        ? jaccard(proposedTokens, objTokens)
        : 1.0;
    if (score >= 0.5) {
        return makeTaskAlignment({
            is_aligned: true,
            alignment_score: Math.round(score * 100) / 100,
        });
    }
    else if (score >= 0.3) {
        return makeTaskAlignment({
            is_aligned: true,
            alignment_score: Math.round(score * 100) / 100,
            warning: `Proposed task '${proposedTask.slice(0, 80)}' may be drifting from ` +
                `loop objective '${objective}'. Consider narrowing scope.`,
            escalation: "warn",
        });
    }
    else {
        return makeTaskAlignment({
            is_aligned: false,
            alignment_score: Math.round(score * 100) / 100,
            warning: `Proposed task '${proposedTask.slice(0, 80)}' is OFF-OBJECTIVE. ` +
                `Loop objective: '${objective}'. Full realignment recommended.`,
            escalation: "block",
        });
    }
}
export function checkLoopHealth(loopId, request, vaultContext) {
    const objectiveEntry = vaultGetLoopObjective(loopId, vaultContext);
    let obj = null;
    if (request.loop_objective) {
        obj = request.loop_objective;
    }
    else if (objectiveEntry) {
        const lo = objectiveEntry.loop_objective;
        if (lo && typeof lo === "object") {
            obj = lo;
        }
    }
    if (obj === null)
        return makeLoopHealth();
    const objective = obj.objective ?? "";
    const successCriteria = obj.success_criteria ?? [];
    const hardConstraints = obj.hard_constraints ?? [];
    // 1. goal_alignment
    let goalAlignment = 1.0;
    if (request.task) {
        const taskTokens = tokenize(request.task.toLowerCase());
        const objText = `${objective} ${successCriteria.join(" ")} ${hardConstraints.join(" ")}`.toLowerCase();
        const objTokens = tokenize(objText);
        goalAlignment =
            taskTokens.size && objTokens.size
                ? jaccard(taskTokens, objTokens)
                : 1.0;
    }
    // 2. constraint_integrity
    let constraintIntegrity = 1.0;
    if (request.last_round_result && hardConstraints.length) {
        const outputText = request.last_round_result.output_summary.toLowerCase();
        const present = hardConstraints.filter((c) => c
            .toLowerCase()
            .split(/\s+/)
            .some((word) => outputText.includes(word))).length;
        constraintIntegrity = present / hardConstraints.length;
    }
    // 3. drift_detected
    const driftDetected = countConsecutiveHashMismatches(loopId, vaultContext) >= 3;
    // 4. strategy_stability
    const recent = getRecentRounds(loopId, 3, vaultContext);
    const strategyStability = recent.length > 0
        ? recent.every((r) => r.quality_score >= 4)
        : true;
    // 5. task_continuity
    let taskContinuity = 1.0;
    const prevTask = getPreviousRoundTask(loopId, request.round - 1, vaultContext);
    if (prevTask && request.task) {
        const currTokens = tokenize(request.task.toLowerCase());
        const prevTokens = tokenize(prevTask.toLowerCase());
        taskContinuity =
            currTokens.size && prevTokens.size
                ? jaccard(currTokens, prevTokens)
                : 1.0;
    }
    // Escalation recommendation
    let escalation = "none";
    if (goalAlignment < 0.5) {
        escalation = "l2";
    }
    else if (constraintIntegrity < 0.7) {
        escalation = "l1";
    }
    else if (driftDetected) {
        escalation = "l2";
    }
    return makeLoopHealth({
        goal_alignment: Math.round(goalAlignment * 100) / 100,
        constraint_integrity: Math.round(constraintIntegrity * 100) / 100,
        drift_detected: driftDetected,
        strategy_stability: strategyStability,
        task_continuity: Math.round(taskContinuity * 100) / 100,
        escalation_recommended: escalation,
    });
}
function computeSuggestedNextTask(loopId, vaultContext) {
    if (vaultContext === null)
        return "";
    const results = vaultContext.results || [];
    for (const r of results) {
        const lineage = (r.loop_lineage || r.lineage || {});
        if (lineage.loop_id === loopId) {
            const task = r.task ?? r.user_intent ?? "";
            if (task)
                return `Previous round focused on: ${task.slice(0, 120)}`;
        }
    }
    return "";
}
export function computeAdvisories(request, vaultContext) {
    const warnings = [];
    let alignment = null;
    let health = null;
    let suggested = "";
    // goal_text_hash drift detection
    const currentHash = computeGoalTextHash(request.task);
    const prev = getPreviousRound(request.loop_id, request.round - 1, vaultContext);
    if (prev && currentHash !== prev.goal_text_hash && prev.goal_text_hash) {
        warnings.push(`goal_text_hash changed (${prev.goal_text_hash} → ${currentHash}) ` +
            "but goal_id matched — wording drift detected");
    }
    // Strategy collapse check
    if (strategyCollapse(request.loop_id, vaultContext)) {
        warnings.push("strategy_collapse: 3 consecutive low-quality rounds — " +
            "consider force_level=L2 rebuild");
    }
    // Repair cue detection
    if (detectsRepairSignal(request)) {
        warnings.push("repair signal detected — L1 patch applied");
    }
    // Task alignment
    if (request.next_task_proposal) {
        alignment = alignTask(request.next_task_proposal, request, vaultContext);
        if (alignment.escalation !== "none") {
            warnings.push(`task_alignment: ${alignment.warning}`);
        }
    }
    // Loop health
    const interval = Math.max(request.health_check_interval, 1);
    if (request.round % interval === 0) {
        health = checkLoopHealth(request.loop_id, request, vaultContext);
        if (health.escalation_recommended !== "none") {
            warnings.push(`loop_health recommends ${health.escalation_recommended}: ` +
                `goal_alignment=${health.goal_alignment.toFixed(2)}, ` +
                `constraint_integrity=${health.constraint_integrity.toFixed(2)}, ` +
                `task_continuity=${health.task_continuity.toFixed(2)}`);
        }
        if (health.drift_detected) {
            warnings.push("drift_detected: goal_text_hash diverged 3+ consecutive rounds");
        }
    }
    // Forward hint
    suggested = computeSuggestedNextTask(request.loop_id, vaultContext);
    return { warnings, suggestedNextTask: suggested, alignment, health };
}
// ═══════════════════════════════════════════════════════════════════════════
// Plan extraction
// ═══════════════════════════════════════════════════════════════════════════
function extractObjectiveFromPlan(planPath) {
    let text;
    try {
        text = readFileSync(planPath, "utf-8");
    }
    catch {
        return null;
    }
    const sections = {
        goal: [],
        success: [],
        constraints: [],
    };
    let currentSection = null;
    const goalPatterns = ["goal", "objective", "目标", "目的", "意图"];
    const successPatterns = [
        "success criteria", "acceptance criteria", "验收标准", "成功标准",
        "done when", "完成标准", "交付标准",
    ];
    const constraintPatterns = [
        "hard constraint", "constraint", "non-goal", "out of scope",
        "硬约束", "约束", "非目标", "不做什么", "限制",
    ];
    for (const line of text.split("\n")) {
        const stripped = line.trim();
        const low = stripped
            .toLowerCase()
            .replace(/^#+\s*/, "");
        if (stripped.startsWith("#")) {
            if (goalPatterns.some((p) => low.includes(p))) {
                currentSection = "goal";
                continue;
            }
            if (successPatterns.some((p) => low.includes(p))) {
                currentSection = "success";
                continue;
            }
            if (constraintPatterns.some((p) => low.includes(p))) {
                currentSection = "constraints";
                continue;
            }
            currentSection = null;
            continue;
        }
        if (!currentSection)
            continue;
        if (/^[-*•]/.test(stripped)) {
            const item = stripped.replace(/^[-*•]\s*/, "").trim();
            if (item && item.length > 3) {
                sections[currentSection].push(item);
            }
        }
        else if (stripped && currentSection === "goal") {
            if (!sections.goal.length && stripped.length > 10) {
                sections.goal.push(stripped);
            }
        }
    }
    if (!Object.values(sections).some((v) => v.length))
        return null;
    return {
        objective: sections.goal[0] ?? "",
        success_criteria: sections.success,
        hard_constraints: sections.constraints,
    };
}
function computeLoopObjectiveFromTask(request, _vaultContext) {
    const task = request.task || "";
    const constraints = [...request.constraints_from_plan];
    let objective = task.trim().slice(0, 200);
    const successCriteria = [];
    const hardConstraints = [...constraints];
    if (/test|测试/i.test(task)) {
        successCriteria.push("All tests pass");
    }
    if (/compat|兼容/i.test(task)) {
        successCriteria.push("Backward compatibility maintained");
    }
    if (/security|安全|audit/i.test(task)) {
        successCriteria.push("No security vulnerabilities found");
    }
    // Try to extract richer objective from plan_source
    if (request.plan_source) {
        const planExtracted = extractObjectiveFromPlan(request.plan_source);
        if (planExtracted) {
            if (planExtracted.objective) {
                objective = planExtracted.objective;
            }
            if (planExtracted.success_criteria) {
                successCriteria.push(...planExtracted.success_criteria);
            }
            if (planExtracted.hard_constraints) {
                hardConstraints.push(...planExtracted.hard_constraints);
            }
        }
        else {
            hardConstraints.push(`Follow plan: ${request.plan_source}`);
        }
    }
    if (!successCriteria.length) {
        successCriteria.push("Task completed successfully");
    }
    if (!hardConstraints.length) {
        hardConstraints.push("Do not modify files outside scope");
    }
    return makeLoopObjective({
        objective,
        success_criteria: successCriteria,
        hard_constraints: hardConstraints,
        created_at_round: 1,
        loop_id: request.loop_id,
    });
}
// ═══════════════════════════════════════════════════════════════════════════
// Compilation — L0 / L1 / L2
// ═══════════════════════════════════════════════════════════════════════════
function compileL0(request, vaultContext, prevRound) {
    const prev = prevRound ??
        getPreviousRound(request.loop_id, request.round - 1, vaultContext);
    const cachedPrompt = prev?.prompt_text ?? "";
    if (cachedPrompt) {
        return makeLoopCompileResponse({
            status: "ok",
            prompt: cachedPrompt,
            recompile_level: "l0",
            diff_from_previous: `L0 cache hit — reusing prompt from round ${request.round - 1}`,
            lineage: [`${request.loop_id}:r${request.round}`],
            constraints_active: prev?.constraints_active ?? [],
            constraints_retired: [],
            technique_used: "cached",
            loop_id: request.loop_id,
            round: request.round,
            goal_id: deriveGoalId(request.loop_id, request.task, request.goal_id),
            goal_text_hash: computeGoalTextHash(request.task),
            plan_source: request.plan_source,
            warnings: [],
        });
    }
    // Auto-escalate: no cached prompt → delegate to L2
    const l2Response = compileL2(request, vaultContext);
    l2Response.recompile_level = "l0";
    l2Response.diff_from_previous =
        `L0 auto-escalated to L2 — no cached prompt available from round ${request.round - 1}`;
    return l2Response;
}
function compileL1(request, vaultContext, prevRound) {
    const prev = prevRound ??
        getPreviousRound(request.loop_id, request.round - 1, vaultContext);
    const goalId = deriveGoalId(request.loop_id, request.task, request.goal_id);
    const newConstraints = [...request.constraints_from_plan];
    let activeRaw = [...(prev?.constraints_active ?? []), ...newConstraints];
    // Deduplicate preserving order
    activeRaw = [...new Set(activeRaw)];
    // v3.5: Constraint retirement
    const { active, retired } = computeConstraintRetirement(activeRaw, request.loop_id, request.round, vaultContext);
    // v3.5: Rolling summary
    const rollingSummary = buildRollingSummary(request.loop_id, request.round, vaultContext);
    const rollingText = formatRollingSummaryForPrompt(rollingSummary);
    const violations = request.last_round_result?.constraint_violations ?? [];
    const diffParts = [];
    if (newConstraints.length) {
        diffParts.push(`new constraints: [${newConstraints.join(", ")}]`);
    }
    if (retired.length) {
        diffParts.push(`retired constraints: [${retired.join(", ")}]`);
    }
    if (violations.length) {
        diffParts.push(`violations from last round: [${violations.join(", ")}]`);
    }
    if (request.new_since_last_round) {
        diffParts.push(`delta: ${request.new_since_last_round.slice(0, 200)}`);
    }
    // Build patched prompt
    const lines = [
        `## Loop Round ${request.round} — L1 Patch`,
        "",
        `**Goal**: ${request.task}`,
        `**Loop ID**: ${request.loop_id}`,
        `**Goal ID**: ${goalId}`,
        "",
    ];
    if (rollingText) {
        lines.push(rollingText);
        lines.push("");
    }
    if (active.length) {
        lines.push("### Active Constraints (inherited + new, pruned)");
        for (const c of active)
            lines.push(`- ${c}`);
        lines.push("");
    }
    if (retired.length) {
        lines.push("### Retired Constraints (no recent activity)");
        for (const c of retired)
            lines.push(`- ~${c}~`);
        lines.push("");
    }
    if (violations.length) {
        lines.push("### Violations From Last Round (must fix)");
        for (const v of violations)
            lines.push(`- ${v}`);
        lines.push("");
    }
    if (request.new_since_last_round) {
        lines.push("### What Changed Since Last Round");
        lines.push(request.new_since_last_round);
        lines.push("");
    }
    if (request.last_round_result?.output_summary) {
        lines.push("### Last Round Summary");
        lines.push(request.last_round_result.output_summary);
        lines.push("");
    }
    lines.push("### Task");
    lines.push(request.task);
    return makeLoopCompileResponse({
        status: "ok",
        prompt: lines.join("\n"),
        recompile_level: "l1",
        diff_from_previous: diffParts.length ? diffParts.join("; ") : "Patch applied.",
        lineage: [`${request.loop_id}:r${request.round}`],
        constraints_active: active,
        constraints_retired: retired,
        technique_used: "patch",
        rolling_summary: rollingSummary,
        loop_id: request.loop_id,
        round: request.round,
        goal_id: goalId,
        goal_text_hash: computeGoalTextHash(request.task),
        plan_source: request.plan_source,
        warnings: [],
    });
}
export function compileL2(request, vaultContext) {
    const goalId = deriveGoalId(request.loop_id, request.task, request.goal_id);
    // v3.5: Adaptive technique routing
    const analysis = routeTechniqueAdaptive(request.task, vaultContext, request.loop_id);
    const technique = analysis.technique;
    const referenceFile = analysis.reference_file;
    // v3.5: Rolling summary
    const rollingSummary = buildRollingSummary(request.loop_id, request.round, vaultContext);
    const rollingText = formatRollingSummaryForPrompt(rollingSummary);
    // Generate loop objective at round 1 if not provided
    let loopObjective = null;
    if (request.round === 1) {
        if (request.loop_objective) {
            loopObjective = request.loop_objective;
        }
        else {
            loopObjective = computeLoopObjectiveFromTask(request, vaultContext);
        }
    }
    let constraints = [...request.constraints_from_plan];
    if (loopObjective) {
        constraints = [...new Set([...constraints, ...loopObjective.hard_constraints])];
    }
    // Build meta-instruction
    const lines = [
        `## PromptCraft L2 Compile — Round ${request.round}`,
        "",
        "Read the technique reference BEFORE generating the prompt:",
        `  Technique:  ${technique}`,
        `  Reference:  ${referenceFile}`,
        `  Rationale:  ${analysis.rationale}`,
        "",
    ];
    if (rollingText) {
        lines.push(rollingText);
        lines.push("");
    }
    if (loopObjective) {
        lines.push("### Loop Objective (Anchor)");
        lines.push(`**Objective**: ${loopObjective.objective}`);
        if (loopObjective.success_criteria.length) {
            lines.push("**Success Criteria**:");
            for (const sc of loopObjective.success_criteria)
                lines.push(`- ${sc}`);
        }
        if (loopObjective.hard_constraints.length) {
            lines.push("**Hard Constraints**:");
            for (const hc of loopObjective.hard_constraints)
                lines.push(`- ${hc}`);
        }
        lines.push("");
    }
    if (constraints.length) {
        lines.push("### Active Constraints");
        for (const c of constraints)
            lines.push(`- ${c}`);
        lines.push("");
    }
    if (request.plan_source) {
        lines.push(`**Plan Source**: ${request.plan_source}`);
        lines.push("");
    }
    lines.push("### Task");
    lines.push(request.task);
    lines.push("");
    if (request.domain) {
        lines.push(`**Domain**: ${request.domain}`);
        lines.push("");
    }
    lines.push("### Loop Identity");
    lines.push(`- Loop ID: \`${request.loop_id}\``);
    lines.push(`- Goal ID: \`${goalId}\``);
    lines.push(`- Round: ${request.round}`);
    lines.push("");
    lines.push("### Generation Instructions");
    lines.push(`1. Read \`${referenceFile}\` — study its structure rules, section count, and format requirements`);
    lines.push("2. Generate a complete prompt following that technique's structure");
    lines.push("3. Inject all hard constraints and the loop objective into the prompt");
    lines.push("4. If Cross-Round Summary is present above, incorporate its recurring issues and key lessons");
    lines.push("5. The prompt must be self-contained — ready for a coding agent to execute");
    lines.push("6. Output only the generated prompt — no preamble, no meta-commentary");
    return makeLoopCompileResponse({
        status: "ok",
        prompt: lines.join("\n"),
        recompile_level: "l2",
        diff_from_previous: request.round === 1 || request.plan_source
            ? "Full recompile — new goal or first call."
            : "Full recompile — goal_id changed or strategy collapse.",
        lineage: [`${request.loop_id}:r${request.round}`],
        constraints_active: constraints,
        constraints_retired: [],
        technique_used: technique,
        reference_file: referenceFile,
        rolling_summary: rollingSummary,
        loop_id: request.loop_id,
        round: request.round,
        goal_id: goalId,
        goal_text_hash: computeGoalTextHash(request.task),
        loop_objective: loopObjective,
        plan_source: request.plan_source,
        warnings: [],
    });
}
// ═══════════════════════════════════════════════════════════════════════════
// Top-level compile — ties layers together
// ═══════════════════════════════════════════════════════════════════════════
export function compileLoop(request, vaultContext = null) {
    // Layer 1: Decide compile level
    const level = decideLevel(request, vaultContext);
    // Compile at the decided level
    let response;
    if (level === "l0") {
        response = compileL0(request, vaultContext);
    }
    else if (level === "l1") {
        response = compileL1(request, vaultContext);
    }
    else {
        response = compileL2(request, vaultContext);
    }
    // Layer 2: Compute advisories
    const { warnings, suggestedNextTask, alignment, health } = computeAdvisories(request, vaultContext);
    // Merge advisories into response
    response.warnings = warnings;
    response.suggested_next_task = suggestedNextTask;
    response.task_alignment = alignment;
    response.loop_health = health;
    response.recompile_level = level;
    return response;
}
//# sourceMappingURL=loop-compiler.js.map