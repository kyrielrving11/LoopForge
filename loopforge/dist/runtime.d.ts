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
    private qualityTrajectory;
    private heartbeatTimer;
    private sigintHandler;
    private sigtermHandler;
    private roundStartTime;
    private lastProgressTime;
    private activeCtx;
    private timedOut;
    constructor(rawConfig: RuntimeConfig);
    get status(): RuntimeStatus;
    getCurrentRound(): number;
    getQualityTrajectory(): number[];
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
 *  // result: { success, stopReason, roundsCompleted, qualityTrajectory }
 */
export declare function run(rawConfig: RuntimeConfig): Promise<RunResult>;
//# sourceMappingURL=runtime.d.ts.map