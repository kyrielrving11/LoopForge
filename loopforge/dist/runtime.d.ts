/** LoopForge — Loop Runtime (v1.2).
 *
 *  Event-driven loop driver that wraps the compilation engine with
 *  heartbeat monitoring, timeout/stall detection, and graceful shutdown.
 *
 *  Primary API:
 *    import { run } from 'loopforge';
 *    const result = await run({ task: '...', execute: myAgent });
 *
 *  Advanced API:
 *    const rt = new LoopRuntime(config);
 *    rt.on('round:complete', (info) => console.log(info));
 *    const result = await rt.start();
 */
import { EventEmitter } from "node:events";
import { RuntimeStatus, type RuntimeConfig, type RunResult } from "./protocol.js";
export declare class LoopRuntime extends EventEmitter {
    private config;
    private engine;
    private _status;
    private currentRound;
    private successTrajectory;
    private heartbeatTimer;
    private sigintHandler;
    private sigtermHandler;
    private lastSelfEval;
    private pendingVerificationFlags;
    private consecutiveRejections;
    private pendingRejectionNotice;
    private injectionCount;
    private lastInjectionRound;
    private injectedContexts;
    private phase2Triggered;
    private phase3Triggered;
    private pendingExternalContext;
    private roundStartTime;
    private lastProgressTime;
    private activeCtx;
    private timedOut;
    constructor(rawConfig: RuntimeConfig);
    get status(): RuntimeStatus;
    getCurrentRound(): number;
    getSuccessTrajectory(): boolean[];
    /** Derive the current progress estimate from the last self evaluation.
     *  Returns -1 if no progress data is available. */
    private getCurrentProgress;
    /** Determine which memory injection phase (0/1/2/3) should fire this round.
     *  Returns 0 if no injection should occur. Phase tracking (phase2Triggered /
     *  phase3Triggered) is updated by the caller based on the returned phase. */
    private getInjectionPhase;
    /** Build the accumulated context for constructing a targeted memory query.
     *  Delegates to the shared buildAccumulatedMemoryContext() utility. */
    private buildAccumulatedContext;
    /** Deduplicate external context against previously injected contexts.
     *  Returns empty string if the new context is too similar to any prior. */
    private dedupAndStoreContext;
    /** Start the loop. Returns when the loop terminates (task complete,
     *  circuit breaker, max rounds, stalled, or manual stop). */
    start(): Promise<RunResult>;
    /** Stop the loop gracefully. Safe to call from any thread/timer. */
    stop(): void;
    private buildCompileRequest;
    private startHeartbeat;
    private heartbeatTick;
    private stopHeartbeat;
    private registerSignalHandlers;
    private unregisterSignalHandlers;
}
/** Run a fully autonomous loop. Only `task` and `execute` are required.
 *  All other configuration has sensible defaults from `loop_policy.json`.
 *
 *  @example
 *  const result = await run({
 *    task: 'Audit ERC20 token for security vulnerabilities',
 *    execute: async (prompt) => await myAgent.call(prompt),
 *  });
 *  // result: { success, stopReason, roundsCompleted, successTrajectory }
 */
export declare function run(rawConfig: RuntimeConfig): Promise<RunResult>;
//# sourceMappingURL=runtime.d.ts.map