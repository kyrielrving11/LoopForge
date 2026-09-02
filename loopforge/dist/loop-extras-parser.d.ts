/** LoopExtrasParser — Typed extraction pipeline for LoopForgeRequest extras.
 *
 * invokeLoopCompile receives a LoopForgeRequest whose extra fields arrive as
 * untyped `Record<string, unknown>`. Before this module, each field was
 * extracted inline with ad-hoc `typeof` guards spread across ~80 lines of
 * engine.ts — brittle, untestable, and error-prone.
 *
 * ExtractionContext provides a single-pass, type-safe extraction surface:
 * - Every method returns a typed value or a sensible default.
 * - Type mismatches and out-of-range values are collected in `errors[]`
 *   rather than thrown, so the caller can log them and continue with
 *   best-effort defaults.
 * - All extraction is synchronous and pure (no I/O, no side effects).
 *
 * Design constraint: zero runtime dependencies (Node.js stdlib only).
 */
import type { VerificationFlag } from "./protocol.js";
export interface FieldError {
    field: string;
    message: string;
    received: unknown;
}
export declare class ExtractionContext {
    /** Errors collected during extraction. The caller decides whether to
     *  log them, fail fast, or ignore them. Never populated for optional
     *  fields when the value is absent — only for present-but-invalid values. */
    readonly errors: FieldError[];
    private readonly source;
    constructor(source: Record<string, unknown>);
    /** Extract a required string field. Returns `fallback` (default `""`) when
     *  the key is missing or the value is not a string. */
    string(key: string, fallback?: string): string;
    /** Extract an optional string field. Returns `null` when absent,
     *  `fallback` when present-but-invalid. */
    optionalString(key: string, fallback?: string | null): string | null;
    /** Extract a number field. Returns `fallback` when missing or invalid.
     *  Applies optional `min`/`max` clamping and `truncate` (Math.trunc). */
    number(key: string, fallback: number, opts?: {
        min?: number;
        max?: number;
        truncate?: boolean;
    }): number;
    /** Extract a boolean field. Returns `fallback` when missing or invalid. */
    boolean(key: string, fallback?: boolean): boolean;
    /** Extract a string array. Returns `fallback` (default `[]`) when missing.
     *  Filters out non-string elements and records them as errors individually. */
    stringArray(key: string, fallback?: string[]): string[];
    /** Extract a plain object field. Returns `null` when missing or when the
     *  value is not a non-array object. Does not recurse into the value. */
    object(key: string): Record<string, unknown> | null;
    /** Check whether a key exists (is not undefined). Useful for gating
     *  optional structured fields — call object() only when present. */
    has(key: string): boolean;
}
export interface ParsedLoopExtras {
    loop_id: string;
    round: number;
    goal_id: string;
    domain: string;
    next_task_proposal: string;
    plan_source: string | null;
    constraints_from_plan: string[];
    new_since_last_round: string;
    force_level: string;
    health_check_interval: number;
    external_context: string;
    max_rounds: number | undefined;
    verification_flags: VerificationFlag[];
    attempt: number;
    consecutive_rejections: number;
    rejection_notice: string;
    last_round_result: Record<string, unknown> | null;
    loop_objective: Record<string, unknown> | null;
}
/** Parse all extras fields from a LoopForgeRequest into a typed structure.
 *  Extraction errors are attached to the returned context for inspection.
 *  This function never throws — every field has a safe default. */
export declare function parseLoopExtras(extras: Record<string, unknown>, taskId: string): {
    parsed: ParsedLoopExtras;
    ctx: ExtractionContext;
};
//# sourceMappingURL=loop-extras-parser.d.ts.map