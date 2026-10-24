/** LoopForge-loop_compile — Engine (compile façade).
 *
 * The engine loads committed history and delegates to the pure compiler. It
 * no longer writes round history; the round transaction coordinator owns the
 * one durable write path.
 */

import { getPolicy } from "./policy.js";
import { FileLoopStore } from "./loop-store.js";
import type { LoopStore } from "./loop-store.js";
import {
  AgentStatus,
  makeLoopCompileResponse,
  type LoopCompileRequest,
  type LoopCompileResponse,
  type OperatorAcceptance,
} from "./protocol.js";
import { compileLoop } from "./loop-compiler.js";
import { loadCommittedHistory } from "./history.js";
import { parseExecutionReport, parseWorkerResults } from "./self-eval.js";

// ── Re-export self-evaluation utilities (moved to self-eval.ts) ──────────
export {
  parseExecutionReport,
  parseWorkerResults,
  buildSelfEvaluation,
} from "./self-eval.js";

// ═══════════════════════════════════════════════════════════════════════════
// LoopForgeEngine
// ═══════════════════════════════════════════════════════════════════════════

export class LoopForgeEngine {
  private store: LoopStore | null = null;

  constructor(store?: LoopStore) {
    this.store = store ?? null;
  }

  private resolveStore(): LoopStore {
    if (this.store === null) {
      this.store = new FileLoopStore(getPolicy().backend.root_dir);
    }
    return this.store;
  }

  /** Public accessor for the loop store — used by the round transaction
   *  coordinator and round driver. */
  getStore(): LoopStore {
    return this.resolveStore();
  }

  // ═══════════════════════════════════════════════════════════════════════
  // Loop Compile (public, primary)
  // ═══════════════════════════════════════════════════════════════════════

  invokeLoopCompile(
    request: LoopCompileRequest,
    options: { operatorAcceptance?: OperatorAcceptance } = {},
  ): LoopCompileResponse {
    let context: Record<string, unknown> | null = null;
    if (
      request.loop_id &&
      (request.round > 1 || (request.round === 1 && (request.attempt ?? 1) > 1))
    ) {
      context = {
        results: loadCommittedHistory(this.resolveStore(), request.loop_id).entries,
      };
    }

    try {
      return compileLoop(request, context, options);
    } catch (exc) {
      // Projection-coverage and operator-acceptance integrity defects are
      // FAIL CLOSED signals, not compile failures. Rethrow so the MCP
      // boundary surfaces their stable codes.
      const code = (exc as { code?: unknown } | null)?.code;
      if (code === "projection_incomplete" ||
          code === "operator_acceptance_conflict") {
        throw exc;
      }
      return makeLoopCompileResponse({
        status: AgentStatus.ERROR,
        prompt: "",
        error: `loop_compile failed: ${exc}`,
      });
    }
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// Factory
// ═══════════════════════════════════════════════════════════════════════════

export function createEngine(
  store?: LoopStore,
): LoopForgeEngine {
  return new LoopForgeEngine(store);
}
