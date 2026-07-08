# LoopForge

**Loop-Time Intelligence Layer** for AI coding agents. Per-iteration prompt compiler
with structured memory, constraint inheritance, and drift correction — maintains
cognitive stability across long-horizon agent loops.

- Language: TypeScript only. No Python, Ruby, or other language files.
- Package: `loopforge/` — npm package `loopforge` v1.12.0, ESM, Node ≥18.
- Zero runtime dependencies — stdlib only.

## Commands

```bash
cd loopforge
npm run build    # tsc + generate JSON Schema
npm test         # tsc + schema gen + 260 tests (node:test)
npx tsc --noEmit # type-check only
```

## Architecture

```
loopforge/src/
  protocol.ts          # 39 types (4 enums + 34 interfaces + 1 type alias) — wire contract
  loop-compiler.ts     # L0/L1/L2 + advisories + specialist compilers (~1600 lines)
  engine.ts            # Lifecycle, circuit breaker, session state + verification gate injection (~890 lines)
  runtime.ts           # Loop Runtime (v1.2+) — event-driven loop with heartbeat/timeout/stall
  verification-gate.ts # Layer 1 cross-round consistency checks (v1.6, ~250 lines)
  builder.ts           # Technique routing (keyword + tier-gated)
  replay.ts            # Time-travel queries: getRound / replay / timeline / diff
  policy.ts            # loop_policy.json loader (includes RuntimePolicy)
  generate-schema.ts   # JSON Schema generator (runs during build)
  observability.ts     # Structured JSON event logging to stderr (LOOPFORGE_LOG env-var gated)
  memory-bridge.ts     # claude-mem integration — autoConfigure, memoryProvider, memoryWriter
  backends/
    interface.ts       # VaultBackend interface (9 methods)
    fs.ts              # FSBackend — JSON vault + Markdown lineage dual-write
  mcp/
    session.ts         # SessionManager — Map<id, {engine, round, ...}> + advance/save/resume/getHealth (~737 lines)
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

### `loop-compiler.ts` (~1600 lines)
Pure-function compiler — largest module. Key boundaries:
- `compileL0/L1/L2()` are entry points; `compileL2()` delegates to specialist compilers
- Specialist compilers (`compileStepBack`, `compileLeastToMost`, `compileToT`) each embed an 8-section skeleton with quality checklist — changes to section requirements must update BOTH the skeleton AND the checklist
- `computeAdvisories()` uses Jaccard token similarity; thresholds hardcoded (0.5 aligned, 0.3 warn)
- Before modifying: ensure `npm test` covers the change path

### `engine.ts` (~890 lines)
Stateful engine — only module with mutable session state.
- `invokeLoopCompile()` delegates to pure-function `compileLoop()`
- `autoFeedback()` flushes buffer immediately so next compile sees latest success flags
- `shouldBreak()` trips on 3 consecutive failures (`success === false`)
- `hydrateLoopContext()` adds `full_prompt` field — this field only exists on hydrated entries, not in the raw JSON vault
- (v1.6) Injects verification gate flags into prompt as a `### Verification Gate` section after compiler warnings

### `runtime.ts` (~530 lines)
Event-driven loop driver. Key invariants:
- Extraction is checked BEFORE should_continue — heuristic extraction always stops the loop
- SIGINT/SIGTERM → `stop()` sets status=STOPPED; next iteration of for-loop exits
- Interactive mode (`interactive: true`) skips timeout/stall — used by CLI `cmdRun`

### `mcp/session.ts` (~737 lines)
Session manager — MCP integration layer. Key invariants:
- Each session = one complete multi-round loop with its own LoopForgeEngine instance
- `advance()` cycle: extract → verify (v1.6) → feedback → check stop → compile next (extraction-first order)
- `create()` compiles round 1 via `engine.invokeLoopCompile()` and stores the session
- `replayTimeline()` wraps ReplayBackend using the same VaultBackend as the engine
- (v1.6) Verification gate runs between extraction and feedback; contradicted rounds skip success trend
- Sessions auto-cleanup when advance returns prompt=null; stop/delete are idempotent

## Key Rules

- `loopforge-protocol.json` is auto-generated. Edit `protocol.ts` and run `npm run build`.
- Schema gen runs on every build; the test suite validates the generated schema.
- The project is the npm package. All commands run from `loopforge/`.
- Spec: `docs/loopforge-spec.md`.
- Agent skill: `skills/perception/SKILL.md` — copy to `~/.claude/skills/perception/` or your agent's skill directory.

## Quick Start (MCP + Skill)

```bash
npm install -g loopforge
claude mcp add loopforge -- npx loopforge-mcp
# Copy the skill:
mkdir -p ~/.claude/skills/perception
cp skills/perception/SKILL.md ~/.claude/skills/perception/
```
