# LoopForge

[中文文档](README.zh-CN.md)

**Loop-Time Intelligence Layer** for AI coding agents. Per-iteration prompt compiler
with structured memory, constraint inheritance, and drift correction — maintains
cognitive stability across long-horizon agent loops.

> **v1.3.1** — `npm install loopforge`. MCP server (8 tools) + Perception-Skill + CLI + library API.
> Zero runtime dependencies. 92 tests. Node.js ≥18.

---

## Quick Start

### MCP + Skill (recommended)

```bash
npm install -g loopforge
claude mcp add loopforge -- npx loopforge-mcp
# Copy the Perception-Skill for multi-round loop instructions
mkdir -p ~/.claude/skills/perception
cp "$(npm root -g)/loopforge/skills/perception/SKILL.md" ~/.claude/skills/perception/
```

Then in Claude Code / Codex: `/loop "Audit ERC20 token"` — the Perception-Skill
handles the full loop lifecycle via MCP tools.

### CLI

```bash
npm install loopforge

# Init vault
npx loopforge init

# Compile a prompt (loop_compile mode)
npx loopforge compile '{"task":"Audit ERC20 token","loop_id":"audit","round":1,"goal_id":"audit"}'

# v1.2: Autonomous loop — interactive mode (paste agent output each round)
npx loopforge run '{"task":"Audit ERC20 token","loop_id":"audit-erc20"}'

# Record feedback (manual mode)
npx loopforge feedback '{"loop_id":"audit","round":1,"success":true,"score":4}'

# Replay timeline
npx loopforge replay audit

# Diff two rounds
npx loopforge diff audit 1 3

# Resume a loop from vault after restart (v1.3.1)
npx loopforge resume audit

# Vault health
npx loopforge status
```

### Library API

```typescript
import { createEngine, ReplayBackend, FSBackend } from "loopforge";

const engine = createEngine();
const result = engine.invokeLoopCompile({
  mode: "loop_compile",
  task: "Audit ERC20 token for security vulnerabilities",
  loop_id: "audit",
  round: 1,
  goal_id: "audit",
});

console.log(result.response?.prompt);
console.log(result.status); // "ok" | "error" | "stalled"
```

```typescript
// v1.2: Autonomous loop — 2 required fields, everything else automatic
import { run } from "loopforge";

const result = await run({
  task: "Audit ERC20 token for security vulnerabilities",
  execute: async (prompt) => {
    // Your AI executor — Claude API, CLI agent, etc.
    return await callAiApi(prompt);
  },
});

console.log(`Completed ${result.roundsCompleted} rounds: ${result.stopReason}`);
console.log(`Quality trajectory: ${result.qualityTrajectory}`);
```

```typescript
// v1.3: MCP server — embed in any MCP-capable host
import { McpServer, SessionManager } from "loopforge";

const server = new McpServer();
server.start(); // JSON-RPC over stdio
```

---

## How It Works

LoopForge closes the agent feedback loop. The agent self-evaluates:

```
LoopForge compiles prompt (with self-eval instructions)
  → Agent executes + outputs structured self-evaluation
    → LoopForge auto-extracts feedback → vault
      → LoopForge compiles next prompt (L0/L1/L2 auto-decided)
        → ... loop until task complete or circuit breaker
```

**MCP integration (v1.3):**

```
AI Host (Claude Code / Codex)
  → Perception-Skill activates on /loop
  → loopforge_start → compiled Round 1 prompt
  → [Agent executes + self-eval]
  → loopforge_next → compiled Round 2 prompt
  → ... loop until prompt=null (task_complete / circuit_breaker / max_rounds / stalled)
  → Process restart: loopforge_resume → pick up from last saved round (v1.3.1)
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

## MCP Tools (v1.3)

| Tool | Input | Output |
|------|-------|--------|
| `loopforge_start` | `task`, `maxRounds?`, `constraints?`, `domain?` | `sessionId`, round 1 `prompt` |
| `loopforge_next` | `sessionId`, `output` (with eval block) | next `prompt` or `null` + `stopReason` |
| `loopforge_status` | `sessionId` | `round`, `qualityTrajectory`, `status`, `technique` |
| `loopforge_stop` | `sessionId` | `roundsCompleted`, final trajectory |
| `loopforge_list` | — | `sessions[]` (in-memory + vault-persisted) |
| `loopforge_replay` | `sessionId` | `timeline[]` |
| `loopforge_resume` | `loopId` | next `prompt` or `null` + `stopReason` (v1.3.1) |
| `loopforge_health` | `loopId` | goal alignment, constraint integrity, drift, strategy stability (v1.3.1) |

Stop reasons: `task_complete` | `circuit_breaker` | `max_rounds` | `stalled` | `stopped`

---

## Perception-Skill

A platform-agnostic agent skill (`skills/perception/SKILL.md`) that teaches
any AI agent how to use LoopForge MCP tools for autonomous multi-round loops.
Copy it to your agent's skill directory — works with Claude Code, Codex, and
any MCP-capable host.

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
loopforge run '<json>'             # v1.2: Autonomous loop with heartbeat/timeout/stall detection
loopforge replay <loop-id>         # Loop timeline — rounds, quality, technique per round
loopforge diff <loop-id> <a> <b>   # Field-level diff between two rounds
loopforge review <loop-id> <rN>    # Structural prompt audit
loopforge resume <loop-id>          # v1.3.1: Resume loop from vault state
loopforge status                   # Vault health summary
```

---

## Key Features

- **MCP Server (v1.3)** — 8 tools over JSON-RPC stdio: `start`, `next`, `status`, `stop`, `list`, `replay`, `resume`, `health`. Zero-config integration with Claude Code and Codex.
- **Session Recovery (v1.3.1)** — Sessions auto-saved to vault. `loopforge_resume` restores loop state after process restart — no more starting from round 1.
- **Success Criteria Enforcement (v1.3.1)** — `loop_objective.success_criteria` merged into active constraints — tracked, retired, and violation-checked like hard constraints.
- **Perception-Skill (v1.3)** — Platform-agnostic agent skill. Copy-and-paste into any MCP-capable host to enable autonomous `/loop` workflows.
- **Loop Runtime (v1.2)** — Event-driven autonomous loop with heartbeat monitoring, round timeout, stall detection, and graceful shutdown. Single `run({ task, execute })` function — 2 required fields.
- **Heartbeat & Timeout** — Per-round heartbeat (configurable interval) with timeout + stall detection. Interactive mode for human-in-the-loop scenarios.
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
- **Circuit Breaker** — 3 consecutive no-improvement rounds → STALLED. Separate executor-failure breaker.
- **Zero Dependencies** — Node.js stdlib only. TypeScript strict mode.

---

## Project Structure

```
LoopForge/
├── loopforge/              # TypeScript package
│   ├── src/                     # adapter, builder, cli, engine, loop-compiler, policy, protocol, replay, runtime, backends, mcp
│   ├── dist/                    # Compiled JS + type declarations
│   ├── skills/
│   │   └── perception/          # Perception-Skill: agent instructions for /loop workflows
│   │       └── SKILL.md
│   └── tests/                   # 92 tests (Node.js built-in runner)
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
| `loopforge` | `run()`, `handle()`, `createEngine()`, `LoopRuntime`, `McpServer`, `SessionManager`, all types |
| `loopforge/compiler` | `compileLoop()`, `decideLevel()`, `compileL2()`, `buildSelfEvalBlock()` |
| `loopforge/replay` | `ReplayBackend` — `getRound()`, `replay()`, `timeline()`, `diff()` |
| `loopforge/mcp` | `McpServer`, `SessionManager` — JSON-RPC transport + session lifecycle |

---

## License

MIT. See [LICENSE](LICENSE).
