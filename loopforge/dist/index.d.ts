/** Supported LoopForge 3.0 public API. */
export { LOOPFORGE_VERSION } from "./version.js";
export type { CapabilityPreflight, ApprovalPolicy, PlanningProfile, PlanChangeImpact, PlanChangeAssessment, PlanDiagnostic, PlanDiagnosticCode, ExternalGateBlock, GateResolution, PlanApprovalRecord, PlanChangeRequest, PlanRevisionRecord, PlanRiskTag, PlanStep, PlanStepKind, PlanStepStatus, RequiredAction, RoundReportV1, StoreResolutionDiagnostic, StructuredPlan, WorkflowPhase, WorkflowProgress, WorkflowReadiness, WorkflowState, RegressionObligation, WorkspaceBinding, WorkspaceRuntimeSummary, } from "./protocol.js";
export { HIGH_RISK_TAGS, collectPlanRiskTags, computeReadyStepIds, computeWorkflowProgress, criticalPlanChange, assessPlanChange, deriveRefinementLinks, planRequiresApproval, validatePlan, validatePlanReplacement, validatePlanReplacementDiagnostics, } from "./plan.js";
export type { PlanRefinementLink, PlanValidationOptions, PlanValidationResult } from "./plan.js";
export { auditClaimTargets, parseRoundReport, stableClaimId, stepClaimTargets, validateRoundReport, } from "./round-report.js";
//# sourceMappingURL=index.d.ts.map