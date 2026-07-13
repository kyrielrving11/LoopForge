/** Zero-dependency structured events and tracing.
 *
 * Lifecycle events remain silent unless LOOPFORGE_LOG is set. Applications can
 * install a TraceSink to receive the same events plus span start/end records
 * without coupling LoopForge to a tracing SDK.
 */
import { randomUUID } from "node:crypto";
let configuredSink = null;
/** Install a process-wide sink. Passing null restores environment-gated stderr. */
export function setTraceSink(sink) {
    configuredSink = sink;
}
export function getTraceSink() {
    return configuredSink;
}
function dispatch(record) {
    try {
        if (configuredSink) {
            const pending = configuredSink.emit(record);
            if (pending && typeof pending.then === "function") {
                void pending.catch(() => undefined);
            }
            return;
        }
        if (process.env.LOOPFORGE_LOG) {
            const output = record.kind === "event"
                ? { ts: record.timestamp, event: record.name, ...record.attributes }
                : record;
            process.stderr.write(`[loopforge] ${JSON.stringify(output)}\n`);
        }
    }
    catch {
        // Observability must never change runtime behaviour.
    }
}
/** Emit a structured lifecycle event. */
export function logEvent(event, data = {}) {
    dispatch({
        schemaVersion: 1,
        timestamp: new Date().toISOString(),
        kind: "event",
        name: event,
        attributes: data,
    });
}
/** Start an explicitly-parented span. Span completion is idempotent. */
export function startSpan(name, attributes = {}, parent) {
    const context = {
        traceId: parent?.traceId ?? randomUUID(),
        spanId: randomUUID(),
    };
    const startedAt = Date.now();
    dispatch({
        schemaVersion: 1,
        timestamp: new Date(startedAt).toISOString(),
        kind: "span",
        name,
        traceId: context.traceId,
        spanId: context.spanId,
        parentSpanId: parent?.spanId,
        phase: "start",
        attributes,
    });
    let ended = false;
    return {
        context,
        end(status = "ok", endAttributes = {}) {
            if (ended)
                return;
            ended = true;
            const endedAt = Date.now();
            dispatch({
                schemaVersion: 1,
                timestamp: new Date(endedAt).toISOString(),
                kind: "span",
                name,
                traceId: context.traceId,
                spanId: context.spanId,
                parentSpanId: parent?.spanId,
                phase: "end",
                status,
                durationMs: endedAt - startedAt,
                attributes: { ...attributes, ...endAttributes },
            });
        },
    };
}
//# sourceMappingURL=observability.js.map