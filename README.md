# LoopForge

[中文文档](README.zh-CN.md)

**Cognitive Loop Governance Layer** for AI coding agents.

Most AI agent loops are either timer-based cron jobs (`/loop` — run the same
thing every N minutes) or single-turn reasoning patterns (CoT, ToT, ReAct —
think harder within one response). Neither is designed for the real problem:
**when a task is too complex to fully decompose upfront, and your understanding
of the task changes as you execute it.**

LoopForge governs the *gap between turns* — the space where an agent finishes
one round of work and needs to decide what to do next. It doesn't plan the
process (you can't, because you don't know what you'll discover). It plans
the **outcome and constraints**, then lets the agent discover the path one
step at a time. As the agent executes, LoopForge tracks real progress, detects
drift, merges discovered constraints, deepens the objective, and corrects
wrong assumptions — maintaining cognitive stability across long-horizon loops.

> **v1.15** — `npm install loopforge`. MCP server (8 tools) + Perception-Skill +
> library API + Verification Gate + Enforcement Gate + Thin Prompt + Fat File +
> Structured Evaluation + Memory System Integration (3-phase injection + writeback).
> **L2 Agent Technique Autonomy** — the Agent freely chooses reasoning strategies
> by reading the technique catalog; escalation (N failures → Tier 2) removed.
> Zero runtime dependencies. 277 tests. Node.js ≥18.

---

## The Philosophy

```
You start with a rough direction and a set of guardrails.
You take one step. You look at what you found.
What you found changes how you understand the task.
So the next step is different from what you would have planned.
This is not a bug — it's the defining feature of complex work.

LoopForge formalizes this loop:
  Execute → Self-Evaluate (with evidence) → Verify against lineage (v1.6) →
  Enforce round-boundary rules (v1.13) → Discover constraints →
  Deepen understanding → Correct mistakes → Write state file (v1.14) →
  Agent chooses technique (v1.15) → Compile next prompt → Execute again —
  until the outcome is achieved.
```

**This is not a timer loop.** A timer loop asks "has N minutes passed?"
A cognitive loop asks "what did I learn, and how does that change what I
should do next?"

---

## Quick Start

### MCP + Skill (recommended)

```bash
npm install -g loopforge
claude mcp add loopforge -- npx loopforge-mcp
# Install the Perception-Skill — teaches the agent how to run cognitive loops
mkdir -p ~/.claude/skills/perception
cp "$(npm root -g)/loopforge/skills/perception/SKILL.md" ~/.claude/skills/perception/
```

Then just describe your task naturally:
- `/perception "Audit ERC20 token for security issues"`
- "Keep going until every file passes review"
- "Take this step by step — I don't know the full scope yet"

The agent activates the Perception-Skill, calls `loopforge_start`, and the
cognitive loop begins. No timer, no fixed plan — just structured discovery.

### Library API

```typescript
import { createEngine } from "loopforge";

const engine = createEngine();
const result = engine.invokeLoopCompile({
  mode: "loop_compile",
  task: "Audit ERC20 token for security vulnerabilities",
  loop_id: "audit",
  round: 1,
  goal_id: "audit",
});
```

```typescript
// Autonomous loop — 2 required fields
import { run } from "loopforge";

const result = await run({
  task: "Audit ERC20 token for security vulnerabilities",
  execute: async (prompt) => await callAiApi(prompt),
});

console.log(`${result.roundsCompleted} rounds: ${result.stopReason}`);
```

---

## How It Works

### The Cognitive Loop

```
Round 1 (L2 — Restart):
  LoopForge compiles a strategy prompt with:
    - Technique Selection block — Agent reads the technique catalog
      (skills/prompt-techniques/SKILL.md) and freely chooses the best
      reasoning strategy for this task
    - The task + Loop Objective + constraints + cross-round summary
    - State file written to .loopforge/state/{loopId}-state.md
  → Agent reads catalog → chooses technique → reads reference → executes
  → LoopForge computes real progress, validates claims, merges discoveries

Round 2+ (L1 — Continue):
  LoopForge compiles a THIN prompt — state is in the state file:
    - Agent reads state file for constraints, progress, checkpoints
    - Technique keyword-routed from Tier 1 (4 techniques: zero-shot,
      few-shot, zero-shot-cot, few-shot-cot)
    - P0-P5 state evolution handled: constraints discovered, objective refined,
      subtasks emerged, wrong assumptions corrected
    - State file rewritten with updated state
  → Agent executes with fresh context each round
  → ... loop until all criteria met, circuit breaker trips, or task complete

Strategy Restart (L2 — triggered by checkpoint boundary or goal_id change):
  Agent declares a subtask boundary → LoopForge compiles a fresh L2 prompt
  → Agent re-reads the technique catalog and re-chooses strategy freely

Failure without new info (L0 — Retry):
  Agent failed honestly but discovered nothing new → same prompt retried
  → Enforcement gate catches fake successes and repeated violations (v1.13)
```

### Self-Evaluation (what the agent reports each round)

Since v1.7, the evaluation is passed as a **structured MCP tool parameter** —
validated by the MCP client before reaching the server. The `loopforge_next`
tool requires an `evaluation` object; the `output` text is optional.

```json
loopforge_next({
  sessionId: "abc-123",
  evaluation: {
    "success": true,
    "output_summary": "Fixed 3 reentrancy bugs. 24/24 tests pass.",
    "constraint_violations": [],
    "should_continue": true,

    "discovered_constraints": ["All external calls must use SafeERC20"],
    "objective_refinement": "Scope expanded: access control is part of a larger upgradeable proxy pattern",
    "emerged_subtasks": ["Audit upgrade proxy initialization", "Verify timelock parameters"],

    "execution_evidence": {
      "files_changed": ["contracts/Token.sol", "test/Token.test.ts"],
      "test_results": {"passed": 24, "failed": 0, "skipped": 0},
      "success_criteria_met": ["No reentrancy vectors remain"],
      "success_criteria_remaining": ["Access control verified", "Overflow checks complete"],
      "progress_estimate": 0.4
    },

    "retracted_constraints": [],
    "revised_success_criteria": [],
    "wrong_assumptions": []
  }
})
```

Every field is consumed by a specific downstream function — nothing decorative.
Legacy `---loopforge-eval` blocks in output text are still supported as fallback.

### What the compiler does with this evidence

| Capability | What happens |
|-----------|-------------|
| **P0 — Constraint Discovery** | `discovered_constraints` merged into active guardrails for future rounds |
| **P1 — Objective Refinement** | `objective_refinement` appended to Loop Objective; version history tracked |
| **P2 — Emergent Subtasks** | `emerged_subtasks` feed the next-round task suggestion |
| **P4 — Progress Tracking** | Objective progress (criteria met / total) vs subjective estimate; gradient alerts |
| **P4 — Consistency Validation** | Agent claims changes but `files_changed` empty → warning; claims success but tests failed → warning |
| **V1.6 — Verification Gate** | Cross-round consistency checks validate every SelfEvaluation against lineage before it enters the compiler. 6 automated checks (progress regression, empty-change detection, success/remains mismatch, duplicate constraint discovery, 3-round recurring violation, retract-fresh-constraint flip-flop). 3 verdict tiers: `trusted` → normal flow; `suspect` → warnings injected into next prompt for agent clarification; `contradicted` → quality score excluded from trend, 🚫 flags become hard constraints the agent must respond to. Quality scores are NEVER modified — only the trend write is skipped. |
| **P5 — Self-Correction** | `retracted_constraints` removed from active set; `revised_success_criteria` update the Loop Objective; `wrong_assumptions` recorded as key lessons |
| **V1.13 — Enforcement Gate** | 5 rules at round boundaries: REJECT invalid self-evaluations (agent must redo same round), TERMINATE unrecoverable loops. Runs before state changes so rejected rounds don't pollute the vault |
| **V1.14 — Thin Prompt + Fat File** | Accumulated state moved to `.loopforge/state/{loopId}-state.md` (rewritten each round). Prompt carries only task + delta. Technique reference lives in the state file |
| **V1.15 — Agent Technique Autonomy** | At L2 strategy restarts, the Agent reads the technique catalog (`skills/prompt-techniques/SKILL.md`) and freely chooses the best reasoning strategy. Technique skeletons are no longer embedded — the skill reference files are the Agent's working manual. Strategy collapse auto-trigger (3 failures → force Tier 2) removed. |
| **Progress Dashboard** | Injected into each round's prompt: files changed, test results, remaining criteria, trend arrow |

---

## MCP Tools (v1.7)

| Tool | Purpose |
|------|---------|
| `loopforge_start` | Start a loop — compiles Round 1 prompt from task + constraints |
| `loopforge_next` | Submit evaluation (+ optional output) → get next prompt (or `null` + stop reason). Evaluation is a required typed object — validated by MCP client before reaching server. |
| `loopforge_status` | Current round, success trajectory, technique in use |
| `loopforge_stop` | Manual stop with final trajectory preserved |
| `loopforge_list` | All active sessions (in-memory + vault-persisted) |
| `loopforge_replay` | Full timeline: rounds, techniques, success, decisions |
| `loopforge_resume` | Resume loop from vault after process restart |
| `loopforge_health` | Goal alignment, constraint integrity, drift, strategy stability |

Stop reasons: `task_complete` | `circuit_breaker` | `max_rounds` | `stalled` | `stopped`

---

## Recompile Levels

| Level | When | What |
|-------|------|------|
| **L0 Retry** | Honest failure with no new information (no P0-P5, no repair, no new constraints) | Reuse cached prompt — same round, same task |
| **L1 Continue** | Default path — all normal execution rounds | Tier 1 technique routing (4 techniques), P0-P5 state evolution, rendered state file, thin prompt |
| **L2 Restart** | Round 1, checkpoint boundary, or goal_id change | Agent reads technique catalog (SKILL.md), freely chooses strategy, rebuilds state file. (v1.15: strategy collapse auto-trigger and technique skeleton embedding removed.) |

---

## Key Features

### Cognitive Evolution (v1.5)
- **Constraint Discovery (P0)** — Agent discovers new guardrails during execution. Auto-merged into active constraints.
- **Objective Refinement (P1)** — Understanding deepens over rounds. Objective grows a version chain — appended, never replaced.
- **Emergent Subtasks (P2)** — Sub-problems surface organically. Feed the next-task suggestion without pre-planning.
- **Execution Evidence (P4)** — Structured reporting of files changed, test results, criteria met/remaining, progress estimate. Gives the compiler real visibility.
- **Progress Tracking (P4)** — Objective vs subjective progress with gradient detection. Early stall warning before the circuit breaker fires.
- **Self-Correction (P5)** — Retract wrong constraints, revise bad success criteria, flag incorrect assumptions. The loop can admit it was wrong.

### Verification Gate (v1.6)
- **Cross-Round Self-Eval Validation** — Every agent self-evaluation is verified against the loop's lineage before it enters the compiler.
- **6 Automated Checks** — Progress regression, empty-change detection, success-with-remaining-criteria mismatch, duplicate constraint discovery, 3-round recurring violation, retract-fresh-constraint flip-flop.
- **3 Verdict Tiers** — `trusted` → normal flow. `suspect` → warnings injected into next prompt for agent clarification. `contradicted` → success flag excluded from success trend; 🚫 flags become hard constraints the agent must address explicitly.
- **Success Flag Preservation** — Success flags are NEVER modified by the gate. Only trend writes are skipped for contradicted rounds — raw flags remain in the vault for audit.

### Structured Evaluation (v1.7)
- **Evaluation Parameter** — `loopforge_next` accepts a typed `evaluation` object validated by MCP client schema enforcement. No more regex extraction of embedded eval blocks. `output` text is optional (kept for audit trail). Legacy `---loopforge-eval` blocks still supported.

### Memory System Integration (v1.7)

**LoopForge is not a memory system — it's a prompt compiler.** Understanding this distinction
is the key to understanding how they complement each other.

| | Agent Memory (claude-mem, Mem0, etc.) | LoopForge |
|---|---|---|
| **Answers** | "What did you do before?" | "What should you do next, and how should you think about it?" |
| **Scope** | Cross-task, cross-session (long-term) | Single-task, cross-round (working memory) |
| **Operation** | Observe → extract → store → retrieve | Compile L0/L1/L2 → inject constraints → verify → generate |
| **Decision** | None — raw context injection | Full — technique routing, strategy rotation, constraint lifecycle |
| **Verification** | Trusts agent's self-report | 6 adversarial cross-round consistency checks |
| **Active** | Passive librarian — fetches relevant files | Active editor — writes the next chapter |

**They are not competitors. They are different layers of the same stack.**

Agent memory manages *what you know across sessions* — codebase patterns, user preferences,
past decisions. LoopForge manages *what you do within a task* — which constraint is active,
what strategy to use, whether progress is real.

#### The Integration: 3-Phase Injection + Writeback

LoopForge v1.7 automatically bridges the two layers:

```
┌─────────────────────────────────────┐
│       Agent Memory (Long-Term)      │  ← cross-session knowledge
│  "You prefer terse responses"       │
│  "The auth module uses JWT"         │
└──────────────┬──────────────────────┘
               │ injected at 3 strategic points
               ▼
┌─────────────────────────────────────┐
│       LoopForge (Working Memory)    │  ← within-task execution control
│  "Round 3: active constraints are…" │
│  "Technique escalated: Tier 2 after 3"│
│  "Progress: 2/5 criteria met"       │
└──────────────┬──────────────────────┘
               │ loop ends → distilled knowledge written back
               ▼
┌─────────────────────────────────────┐
│       Agent Memory (updated)        │
│  "ERC20 audits: escalate to Tier 2   │
│   after 3 consecutive failures"      │
│  "Key discovery: reentrancy in …"   │
└─────────────────────────────────────┘
```

**3-Phase Injection** (read from memory, only during L2 full recompiles).
Injection frequency scales with loop length via a tiered strategy:

| maxRounds | Injections | Phases | Rationale |
|-----------|-----------|--------|-----------|
| ≤10 | 1 | Phase 1 (Round 1) | Short loops — working memory stays fresh, one anchor is enough |
| 11–20 | 2 | Phase 1 + Phase 3 (70% progress) | Medium loops — initial context + late-stage verification |
| 21+ | 3 | Phase 1 + Phase 2 (40% progress) + Phase 3 (70% progress) | Long loops — full cognitive support at all strategic points |

L0 and L1 rounds NEVER inject memory — the compiler's incremental path is deterministic
and injecting external context would create unpredictable signal interference.

**Writeback** (write to memory, once per loop):
- **1 project entry** — task outcome + key discoveries (absolute dates)
- **≤5 feedback entries** — tactical lessons (rule + Why + How to apply, matching claude-mem's format)
- **1 reference entry** — pointer to the LoopForge vault for deep dives

Writeback follows claude-mem's core principle: **only store what cannot be derived from current state.**
Code patterns stay in code. Decisions, discoveries, and tactical lessons go to memory.

**Auto-detection**: No configuration required. LoopForge detects claude-mem automatically
(via the local filesystem). Users can override with explicit `memoryProvider`
/ `memoryWriter` callbacks. If claude-mem is unavailable, memory integration degrades
silently — the loop continues normally.

#### How to install claude-mem

claude-mem is a third-party Claude Code plugin ([github.com/thedotmack/claude-mem](https://github.com/thedotmack/claude-mem))
that provides persistent cross-session memory. LoopForge auto-detects it — no additional
wiring needed once installed.

| Platform | Install command | Notes |
|----------|----------------|-------|
| **Claude Code** | `claude plugin install claude-mem@thedotmack` | One-click via plugin marketplace. Auto-starts on session open. |
| **Codex (OpenAI)** | `npx codex-mem-cli@latest codex setup` | Dedicated Codex port ([npm](https://www.npmjs.com/package/@iflow-mcp/keystonescience-codex-mem)). |
| **Cursor / MCP** | Manual — add to MCP config: | Point to `mcp-server.cjs` from the installed plugin or a source build. See [claude-mem docs](https://docs.claude-mem.ai/development) for the MCP server path. |

LoopForge will detect it on next startup. No config changes needed.

### Observability (v1.7)
- **Engine Metrics** — `getMetrics()` public getter exposes 8 health counters: vault write errors/bytes, feedback buffer stats, cache misses, analysis errors. Included in `loopforge_status` MCP tool output.
- **Structured Event Logging** — JSON-line events to stderr when `LOOPFORGE_LOG=1` is set. 6 event types: `round_complete`, `circuit_breaker`, `gate_contradicted`, `vault_write_error`, `session_start` / `session_end`. Silent by default — zero overhead when not enabled.

### Agent Technique Autonomy (v1.15)
- **L2 Agent-Driven Technique Selection** — At strategy restart points (Round 1, checkpoint boundaries, goal_id changes), LoopForge no longer auto-selects a technique via keyword routing. Instead, the Agent reads the technique catalog (`skills/prompt-techniques/SKILL.md`), freely chooses the best reasoning strategy based on loop state, reads the corresponding reference file, and applies the technique directly.
- **Technique Skeleton Removal** — L2 prompts no longer embed 8-section technique skeletons. The skill reference files are the Agent's working manual, not dictated templates.
- **Strategy Collapse Removal** — The "3 consecutive failures → force Tier 2 techniques" mechanism is removed. The Agent decides when to change approach; LoopForge enforces honesty (verification gate) and progress (enforcement gate) without micromanaging reasoning strategy.
- **Simplified Technique Router** — `routeTechniqueAdaptive()` no longer counts consecutive failures or escalates tiers. It provides Tier 1 routing for L1 and full access at checkpoint boundaries.

### Foundation (v1.0–v1.3)
- **MCP Server** — 8 tools over JSON-RPC stdio. Zero-config with Claude Code and Codex.
- **Session Recovery** — Vault-persisted sessions. `loopforge_resume` after restart.
- **L0/L1/L2 Incremental Recompilation** — 4-gate router: force_level → first-call → goal_id stability → failure signals.
- **Loop Objective Anchoring** — Stable outcome reference created at Round 1, refined over time.
- **Constraint Retirement** — Stale constraints silent for 3+ rounds auto-retire.
- **Failure Lineage Weighting** — Repeated failure patterns with same technique + similar task are detected and demoted in summaries. Failed-path lessons pushed down, marked `[Consider alternatives]`. Dead-end violations flagged `[Possible dead end]`. Explicit `### ⚠️ Failure Patterns` section in compiled prompts.
- **Rolling Summary** — Cross-round knowledge distillation from last 5 rounds.
- **Tier-Gated Technique Routing** — Tier 1 (zero-shot/few-shot/CoT) always available at L1 via keyword heuristic. L2 lets the Agent freely choose from all 7 techniques by reading the technique catalog. (v1.15: tier escalation after consecutive failures removed — the Agent owns technique decisions.)
- **Circuit Breaker** — 3 consecutive failed rounds → stop. Separate executor-failure breaker.
- **Replay Engine** — Time-travel queries: `replay()`, `diff()`, `timeline()`.
- **Policy Externalization** — All tunables in `loop_policy.json`.
- **Vault File Lock** — mkdir-based mutex guards all JSON vault writes. Re-entrant for same-process nesting. Concurrent-process safe — prevents lost updates from parallel sessions.
- **Zero Dependencies** — Node.js stdlib only. TypeScript strict mode.

---

## Project Structure

```
LoopForge/
├── loopforge/              # TypeScript package
│   ├── src/                     # builder, engine, loop-compiler, memory-bridge, observability,
│   │                            #   policy, protocol, replay, runtime, verification-gate, backends, mcp
│   ├── dist/                    # Compiled JS + type declarations
│   ├── skills/
│   │   └── perception/          # Perception-Skill: agent instructions for cognitive loops
│   │       └── SKILL.md
│   └── tests/                   # 277 tests (Node.js built-in runner)
├── skills/
│   └── prompt-techniques/       # Technique reference files (read at runtime)
│       └── references/          # zero-shot, few-shot, cot, step-back, least-to-most, tot
├── docs/
│   └── loopforge-spec.md       # Semantic spec
├── loopforge-protocol.json     # JSON Schema (draft 2020-12)
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
