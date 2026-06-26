# LoopForge

[中文文档](README.zh-CN.md)

**Loop-Time Intelligence Layer** for AI coding agents. Per-iteration prompt compiler
with structured memory, constraint inheritance, and drift correction — maintains
cognitive stability across long-horizon agent loops.

> **v1.1** — `npm install loopforge`. CLI + library API. Zero runtime dependencies.
> 150 tests. Node.js ≥18.

---

## Quick Start

```bash
npm install loopforge

# Init vault
npx loopforge init

# Compile a prompt (loop_compile mode)
npx loopforge compile '{"task":"Audit ERC20 token","loop_id":"audit","round":1,"goal_id":"audit"}'

# v1.1: Autonomous loop via Claude Code hook — agent drives itself
# Step 1: Copy the Stop hook config to .claude/settings.json
# Step 2: Start a loop
npx loopforge compile '{"task":"Audit ERC20","loop_id":"audit","round":1,"goal_id":"audit"}'

# The hook auto-continues after each round — no human needed.
# Task complete? Agent stops. Drift detected? Circuit breaker triggers.

# Record feedback (manual mode)
npx loopforge feedback '{"loop_id":"audit","round":1,"success":true,"score":4}'

# Replay timeline
npx loopforge replay audit

# Diff two rounds
npx loopforge diff audit 1 3

# Vault health
npx loopforge status
```

```typescript
// Library API
import { createEngine, ReplayBackend, FSBackend } from "loopforge";

const engine = createEngine();
const result = engine.invokeLoopCompile({
  mode: "loop_compile",
  task: "Audit ERC20 token for security vulnerabilities",
  loop_id: "audit",
  round: 1,
  goal_id: "audit",
});

console.log(result.response?.full_prompt);
console.log(result.response?.health_line);
```

```typescript
// v1.1: Autonomous loop — no human in the feedback loop
import { createEngine, runAutonomousLoop } from "loopforge";

const engine = createEngine();
const result = await runAutonomousLoop(engine, {
  task: "Audit ERC20 token for security vulnerabilities",
  loopId: "audit-erc20",
  maxRounds: 10,
}, async (prompt, round) => {
  // Your AI executor here — Claude API, CLI agent, etc.
  return await callAiApi(prompt);
});

console.log(`Completed ${result.roundsCompleted} rounds: ${result.stopReason}`);
console.log(`Quality trajectory: ${result.qualityTrajectory}`);
```

---

## How It Works

LoopForge closes the agent feedback loop.  The agent self-evaluates:

```
LoopForge compiles prompt (with self-eval instructions)
  → Agent executes + outputs structured self-evaluation
    → LoopForge auto-extracts feedback → vault
      → LoopForge compiles next prompt (L0/L1/L2 auto-decided)
        → ... loop until task complete or circuit breaker
```

The self-evaluation is a 4-field JSON block embedded in every compiled prompt:

```json
{
  "success": true,
  "output_summary": "Found 3 vulns: reentrancy in withdraw(), integer overflow in transfer(), missing access control in mint()",
  "constraint_violations": [],
  "should_continue": true
}
```

Each field is consumed by specific downstream functions — nothing decorative.

---

## 3 Modes

| Mode | When | Returns |
|------|------|---------|
| **loop_compile** | Every agent loop iteration | Compiled prompt + recompile level (L0/L1/L2) + loop health + task alignment |
| **feedback** | After execution (manual or auto) | Quality score → vault persistence |
| **review** | Audit prompt quality | Structural checks + constraint compliance |

---

## Recompile Levels

| Level | Trigger | What Happens |
|-------|---------|--------------|
| **L0 Fast Path** | goal_id unchanged, no new failures/constraints | Reuse cached prompt from previous round |
| **L1 Patch** | New constraints, failures, or repair signals | Patch previous prompt with deltas; auto-retires stale constraints |
| **L2 Full Recompile** | Round 1, goal_id changed, plan_source, strategy collapse | Full hydrate + adaptive technique routing + rolling summary |

---

## CLI Commands

```bash
loopforge init                     # Initialize .promptcraft vault
loopforge compile '<json>'         # Compile a loop prompt (or pipe JSON via stdin)
loopforge feedback '<json>'        # Record execution feedback
loopforge run '<json>'             # v1.1: Autonomous loop (compile → extract → repeat)
loopforge hook-stop               # Claude Code Stop hook — auto-continue loop
loopforge replay <loop-id>         # Loop timeline — rounds, quality, technique per round
loopforge diff <loop-id> <a> <b>   # Field-level diff between two rounds
loopforge review <loop-id> <rN>    # Structural prompt audit
loopforge status                   # Vault health summary
```

---

## Key Features

- **Autonomous Loop (v1.1)** — Agent self-evaluates each round via structured JSON block. No human in the feedback loop. Claude Code Stop hook (`npx loopforge hook-stop`) auto-continues after every round.
- **Self-Evaluation Extraction** — Parses `---loopforge-eval` blocks from agent output. Falls back to heuristic extraction for graceful degradation.
- **L0/L1/L2 Incremental Recompilation** — 4-gate hard router: force_level → first-call/plan_source → goal_id stability → failure/constraint
- **Loop Objective Anchoring** — Auto-generated stable reference at round 1, checked every round
- **Constraint Retirement** — Stale constraints silent for 3+ rounds auto-retire to prevent prompt bloat
- **Rolling Summary** — Deterministic cross-round knowledge distillation from last 5 rounds
- **Adaptive Technique Routing** — Quality-driven fallback: 2+ consecutive low-quality rounds trigger rotation
- **Replay Engine** — Time-travel queries over vault lineage: `replay()`, `diff()`, `timeline()`
- **Policy Externalization** — All tunables in `loop_policy.json` — constraint windows, technique chains, triggers
- **Pluggable Backends** — `VaultBackend` interface; `FSBackend` (JSON + Markdown dual-write) ships by default
- **Task Alignment** — Validates proposed next-task against Loop Objective — advisory drift detection
- **Circuit Breaker** — 3 consecutive no-improvement rounds → STALLED
- **Zero Dependencies** — Node.js stdlib only. TypeScript strict mode.

---

## Project Structure

```
LoopForge/
├── loopforge/              # TypeScript package
│   ├── src/                     # adapter, autonomous, builder, cli, engine, loop-compiler, policy, protocol, replay, backends
│   ├── dist/                    # Compiled JS + type declarations
│   └── tests/                   # 150 tests (Node.js built-in runner)
├── skills/
│   └── prompt-techniques/       # Technique reference files (read at runtime)
│       └── references/          # zero-shot, few-shot, cot, step-back, least-to-most, tot
├── docs/
│   └── loopforge-spec.md      # Semantic spec
├── loopforge-protocol.json    # JSON Schema (draft 2020-12)
└── README.md / README.zh-CN.md
```

---

## API Modules

| Import | Purpose |
|--------|---------|
| `loopforge` | `handle()`, `createEngine()`, all types |
| `loopforge/compiler` | `compileLoop()`, `decideLevel()`, `compileL2()`, `buildSelfEvalBlock()` |
| `loopforge/replay` | `ReplayBackend` — `getRound()`, `replay()`, `timeline()`, `diff()` |
| `loopforge/autonomous` | `runOneRound()`, `runAutonomousLoop()` — v1.1 autonomous loop driver |

---

## License

MIT. See [LICENSE](LICENSE).
