/** Self-evaluation extraction and parsing — pure functions.
 *
 * These functions parse an Agent's raw output into a structured
 * SelfEvaluation. They have no dependency on Engine state, file I/O,
 * or external services. They are shared by both the MCP tool handler
 * (which receives structured JSON directly) and the legacy invoke
 * path (which regex-scans free-text Agent output).
 */
import { type CriterionRevision, type ExecutionEvidence, type PromptRequests, type RoundContract, type RoundOutcome, type SelfEvaluation } from "./protocol.js";
/** Parse ExecutionEvidence from a raw JSON object. */
export declare function parseExecutionEvidence(raw: Record<string, unknown> | undefined | null): ExecutionEvidence | undefined;
/** Parse CriterionRevision[] from a raw JSON array. */
export declare function parseCriterionRevisions(raw: unknown): CriterionRevision[];
/** Parse WorkerResult[] from a raw JSON array. */
export declare function parseWorkerResults(raw: unknown): import("./protocol.js").WorkerResult[];
/** Extract a structured SelfEvaluation from agent output text.
 *  Returns null if no valid self-eval block is found.
 *  The agent is instructed to output JSON between the delimiters. */
export declare function extractSelfEvaluation(text: string): SelfEvaluation | null;
/** v2.12: The effective round outcome — declared outcome wins, otherwise
 *  derived from `success`. "partial" can only be declared explicitly (never
 *  silently derived from success=false, which would quietly change the
 *  success-class enforcement surface). */
export declare function effectiveOutcome(selfEval: SelfEvaluation): RoundOutcome;
/** v2.12: Whether the effective outcome is a success claim. Shared by the
 *  verification gate (success-class checks) and enforcement gate (R3). */
export declare function effectiveSuccess(selfEval: SelfEvaluation): boolean;
/** v2.12: Minimal outcome inference from free text — DIAGNOSTICS ONLY.
 *  The runtime never guesses state from text; this only tells the agent
 *  what was recognizable so it can resubmit a structured evaluation. */
export declare function inferOutcomeFromText(text: string): {
    outcome: "success" | "partial" | "failed";
    summary: string;
} | null;
/** v2.12: Why structured extraction failed — for actionable diagnostics. */
export type ExtractionFailureReason = "no_eval_block" | "json_parse_failed" | "missing_required_fields";
/** v2.12: Extraction with a structured failure reason. Behavior identical
 *  to extractSelfEvaluation on success; the reason powers the stalled
 *  diagnostic message so the agent knows exactly what to fix. */
export declare function extractSelfEvaluationWithDiagnostics(text: string): {
    selfEval: SelfEvaluation | null;
    reason: ExtractionFailureReason | null;
};
/** v2.12: Field-level validation gaps — diagnostics only. Collects what
 *  buildSelfEvaluation silently tolerates, without changing acceptance. */
export declare function collectSelfEvalGaps(raw: Record<string, unknown>): {
    field: string;
    issue: string;
}[];
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