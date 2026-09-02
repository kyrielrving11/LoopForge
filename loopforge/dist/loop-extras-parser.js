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
// ── ExtractionContext ──────────────────────────────────────────────────────
export class ExtractionContext {
    /** Errors collected during extraction. The caller decides whether to
     *  log them, fail fast, or ignore them. Never populated for optional
     *  fields when the value is absent — only for present-but-invalid values. */
    errors = [];
    source;
    constructor(source) {
        this.source = source;
    }
    // ── Primitives ─────────────────────────────────────────────────────────
    /** Extract a required string field. Returns `fallback` (default `""`) when
     *  the key is missing or the value is not a string. */
    string(key, fallback = "") {
        const raw = this.source[key];
        if (raw === undefined || raw === null)
            return fallback;
        if (typeof raw === "string")
            return raw;
        this.errors.push({
            field: key,
            message: `expected string, got ${typeof raw}`,
            received: raw,
        });
        return fallback;
    }
    /** Extract an optional string field. Returns `null` when absent,
     *  `fallback` when present-but-invalid. */
    optionalString(key, fallback = null) {
        const raw = this.source[key];
        if (raw === undefined || raw === null)
            return null;
        if (typeof raw === "string")
            return raw;
        this.errors.push({
            field: key,
            message: `expected string or null, got ${typeof raw}`,
            received: raw,
        });
        return fallback;
    }
    /** Extract a number field. Returns `fallback` when missing or invalid.
     *  Applies optional `min`/`max` clamping and `truncate` (Math.trunc). */
    number(key, fallback, opts) {
        const raw = this.source[key];
        if (raw === undefined || raw === null)
            return fallback;
        if (typeof raw === "number" && !Number.isNaN(raw)) {
            let value = raw;
            if (opts?.truncate)
                value = Math.trunc(value);
            if (opts?.min !== undefined)
                value = Math.max(opts.min, value);
            if (opts?.max !== undefined)
                value = Math.min(opts.max, value);
            return value;
        }
        this.errors.push({
            field: key,
            message: `expected number, got ${typeof raw}`,
            received: raw,
        });
        return fallback;
    }
    /** Extract a boolean field. Returns `fallback` when missing or invalid. */
    boolean(key, fallback = false) {
        const raw = this.source[key];
        if (raw === undefined || raw === null)
            return fallback;
        if (typeof raw === "boolean")
            return raw;
        this.errors.push({
            field: key,
            message: `expected boolean, got ${typeof raw}`,
            received: raw,
        });
        return fallback;
    }
    // ── Collections ────────────────────────────────────────────────────────
    /** Extract a string array. Returns `fallback` (default `[]`) when missing.
     *  Filters out non-string elements and records them as errors individually. */
    stringArray(key, fallback = []) {
        const raw = this.source[key];
        if (raw === undefined || raw === null)
            return fallback;
        if (!Array.isArray(raw)) {
            this.errors.push({
                field: key,
                message: `expected array, got ${typeof raw}`,
                received: raw,
            });
            return fallback;
        }
        const result = [];
        for (let i = 0; i < raw.length; i++) {
            if (typeof raw[i] === "string") {
                result.push(raw[i]);
            }
            else {
                this.errors.push({
                    field: `${key}[${i}]`,
                    message: `expected string in array, got ${typeof raw[i]}`,
                    received: raw[i],
                });
            }
        }
        return result;
    }
    // ── Structured ─────────────────────────────────────────────────────────
    /** Extract a plain object field. Returns `null` when missing or when the
     *  value is not a non-array object. Does not recurse into the value. */
    object(key) {
        const raw = this.source[key];
        if (raw === undefined || raw === null)
            return null;
        if (typeof raw === "object" && !Array.isArray(raw)) {
            return raw;
        }
        this.errors.push({
            field: key,
            message: `expected object, got ${Array.isArray(raw) ? "array" : typeof raw}`,
            received: raw,
        });
        return null;
    }
    /** Check whether a key exists (is not undefined). Useful for gating
     *  optional structured fields — call object() only when present. */
    has(key) {
        return this.source[key] !== undefined;
    }
}
/** Parse all extras fields from a LoopForgeRequest into a typed structure.
 *  Extraction errors are attached to the returned context for inspection.
 *  This function never throws — every field has a safe default. */
export function parseLoopExtras(extras, taskId) {
    const ctx = new ExtractionContext(extras);
    const parsed = {
        loop_id: ctx.string("loop_id") || taskId,
        round: ctx.number("round", 1, { min: 1, truncate: true }),
        goal_id: ctx.string("goal_id"),
        domain: ctx.string("domain"),
        next_task_proposal: ctx.string("next_task_proposal"),
        plan_source: ctx.optionalString("plan_source"),
        constraints_from_plan: ctx.stringArray("constraints_from_plan"),
        new_since_last_round: ctx.string("new_since_last_round"),
        force_level: ctx.string("force_level", "auto"),
        health_check_interval: ctx.number("health_check_interval", 1, {
            min: 1,
            truncate: true,
        }),
        external_context: ctx.string("external_context"),
        max_rounds: ctx.has("max_rounds")
            ? ctx.number("max_rounds", 0, { min: 1, truncate: true }) || undefined
            : undefined,
        verification_flags: validateVerificationFlags(extras.verification_flags, ctx),
        attempt: ctx.number("attempt", 1, { min: 1, truncate: true }),
        consecutive_rejections: ctx.number("consecutive_rejections", 0, {
            min: 0,
            truncate: true,
        }),
        rejection_notice: ctx.string("rejection_notice"),
        last_round_result: ctx.object("last_round_result"),
        loop_objective: ctx.object("loop_objective"),
    };
    return { parsed, ctx };
}
// ── Specialized validators ────────────────────────────────────────────────
function validateVerificationFlags(raw, ctx) {
    if (!Array.isArray(raw)) {
        if (raw !== undefined && raw !== null) {
            ctx.errors.push({
                field: "verification_flags",
                message: `expected array, got ${typeof raw}`,
                received: raw,
            });
        }
        return [];
    }
    const flags = [];
    for (let i = 0; i < raw.length; i++) {
        const item = raw[i];
        if (item !== null &&
            typeof item === "object" &&
            !Array.isArray(item) &&
            typeof item.severity === "string" &&
            typeof item.field === "string" &&
            typeof item.check === "string" &&
            typeof item.detail === "string") {
            flags.push(item);
        }
        else {
            ctx.errors.push({
                field: `verification_flags[${i}]`,
                message: "expected VerificationFlag object",
                received: item,
            });
        }
    }
    return flags;
}
//# sourceMappingURL=loop-extras-parser.js.map