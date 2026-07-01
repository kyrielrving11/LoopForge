# Changelog

## v1.8.0 (2026-07-01)

Memory System Integration — bidirectional bridge between LoopForge and Agent long-term memory.

### Memory Injection (Retrieval)
- **Tiered Injection Strategy** — injection frequency scales with loop length. Short loops (≤10 rounds)
  get 1 injection (Phase 1 only). Medium loops (11–20 rounds) get 2 injections (Phase 1 + Phase 3).
  Long loops (21+ rounds) get all 3 phases. Configurable via `round_tiers` in policy.
- **Refined Phase Thresholds** — Phase 2 fires at 40% progress (was 30% — too early).
  Phase 3 fires at 70% progress (was 60% — still in execution). Better alignment with real task cadence.
- **Jaccard Deduplication** — subsequent injections deduped against previous contexts (threshold 0.6).
  Prevents redundant retrieval when memory returns stale/similar results.
- **Phase-Aware Query Construction** — each phase uses a different query composition:
  Phase 1 queries task + constraints, Phase 2 queries current focus + failure patterns,
  Phase 3 queries remaining criteria + key lessons + edge cases.
- **Configurable Policy** — `memory_injection` section in `loop_policy.json`:
  `enabled`, `min_rounds_between_injections`, `phase_thresholds` (progress-based trigger points),
  `round_tiers` (tiered phase allowance by maxRounds), `dedup_threshold`, `max_context_length`.
- **Zero-Cost at L0/L1** — memory retrieval only fires when compiler level is L2.
  L0 (cache hit) and L1 (patch) rounds have zero memory overhead.

### Memory Writeback
- **Automatic on Loop End** — distilled knowledge written back to Agent memory on every stop reason
  (task_complete, circuit_breaker, max_rounds, stalled, stopped). Configurable via `memory_writeback.write_on_outcomes`.
- **Structured Payload** — `LoopMemoryWriteback` interface: 1 project entry (outcome + key discoveries), 
  ≤5 feedback entries (rule + Why + How to apply, matching claude-mem's feedback format), 
  1 reference entry (pointer to LoopForge vault).
- **Format Alignment** — feedback entries follow claude-mem's requirement of structured body: 
  rule statement + `**Why:**` + `**How to apply:**`. Project entries store absolute dates 
  (relative→absolute conversion on write).
- **Minimal Principle** — only writes what cannot be derived from current code state. 
  Code patterns stay in code; decisions, discoveries, and tactical lessons go to memory.

### Protocol Changes (v1.7→v1.8)
- **5 new interfaces**: `MemoryProviderContext`, `LoopMemoryWriteback`, `LoopMemoryWritebackProjectEntry`, 
  `LoopMemoryWritebackFeedbackEntry`, `LoopMemoryWritebackReferenceEntry`.
- **`LoopCompileRequest.external_context`** — optional field for memory context injection 
  (ignored by L0/L1, formatted into L2 prompt with priority disclaimer).
- **`RuntimeConfig.memoryProvider` / `memoryWriter`** — optional callbacks for custom memory system integration.
  Auto-detected when running with claude-mem; users can override.
- **`LoopPolicy.memory_injection` / `memory_writeback`** — externalized configuration.

### Compiler Changes
- **`formatExternalContext()`** — formats memory context as a marked section in L2 prompts with 
  explicit priority disclaimer: "If any insight contradicts the Loop Objective or Active Constraints, 
  LoopForge takes absolute precedence."
- **`tokenize()` / `jaccard()` exported** — for dedup use by runtime and MCP session manager.

### Runtime & MCP
- **`LoopRuntime`**: phase tracking (`injectionCount`, `lastInjectionRound`, `injectedContexts`, 
  `phase2Triggered`/`phase3Triggered`), `shouldInjectMemory()`, `buildAccumulatedContext()`, 
  `dedupAndStoreContext()`, `buildWritebackPayload()`.
- **`SessionManager`**: `memoryProvider`/`memoryWriter` callbacks, `doWriteback()` helper, 
  memory state persisted to vault via `loop_lineage` (injection_count, phase2_triggered, etc.).
- **`McpSession`**: 5 new memory tracking fields.
- **Async upgrade**: `create()`, `advance()`, and all MCP tool handlers now async. 
  `dispatch()` and stdin handler also async.

### Memory Bridge — Auto-Detection & Filesystem Integration
- **`memory-bridge.ts`** (~250 lines) — zero-config auto-detection of claude-mem via local filesystem.
  Scans `~/.claude/projects/{hash}/memory/` for project hash (computed from git root path,
  matching claude-mem's `[^a-zA-Z0-9] → -` algorithm). No REST API dependency, no auth tokens.
- **Retrieval via filesystem** — `createMemoryProvider()` reads `*.md` memory files directly,
  scores by keyword overlap against phase-aware query terms (Phase 1: task terms, Phase 2: + issues/patterns,
  Phase 3: + remaining criteria/lessons). Returns top-3 memories concatenated. Strips YAML frontmatter.
- **Writeback via filesystem** — `createMemoryWriter()` writes project/feedback/reference `.md` files
  in claude-mem's exact format (YAML frontmatter + structured body). Appends to `MEMORY.md` index.
  mkdir-based file lock prevents concurrent write corruption.
- **Two integration paths**:
  - MCP: `autoConfigureMemory(mgr)` sets `memoryProvider`/`memoryWriter` on `SessionManager`.
    Called automatically in `McpServer` constructor — zero user configuration.
  - Library: `tryAutoConfigure()` returns `{ memoryProvider?, memoryWriter? }`.
    Called automatically in `resolveConfig()` when no explicit callbacks provided.
- **Silent degradation** — if claude-mem is not installed or the project has no memory directory,
  both functions are no-ops. LoopForge continues normally without memory integration.
- **Explicit overrides** — user-provided `memoryProvider`/`memoryWriter` callbacks always take
  precedence over auto-detection.

### Design Rationale
- **LoopForge is not a memory system — it's a prompt compiler.** Agent memory answers "what did you do before"; 
  LoopForge answers "what should you do next, and how should you think about it." They are different layers 
  of the same cognitive stack: long-term memory (cross-session) vs working memory + executive control (within-task).
- **Not a replacement — a complement.** Agent memory cannot replace LoopForge's constraint lifecycle, 
  technique routing, or verification gate. LoopForge cannot replace Agent memory's cross-session semantic search. 
  Together they form a complete cognitive architecture: memory IN → LoopForge → memory OUT.

### Tests
- 227 tests (was 202 — 25 new memory-bridge tests covering detection, retrieval, writeback, edge cases).

## v1.3.1 (2026-06-27)

Session recovery, success criteria enforcement, and MCP tool expansion.

### Session Durability
- **`save()` / `resume()` in SessionManager** — session state persisted to vault as `session_state` entries (upsert per loop). Process restart → `resume(loopId)` reconstructs session from vault lineage and compiles the next round's prompt.
- **Auto-save in `create()` and `advance()`** — every state change (compile, stop, stall, task_complete) writes to vault automatically.
- **`loopforge resume <loop-id>` CLI command** — restore loop from vault and print the next-round prompt.

### MCP Tool Expansion (6 → 8 tools)
- **`loopforge_resume`** — resume a loop from vault after process restart. Returns next-round prompt or stopReason.
- **`loopforge_health`** — standalone loop health check: goal alignment, constraint integrity, drift detection, strategy stability, task continuity.
- **`loopforge_list`** — now scans vault for persisted sessions in addition to in-memory sessions. Shows all loops available for resume after a restart.

### Success Criteria as Hard Constraints
- `compileL2()` now merges `loop_objective.success_criteria` into `constraints_active` alongside `hard_constraints`. Success criteria are tracked, retired, and checked for violations like any other constraint — no longer decorative text.

### Bug Fix
- **`last_technique` was never written** — `loopforge_status` always returned `null` for `technique`. Fixed: `invokeLoopCompile` now writes `this.state.last_technique = response.technique_used`.

### Code Hygiene
- Removed 5 unused imports across `cli.ts`, `loop-compiler.ts`, `backends/fs.ts`.
- Deleted 48 stale build artifacts (36 in `src/`, 12 orphan files in `dist/`).
- Added `.gitignore` patterns for `src/**/*.{js,d.ts,js.map,d.ts.map}`.
- Annotated `globalVaultPath` and `global_vault_path` as `v2: federation (not yet implemented)`.

### New Tests
- 10 new tests: success criteria → constraints_active, session persistence (save/resume round-trip, stopped/stalled states), MCP resume/health/list-vault handlers, status technique fix.

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
