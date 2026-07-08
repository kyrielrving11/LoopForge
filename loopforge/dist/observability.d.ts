/** LoopForge — Structured event logging (v1.7).
 *
 *  JSON-line events to stderr for key lifecycle moments.
 *  Gated behind process.env.LOOPFORGE_LOG — silent by default.
 *
 *  Events:
 *    round_complete   — engine/runtime after feedback processed
 *    circuit_breaker  — shouldBreak() returns true
 *    gate_contradicted — verification gate returns contradicted verdict
 *    tier2_escalation — builder escalates to Tier 2 techniques
 *    vault_write_error — any catch in vault write paths
 *    session_start / session_end — MCP session lifecycle
 *
 *  Usage:
 *    LOOPFORGE_LOG=1 npm test
 *    LOOPFORGE_LOG=1 node my_script.js 2>&1 | grep '\[loopforge\]'
 */
export interface LogEventData {
    [key: string]: unknown;
}
/** Emit a structured JSON event to stderr when LOOPFORGE_LOG is set. */
export declare function logEvent(event: string, data?: LogEventData): void;
//# sourceMappingURL=observability.d.ts.map