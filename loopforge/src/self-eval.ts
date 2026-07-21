/** Self-evaluation extraction and parsing — pure functions.
 *
 * These functions parse an Agent's raw output into a structured
 * SelfEvaluation. They have no dependency on Engine state, file I/O,
 * or external services. They are shared by both the MCP tool handler
 * (which receives structured JSON directly) and the legacy invoke
 * path (which regex-scans free-text Agent output).
 */

import {
  makeExecutionEvidence,
  makeSelfEvaluation,
  SELF_EVAL_REGEX,
  type CriterionRevision,
  type ExecutionEvidence,
  type SelfEvaluation,
} from "./protocol.js";

// ── Raw parsing helpers ───────────────────────────────────────────────────

/** Parse ExecutionEvidence from a raw JSON object. */
export function parseExecutionEvidence(
  raw: Record<string, unknown> | undefined | null,
): ExecutionEvidence | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const testResults = raw.test_results as Record<string, unknown> | undefined;
  return makeExecutionEvidence({
    files_changed: Array.isArray(raw.files_changed)
      ? raw.files_changed.filter((v: unknown) => typeof v === "string")
      : [],
    test_results: testResults && typeof testResults.passed === "number"
      ? {
          passed: testResults.passed as number,
          failed: (testResults.failed as number) ?? 0,
          skipped: (testResults.skipped as number) ?? 0,
        }
      : null,
    success_criteria_met: Array.isArray(raw.success_criteria_met)
      ? raw.success_criteria_met.filter((v: unknown) => typeof v === "string")
      : [],
    success_criteria_remaining: Array.isArray(raw.success_criteria_remaining)
      ? raw.success_criteria_remaining.filter((v: unknown) => typeof v === "string")
      : [],
    progress_estimate: typeof raw.progress_estimate === "number"
      ? Math.max(0, Math.min(1, raw.progress_estimate))
      : 0.0,
  });
}

/** Parse CriterionRevision[] from a raw JSON array. */
export function parseCriterionRevisions(
  raw: unknown,
): CriterionRevision[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((v: unknown) =>
      typeof v === "object" && v !== null &&
      typeof (v as Record<string, unknown>).old === "string" &&
      typeof (v as Record<string, unknown>).new === "string")
    .map((v: unknown) => {
      const r = v as Record<string, unknown>;
      return { old: r.old as string, new: r.new as string };
    });
}

/** Parse WorkerResult[] from a raw JSON array. */
export function parseWorkerResults(
  raw: unknown,
): import("./protocol.js").WorkerResult[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((v: unknown) =>
      typeof v === "object" && v !== null &&
      typeof (v as Record<string, unknown>).agentId === "string" &&
      typeof (v as Record<string, unknown>).subTask === "string" &&
      typeof (v as Record<string, unknown>).resultSummary === "string")
    .map((v: unknown) => {
      const w = v as Record<string, unknown>;
      return {
        agentId: w.agentId as string,
        subAgentType: typeof w.subAgentType === "string" ? w.subAgentType : "general-purpose",
        subTask: w.subTask as string,
        resultSummary: w.resultSummary as string,
        success: typeof w.success === "boolean" ? w.success : false,
        discoveredConstraints: Array.isArray(w.discoveredConstraints)
          ? w.discoveredConstraints.filter((c: unknown) => typeof c === "string")
          : [],
      };
    });
}

// ── Self-evaluation extraction ───────────────────────────────────────────

/** Extract a structured SelfEvaluation from agent output text.
 *  Returns null if no valid self-eval block is found.
 *  The agent is instructed to output JSON between the delimiters. */
export function extractSelfEvaluation(text: string): SelfEvaluation | null {
  const match = text.match(SELF_EVAL_REGEX);
  if (!match) return null;

  try {
    const raw = JSON.parse(match[1]);
    if (typeof raw.success !== "boolean") return null;
    if (typeof raw.output_summary !== "string") return null;
    if (!Array.isArray(raw.constraint_violations)) return null;
    if (typeof raw.should_continue !== "boolean") return null;
    return buildSelfEvaluation(raw);
  } catch {
    return null;
  }
}

/** Build a SelfEvaluation from a parsed JSON object.
 *  Lenient parsing: missing optional fields get sensible defaults. */
export function buildSelfEvaluation(
  raw: Record<string, unknown>,
): SelfEvaluation {
  const executionEvidence = parseExecutionEvidence(
    raw.execution_evidence as Record<string, unknown> | undefined,
  );

  const retractedConstraints: string[] = Array.isArray(raw.retracted_constraints)
    ? raw.retracted_constraints.filter((v: unknown) => typeof v === "string")
    : [];
  const revisedCriteria: CriterionRevision[] = parseCriterionRevisions(raw.revised_success_criteria);
  const wrongAssumptions: string[] = Array.isArray(raw.wrong_assumptions)
    ? raw.wrong_assumptions.filter((v: unknown) => typeof v === "string")
    : [];
  const workerResults = parseWorkerResults(raw.worker_results);

  return makeSelfEvaluation({
    success: typeof raw.success === "boolean" ? raw.success : false,
    output_summary: typeof raw.output_summary === "string" ? raw.output_summary : "",
    constraint_violations: Array.isArray(raw.constraint_violations)
      ? raw.constraint_violations.filter((v: unknown) => typeof v === "string")
      : [],
    should_continue: typeof raw.should_continue === "boolean" ? raw.should_continue : true,
    discovered_constraints: Array.isArray(raw.discovered_constraints)
      ? raw.discovered_constraints.filter((v: unknown) => typeof v === "string")
      : [],
    objective_refinement: typeof raw.objective_refinement === "string"
      ? raw.objective_refinement
      : "",
    emerged_subtasks: Array.isArray(raw.emerged_subtasks)
      ? raw.emerged_subtasks.filter((v: unknown) => typeof v === "string")
      : [],
    execution_evidence: executionEvidence,
    retracted_constraints: retractedConstraints,
    revised_success_criteria: revisedCriteria,
    wrong_assumptions: wrongAssumptions,
    worker_results: workerResults,
    compression_checkpoint:
      typeof raw.compression_checkpoint === "boolean" ? raw.compression_checkpoint : false,
    checkpoint_label:
      typeof raw.checkpoint_label === "string" ? raw.checkpoint_label : "",
    next_action:
      typeof raw.next_action === "string" ? raw.next_action : undefined,
  });
}

/** Fallback heuristic when structured self-eval extraction fails.
 *  Scans agent output for completion and error signals. */
export function heuristicSelfEvaluation(text: string): SelfEvaluation | null {
  const lower = text.toLowerCase();
  const hasError =
    /error|failed|exception|cannot|unable|失败|错误|异常/.test(lower);
  const hasCompletion =
    /done|complete|finished|完成|成功/.test(lower);
  const hasRemaining =
    /remaining|continue|still need|next|todo|剩余|继续|下一步/.test(lower);

  const paragraphs = text.split(/\n\n+/).filter((p) => p.trim().length > 30);
  const summary = paragraphs.length > 0
    ? paragraphs[paragraphs.length - 1].trim().slice(0, 300)
    : text.trim().slice(0, 300);

  return makeSelfEvaluation({
    success: !hasError && (hasCompletion || !hasRemaining),
    output_summary: summary || "[heuristic fallback — could not parse structured self-eval]",
    constraint_violations: [],
    should_continue: hasRemaining && !hasError,
  });
}
