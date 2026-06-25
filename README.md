# LoopForge

[中文文档](README.zh-CN.md)

**Loop-Time Intelligence Layer** for AI coding agents. Per-iteration prompt compiler
with structured memory, constraint inheritance, and drift correction — maintains
cognitive stability across long-horizon agent loops.

> **v1.0** — `npm install loopforge`. CLI + library API. Zero runtime dependencies.
> 103 tests. Node.js ≥18.

---

## Quick Start

```bash
npm install loopforge

# Init vault
npx loopforge init

# Compile a prompt (loop_compile mode)
npx loopforge compile '{"task":"Audit ERC20 token","loop_id":"audit","round":1,"goal_id":"audit"}'

# Record feedback
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

---

## 3 Modes

| Mode | When | Returns |
|------|------|---------|
| **loop_compile** | Every agent loop iteration | Compiled prompt + recompile level (L0/L1/L2) + loop health + task alignment |
| **feedback** | After execution | Quality score → vault persistence |
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
loopforge replay <loop-id>         # Loop timeline — rounds, quality, technique per round
loopforge diff <loop-id> <a> <b>   # Field-level diff between two rounds
loopforge review <loop-id> <rN>    # Structural prompt audit
loopforge status                   # Vault health summary
```

---

## Key Features

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
│   ├── src/                     # adapter, builder, cli, engine, loop-compiler, policy, protocol, replay, backends
│   ├── dist/                    # Compiled JS + type declarations
│   └── tests/                   # 103 tests (Node.js built-in runner)
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
| `loopforge/compiler` | `compileLoop()`, `decideLevel()`, `compileL2()` |
| `loopforge/replay` | `ReplayBackend` — `getRound()`, `replay()`, `timeline()`, `diff()` |

---

## License

MIT. See [LICENSE](LICENSE).
