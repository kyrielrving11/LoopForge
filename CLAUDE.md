# LoopForge

**Loop-Time Intelligence Layer** for AI coding agents. Per-iteration prompt compiler
with structured memory, constraint inheritance, and drift correction — maintains
cognitive stability across long-horizon agent loops.

- Language: TypeScript only. No Python, Ruby, or other language files.
- Package: `loopforge/` — npm package `loopforge` v1.15.0, ESM, Node ≥18.
- Zero runtime dependencies — stdlib only.

## Commands

```bash
cd loopforge
npm run build    # tsc + generate JSON Schema
npm test         # tsc + schema gen + 277 tests (node:test)
npx tsc --noEmit # type-check only
```

## Architecture

```
loopforge/src/
  protocol.ts          # 40 types (4 enums + 35 interfaces + 1 type alias) — wire contract
  loop-compiler.ts     # L0/L1/L2 + Thin Prompt + Fat File + advisories (~2550 lines; v1.15: L2 Agent autonomy)
  engine.ts            # Lifecycle, circuit breaker, session state + verification gate injection (~890 lines)
  runtime.ts           # Loop Runtime — event-driven loop with heartbeat/timeout/stall + state file write
  verification-gate.ts # Layer 2 cross-round consistency checks (v1.6, ~250 lines)
  enforcement-gate.ts  # Layer 3 round-boundary enforcement (v1.13, ~330 lines) — accept/reject/terminate
  builder.ts           # Technique routing (keyword heuristic; v1.15: tier escalation removed)
  replay.ts            # Time-travel queries: getRound / replay / timeline / diff
  policy.ts            # loop_policy.json loader (includes RuntimePolicy, StateFilePolicy)
  generate-schema.ts   # JSON Schema generator (runs during build)
  observability.ts     # Structured JSON event logging to stderr (LOOPFORGE_LOG env-var gated)
  memory-bridge.ts     # claude-mem integration — autoConfigure, memoryProvider, memoryWriter
  backends/
    interface.ts       # VaultBackend interface (9 methods)
    fs.ts              # FSBackend — JSON vault + Markdown lineage dual-write
  mcp/
    session.ts         # SessionManager — Map<id, {engine, round, ...}> + advance/save/resume/getHealth (~830 lines)
    tools.ts           # 8 tool defs + handlers: start/next/status/stop/list/replay/resume/health (~250 lines)
    server.ts          # JSON-RPC over stdio — initialize/tools/list/tools/call (~100 lines)
  mcp-server.ts        # MCP server entry point (#!/usr/bin/env node)
  skills/
    perception/
      SKILL.md          # Platform-agnostic agent skill — multi-round loop instructions
```

## Hotspot Files

### `verification-gate.ts` (~250 lines)
Pure-function cross-round consistency verifier. Key boundaries:
- 6 individual check functions, each returns `VerificationFlag | null`
- `verifySelfEvaluation()` orchestrates all 6 checks and produces a `VerificationResult`
- 3 verdict tiers: `trusted` (normal flow), `suspect` (warn in prompt), `contradicted` (skip success trend, hard constraint to respond)
- Zero side effects — all data flows through parameters; vault queries happen in the caller (session.ts)
- Does NOT modify success flags — only skips trend writes for contradicted rounds

### `enforcement-gate.ts` (~330 lines)
Round-boundary runtime enforcement. Takes verification findings and decides:
- **accept**: round passes; advance to next round
- **reject**: agent's self-evaluation is invalid; returns a rejection prompt, agent must redo SAME round
- **terminate**: unrecoverable state; stop loop with stopReason `enforcement_terminated`
5 rules (R1–R5) in priority order: fake success, recurring violation, empty success, progress stall, max rejections.
Runs BEFORE autoFeedback so rejected rounds don't pollute the vault.

### `loop-compiler.ts` (~2500 lines)
Pure-function compiler — largest module. Key boundaries:
- **L0 (Retry)**: honest failure with no new information — reuses cached prompt
- **L1 (Continue)**: default path — Tier 1 technique routing (4 techniques via keyword heuristic), handles all P0-P5 state evolution (discovered constraints, objective refinement, self-correction), renders state file, produces thin prompt
- **L2 (Restart)**: Round 1, checkpoint boundary, or goal_id change — Agent reads `skills/prompt-techniques/SKILL.md`, freely chooses the best technique, reads the corresponding reference file, and applies it directly to the task. LoopForge provides context; the Agent provides the reasoning strategy. (v1.15: specialist compiler dispatch and embedded technique skeletons removed from L2.)
- `compileL2()` delegates to `buildL2Prompt()` which generates a Technique Selection block + Loop Objective + Constraints + Task — no auto-selected technique
- `renderStateFile()` produces `.loopforge/state/{loopId}-state.md` — a snapshot rewritten every round, not append-only
- `decideLevel()` gates: force_level → round 1 / plan_source (L2) → checkpoint boundary (L2) → goal_id stability (L2) → honest failure with no new info (L0) → default (L1). (v1.15: Gate 4 — strategy collapse / 3 consecutive failures → auto L2 — removed.)
- `computeAdvisories()` uses Jaccard token similarity; thresholds hardcoded (0.5 aligned, 0.3 warn). (v1.15: strategy_collapse advisory removed.)
- Before modifying: ensure `npm test` covers the change path

### `engine.ts` (~890 lines)
Stateful engine — only module with mutable session state.
- `invokeLoopCompile()` delegates to pure-function `compileLoop()`
- Passes `state_file_content` from compiler response through to callers (v1.14)
- `autoFeedback()` flushes buffer immediately so next compile sees latest success flags
- `shouldBreak()` trips on 3 consecutive failures (`success === false`)
- `hydrateLoopContext()` adds `full_prompt` field — this field only exists on hydrated entries, not in the raw JSON vault
- (v1.6) Injects verification gate flags into prompt as a `### Verification Gate` section after compiler warnings

### `runtime.ts` (~550 lines)
Event-driven loop driver. Key invariants:
- Extraction is checked BEFORE should_continue — heuristic extraction always stops the loop
- Verification gate + Enforcement gate run BEFORE autoFeedback — rejected rounds don't pollute vault
- REJECT handling: sets pendingRejectionNotice, decrements currentRound, continues (retries same round)
- SIGINT/SIGTERM → `stop()` sets status=STOPPED; next iteration of for-loop exits
- Interactive mode (`interactive: true`) skips timeout/stall — used by CLI `cmdRun`
- (v1.14) Writes state file after every compile that produces state file content

### `mcp/session.ts` (~830 lines)
Session manager — MCP integration layer. Key invariants:
- Each session = one complete multi-round loop with its own LoopForgeEngine instance
- `advance()` cycle: extract → verify (v1.6) → enforce (v1.13) → feedback → check stop → compile next (extraction-first order)
- Enforcement gate (v1.13) runs between verification and feedback; REJECT returns a rejection prompt without incrementing round; TERMINATE stops the loop
- `create()` compiles round 1 via `engine.invokeLoopCompile()` and stores the session
- `save()` persists session state to vault including `consecutiveRejections` for cross-process recovery
- `resume()` restores session state from vault, including enforcement gate state
- (v1.14) Writes state file (`.loopforge/state/{loopId}-state.md`) after every compile that produces state file content
- `replayTimeline()` wraps ReplayBackend using the same VaultBackend as the engine
- Sessions auto-cleanup when advance returns prompt=null; stop/delete are idempotent

## Key Rules

- `loopforge-protocol.json` is auto-generated. Edit `protocol.ts` and run `npm run build`.
- Schema gen runs on every build; the test suite validates the generated schema.
- The project is the npm package. All commands run from `loopforge/`.
- Agent skill: `skills/perception/SKILL.md` — copy to `~/.claude/skills/perception/` or your agent's skill directory.
- State files are written to `.loopforge/state/{loopId}-state.md` — rewritten every round (not append-only).
- `loop_policy.json` controls state file behavior via `state_file.enabled` (master toggle).

## Quick Start (MCP + Skill)

```bash
npm install -g loopforge
claude mcp add loopforge -- npx loopforge-mcp
# Copy the skill:
mkdir -p ~/.claude/skills/perception
cp skills/perception/SKILL.md ~/.claude/skills/perception/
```
