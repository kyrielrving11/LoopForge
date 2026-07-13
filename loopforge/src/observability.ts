/** Zero-dependency structured events and tracing.
 *
 * Lifecycle events remain silent unless LOOPFORGE_LOG is set. Applications can
 * install a TraceSink to receive the same events plus span start/end records
 * without coupling LoopForge to a tracing SDK.
 */

import { randomUUID } from "node:crypto";

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

let configuredSink: TraceSink | null = null;

/** Install a process-wide sink. Passing null restores environment-gated stderr. */
export function setTraceSink(sink: TraceSink | null): void {
  configuredSink = sink;
}

export function getTraceSink(): TraceSink | null {
  return configuredSink;
}

function dispatch(record: TraceRecord): void {
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
  } catch {
    // Observability must never change runtime behaviour.
  }
}

/** Emit a structured lifecycle event. */
export function logEvent(event: string, data: LogEventData = {}): void {
  dispatch({
    schemaVersion: 1,
    timestamp: new Date().toISOString(),
    kind: "event",
    name: event,
    attributes: data,
  });
}

export interface TraceSpan {
  readonly context: TraceContext;
  end(status?: TraceStatus, attributes?: Record<string, unknown>): void;
}

/** Start an explicitly-parented span. Span completion is idempotent. */
export function startSpan(
  name: string,
  attributes: Record<string, unknown> = {},
  parent?: TraceContext,
): TraceSpan {
  const context: TraceContext = {
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
    end(status: TraceStatus = "ok", endAttributes = {}) {
      if (ended) return;
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
