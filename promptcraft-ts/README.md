# PromptCraft — TypeScript Reference Implementation

**Loop-Time Intelligence Layer** for AI coding agents. Per-iteration prompt compiler
with structured memory, constraint inheritance, and drift correction — maintains
cognitive stability across long-horizon agent loops.

Python reference: [`loop-compiler/`](../loop-compiler/) | Spec: [`docs/promptcraft-spec.md`](../docs/promptcraft-spec.md)

## Quick Start

```bash
npm install promptcraft

# CLI
npx promptcraft init
npx promptcraft compile '{"task":"Audit ERC20","loop_id":"audit","round":1,"goal_id":"audit"}'
npx promptcraft status
```

```typescript
// Library API
import { createEngine, compileLoop, ReplayBackend, FSBackend } from "promptcraft";

const engine = createEngine();
const result = engine.invokeLoopCompile({
  task: "Audit ERC20 token",
  mode: "loop_compile",
  loop_id: "audit",
  round: 1,
  goal_id: "audit",
  // ...
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
promptcraft init                     # Init vault
promptcraft compile '<json>'         # Compile prompt (or pipe via stdin)
promptcraft feedback '<json>'        # Record feedback
promptcraft replay <loop-id>         # Loop timeline
promptcraft diff <loop-id> <a> <b>   # Diff two rounds
promptcraft review <loop-id> <rN>    # Audit stored prompt
promptcraft status                   # Vault health
```

## API Modules

| Module | Import | Purpose |
|--------|--------|---------|
| `promptcraft` | Main entry | `handle`, `createEngine`, types |
| `promptcraft/compiler` | `compileLoop`, `decideLevel` | Pure-function compiler |
| `promptcraft/replay` | `ReplayBackend` | Time-travel audit queries |

## Zero Dependencies

No runtime dependencies — Node.js stdlib only. TypeScript strict mode.
Tests use Node.js built-in test runner (`node:test`).

## License

MIT
