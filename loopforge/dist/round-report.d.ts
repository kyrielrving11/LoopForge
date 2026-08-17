import type { ProviderSnapshot } from "./evidence-provider.js";
import type { NormalizedRoundEvaluation, PlanStep, RoundEvidenceClaim, RoundEvidenceEnvelope, RoundReportV1, StructuredPlan, WorkflowPhase, ReportClaimTarget } from "./protocol.js";
export declare function parseRoundReport(value: unknown): RoundReportV1 | null;
export declare function stableClaimId(prefix: "ac" | "er" | "cr", text: string): string;
export declare function stepClaimTargets(step: PlanStep): Array<{
    id: string;
    text: string;
    kind: "acceptance" | "evidence";
}>;
export declare function auditClaimTargets(plan: StructuredPlan): Array<{
    id: string;
    text: string;
}>;
export declare function validateRoundReport(report: RoundReportV1, phase: WorkflowPhase, activeStep: PlanStep | null, plan: StructuredPlan | null, extraTargets?: ReportClaimTarget[]): string[];
export declare function normalizeRoundReport(report: RoundReportV1, phase: WorkflowPhase, activeStepId: string | null, _requiredClaimIds: string[]): NormalizedRoundEvaluation;
export declare function mergeRuntimeEvidence(evaluation: NormalizedRoundEvaluation, snapshots: ProviderSnapshot[], previous?: NormalizedRoundEvaluation): RoundEvidenceEnvelope;
export declare function claimHasVerifiedEvidenceForEnvelope(envelope: RoundEvidenceEnvelope, claim: RoundEvidenceClaim): boolean;
//# sourceMappingURL=round-report.d.ts.map