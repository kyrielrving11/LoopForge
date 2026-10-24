/** Stable runtime errors that cross the MCP/tool boundary.
 *
 * These are state/compile conditions, not protocol payload defects. A tool
 * maps their `code` onto the uniform error envelope without re-deriving the
 * meaning from prose.
 */
/** The compiler did not produce a prompt. The message carries the compiler's
 *  own error when it supplied one. Never a session state. */
export class CompileFailureError extends Error {
    code = "compile_failed";
    constructor(message) {
        super(message);
        this.name = "CompileFailureError";
    }
}
/** A new loop could not be started. No session or handle exists. */
export class StartFailureError extends Error {
    code = "start_failed";
    constructor(message) {
        super(message);
        this.name = "StartFailureError";
    }
}
/** A loopId already names a persisted session or committed round. Starting a
 *  new round 1 would overwrite durable history. */
export class LoopExistsError extends Error {
    loopId;
    reason;
    code = "loop_exists";
    constructor(loopId, reason) {
        super(reason === "active"
            ? `A loop "${loopId}" is already running in this process. Resume or stop it instead of starting a duplicate.`
            : `Loop "${loopId}" already has persisted ${reason === "session" ? "session state" : "rounds"}. ` +
                "Resume it, or start a new loop with a different loopId.");
        this.loopId = loopId;
        this.reason = reason;
        this.name = "LoopExistsError";
    }
}
/** A stored loop contains rounds this runtime cannot decode. Recompiling
 *  would overwrite them, so resume refuses and leaves the data read-only. */
export class LegacyHistoryError extends Error {
    loopId;
    rounds;
    code = "legacy_history";
    constructor(loopId, rounds) {
        super(`Loop "${loopId}" contains ${rounds.length} round(s) written by an unsupported schema ` +
            `(${rounds.slice(0, 8).join(", ")}${rounds.length > 8 ? ", …" : ""}). ` +
            "This runtime does not migrate history; start a new loop instead.");
        this.loopId = loopId;
        this.rounds = rounds;
        this.name = "LegacyHistoryError";
    }
}
/** Different transactions carry different copies of the immutable operator
 *  acceptance. The history is inconsistent; never choose a copy silently. */
export class OperatorAcceptanceConflictError extends Error {
    loopId;
    code = "operator_acceptance_conflict";
    constructor(loopId) {
        super(`Loop "${loopId}" contains conflicting operator acceptance copies. ` +
            "The operator surface is immutable; the history must be repaired before work continues.");
        this.loopId = loopId;
        this.name = "OperatorAcceptanceConflictError";
    }
}
//# sourceMappingURL=errors.js.map