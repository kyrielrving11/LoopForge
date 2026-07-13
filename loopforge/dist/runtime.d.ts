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
    private roundDriver;
    private _status;
    private currentRound;
    private successTrajectory;
    private heartbeatTimer;
    private sigintHandler;
    private sigtermHandler;
    private lastSelfEval;
    private pendingVerificationFlags;
    private consecutiveRejections;
    /** Which enforcement check triggered the last rejection.
     *  Only same-check rejections accumulate; a different check resets the counter. */
    private lastRejectionCheck;
    private pendingRejectionNotice;
    private roundSnapshot;
    private pauseTimestamp;
    private pauseRequested;
    private driverPromise;
    private pendingExternalContext;
    private roundStartTime;
    private lastProgressTime;
    private activeCtx;
    private activeAbortController;
    private timedOut;
    constructor(rawConfig: RuntimeConfig);
    get status(): RuntimeStatus;
    getCurrentRound(): number;
    getSuccessTrajectory(): boolean[];
    /** Start the loop. Returns when the loop terminates (task complete,
     *  circuit breaker, max rounds, stalled, paused, or manual stop).
     *  Can only be called from IDLE state. */
    start(): Promise<RunResult>;
    /** Start the one allowed loop driver and clear its ownership on exit. */
    private launchDriver;
    /** Internal loop driver. Called by both start() (isResume=false) and
     *  resume() (isResume=true). When resuming, skips the currentRound=1
     *  reset — the loop picks up exactly where it left off. */
    private _continue;
    /** Execute one round with a hard driver deadline. The AbortSignal lets a
     *  cooperative executor stop early; the race guarantees the runtime itself
     *  still resolves when an executor ignores cancellation. */
    private executeWithDeadline;
    private triggerTimeout;
    private triggerStall;
    /** Stop the loop gracefully. Safe to call from any thread/timer. */
    stop(): void;
    /** Pause the loop gracefully. Completes the current round, then suspends.
     *  Safe to call from signal handlers or callbacks.
     *  Only has effect when the loop is RUNNING. */
    pause(): void;
    /** Resume a paused loop. Re-enters the main loop from currentRound.
     *  The loop continues exactly where it was suspended. */
    resume(): Promise<RunResult>;
    private buildCompileRequest;
    /** Adapt the typed compiler request to the engine envelope once for both
     * normal rounds and enforcement retry attempts. */
    private buildEngineCompileRequest;
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