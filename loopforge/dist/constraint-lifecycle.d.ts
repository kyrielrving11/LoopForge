/** v3.9.7: the ONE constraint provenance and retraction resolver.
 *
 *  Both are pure derivations over committed facts. The compiler, the
 *  submission boundary and the receipt must call these functions rather than
 *  maintaining their own text/ID matching rules — a second resolver would
 *  let the boundary reject a target the compiler applied (or the reverse).
 *
 *  Provenance is a derived display fact, never a second ledger. It answers
 *  "where did this active constraint come from in the current branch's
 *  committed history?" — not "is the constraint true?".
 */
import type { ConstraintMeta, LoopObjective } from "./protocol.js";
import type { CommittedRoundView } from "./committed-round.js";
export interface ConstraintProvenance {
    source: ConstraintMeta["source"];
    source_round?: number;
}
export interface ConstraintProvenanceInput {
    text: string;
    objective: LoopObjective | null;
    /** Current branch committed rounds below the compile round. */
    windowRounds: ReadonlyArray<CommittedRoundView>;
    /** Plan constraints accepted at round 1 only. */
    roundOnePlan: ReadonlyArray<string>;
    /** Discoveries preserved by the pending rollback directive. */
    preservedDiscoveries: ReadonlyArray<string>;
    /** Directive trigger round, when known. */
    preservedRound?: number;
}
/** Derive the provenance of one active constraint from committed facts.
 *
 *  Precedence is fixed: operator criterion > operator hard constraint >
 *  round-1 plan > preserved rollback discovery > current-streak Agent
 *  discovery > carried active-since > unrecorded. `source` and
 *  `source_round` always come from this one classifier.
 */
export declare function deriveConstraintProvenance(input: ConstraintProvenanceInput): ConstraintProvenance;
export type ConstraintRetractionReason = "unknown_target" | "not_active" | "already_retired" | "operator_immutable" | "plan_not_retractable" | "unrecorded_target" | "same_round_discovery" | "duplicate_request";
export interface ConstraintRetractionTarget {
    text: string;
    provenance: ConstraintProvenance;
}
export interface ConstraintRetractionInput {
    targets: ReadonlyArray<string>;
    /** Active constraints at the START of the submitting round. */
    active: ReadonlyArray<ConstraintRetractionTarget>;
    /** Discoveries declared by the same submission (never retractable). */
    newDiscoveries: ReadonlyArray<string>;
    /** Targets already retired by committed rounds. */
    previouslyRetired: ReadonlyArray<string>;
}
export interface ConstraintRetractionResult {
    /** Effective retraction targets, as active texts, deduplicated. */
    effective: string[];
    /** Accepted-but-inert requests with a stable reason. */
    noops: Array<{
        target: string;
        reason: ConstraintRetractionReason;
    }>;
    /** Structural boundary violations (the submission must be rejected). */
    errors: Array<{
        target: string;
        reason: "immutable_constraint" | "not_retractable";
        detail: string;
    }>;
}
/** Resolve retraction targets against the active set before this
 *  submission's new discoveries. Only active Agent-discovered (or preserved)
 *  constraints are retractable. Operator criteria/hard constraints and plan
 *  constraints are structural errors; unknown/inactive/already-retired
 *  targets are inert no-ops with a machine reason. */
export declare function resolveConstraintRetractions(input: ConstraintRetractionInput): ConstraintRetractionResult;
//# sourceMappingURL=constraint-lifecycle.d.ts.map