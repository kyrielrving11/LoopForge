/** Structured self-evaluation parsing and normalization — pure functions.
 * The MCP boundary validates required fields before these helpers run.
 */
import { type CriterionRevision, type ExecutionEvidence, type PromptRequests, type RoundContract, type RoundOutcome, type SelfEvaluation } from "./protocol.js";
/** Parse ExecutionEvidence from a raw JSON object. */
export declare function parseExecutionEvidence(raw: Record<string, unknown> | undefined | null): ExecutionEvidence | undefined;
/** Parse CriterionRevision[] from a raw JSON array. */
export declare function parseCriterionRevisions(raw: unknown): CriterionRevision[];
/** Parse WorkerResult[] from a raw JSON array. */
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
 * round for a non-authoritative reporting detail. */
export interface EvaluationValidation {
    missing: string[];
    invalid: Array<{
        field: string;
        expected: string;
    }>;
}
export declare function validateCoreSelfEvaluation(raw: Record<string, unknown>): EvaluationValidation;
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