/** LoopForge-loop_compile — Engine (compile façade).
 *
 * The engine loads committed history and delegates to the pure compiler. It
 * no longer writes round history; the round transaction coordinator owns the
 * one durable write path.
 */
import type { LoopStore } from "./loop-store.js";
import { type LoopCompileRequest, type LoopCompileResponse, type OperatorAcceptance } from "./protocol.js";
export { parseExecutionReport, parseWorkerResults, buildSelfEvaluation, } from "./self-eval.js";
export declare class LoopForgeEngine {
    private store;
    constructor(store?: LoopStore);
    private resolveStore;
    /** Public accessor for the loop store — used by the round transaction
     *  coordinator and round driver. */
    getStore(): LoopStore;
    invokeLoopCompile(request: LoopCompileRequest, options?: {
        operatorAcceptance?: OperatorAcceptance;
    }): LoopCompileResponse;
}
export declare function createEngine(store?: LoopStore): LoopForgeEngine;
//# sourceMappingURL=engine.d.ts.map