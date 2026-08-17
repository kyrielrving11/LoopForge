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
export function logEvent(event: string, data: LogEventData = {}): void {
  if (!process.env.LOOPFORGE_LOG) return;
  try {
    process.stderr.write(
      `[loopforge] ${JSON.stringify({ ts: new Date().toISOString(), event, ...data })}\n`,
    );
  } catch {
    // Observability must never change runtime behaviour.
  }
}
