import type { PlanChangeRequest, PlanRiskTag, PlanStep, StructuredPlan, WorkflowProgress, WorkflowState, ApprovalPolicy, PlanningProfile, PlanChangeAssessment, PlanDiagnostic } from "./protocol.js";
export declare const HIGH_RISK_TAGS: readonly PlanRiskTag[];
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
export declare function computeReadyStepIds(plan: StructuredPlan): string[];
export declare function validatePlan(plan: StructuredPlan, options: PlanValidationOptions): PlanValidationResult;
export declare function planRequiresApproval(plan: StructuredPlan): boolean;
export declare function collectPlanRiskTags(plan: StructuredPlan): PlanRiskTag[];
export declare function criticalPlanChange(previous: StructuredPlan, next: StructuredPlan): boolean;
/** Classifies a plan replacement without trusting Agent-declared impact. */
export declare function assessPlanChange(previous: StructuredPlan | null, next: StructuredPlan): PlanChangeAssessment;
export declare function validatePlanReplacement(previous: StructuredPlan, next: StructuredPlan): string[];
/** Structured counterpart of validatePlanReplacement; string errors remain the
 * internal compatibility surface while callers can render deterministic fixes. */
export declare function validatePlanReplacementDiagnostics(previous: StructuredPlan, next: StructuredPlan): PlanDiagnostic[];
export declare function deriveRefinementLinks(plan: StructuredPlan): PlanRefinementLink[];
export declare function selectActiveStep(plan: StructuredPlan): PlanStep | null;
export declare function makeApprovalId(planVersion: number, plan: StructuredPlan): string;
export declare function createWorkflowState(planSource?: string, baselineConstraints?: string[], approvalPolicy?: ApprovalPolicy, planningProfile?: PlanningProfile): WorkflowState;
export declare function buildPlanningPrompt(task: string, constraints: string[], planningProfile?: PlanningProfile, diagnostics?: PlanDiagnostic[]): string;
export declare function buildRefinementPrompt(plan: StructuredPlan, step: PlanStep): string;
export declare function buildPlanChangePrompt(plan: StructuredPlan, request: PlanChangeRequest, discoveries?: string[]): string;
export declare function buildAuditPrompt(plan: StructuredPlan): string;
export declare function computeWorkflowProgress(workflow: WorkflowState): WorkflowProgress;
//# sourceMappingURL=plan.d.ts.map