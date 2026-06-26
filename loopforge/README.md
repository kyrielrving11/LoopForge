# LoopForge

**Loop-Time Intelligence Layer** for AI coding agents. Per-iteration prompt compiler
with structured memory, constraint inheritance, and drift correction — maintains
cognitive stability across long-horizon agent loops.

Spec: [`../docs/loopforge-spec.md`](../docs/loopforge-spec.md)

## Quick Start

```bash
npm install loopforge

# CLI
npx loopforge init
npx loopforge compile '{"task":"Audit ERC20","loop_id":"audit","round":1,"goal_id":"audit"}'
npx loopforge status
```

```typescript
// Library API
import { createEngine, ReplayBackend, FSBackend } from "loopforge";

const engine = createEngine();
const result = engine.invokeLoopCompile({
  task: "Audit ERC20 token",
  mode: "loop_compile",
  loop_id: "audit",
  round: 1,
  goal_id: "audit",
});
```

## 3 Modes

| Mode | When | Returns |
|------|------|---------|
| `loop_compile` | Every agent loop iteration | Compiled prompt + recompile level + health + advisories |
| `feedback` | After execution | Quality score → vault persistence |
| `review` | Audit prompt quality | Structural checks + constraint compliance |

## Recompile Levels

- **L0 Fast Path** — goal unchanged, no new failures → reuse cached prompt
- **L1 Patch** — new constraints or repair signals → patch previous prompt
- **L2 Full Recompile** — round 1, goal changed, plan_source, strategy collapse → full build

## CLI Commands

```bash
loopforge init                     # Init vault
loopforge compile '<json>'         # Compile prompt (or pipe via stdin)
loopforge feedback '<json>'        # Record feedback
loopforge run '<json>'              # Autonomous loop (v1.2)
loopforge replay <loop-id>         # Loop timeline
loopforge diff <loop-id> <a> <b>   # Diff two rounds
loopforge review <loop-id> <rN>    # Audit stored prompt
loopforge resume <loop-id>          # Resume loop from vault (v1.3.1)
loopforge status                   # Vault health
```

## API Modules

| Module | Import | Purpose |
|--------|--------|---------|
| `loopforge` | Main entry | `handle`, `createEngine`, types |
| `loopforge/compiler` | `compileLoop`, `decideLevel` | Pure-function compiler |
| `loopforge/replay` | `ReplayBackend` | Time-travel audit queries |

## Zero Dependencies

No runtime dependencies — Node.js stdlib only. TypeScript strict mode.
Tests use Node.js built-in test runner (`node:test`).

## License

MIT
