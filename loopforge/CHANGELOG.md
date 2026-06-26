# Changelog

## v1.3.0 (2026-06-26)

MCP Server — Model Context Protocol integration for AI coding agents.

### MCP Server
- **`McpServer`** — JSON-RPC over stdio transport (`node:readline`), handles `initialize` / `tools/list` / `tools/call`
- **`SessionManager`** — manages `Map<sessionId, McpSession>`, each session = one complete multi-round loop with its own `LoopForgeEngine`
- **6 MCP tools**: `loopforge_start`, `loopforge_next`, `loopforge_status`, `loopforge_stop`, `loopforge_list`, `loopforge_replay`
- **`loopforge-mcp` binary** — `npx loopforge-mcp` entry point, registers with `claude mcp add loopforge -- npx loopforge-mcp`
- **Zero new dependencies** — stdlib only (`node:readline`, `node:crypto`)
- **8 existing source files unchanged** — engine, compiler, builder, policy, replay, backends, adapter, runtime all reused directly

### New files
- `src/mcp/session.ts` — SessionManager + advance() cycle (~230 lines)
- `src/mcp/tools.ts` — 6 tool schemas + handler registry (~190 lines)
- `src/mcp/server.ts` — JSON-RPC transport (~100 lines)
- `src/mcp-server.ts` — entry point
- `src/tests/mcp.test.ts` — 9 integration tests

### Modified
- `package.json` — bin `loopforge-mcp`, exports `./mcp`
- `src/index.ts` — exports `McpServer`, `SessionManager`, `McpSession` types

## v1.2.0 (2026-06-26)

Loop Runtime — event-driven autonomous loop driver.

### Loop Runtime
- **`run()` convenience function** — 2 required fields (`task`, `execute`), everything else automatic
- **`LoopRuntime` class** (EventEmitter) — `start()`, `stop()`, `getCurrentRound()`, `getQualityTrajectory()`
- **Heartbeat monitoring** — configurable interval (`heartbeatIntervalMs`, default 30s), emits per-round elapsed/progress
- **Round timeout** — sets `ctx.signal.aborted = true` when `roundTimeoutMs` (default 10 min) exceeded
- **Stall detection** — timeout + `stallGraceMs` (default 5 min) → status becomes STALLED
- **Executor failure breaker** — `maxConsecutiveErrors` (default 3) consecutive `execute()` throws → stop
- **SIGINT/SIGTERM graceful shutdown** — stops loop, cleans up timers
- **Interactive mode** — `interactive: true` disables timeout/stall (human-in-the-loop CLI scenarios)
- **Auto loopId** — derived from task text if not provided

### Removed
- **`autonomous.ts`** — replaced by `runtime.ts`
- **`cmdHookStop`** — removed hook-stop CLI command (runtime replaces hook-based integration)
- **`loopforge/autonomous`** export path — removed from package.json `exports`

### API
- `run(config): Promise<RunResult>` — primary user-facing API
- `LoopRuntime` — advanced class with EventEmitter events: `start`, `round:start`, `round:complete`, `heartbeat`, `timeout`, `stalled`, `done`, `stop`
- 9 new protocol types: `RuntimeStatus`, `RoundContext`, `AgentExecutor`, `StopReason`, `RoundStartInfo`, `RoundCompleteInfo`, `HeartbeatInfo`, `TimeoutInfo`, `HealthWarning`, `RuntimeConfig`, `RunResult`
- `RuntimePolicy` added to `loop_policy.json` — all configurable with sensible defaults

### Tests
- 165 total (was 150). 12 new runtime tests covering: minimal config, task_complete, circuit_breaker, max_rounds, executor_failure, timeout, stall, stop(), heartbeat events, reportProgress, extraction_failure, auto-generated loopId.

## v1.0.0 (2026-06-25)

Initial TypeScript reference implementation of the LoopForge protocol v3.5.

### Core Compiler
- **4-gate hard router**: force_level → first-call/plan_source → goal_id stability → failure/constraint signals
- **L0 Fast Path**: reuses cached prompt from previous round, auto-escalates to L2 when no cache available
- **L1 Patch**: incremental constraint injection with rolling summary context
- **L2 Full Recompile**: technique routing, loop objective anchoring, meta-instruction generation

### Features
- **Constraint Retirement (v3.5)**: auto-retires stale constraints after 3 inactive rounds
- **Rolling Summary (v3.5)**: deterministic cross-round knowledge distillation from last 5 rounds
- **Adaptive Technique Routing (v3.5)**: quality-driven fallback from keyword heuristic
- **Loop Objective Anchoring**: auto-generated at round 1 from task/plan_source, checked every round
- **Task Alignment**: Jaccard-based advisory drift detection (aligned/warn/block)
- **Circuit Breaker**: stalls after 3 consecutive no-improvement iterations

### Storage
- **VaultBackend interface**: pluggable storage abstraction (9 methods)
- **FSBackend**: filesystem implementation with dual-write (JSON vault + Markdown lineage)
- **ReplayBackend**: time-travel queries — getRound, replay, timeline, diff

### CLI
- `loopforge init` — initialise vault
- `loopforge compile` — loop_compile mode (L0/L1/L2)
- `loopforge feedback` — execution recording with quality scoring
- `loopforge replay` — loop timeline with technique/quality history
- `loopforge diff` — field-level round comparison
- `loopforge review` — structural prompt audit
- `loopforge status` — vault health summary

### API
- Zero runtime dependencies — stdlib only (Node.js built-ins)
- Full TypeScript strict mode with declaration files
- Tree-shakeable exports: protocol, compiler, replay, policy, builder, engine, adapter
