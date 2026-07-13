# Changelog

## 2.0.0-rc.1 (2026-07-13)

This release candidate changes LoopForge from a prompt-technique framework into
a recoverable cognitive state runtime driven by an external Agent.

### Breaking changes

- Replaced `loopforge-mcp` with the unified `loopforge` command. Start the MCP
  server with `loopforge mcp`.
- Removed `Technique`, `Analysis`, `vault_config`, strategy routing, the
  prompt-technique catalog, MCP Tasks, automatic memory discovery, and Markdown
  lineage recovery.
- Replaced the shared PromptCraft vault with typed per-loop JSON documents under
  `.loopforge/loops/`. Use `loopforge migrate` to import a legacy vault without
  deleting it.

### Runtime and prompts

- Added one canonical loop state and one prompt assembly pass. L0, L1, and L2
  now control state density only.
- Added stable round IDs, prompt artifacts, attempt numbers, before and after
  evidence, zero-commit rejection, and idempotent recovery of committed rounds.
- Runtime and MCP now share the same RoundDriver and round transaction path.
- Fixed pause, resume, stop, concurrent next, timeout, stalled executor, signal,
  and terminal cleanup state combinations.

### Storage, evidence, and observability

- Added atomic, locked, hash-isolated `FileLoopStore` session and round
  documents. Markdown state files remain optional derived views.
- Added async evidence isolation and explicit `CommandEvidenceProvider` support
  with shell-free execution, workspace cwd checks, output limits, abort, and
  required-command verification.
- Added structured tracing, policy metrics, renewable cross-process session
  leases, and portable checkpoint sinks without runtime dependencies.

### MCP and CLI

- Added strict runtime validation for MCP tool arguments and safe handling of
  primitive JSON-RPC input.
- MCP tools return structured output and serialized text. MCP Tasks are not
  implemented because the client Agent owns long-running execution.
- Added `init`, `doctor`, `inspect`, and `migrate` CLI commands.

## v1.19.0 (2026-07-12)

Execution Strategy Hints — L1 advisory mode gets lightweight, task-aware execution guidance
instead of the single `"direct"` label. Perception SKILL.md trimmed from 310 to 203 lines
with corrected L1 behavior description.

### Execution Strategy Hints
- **`ExecutionStrategy` type** — New type in `builder.ts`. Five strategies: `direct`,
  `investigate`, `decompose`, `compare`, `verify`. Each provides a 2–3 sentence hint
  without imposing a full reasoning technique framework.
- **`detectStrategySignals(task)`** — New function. Keyword-based signal detection returning
  `{ bug, rootCause, multiStep, compare, verify }` booleans. Uses prefix matching (`\bword`
  without trailing `\b`) so "crashes", "errors", "migration" match correctly.
- **`selectExecutionStrategy(task, override?)`** — New function. Priority-ordered heuristic:
  rootCause → investigate, multiStep → decompose, compare → compare, verify → verify,
  default → direct. `override` parameter allows users to pin a specific strategy via policy.
- **`buildStrategyHintBlock(decision)`** — New function. Formats a markdown block with
  `### Execution Strategy: [name]`, the hint text, and `"Execute the task directly.
  Do not generate another prompt."` — an anti-meta-prompt guarantee.
- **`SpecialistOpts.strategyHintBlock`** — New optional field. When provided, replaces the
  generic "Execution Instructions" block in `compileGeneric()`. Undefined by default
  (backward compatible).
- **`compileL1()` advisory block** — When `technique.mode` is `"advisory"` (default),
  computes a strategy hint via `selectExecutionStrategy()` + `buildStrategyHintBlock()`
  and passes it to `compileGeneric()`. Legacy and disabled modes are unaffected.
- **`TechniquePolicy.execution_strategy`** — New policy field. Accepts `"auto"` (default,
  heuristic-driven) or a specific strategy name (`"direct"`, `"investigate"`, etc.).
  Only applies in advisory mode; ignored in legacy and disabled modes.
- **`loop_policy.json`** — Added `"execution_strategy": "auto"` to technique block.

### Perception SKILL.md
- **P1 Fix** — L1 description corrected from "technique keyword-routed from Tier 1" to
  "direct execution (advisory mode, default) or keyword-routed Tier 1 (legacy mode)".
  L2 technique selection softened from mandatory "read" to conditional "if available, read".
  Rule 5 updated to say "follow the compiled prompt instructions" instead of "follow the
  keyword-routed technique."
- **P2 Trimming** — Trimmed from 310 lines to 203 lines. Removed marketing language,
  legacy `---loopforge-eval` block note, standalone Tool Reference table (merged into
  step-by-step). Collapsed Delegation Helpers from 44 lines to ~12 lines. Shortened
  full worked example from 47 to ~18 lines. Condensed "Why this matters" editorial
  to 2 sentences.

### Tests
- **332 tests** (was 286). 46 new tests:
  - `strategy.test.ts` (new file): 16 signal detection tests + 18 strategy selection tests
    (including priority ordering and override behavior) + 3 hint format tests.
  - `loop-compiler.test.ts`: 9 integration tests covering L1 strategy hint injection
    (investigate, direct, decompose, verify), legacy/disabled mode exclusion, policy
    override, multi-round persistence, and anti-meta-prompt guarantee.

### Documentation
- Root README.md and README.zh-CN.md: v1.19 hero banner, Philosophy block, L1 description
  in How It Works, Recompile Levels table, Execution Strategy Hints feature section,
  Agent Technique Autonomy section updated. Test count: 286 → 332.

---

## v1.18.0 (2026-07-12)

Pause/Resume + EvidenceProvider Interface — two structural improvements that build on the
Phase 2 RoundCoordinator unification and mandatory evidence enforcement.

### Pause/Resume
- **`RuntimeStatus.PAUSED`** — New runtime status. Loop is suspended at round boundary,
  signal handlers stay registered, memory writeback is skipped. Resumable from `currentRound`.
- **`LoopRuntime.pause()` / `resume()`** — Pause suspends the loop at the next iteration;
  resume re-enters via `_continue()` which picks up from `currentRound` without reset.
  Paused loops keep heartbeat and signal handlers registered.
- **SIGINT Double-Tap** — First `Ctrl+C` pauses (safe), second within `pause_double_tap_ms`
  (default 3000ms) forces stop. Configurable via policy; set to 0 to disable (always stop).
- **`SessionManager.pause()` / `unpause()`** — Pause persists session to vault with status
  `"paused"`. Unpause reconstructs from vault and compiles the next prompt. `autoResumeAll()`
  recovers both `"running"` and `"paused"` sessions on MCP server startup.
- **`loopforge_pause` MCP tool** — New tool. Pause a running session with vault persistence.
- **`loopforge_resume`** — Extended to handle both crash-recovery (running) and paused sessions.
  First tries `resume()` for crash-recovery, falls back to `unpause()` for paused sessions.
- **`McpSession.status`** — Added `"paused"` to status union. `McpSessionSummary` updated.
- **`StopReason."paused"`** — New stop reason. `STOP_REASON_OUTCOME_MAP` and
  `LoopMemoryWriteback.outcome` updated.
- **`RuntimePolicy.pause_double_tap_ms`** — New policy field (default 3000).

### EvidenceProvider Interface
- **`EvidenceProvider`** — New interface. `name: string` + `capture(): ProviderSnapshot | null`.
  Providers return null when unavailable (e.g. git not installed) — pipeline degrades gracefully.
- **`ProviderSnapshot`** — New type. `{ provider, timestamp, files, data }`. Carries structured
  evidence from each provider into the verification pipeline.
- **`EvidenceCollector`** — Runs all configured providers, silently skips unavailable ones.
  Used by both `runtime.ts` and `session.ts` instead of direct `captureGitModifiedFiles()` calls.
- **`GitEvidenceProvider`** — Built-in provider wrapping `captureGitFileState()`. Captures
  tracked, staged, and untracked file changes into a structured `ProviderSnapshot`.
- **`extractFilesFromSnapshots()`** / `diffSnapshots()`** — Utility functions. Extract merged
  file list from snapshots (backward compat with `runtimeFilesChanged`), and compute
  before→after diffs for `runtime.ts`.
- **`round-coordinator.ts`** — `RoundProcessInput` gains optional `evidenceSnapshots` field.
  Passed through to `verifySelfEvaluation()`.
- **`verification-gate.ts`** — `verifySelfEvaluation()` gains optional `evidenceSnapshots`
  parameter. New `checkEvidenceIntegrity()` cross-validates agent-reported `files_changed`
  against git provider snapshot. 7 checks total (was 6).
- **`EvidencePolicy`** — New policy section. `providers: string[]` — which providers to enable.
  Default: `["git"]`. Added to `DEFAULT_POLICY` and `loop_policy.json`.
- **`runtime.ts` / `session.ts`** — Replaced direct `captureGitModifiedFiles()` calls with
  `EvidenceCollector` + `GitEvidenceProvider`. Unused import removed from both files.

### Exports
- **`index.ts`** — New exports: `EvidenceCollector`, `GitEvidenceProvider`,
  `extractFilesFromSnapshots`, `diffSnapshots` (values), `ProviderSnapshot`,
  `EvidenceProvider` (types).

### Tests
- 286 tests (was 284). All existing tests pass without modification.

---

## v1.16.0 (2026-07-12)

Cognitive State Runtime — the project repositions from "Prompt Compiler" to
"State Runtime." Three Runtime-ification improvements make state management a
Runtime guarantee instead of a Prompt request.

### State File Inline Injection
- **`StateFilePolicy.inline_in_prompt`** — New policy field (default `true`). When
  enabled, the full state file content is prepended directly into the prompt —
  the Agent no longer needs to remember to read `.loopforge/state/{id}-state.md`.
  State injection is now a Runtime guarantee, not a Prompt request.
- **`compileL1()` / `compileL2()`** — Conditionally inline state file content
  based on `inline_in_prompt` policy. File is still written to disk as fallback.

### Git Diff Auto-Detection
- **`captureGitModifiedFiles()`** — New function in `verification-gate.ts`. Captures
  `git diff --name-only` before and after each agent execution round.
- **`checkFilesIntegrity()`** — New verification check. Compares agent-reported
  `files_changed` against git reality. Raises `warn` flag on mismatch.
  Gracefully degrades when git is unavailable (returns null → check skipped).
- **`verifySelfEvaluation()`** — New optional 5th parameter `runtimeFilesChanged`.
  Integrated into `runtime.ts` execute cycle.

### Evidence Block
- **`EvidenceSnapshot`** — New protocol type. Four categories: ✅ Verified,
  🔄 Pending, ❌ Invalidated, 💡 Discovered — aggregated from accumulated
  SelfEvaluation data.
- **`buildEvidenceSnapshot()`** — New function in `loop-compiler.ts`. Derives
  evidence from loop objective, last round result, and rolling summary.
- **`renderStateFile()`** — Renders `## Evidence` section in state file with
  four-quadrant view (empty categories hidden).

### Agent Reflection — next_action
- **`SelfEvaluation.next_action`** — New optional field. Agent declares its
  intended next step ("下一轮我要调查缓存层").
- **`LoopRoundResult.next_action`** — Carries the declaration forward.
- **`renderStateFile()`** — Renders `## Agent's Declared Next Action` in state file.
- **`compileL1()` / `compileL2()`** — Injects `### Your Declared Next Step`
  block into the prompt.

### Brand Repositioning
- README, CLAUDE.md, package.json, README.zh-CN.md, perception SKILL.md —
  repositioned from "Loop-Time Intelligence Layer / Prompt Compiler" to
  "Cognitive State Runtime."

---

## v1.15.0 (2026-07-09)

Agent Technique Autonomy at L2 — the Agent now freely chooses reasoning strategies
by reading the technique catalog instead of having LoopForge auto-select via keyword routing.

### L2 Restart Rework
- **`buildL2Prompt()`** — New function. Generates L2 prompts with a Technique Selection block
  that instructs the Agent to read `skills/prompt-techniques/SKILL.md`, freely choose the
  best technique based on loop state, read the corresponding reference file, and apply it
  directly. No technique skeleton is embedded — the skill reference files are the Agent's
  working manual.
- **`compileL2()`** — No longer calls `routeTechniqueAdaptive()` or dispatches to specialist
  compilers. Uses `buildL2Prompt()` instead. `technique_used` set to `"agent-selected"`,
  `reference_file` set to `"skills/prompt-techniques/SKILL.md"`.

### Strategy Collapse Removal
- **`strategyCollapse()`** — Removed. The "3 consecutive failures → force L2" gate in
  `decideLevel()` is gone. The decision to restart strategy belongs to the Agent (via
  checkpoint declaration), not to a failure counter.
- **`decideLevel()` Gate 4** — Removed. L2 now triggers on: Round 1, plan_source,
  checkpoint boundary, goal_id change.
- **`computeAdvisories()` strategy_collapse warning** — Removed.

### Tier Escalation Removal
- **`countConsecutiveFailures()`** — Removed from `builder.ts`.
- **`routeTechniqueAdaptive()` escalation branch** — Removed. No longer counts failures
  or forces Tier 2 techniques. Simplified to: checkpoint → all 7 techniques, normal → Tier 1 only.
- **`tier2_escalation_failures`** — Deprecated in `policy.ts`. Field retained for config
  compatibility but no longer consumed.

### Specialist Compilers
- `compileStepBack`, `compileLeastToMost`, `compileToT`, `compileGeneric` — All **preserved**.
  Still used by L1 for keyword-routed technique prompts. Only L2 no longer calls them.

### Observability
- **`tier2_escalation`** event — Deprecated. No longer emitted.

---

## v1.15.1 (2026-07-09)

Bug fixes and policy completeness for the Thin Prompt architecture.

### Bug Fixes
- **`state_file.enabled` now respected** — State files were written to disk regardless of the
  `state_file.enabled` policy flag. Fixed in `runtime.ts` and `mcp/session.ts` (3 call sites)
  to check `getPolicy().state_file.enabled` before writing.
- **`enforcement-gate.ts` git tracking** — The enforcement gate module was untracked despite
  being imported by `runtime.ts` and `mcp/session.ts`. Now staged in git.

### Policy
- **`loop_policy.json`** — Added missing `state_file` configuration section with defaults
  (`enabled: true`, `directory: ".loopforge/state"`, `max_checkpoints: 5`, `max_summary_rounds: 5`).
- **`write_on_outcomes`** — Corrected from `"completed"` to `"task_complete"` to match the
  actual `StopReason` enum value. Previously `"completed"` never matched any stop reason.

---

## v1.9.0 (2026-07-01)

Multi-Agent Delegation Support — LoopForge now tracks and injects sub-agent delegation
history into compiled prompts. Works with AgentTool sub-agents and Coordinator Workers
without requiring a separate "mode."

### Delegation Helpers (AgentTool Mode)
- **`filterConstraintsForSubTask(allConstraints, subTask, threshold?)`** — Pure function.
  Filters relevant constraints for a sub-agent task using Jaccard token similarity.
  Default threshold 0.15 (inclusive — lower than the 0.3 warn threshold).
- **`formatDelegationPrompt(subTask, subAgentType, constraints, options?)`** — Pure function.
  Produces self-contained prompts for Explore / General-purpose / Plan sub-agent types.
  All outputs are self-contained (no "based on above" references) — matching the
  AgentTool contract: "Workers can't see your conversation."
- **`recordDelegation(loopId, round, entries)`** — Engine method. Writes delegation
  journal entries to vault as `task_type: "delegation_journal"`.

### Worker Results (Coordinator / Multi-Agent)
- **`WorkerResult` interface** — `{ agentId, subAgentType, subTask, resultSummary, success, discoveredConstraints? }`.
  Added to `SelfEvaluation.worker_results` and `LoopRoundResult.worker_results`.
- **Auto-detection** — `buildSelfEvaluation()` parses `worker_results` from raw evaluation JSON.
  `autoFeedback()` automatically calls `recordDelegation()` when `worker_results` are present.
- **MCP schema** — `loopforge_next` evaluation schema updated with `worker_results` array property.
- **Cross-round injection** — `buildDelegationSummary(vaultContext)` scans vault for delegation
  journal entries and formats them as a `### Delegation History` table injected into the
  next round's compiled prompt.
- **Constraint flow** — Workers discover constraints → Coordinator reports via `worker_results` →
  LoopForge records to vault → next round's `Active Constraints` includes them →
  Coordinator passes them to future Workers.

### Design Principle
No `MultiAgentMode` enum. No `compileCoordination()` function. LoopForge does not
distinguish between single-agent and multi-agent execution. The main agent —
whether a single agent, an AgentTool user, or a Coordinator — receives compiled
prompts, executes, and reports results. LoopForge records, compresses, and injects.

### Protocol Changes (v1.8→v1.9)
- **1 new interface**: `WorkerResult`.
- **`SelfEvaluation.worker_results`** — optional array. Main agent reports sub-agent
  delegation results.
- **`LoopRoundResult.worker_results`** — optional array. Forwarded through
  `buildLoopRequest()` for compiler access.

### Tests
- 251 tests (was 241). 10 new tests: protocol factory defaults, constraint filtering
  (8 cases incl. CJK), delegation prompt formatting (6 cases incl. self-containment),
  delegation summary (null vault, multi-round table, failed delegations, backward compat,
  pipe escaping), schema count update.

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
