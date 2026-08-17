import { createHash, randomUUID } from "node:crypto";
import type {
  PlanChangeRequest,
  PlanRiskTag,
  PlanStep,
  StructuredPlan,
  WorkflowProgress,
  WorkflowState,
  ApprovalPolicy,
  PlanningProfile,
  PlanChangeAssessment,
  PlanChangeImpact,
  PlanDiagnostic,
} from "./protocol.js";
import { stableClaimId } from "./round-report.js";

export const HIGH_RISK_TAGS: readonly PlanRiskTag[] = [
  "destructive_workspace",
  "data_migration",
  "production_change",
  "credentials_or_permissions",
  "external_side_effect",
  "public_api_break",
] as const;

export interface PlanValidationOptions {
  maxSteps: number;
  executableHorizon: number;
  allowHistoricalStatuses?: boolean;
  requiredConstraints?: string[];
  planningProfile?: PlanningProfile;
}

export interface PlanValidationResult {
  valid: boolean;
  errors: string[];
  warnings: string[];
  readyStepIds: string[];
  riskTags: PlanRiskTag[];
  diagnostics: PlanDiagnostic[];
}

export interface PlanRefinementLink {
  sourceStepId: string;
  childStepIds: string[];
}

function normalized(values: string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}

function coverage(plan: StructuredPlan, field: "successCriteria" | "constraints"): string[] {
  const covered = new Set(plan.steps.flatMap((step) => step[field]));
  return normalized(plan[field]).filter((item) => !covered.has(item));
}

function findCycle(steps: PlanStep[]): string[] | null {
  const graph = new Map(steps.map((step) => [step.id, step.dependsOn]));
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const path: string[] = [];
  const visit = (id: string): string[] | null => {
    if (visiting.has(id)) return [...path.slice(path.indexOf(id)), id];
    if (visited.has(id)) return null;
    visiting.add(id);
    path.push(id);
    for (const dep of graph.get(id) ?? []) {
      const cycle = visit(dep);
      if (cycle) return cycle;
    }
    path.pop();
    visiting.delete(id);
    visited.add(id);
    return null;
  };
  for (const step of steps) {
    const cycle = visit(step.id);
    if (cycle) return cycle;
  }
  return null;
}

export function computeReadyStepIds(plan: StructuredPlan): string[] {
  const done = new Set(plan.steps.filter((step) => step.status === "done" || step.status === "canceled").map((step) => step.id));
  return plan.steps
    .filter((step) =>
      step.status !== "done" && step.status !== "canceled" && step.status !== "blocked" &&
      step.dependsOn.every((dependency) => done.has(dependency)))
    .map((step) => step.id);
}

export function validatePlan(
  plan: StructuredPlan,
  options: PlanValidationOptions,
): PlanValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];
  const diagnostics: PlanDiagnostic[] = [];
  const addDiagnostic = (diagnostic: PlanDiagnostic): void => { diagnostics.push(diagnostic); };
  if (!plan.objective.trim()) errors.push("plan.objective must be non-empty");
  if (plan.steps.length === 0) errors.push("plan.steps must contain at least one step");
  if (plan.steps.length > options.maxSteps) errors.push(`plan.steps exceeds maximum ${options.maxSteps}`);
  const requiredConstraints = normalized(options.requiredConstraints ?? []);
  const planConstraints = new Set(normalized(plan.constraints));
  const missingRequiredConstraints = requiredConstraints.filter((item) => !planConstraints.has(item));
  if (missingRequiredConstraints.length) {
    errors.push(`plan omits session hard constraints: ${missingRequiredConstraints.join(" | ")}`);
    for (const constraint of missingRequiredConstraints) addDiagnostic({
      code: "uncovered_constraint", severity: "error", path: "constraints", message: `Session hard constraint is not covered: ${constraint}`,
      repairHint: `Add the exact constraint to plan.constraints and to a step's constraints: ${constraint}`,
    });
  }

  const ids = new Set<string>();
  for (const step of plan.steps) {
    if (!/^ps-[a-zA-Z0-9][a-zA-Z0-9_-]{2,63}$/.test(step.id)) {
      errors.push(`invalid plan step ID: ${step.id}`);
    } else if (ids.has(step.id)) {
      errors.push(`duplicate plan step ID: ${step.id}`);
    }
    ids.add(step.id);
    if (!step.title.trim()) errors.push(`${step.id}: title must be non-empty`);
    if (!options.allowHistoricalStatuses && !["pending", "ready"].includes(step.status)) {
      errors.push(`${step.id}: initial plan status must be pending or ready`);
    }
    if (!options.allowHistoricalStatuses && step.refinesStepId !== undefined) {
      errors.push(`${step.id}: initial plan steps cannot declare refinesStepId`);
      addDiagnostic({ code: "invalid_refinement", severity: "error", path: `steps.${step.id}.refinesStepId`, stepId: step.id,
        message: `${step.id} declares refinesStepId in an initial plan`, repairHint: "Remove refinesStepId from the initial plan; use it only in a later plan update." });
    }
    if (step.refinement === "executable" && step.kind === "outline") {
      errors.push(`${step.id}: outline kind cannot use executable refinement`);
    }
    if (step.kind === "executable" && step.refinement !== "executable") {
      errors.push(`${step.id}: executable step must be fully refined`);
    }
    if (step.kind === "executable" && step.acceptanceCriteria.length === 0) {
      errors.push(`${step.id}: executable step requires acceptance criteria`);
      addDiagnostic({ code: "missing_acceptance", severity: "error", path: `steps.${step.id}.acceptanceCriteria`, stepId: step.id,
        message: `${step.id} has no acceptance criteria`, repairHint: "Add at least one observable acceptance criterion." });
    }
    if (step.kind === "executable" && step.evidenceRequirements.length === 0) {
      errors.push(`${step.id}: executable step requires evidence requirements`);
      addDiagnostic({ code: "missing_evidence_requirement", severity: "error", path: `steps.${step.id}.evidenceRequirements`, stepId: step.id,
        message: `${step.id} has no evidence requirement`, repairHint: "Add at least one concrete file, check, provider, or gate evidence requirement." });
    }
    if (step.kind === "external_gate" && step.evidenceRequirements.length === 0) {
      errors.push(`${step.id}: external gate requires evidence requirements`);
    }
  }
  for (const step of plan.steps) {
    for (const dependency of step.dependsOn) {
       if (!ids.has(dependency)) {
         errors.push(`${step.id}: unknown dependency ${dependency}`);
         addDiagnostic({ code: "unknown_dependency", severity: "error", path: `steps.${step.id}.dependsOn`, stepId: step.id, relatedStepId: dependency,
           message: `${step.id} depends on unknown step ${dependency}`, repairHint: "Use an existing ps-* ID or remove the dependency if no artifact or gate is consumed." });
       }
      if (dependency === step.id) errors.push(`${step.id}: step cannot depend on itself`);
    }
  }
  const cycle = findCycle(plan.steps);
  if (cycle) {
    errors.push(`plan dependency cycle: ${cycle.join(" -> ")}`);
    addDiagnostic({ code: "dependency_cycle", severity: "error", path: "steps.dependsOn", message: `Dependency cycle: ${cycle.join(" -> ")}`,
      repairHint: "Remove one dependency edge from the cycle; dependsOn must represent a real work-product dependency." });
  }

  const missingCriteria = coverage(plan, "successCriteria");
  if (missingCriteria.length) {
    errors.push(`uncovered success criteria: ${missingCriteria.join(" | ")}`);
    for (const criterion of missingCriteria) addDiagnostic({ code: "uncovered_success_criterion", severity: "error", path: "successCriteria", message: `Success criterion is not covered: ${criterion}`,
      repairHint: "Assign this criterion to an outline or executable step's successCriteria." });
  }
  const missingConstraints = coverage(plan, "constraints");
  if (missingConstraints.length) {
    errors.push(`uncovered constraints: ${missingConstraints.join(" | ")}`);
    for (const constraint of missingConstraints) addDiagnostic({ code: "uncovered_constraint", severity: "error", path: "constraints", message: `Plan constraint is not covered: ${constraint}`,
      repairHint: "Assign this constraint to at least one step." });
  }

  const readyStepIds = computeReadyStepIds(plan);
  if (readyStepIds.length === 0 && plan.steps.some((step) => !["done", "canceled"].includes(step.status))) {
    errors.push("plan has no ready executable or outline step");
    addDiagnostic({ code: "no_ready_step", severity: "error", path: "steps", message: "Plan has no ready executable or outline step", repairHint: "Add a pending/ready root step or resolve its dependencies." });
  }
  const readyExecutable = readyStepIds.filter((id) => plan.steps.find((step) => step.id === id)?.kind === "executable");
  if (readyExecutable.length > options.executableHorizon) {
    warnings.push(`ready executable horizon ${readyExecutable.length} exceeds preferred ${options.executableHorizon}`);
  }
  const riskTags = collectPlanRiskTags(plan);
  diagnostics.sort((a, b) => a.severity.localeCompare(b.severity) || a.path.localeCompare(b.path) || a.code.localeCompare(b.code));
  return { valid: errors.length === 0, errors, warnings, readyStepIds, riskTags, diagnostics };
}

export function planRequiresApproval(plan: StructuredPlan): boolean {
  return collectPlanRiskTags(plan).length > 0;
}

export function collectPlanRiskTags(plan: StructuredPlan): PlanRiskTag[] {
  const declared = plan.steps.flatMap((step) => step.riskTags);
  const searchable = [
    plan.objective,
    ...plan.steps
      .filter((step) => step.kind === "executable" || step.kind === "outline")
      .flatMap((step) => [
      step.title,
      ...step.scope,
      ...step.acceptanceCriteria,
      ...step.evidenceRequirements,
      ]),
  ].join(" ").toLowerCase();
  const inferred: PlanRiskTag[] = [];
  const matches = (pattern: RegExp) => pattern.test(searchable);
  if (matches(/\b(rm\s+-rf|reset\s+--hard|recursive delete|destructive)\b|删除工作区|清空工作区/)) inferred.push("destructive_workspace");
  if (matches(/\b(database migration|schema migration|migrate database|migration)\b|数据迁移|[\\/._-]migrations?(?:[\\/._-]|$)/)) inferred.push("data_migration");
  if (matches(/\b(production|prod deploy|deploy to prod|release to production)\b|(?:^|[\s\\/._-])prod(?:$|[\s\\/._-])|生产环境|上线部署/)) inferred.push("production_change");
  if (matches(/\b(credentials?|permissions?|api keys?|secrets?)\b|凭据|密钥|权限/)) inferred.push("credentials_or_permissions");
  if (matches(/\b(publish|send email|webhook|payment|external side effect)\b|对外发布|外部副作用/)) inferred.push("external_side_effect");
  if (matches(/\b(public api|breaking change|api break)\b|公共接口|破坏性接口/)) inferred.push("public_api_break");
  return [...new Set([...declared, ...inferred])]
    .filter((tag): tag is PlanRiskTag => HIGH_RISK_TAGS.includes(tag));
}

export function criticalPlanChange(previous: StructuredPlan, next: StructuredPlan): boolean {
  const stable = (value: unknown) => JSON.stringify(value);
  if (previous.objective !== next.objective) return true;
  if (stable(previous.successCriteria) !== stable(next.successCriteria)) return true;
  if (stable(previous.constraints) !== stable(next.constraints)) return true;
  const previousSteps = new Map(previous.steps.map((step) => [step.id, step]));
  return next.steps.some((step) => {
    const old = previousSteps.get(step.id);
    if (!old) return false;
    // Outline -> executable is the normal rolling-refinement transition. Its
    // executable contract is expected to be filled in, but inherited scope,
    // dependencies, criteria, and risk semantics remain approval-sensitive.
    const outlineRefinement = old.kind === "outline" && step.kind === "executable";
    const fields: Array<keyof PlanStep> = outlineRefinement
      ? ["title", "dependsOn", "scope", "successCriteria", "constraints", "riskTags"]
      : [
        "title", "kind", "dependsOn", "scope", "successCriteria", "constraints",
        "acceptanceCriteria", "evidenceRequirements", "refinement", "riskTags",
      ];
    return fields.some((field) => stable(old[field]) !== stable(step[field]));
  });
}

function normalizedPlanForComparison(plan: StructuredPlan): unknown {
  const sort = (values: string[]) => [...new Set(values.map((item) => item.trim()))].sort();
  return {
    objective: plan.objective.trim(),
    successCriteria: sort(plan.successCriteria),
    constraints: sort(plan.constraints),
    steps: [...plan.steps].sort((a, b) => a.id.localeCompare(b.id)).map((step) => ({
      ...step,
      dependsOn: sort(step.dependsOn), scope: sort(step.scope), successCriteria: sort(step.successCriteria),
      constraints: sort(step.constraints), acceptanceCriteria: sort(step.acceptanceCriteria), evidenceRequirements: sort(step.evidenceRequirements),
      riskTags: sort(step.riskTags),
    })),
  };
}

/** Classifies a plan replacement without trusting Agent-declared impact. */
export function assessPlanChange(previous: StructuredPlan | null, next: StructuredPlan): PlanChangeAssessment {
  if (!previous || JSON.stringify(normalizedPlanForComparison(previous)) === JSON.stringify(normalizedPlanForComparison(next))) {
    return { impact: "none", changedPaths: [], reasons: [] };
  }
  const changedPaths: string[] = [];
  const reasons: string[] = [];
  const previousSteps = new Map(previous.steps.map((step) => [step.id, step]));
  const nextSteps = new Map(next.steps.map((step) => [step.id, step]));
  if (previous.objective !== next.objective) { changedPaths.push("objective"); reasons.push("objective changed"); }
  if (JSON.stringify(normalized(previous.successCriteria)) !== JSON.stringify(normalized(next.successCriteria))) { changedPaths.push("successCriteria"); reasons.push("global success criteria changed"); }
  if (JSON.stringify(normalized(previous.constraints)) !== JSON.stringify(normalized(next.constraints))) { changedPaths.push("constraints"); reasons.push("hard constraints changed"); }
  const riskChanged = JSON.stringify(collectPlanRiskTags(previous).sort()) !== JSON.stringify(collectPlanRiskTags(next).sort());
  for (const id of new Set([...previousSteps.keys(), ...nextSteps.keys()])) {
    const old = previousSteps.get(id);
    const current = nextSteps.get(id);
    if (!old && current) { changedPaths.push(`steps.${id}`); reasons.push(`step ${id} added`); continue; }
    if (old && !current) { changedPaths.push(`steps.${id}`); reasons.push(`step ${id} removed`); continue; }
    if (!old || !current) continue;
    const normalOutlineRefinement = old.kind === "outline" && old.refinement === "outline" && current.kind === "executable" && current.refinement === "executable";
    const fields: Array<keyof PlanStep> = ["title", "kind", "dependsOn", "scope", "successCriteria", "constraints", "acceptanceCriteria", "evidenceRequirements", "refinement", "riskTags", "refinesStepId"];
    for (const field of fields) {
      if (JSON.stringify(old[field]) === JSON.stringify(current[field])) continue;
      changedPaths.push(`steps.${id}.${String(field)}`);
      if (field === "title" || field === "scope" || field === "refinesStepId") reasons.push(`tactical step detail changed: ${id}.${String(field)}`);
      else if (normalOutlineRefinement) reasons.push(`normal outline refinement: ${id}.${String(field)}`);
      else if (["acceptanceCriteria", "evidenceRequirements", "dependsOn", "successCriteria", "constraints"].includes(String(field))) reasons.push(`step contract changed: ${id}.${String(field)}`);
      else reasons.push(`step structure changed: ${id}.${String(field)}`);
    }
  }
  if (riskChanged) return { impact: "risk", changedPaths: [...new Set(changedPaths)].sort(), reasons: [...new Set([...reasons, "declared or inferred risk tags changed"])].sort() };
  // Filling an outline is a tactical operation, including the normal
  // transition from outline -> executable and its title/scope details. The
  // transition becomes contractual only when it changes the real dependency
  // or evidence contract (or risk semantics, handled above).
  const hasContractStepChange = [...previousSteps.keys()].some((id) => {
    const old = previousSteps.get(id);
    const current = nextSteps.get(id);
    if (!old || !current) return false;
    const normalOutlineRefinement = old.kind === "outline" && old.refinement === "outline" &&
      current.kind === "executable" && current.refinement === "executable";
    const changed = (field: keyof PlanStep): boolean => JSON.stringify(old[field]) !== JSON.stringify(current[field]);
    if (normalOutlineRefinement) {
      return (["dependsOn", "successCriteria", "constraints", "riskTags"] as Array<keyof PlanStep>)
        .some(changed);
    }
    return (["kind", "dependsOn", "scope", "successCriteria", "constraints", "acceptanceCriteria",
      "evidenceRequirements", "refinement", "riskTags"] as Array<keyof PlanStep>).some(changed);
  });
  const normalRefinementOnly = !hasContractStepChange && reasons.every((reason) =>
    /normal outline refinement|tactical step detail|step .* added/.test(reason));
  const contract = !normalRefinementOnly && (changedPaths.some((path) => /objective|successCriteria|constraints|dependsOn|acceptanceCriteria|evidenceRequirements|kind|refinement|riskTags/.test(path)) ||
    reasons.some((reason) => /contract|structure/.test(reason)) || /production|credential|migration|external side effect|public api/i.test(JSON.stringify(next)));
  const impact: PlanChangeImpact = contract ? "contract" : "tactical";
  return { impact, changedPaths: [...new Set(changedPaths)].sort(), reasons: [...new Set(reasons)].sort() };
}

function collectStepRiskTags(step: PlanStep): PlanRiskTag[] {
  return collectPlanRiskTags({
    objective: "",
    successCriteria: [],
    constraints: [],
    steps: [step],
  });
}

export function validatePlanReplacement(previous: StructuredPlan, next: StructuredPlan): string[] {
  const errors: string[] = [];
  const nextById = new Map(next.steps.map((step) => [step.id, step]));
  const previousById = new Map(previous.steps.map((step) => [step.id, step]));
  const refinedSources = new Set<string>();

  for (const step of next.steps) {
    if (!step.refinesStepId) continue;
    const source = previousById.get(step.refinesStepId);
    if (!source) {
      errors.push(`${step.id}: refinement source does not exist in base plan: ${step.refinesStepId}`);
      continue;
    }
    if (previousById.has(step.id)) {
      errors.push(`${step.id}: only newly introduced steps may declare refinesStepId`);
    }
    if (source.kind !== "outline" || source.refinement !== "outline") {
      errors.push(`${step.id}: refinement source must be an outline: ${source.id}`);
    }
    if (["done", "canceled"].includes(source.status)) {
      errors.push(`${step.id}: refinement source is already terminal: ${source.id}`);
    }
    if (step.kind !== "executable" || step.refinement !== "executable") {
      errors.push(`${step.id}: refinement children must be executable steps`);
    }
    const sourceRisks = collectStepRiskTags(source);
    const childRisks = collectStepRiskTags(step);
    const missingInheritedRisks = sourceRisks.filter((tag) => !childRisks.includes(tag));
    if (missingInheritedRisks.length) {
      errors.push(`${step.id}: refinement child must inherit risk tags from ${source.id}: ${missingInheritedRisks.join(", ")}`);
    }
    refinedSources.add(source.id);
  }
  for (const step of previous.steps.filter((candidate) => candidate.status === "done")) {
    const replacement = nextById.get(step.id);
    if (!replacement) {
      errors.push(`completed step cannot be deleted: ${step.id}`);
      continue;
    }
    if (replacement.status !== "done") {
      errors.push(`completed step must remain done: ${step.id}`);
    }
    const immutableOld = { ...step, status: "done" };
    const immutableNew = { ...replacement, status: "done" };
    if (JSON.stringify(immutableOld) !== JSON.stringify(immutableNew)) {
      errors.push(`completed step cannot be changed: ${step.id}`);
    }
  }
  for (const step of next.steps) {
    const previousStep = previous.steps.find((candidate) => candidate.id === step.id);
    if (!previousStep && !["pending", "ready", "canceled"].includes(step.status)) {
      errors.push(`new step cannot start in server-owned status ${step.status}: ${step.id}`);
    }
    if (previousStep && previousStep.status !== "done" &&
        ["active", "done", "blocked"].includes(step.status) &&
        step.status !== previousStep.status) {
      errors.push(`plan update cannot assign server-owned status ${step.status}: ${step.id}`);
    }
  }
  for (const step of previous.steps.filter((candidate) =>
    candidate.kind === "outline" && !["done", "canceled"].includes(candidate.status))) {
    if (!nextById.has(step.id) && !refinedSources.has(step.id)) {
      errors.push(`outline cannot be removed without cancellation or refinement lineage: ${step.id}`);
    }
  }
  return errors;
}

/** Structured counterpart of validatePlanReplacement; string errors remain the
 * internal compatibility surface while callers can render deterministic fixes. */
export function validatePlanReplacementDiagnostics(previous: StructuredPlan, next: StructuredPlan): PlanDiagnostic[] {
  const diagnostics: PlanDiagnostic[] = [];
  const errors = validatePlanReplacement(previous, next);
  for (const error of errors) {
    const stepId = error.match(/^(ps-[^: ]+)/)?.[1];
    let code: PlanDiagnostic["code"] = "completed_step_mutation";
    let repairHint = "Restore the previous plan state and submit against the exact current baseVersion.";
    if (/unknown|does not exist/.test(error)) { code = "invalid_refinement"; repairHint = "Reference an existing non-terminal outline from the exact baseVersion."; }
    else if (/inherit risk tags/.test(error)) { code = "risk_tag_not_inherited"; repairHint = "Copy every inherited high-risk tag to the refinement child."; }
    else if (/outline cannot be removed/.test(error)) { code = "invalid_refinement"; repairHint = "Keep the outline, cancel it with a reason, or add refinesStepId children."; }
    diagnostics.push({ code, severity: "error", path: stepId ? `steps.${stepId}` : "steps", stepId, message: error, repairHint });
  }
  return diagnostics.sort((a, b) => a.path.localeCompare(b.path) || a.code.localeCompare(b.code));
}

export function deriveRefinementLinks(plan: StructuredPlan): PlanRefinementLink[] {
  const grouped = new Map<string, string[]>();
  for (const step of plan.steps) {
    if (!step.refinesStepId) continue;
    const children = grouped.get(step.refinesStepId) ?? [];
    children.push(step.id);
    grouped.set(step.refinesStepId, children);
  }
  return [...grouped.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([sourceStepId, childStepIds]) => ({
      sourceStepId,
      childStepIds: [...new Set(childStepIds)].sort(),
    }));
}

export function selectActiveStep(plan: StructuredPlan): PlanStep | null {
  const ready = new Set(computeReadyStepIds(plan));
  return plan.steps.find((step) => ready.has(step.id)) ?? null;
}

export function makeApprovalId(planVersion: number, plan: StructuredPlan): string {
  const digest = createHash("sha256").update(JSON.stringify(plan)).digest("hex").slice(0, 10);
  return `pa-${planVersion}-${digest}-${randomUUID().slice(0, 8)}`;
}

export function createWorkflowState(
  planSource?: string,
  baselineConstraints: string[] = [],
  approvalPolicy: ApprovalPolicy = "risk_only",
  planningProfile: PlanningProfile = "minimal",
): WorkflowState {
  return {
    phase: "planning",
    approvalPolicy,
    planningProfile,
    planVersion: null,
    plan: null,
    revisions: [],
    approvalId: null,
    approvalHistory: [],
    activeStepId: null,
    planningPrompt: null,
    planSource: planSource ?? null,
    baselineConstraints: normalized(baselineConstraints),
    pendingPlanChange: null,
    queuedPlanChange: null,
    auditVerifiedCriteria: [],
    blockingGate: null,
    advancementHistory: [],
  };
}

export function buildPlanningPrompt(task: string, constraints: string[], planningProfile: PlanningProfile = "minimal", diagnostics: PlanDiagnostic[] = []): string {
  return [
    "# LoopForge Planning",
    "",
    "Mode: planning.",
    "Research the repository and submit a structured execution plan. Do not modify code in this phase.",
    "",
    `Objective: ${task}`,
    constraints.length ? `Hard constraints:\n${constraints.map((item) => `- ${item}`).join("\n")}` : "Hard constraints: none supplied.",
    "",
    `Planning profile: ${planningProfile}. Define the global objective, hard constraints, success criteria, current stage, and only the next 1-3 ready executable or outline nodes. ${planningProfile === "full" ? "Because this is a full profile, include the complete known topology." : "Do not invent distant implementation steps; leave later stages as outlines or refine them at the next boundary."}`,
    "Each executable step needs scope, acceptance criteria, evidence requirements, dependencies, and risk tags.",
    "Use dependsOn only when a downstream step consumes an artifact, decision, gate, or serialized resource from the dependency.",
    "Do not use refinesStepId in the initial plan. Later plan updates use it to expand one existing outline into executable children.",
    ...(diagnostics.length ? ["Plan diagnostics to repair:", ...diagnostics.slice(0, 12).map((item) => `- [${item.code}] ${item.path}: ${item.message} Hint: ${item.repairHint}`)] : []),
    "Submit the result with loopforge_plan_submit.",
  ].join("\n");
}

export function buildRefinementPrompt(plan: StructuredPlan, step: PlanStep): string {
  return [
    "# LoopForge Plan Refinement",
    "",
    "Mode: refine_plan.",
    `The next ready node ${step.id} (${step.title}) is still an outline.`,
    "Inspect current repository evidence and submit a full replacement plan with loopforge_plan_update.",
    `Refine this node into one or more new executable steps with refinesStepId=${step.id}.`,
    "Preserve completed history and stable IDs. Do not create dependencies that express ordering without real work flow.",
    `Current objective: ${plan.objective}`,
  ].join("\n");
}

export function buildPlanChangePrompt(
  plan: StructuredPlan,
  request: PlanChangeRequest,
  discoveries: string[] = [],
): string {
  return [
    "# LoopForge Plan Change Required",
    "",
    "Mode: refine_plan.",
    `Current objective: ${plan.objective}`,
    `Reason: ${request.reason}`,
    `Affected IDs: ${request.affectedIds.join(", ")}`,
    discoveries.length ? `New evidence:\n${discoveries.map((item) => `- ${item}`).join("\n")}` : "",
    "Submit a full replacement plan with loopforge_plan_update against the exact baseVersion.",
    "Do not modify code while the workflow is in planning.",
  ].filter(Boolean).join("\n");
}

export function buildAuditPrompt(plan: StructuredPlan): string {
  return [
    "# LoopForge Final Audit",
    "",
    "Mode: audit.",
    `Objective: ${plan.objective}`,
    "Verify every success criterion and hard constraint against actual repository and command evidence.",
    "Do not claim completion from implementation summaries alone. Run required checks and submit loopforge_next with the exact roundId and compact report.",
    "A successful audit uses status=completed and evidence claims covering every cr-* target.",
  ].join("\n");
}

export function computeWorkflowProgress(workflow: WorkflowState): WorkflowProgress {
  const plan = workflow.plan;
  const executable = plan?.steps.filter((step) => step.kind === "executable") ?? [];
  const external = plan?.steps.filter((step) => step.kind === "external_gate") ?? [];
  const outlines = plan?.steps.filter((step) => step.kind === "outline" || step.refinement === "outline") ?? [];
  const successCriteria = plan?.successCriteria ?? [];
  const covered = successCriteria.filter((criterion) =>
    plan?.steps.some((step) => step.successCriteria.includes(criterion)));
  const provisionallyMet = successCriteria.filter((criterion) => {
    const owners = plan?.steps.filter((step) =>
      step.kind !== "outline" && step.successCriteria.includes(criterion)) ?? [];
    return owners.length > 0 && owners.every((step) => step.status === "done");
  });
  const auditVerified = new Set(workflow.auditVerifiedCriteria);
  const allImplementationDone = executable.every((step) => step.status === "done" || step.status === "canceled");
  const allGatesDone = external.every((step) => step.status === "done");
  let readiness: WorkflowProgress["readiness"];
  if (workflow.phase === "planning") readiness = "planning";
  else if (workflow.phase === "awaiting_approval") readiness = "awaiting_approval";
  else if (workflow.phase === "auditing") readiness = "auditing";
  else if (workflow.phase === "terminal" && workflow.blockingGate) readiness = "awaiting_external_gate";
  else if (workflow.phase === "terminal" && successCriteria.every((criterion) => auditVerified.has(stableClaimId("cr", criterion)))) readiness = "completed";
  else if (workflow.phase === "terminal") readiness = "blocked";
  else if (allImplementationDone && outlines.length === 0 && allGatesDone) readiness = "ready_for_audit";
  else readiness = "executing";
  return {
    planVersion: workflow.planVersion,
    planSteps: {
      total: executable.length,
      done: executable.filter((step) => step.status === "done").length,
      active: executable.filter((step) => step.status === "active").length,
      pending: executable.filter((step) => step.status === "pending" || step.status === "ready").length,
      blocked: executable.filter((step) => step.status === "blocked").length,
      canceled: executable.filter((step) => step.status === "canceled").length,
    },
    outlineRemaining: outlines.filter((step) => !["done", "canceled"].includes(step.status)).length,
    successCriteria: {
      total: successCriteria.length,
      covered: covered.length,
      provisionallyMet: provisionallyMet.length,
      auditVerified: successCriteria.filter((criterion) => auditVerified.has(stableClaimId("cr", criterion))).length,
      remaining: successCriteria.filter((criterion) => !auditVerified.has(stableClaimId("cr", criterion))).length,
    },
    externalGates: {
      total: external.length,
      satisfied: external.filter((step) => step.status === "done").length,
      pending: external.filter((step) => step.status === "pending" || step.status === "ready" || step.status === "active").length,
      blocked: external.filter((step) => step.status === "blocked").length,
    },
    readiness,
  };
}
