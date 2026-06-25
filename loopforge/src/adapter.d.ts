/** LoopForge-loop_compile — Sub-agent adapter (unified entry point).
 *
 * This is the single entry point when LoopForge is invoked as a sub-agent.
 * It wraps the Engine, routes by mode, and always prepends a compact health line.
 *
 * Three modes (v1.0):
 *     loop_compile — Per-iteration prompt compiler (primary entry point)
 *     feedback     — Record execution results → quality scoring → vault persistence
 *     review       — Audit prompt quality (structural checks + constraint compliance)
 *
 * build is an internal path (loop_compile L2 delegation) — not an exposed mode.
 */
import { type LoopForgeRequest } from "./protocol.js";
import { LoopForgeEngine } from "./engine.js";
export declare function handle(requestInput: string | Record<string, unknown> | LoopForgeRequest, engine?: LoopForgeEngine): string;
export declare function main(): void;
//# sourceMappingURL=adapter.d.ts.map