import type { VaultEntry } from "./backends/interface.js";
import type { GraphSliceSummary, NormalizedRoundEvaluation, WorkflowState } from "./protocol.js";
export type GovernanceGraphNodeKind = "objective" | "criterion" | "constraint" | "plan_version" | "step" | "round" | "attempt" | "claim" | "evidence" | "approval" | "outcome";
export type GovernanceGraphEdgeKind = "defines" | "contains" | "depends_on" | "refines" | "covers" | "constrained_by" | "attempts" | "produced" | "supports" | "contradicts" | "approved_by" | "supersedes" | "restored_from";
export type GovernanceGraphDiagnosticCode = "orphan_refinement" | "orphan_claim" | "blocked_descendants" | "plan_execution_divergence" | "unverified_completion_edge" | "approval_version_mismatch" | "malformed_event";
export interface GovernanceGraphNode {
    id: string;
    kind: GovernanceGraphNodeKind;
    label: string;
    status?: string;
    planVersion?: number | null;
    round?: number;
}
export interface GovernanceGraphEdge {
    id: string;
    kind: GovernanceGraphEdgeKind;
    from: string;
    to: string;
    planVersion?: number | null;
    round?: number;
}
export interface GovernanceGraphDiagnostic {
    code: GovernanceGraphDiagnosticCode;
    severity: "warn" | "error";
    detail: string;
    nodeId?: string;
}
export interface GovernanceGraphView {
    schemaVersion: 1;
    loopId: string;
    effectivePlanVersion: number | null;
    nodes: GovernanceGraphNode[];
    edges: GovernanceGraphEdge[];
    diagnostics: GovernanceGraphDiagnostic[];
}
export interface GovernanceGraphSummary {
    nodeCount: number;
    edgeCount: number;
    effectivePlanVersion: number | null;
    blockedDescendants: number;
    errorCount: number;
    warningCount: number;
}
export declare function buildGovernanceGraph(loopId: string, entries: VaultEntry[], options?: {
    throughRound?: number;
}): GovernanceGraphView;
export declare function summarizeGovernanceGraph(graph: GovernanceGraphView): GovernanceGraphSummary;
export declare function graphEntriesHash(entries: VaultEntry[]): string;
export declare function buildGraphSlice(workflow: WorkflowState, previous?: NormalizedRoundEvaluation): GraphSliceSummary;
//# sourceMappingURL=governance-graph.d.ts.map