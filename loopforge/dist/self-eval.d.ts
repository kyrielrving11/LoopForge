/** Self-evaluation extraction and parsing — pure functions.
 *
 * These functions parse an Agent's raw output into a structured
 * SelfEvaluation. They have no dependency on Engine state, file I/O,
 * or external services. They are shared by both the MCP tool handler
 * (which receives structured JSON directly) and the legacy invoke
 * path (which regex-scans free-text Agent output).
 */
import { type CriterionRevision, type ExecutionEvidence, type SelfEvaluation } from "./protocol.js";
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
/** Build a SelfEvaluation from a parsed JSON object.
 *  Lenient parsing: missing optional fields get sensible defaults. */
export declare function buildSelfEvaluation(raw: Record<string, unknown>): SelfEvaluation;
/** Fallback heuristic when structured self-eval extraction fails.
 *  Scans agent output for completion and error signals. */
export declare function heuristicSelfEvaluation(text: string): SelfEvaluation | null;
//# sourceMappingURL=self-eval.d.ts.map