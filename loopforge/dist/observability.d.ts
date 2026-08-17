/** Zero-dependency structured lifecycle events.
 *
 * Events remain silent unless LOOPFORGE_LOG is set. v2.6 removes the
 * span-tracing abstraction (startSpan / TraceSink / TraceSpan) —
 * it was called only once in production and had no real consumers.
 */
export interface LogEventData {
    [key: string]: unknown;
}
/** Emit a structured lifecycle event. Quiet unless LOOPFORGE_LOG is set. */
export declare function logEvent(event: string, data?: LogEventData): void;
//# sourceMappingURL=observability.d.ts.map