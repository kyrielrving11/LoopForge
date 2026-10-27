/** Stable runtime errors that cross the MCP/tool boundary.
 *
 * These are state/compile conditions, not protocol payload defects. A tool
 * maps their `code` onto the uniform error envelope without re-deriving the
 * meaning from prose.
 */
/** The compiler did not produce a prompt. The message carries the compiler's
 *  own error when it supplied one. Never a session state. */
export declare class CompileFailureError extends Error {
    readonly code: "compile_failed";
    constructor(message: string);
}
/** A new loop could not be started. No session or handle exists. */
export declare class StartFailureError extends Error {
    readonly code: "start_failed";
    constructor(message: string);
}
/** A loopId already names a persisted session or committed round. Starting a
 *  new round 1 would overwrite durable history. */
export declare class LoopExistsError extends Error {
    readonly loopId: string;
    readonly reason: "session" | "rounds" | "active" | "stopped";
    readonly code: "loop_exists";
    constructor(loopId: string, reason: "session" | "rounds" | "active" | "stopped");
}
/** A stored loop contains rounds this runtime cannot decode. Recompiling
 *  would overwrite them, so resume refuses and leaves the data read-only. */
export declare class LegacyHistoryError extends Error {
    readonly loopId: string;
    readonly rounds: number[];
    readonly code: "legacy_history";
    constructor(loopId: string, rounds: number[]);
}
/** Different transactions carry different copies of the immutable operator
 *  acceptance. The history is inconsistent; never choose a copy silently. */
export declare class OperatorAcceptanceConflictError extends Error {
    readonly loopId: string;
    readonly code: "operator_acceptance_conflict";
    constructor(loopId: string);
}
//# sourceMappingURL=errors.d.ts.map