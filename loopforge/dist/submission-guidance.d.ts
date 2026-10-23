/** The evaluation field guide and the submission-guidance projection.
 *
 * This module is the ONE source for what an evaluation field means, when it
 * applies, what a legal example looks like, and where a submitted value goes.
 * The MCP tool schema, the round prompt's evaluation block, and
 * `submission_guidance` all read it; none of them owns a second copy.
 *
 * It is an interface description, not state: it performs no I/O, persists
 * nothing, and makes no business decision. The runtime's submission boundary
 * remains the only validator.
 */
import type { ActiveContractView } from "./round-contract.js";
import type { ContractItemStatusView } from "./contract-items.js";
import type { CommittedRoundView } from "./committed-round.js";
import type { CriterionStatus, PromptArtifact, SubGoal, SubmissionGuidance, VerificationFlag } from "./protocol.js";
export type FieldNature = "report" | "claim" | "proposal" | "transition" | "control";
export interface FieldGuide {
    /** Dotted path, e.g. `execution_report.files_changed`. */
    path: string;
    /** One-line meaning. */
    purpose: string;
    /** The event that makes this field applicable. */
    when: string;
    nature: FieldNature;
    /** Where a submitted value goes after it is committed. */
    downstream: string;
    /** The `loopforge_next.evaluation` schema description. */
    toolDescription: string;
    /** True when the value is saved as a report but never auto-expands into
     *  derived state (e.g. worker-reported discoveries). */
    reportOnly?: boolean;
    /** One of the four strict core fields. */
    core?: boolean;
    /** v3.9.2: a compact trigger sentence used only by the prompt checklist. */
    decision?: string;
    /** 3.9.3: the ONLY marker of compact-checklist membership. The set is
     *  level-independent: L0/L1/L2 differ in state density, never in which
     *  evaluation fields they offer. Fields with dedicated contract/sub-goal
     *  renderers leave this unset. */
    compact?: true;
    /** Deterministic order inside the compact checklist. */
    promptRank?: number;
}
/** Field order used by the prompt, guidance and receipts. Core fields first,
 *  then the execution report, then contract/sub-goal state, then the
 *  cognitive/report fields, then terminal fields. Deterministic by design. */
export declare const FIELD_ORDER: readonly ["success", "output_summary", "constraint_violations", "should_continue", "execution_report.files_changed", "execution_report.tests_reported", "execution_report.contract_item_claims", "execution_report.criterion_claims", "subgoal_updates", "emerged_subtasks", "discovered_constraints", "wrong_assumptions", "objective_refinement", "retracted_constraints", "round_contract", "contract_transition", "worker_results", "prompt_requests", "compression_checkpoint", "checkpoint_label", "retroactiveClaims", "gate_ids", "outcome", "blocker", "stop_reason", "no_change_reason"];
export type FieldPath = (typeof FIELD_ORDER)[number];
export declare function fieldGuide(path: string): FieldGuide | undefined;
export declare function fieldGuideDescription(path: string): string;
export declare function retiredFieldDetail(path: string): string | undefined;
/** The current SelfEvaluation + ExecutionReport paths, for a schema-sync test. */
export declare function allFieldGuidePaths(): string[];
export interface FieldExampleContext {
    activeContract: ActiveContractView | null;
    activeSubGoals: ReadonlyArray<SubGoal>;
    commands: ReadonlyArray<string>;
    contractVerificationAvailable: boolean;
    criteria?: ReadonlyArray<CriterionStatus>;
}
/** A legal minimal example for a field, or null when the current facts make the
 *  field unusable (no real id/command to cite). The renderer omits nulls; it
 *  never invents an sg-/rci- reference. */
export declare function fieldExample(path: string, ctx: FieldExampleContext): unknown | null;
export interface GuidanceFacts {
    activeContract: ActiveContractView | null;
    itemStatuses?: ContractItemStatusView | null;
    subGoals: ReadonlyArray<SubGoal>;
    commands: ReadonlyArray<string>;
    contractVerificationAvailable: boolean;
    gateEnabled: boolean;
    criteria?: ReadonlyArray<CriterionStatus>;
}
/** Semantic applicability — the ONE rule, deliberately independent of prompt
 *  level. Core fields and the two baseline execution-report fields are always
 *  applicable; the rest depend on facts the runtime can actually observe.
 *  Future events (delegation, a checkpoint boundary, a falsified assumption)
 *  remain conditional opportunities, not render-time facts. */
export declare function isFieldApplicable(path: string, facts: GuidanceFacts): boolean;
/** Compact-checklist membership: the explicit `compact` marker plus semantic
 *  applicability. The level is deliberately absent — L0/L1/L2 offer the same
 *  evaluation fields; only state density changes. Dedicated renderer fields
 *  (`round_contract`, `subgoal_updates`, `contract_item_claims`) are never
 *  compact members, so they cannot duplicate their own blocks. */
export declare function isFieldPrompted(path: string, facts: GuidanceFacts): boolean;
/** Deterministic compact-checklist order, shared by the renderer and tests. */
export declare function promptedFieldPaths(facts: GuidanceFacts): string[];
export interface SelfEvalPromptContext {
    round: number;
    level: "l0" | "l1" | "l2";
    activeContract: ActiveContractView | null;
    itemStatuses?: ContractItemStatusView | null;
    commands: ReadonlyArray<string>;
    contractVerificationAvailable: boolean;
    subGoals: ReadonlyArray<SubGoal>;
    verificationFlags: ReadonlyArray<VerificationFlag>;
    recovery: boolean;
    gateEnabled?: boolean;
    criteria?: ReadonlyArray<CriterionStatus>;
}
/** Render the evaluation block appended to every prompt. */
export declare function renderSelfEvalBlock(ctx: SelfEvalPromptContext): string;
/** The session slice guidance needs. Structural so lifecycle and manager can
 *  both pass their own view without importing each other. */
export interface GuidanceSessionView {
    loopId: string;
    currentRound: number;
    /** The task / current work item, when the caller can observe it. */
    task?: string;
    roundSnapshot?: {
        roundId: string;
        promptArtifact?: PromptArtifact;
        beforeEvidence?: unknown;
    } | null;
}
export interface GuidanceOptions {
    /** The history window the caller already uses: `derivationRounds` for a live
     *  prepare, `readOnlyRounds` for a read-only view. Never derive a second one. */
    rounds: ReadonlyArray<CommittedRoundView>;
    /** The operator objective's success criteria, resolved by the caller from
     *  the held acceptance or committed objective. Absent = unobservable; no
     *  criterion rows are rendered. */
    objective?: {
        success_criteria: ReadonlyArray<string>;
    } | null;
    verificationFlags?: ReadonlyArray<VerificationFlag>;
    recovery?: {
        pending: boolean;
        redo_round: number;
        checkpoint_id: string;
        restore_verified: boolean;
        origin?: "agent" | "machine";
        reason?: string;
    } | null;
}
/** Derive `submission_guidance` from current facts. Pure: no I/O, no writes,
 *  no persistence. The same inputs produce the same object. */
export declare function deriveSubmissionGuidance(session: GuidanceSessionView, options: GuidanceOptions): SubmissionGuidance;
/** The ATTEMPTED manifest: known paths present in the raw payload, in
 *  FIELD_ORDER. Presence means the key is an own property with a defined
 *  value; an explicit `null` is still an attempt (the normalizer diagnoses
 *  whether it survived). Unknown fields are NOT in the manifest; the
 *  diagnostic channel owns them. */
export declare function submittedFieldPaths(raw: Record<string, unknown>): string[];
export declare function unknownExecutionReportEntryFields(report: Record<string, unknown>): string[];
export declare function unknownExecutionReportFields(raw: Record<string, unknown>): string[];
export declare function unknownTopLevelFields(raw: Record<string, unknown>): string[];
//# sourceMappingURL=submission-guidance.d.ts.map