/** Structured self-evaluation parsing and normalization — pure functions.
 * The MCP boundary validates required fields before these helpers run.
 */
import { type CriterionRevision, type ExecutionEvidence, type PromptRequests, type RoundContract, type RoundOutcome, type SelfEvaluation, type SubGoalUpdate } from "./protocol.js";
/** Parse ExecutionEvidence from a raw JSON object. */
export declare function parseExecutionEvidence(raw: Record<string, unknown> | undefined | null): ExecutionEvidence | undefined;
/** Parse CriterionRevision[] from a raw JSON array. */
export declare function parseCriterionRevisions(raw: unknown): CriterionRevision[];
/** Parse SubGoalUpdate[] from a raw JSON array.
 *  v3.7.1: lenient per-entry filtering (id/status shape) with fixed caps
 *  (20 entries, id ≤ 64, note ≤ 300). Referential validity — unknown IDs
 *  and illegal migrations — is NOT checked here: that needs the committed
 *  sub-goal set and runs as a pre-advance validation (evaluation_invalid). */
export declare function parseSubGoalUpdates(raw: unknown): SubGoalUpdate[];
/** Parse WorkerResult[] from a raw JSON array.
 *  v3.7.1: `outcome` is the single fact. An entry without a valid outcome
 *  is dropped (not derived, not defaulted) — the array stays informational:
 *  absent/empty arrays are accepted unchanged, so a round without any
 *  delegation can never be rejected over worker fields. */
export declare function parseWorkerResults(raw: unknown): import("./protocol.js").WorkerResult[];
/** v2.12: The effective round outcome — declared outcome wins, otherwise
 *  derived from `success`. "partial" can only be declared explicitly (never
 *  silently derived from success=false, which would quietly change the
 *  success-class enforcement surface). */
export declare function effectiveOutcome(selfEval: SelfEvaluation): RoundOutcome;
/** v2.12: Whether the effective outcome is a success claim. Shared by the
 *  verification gate (success-class checks) and enforcement gate (R3). */
export declare function effectiveSuccess(selfEval: SelfEvaluation): boolean;
/** Required evaluation fields are the only format boundary. Optional fields
 * are deliberately normalized by buildSelfEvaluation instead of rejecting a
 * round for a non-authoritative reporting detail.
 *
 * v3.7.1: subgoal_updates is one documented exception — it is a strict
 * STRUCTURAL boundary (machine-processable state transitions). Its shape
 * and referential errors ride here as `subgoal_errors` and return
 * evaluation_invalid with the same guarantees: no state change, no gates,
 * no rejection counters, same-roundId retry. */
export interface EvaluationValidation {
    missing: string[];
    invalid: Array<{
        field: string;
        expected: string;
    }>;
    subgoal_errors?: Array<{
        field: string;
        reason: string;
        detail: string;
    }>;
}
export declare function validateCoreSelfEvaluation(raw: Record<string, unknown>): EvaluationValidation;
/** v3.7.1: Strict structural checks for the sub-goal protocol fields
 *  (subgoal_updates / emerged_subtasks). Runs in the same pre-advance
 *  evaluation_invalid boundary as the four core fields: an error here is a
 *  payload defect, never a work-quality rejection — no session state, no
 *  gates, no rejection counters, retry with the same roundId.
 *
 *  Shape-only (no vault): entry shape, id pattern, status enum, caps, and
 *  the sg-XXXXXXXX creation prohibition on emerged_subtasks. Referential
 *  validity (unknown IDs / terminal references / illegal migrations) needs
 *  the committed sub-goal set and is checked against the compiled
 *  sub_goals right before advance (validateSubGoalUpdates in
 *  loop-compiler.ts). */
export declare function validateSubGoalUpdatesShape(raw: Record<string, unknown>): Array<{
    field: string;
    reason: string;
    detail: string;
}>;
/** Build a SelfEvaluation from a parsed JSON object.
 *  Lenient parsing: missing optional fields get sensible defaults. */
export declare function buildSelfEvaluation(raw: Record<string, unknown>): SelfEvaluation;
/** Parse a RoundContract object from raw JSON input. Lenient: non-string
 *  entries are dropped, strings are trimmed and capped. An object that IS
 *  present is returned even with empty arrays — an empty contract is a
 *  real declaration the round_underspecified check must see. Returns
 *  undefined only when the raw value is absent or not an object. */
export declare function parseRoundContract(raw: unknown): RoundContract | undefined;
/** Parse a PromptRequests object from raw JSON input.
 *  Lenient: missing or invalid fields get sensible defaults.
 *  Returns undefined if the raw value is absent or not an object,
 *  so makeSelfEvaluation can distinguish "not set" from "empty".
 *  Exported for the engine's last_round_result rebuild — the MCP
 *  lifecycle assembles prompt_requests into the request, but every
 *  compile path funnels through engine.invokeLoopCompile, whose
 *  field-by-field reconstruction must preserve them (v3.3.1). */
export declare function parsePromptRequests(raw: unknown): PromptRequests | undefined;
//# sourceMappingURL=self-eval.d.ts.map