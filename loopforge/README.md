# LoopForge

**Loop-Time Intelligence Layer** for AI coding agents. Per-iteration prompt compiler
with structured memory, constraint inheritance, and drift correction — maintains
cognitive stability across long-horizon agent loops. Supports single-agent and
multi-agent (AgentTool / Coordinator) scenarios.

Spec: [`../docs/loopforge-spec.md`](../docs/loopforge-spec.md)

## Quick Start

```bash
npm install loopforge

# MCP server (recommended)
claude mcp add loopforge -- npx loopforge-mcp

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

## Multi-Agent Support (v1.9)

LoopForge treats all agents the same — whether a single agent, an agent spawning
sub-agents via AgentTool, or a Coordinator orchestrating Workers. The core loop
(compile → execute → self-eval → compile) is identical.

### Delegation Helpers (AgentTool Mode)

When the main agent spawns sub-agents, three optional helpers improve delegation quality:

```typescript
import {
  filterConstraintsForSubTask,  // filter relevant constraints for a sub-task
  formatDelegationPrompt,       // format a self-contained sub-agent prompt
  recordDelegation,             // write delegation journal to vault
  buildDelegationSummary,       // build delegation history table for prompts
} from "loopforge";
```

- **`filterConstraintsForSubTask(allConstraints, subTask, threshold?)`** — Jaccard-based constraint filter. Returns only constraints relevant to the sub-task (default threshold 0.15).
- **`formatDelegationPrompt(subTask, subAgentType, constraints, options?)`** — Produces self-contained prompts for Explore / General-purpose / Plan sub-agents. No "based on above" references — sub-agents can't see the parent conversation.
- **`recordDelegation(loopId, round, entries)`** — Engine method. Writes delegation journal to vault.
- **`buildDelegationSummary(vaultContext)`** — Reads delegation history from vault and formats a summary table for injection into the next round's prompt.

### Worker Results (Coordinator / Multi-Agent)

The main agent reports sub-agent results via `worker_results` in its self-evaluation:

```json
{
  "success": true,
  "output_summary": "Spawned 2 Workers. Worker A found 3 reentrancy bugs. Worker B fixed auth.",
  "constraint_violations": [],
  "should_continue": true,
  "worker_results": [
    {
      "agentId": "abc123",
      "subAgentType": "explore",
      "subTask": "Search for security vulnerabilities",
      "resultSummary": "Found 3 reentrancy bugs in withdraw(), deposit(), transfer()",
      "success": true,
      "discoveredConstraints": ["All external calls must use nonReentrant modifier"]
    }
  ]
}
```

The engine auto-detects `worker_results` → writes to delegation journal → injects delegation
history into the next round's compiled prompt. Constraints discovered by Workers flow into
the active constraint set and appear in future prompts automatically.

### Design Principle

LoopForge does not distinguish between "single-agent mode" and "coordinator mode."
The main agent — whatever its role — receives compiled prompts, executes, and reports
results. LoopForge records, compresses, and injects. The agent decides.

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
| `loopforge` | Main entry | `createEngine`, `compileLoop`, types |
| `loopforge/compiler` | `compileLoop`, `decideLevel`, `buildDelegationSummary` | Pure-function compiler + delegation helpers |
| `loopforge/replay` | `ReplayBackend` | Time-travel audit queries |

## Zero Dependencies

No runtime dependencies — Node.js stdlib only. TypeScript strict mode.
Tests use Node.js built-in test runner (`node:test`).

## License

MIT
