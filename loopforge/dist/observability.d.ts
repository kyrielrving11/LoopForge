/** Zero-dependency structured events and tracing.
 *
 * Lifecycle events remain silent unless LOOPFORGE_LOG is set. Applications can
 * install a TraceSink to receive the same events plus span start/end records
 * without coupling LoopForge to a tracing SDK.
 */
export interface LogEventData {
    [key: string]: unknown;
}
export type TraceStatus = "ok" | "error" | "cancelled";
export interface TraceRecord {
    schemaVersion: 1;
    timestamp: string;
    kind: "event" | "span";
    name: string;
    traceId?: string;
    spanId?: string;
    parentSpanId?: string;
    phase?: "start" | "end";
    status?: TraceStatus;
    durationMs?: number;
    attributes: Record<string, unknown>;
}
/** Adapter point for OpenTelemetry, files, test collectors, or remote sinks. */
export interface TraceSink {
    emit(record: TraceRecord): void | Promise<void>;
}
export interface TraceContext {
    traceId: string;
    spanId: string;
}
/** Install a process-wide sink. Passing null restores environment-gated stderr. */
export declare function setTraceSink(sink: TraceSink | null): void;
export declare function getTraceSink(): TraceSink | null;
/** Emit a structured lifecycle event. */
export declare function logEvent(event: string, data?: LogEventData): void;
export interface TraceSpan {
    readonly context: TraceContext;
    end(status?: TraceStatus, attributes?: Record<string, unknown>): void;
}
/** Start an explicitly-parented span. Span completion is idempotent. */
export declare function startSpan(name: string, attributes?: Record<string, unknown>, parent?: TraceContext): TraceSpan;
//# sourceMappingURL=observability.d.ts.map