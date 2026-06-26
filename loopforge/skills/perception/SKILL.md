---
name: perception
description: Multi-round autonomous loop driver powered by LoopForge MCP. Compiles context-aware prompts per iteration, tracks quality, inherits constraints, and stops when work is done — not when rounds run out.
---

# Perception — Loop-Time Intelligence Skill

**Perception** turns any AI agent into a self-aware multi-round executor. It
drives the LoopForge MCP server (`loopforge-mcp`) to compile per-iteration
prompts from running quality trajectory, constraint inheritance, and drift
detection — maintaining cognitive stability across long-horizon loops.

Works with Claude Code, Codex, and any MCP-capable host. Zero configuration
beyond having `loopforge-mcp` registered as an MCP server.

## When to Activate

Activate when the user says any of:
- `/loop <task>` — start an autonomous multi-round loop
- "do this in a loop", "keep going until done", "iterate on this"
- Any task that clearly needs 3+ rounds (audit, refactor, migrate, review-and-fix cycles)

Also activate implicitly when the user's request is too large for a single
round (e.g. "audit the entire codebase and fix every issue").

## Core Workflow

```
┌─────────────────────────────────────────────────────┐
│  1. loopforge_start(task, constraints, maxRounds)    │
│     → sessionId + Round 1 prompt                     │
│                                                      │
│  2. Execute the prompt (read, write, test, fix)      │
│     MUST include ---loopforge-eval block in output   │
│                                                      │
│  3. loopforge_next(sessionId, output)                │
│     → if prompt: go to step 2                        │
│     → if prompt=null: loop ended, read stopReason    │
└─────────────────────────────────────────────────────┘
```

### Step-by-step

**Step 1 — Start the loop:**
```
Call loopforge_start with:
  task:        required — the full task description
  maxRounds:   optional — default 20 from policy
  constraints: optional — hard constraints as string[]
  domain:      optional — domain hint (solidity, react, rust…)

Keep the returned sessionId — you will need it for every subsequent call.
```

**Step 2 — Execute the round:**
Execute the compiled prompt exactly as you would any user task. Read files,
write code, run tests, fix bugs. The prompt already contains the task scope,
constraints, and quality expectations for this specific round.

**CRITICAL: Every round's output MUST end with a self-evaluation block:**
```
---loopforge-eval
{
  "success": true,
  "output_summary": "Fixed 3 reentrancy bugs in withdraw() and deposit(). All 12 tests pass.",
  "constraint_violations": [],
  "should_continue": true
}
---end-loopforge-eval
```

**Field rules:**

| Field | Type | Rule |
|-------|------|------|
| `success` | boolean | `true` ONLY if all hard constraints met AND the task goal achieved |
| `output_summary` | string | Specific, actionable. What was DONE this round — not what was attempted |
| `constraint_violations` | string[] | Constraints the agent actually violated this round. Be honest — hiding violations corrupts the quality signal and defeats the circuit breaker |
| `should_continue` | boolean | `false` ONLY when the ENTIRE task is complete. Partial progress = `true` |

**Why this matters:** Without a valid `---loopforge-eval` block, extraction
fails and the loop stops with `stopReason: stalled`. The circuit breaker
uses `success` + `violations` to compute quality scores — lying here defeats
the only mechanism that prevents infinite loops.

**Step 3 — Advance to next round:**
```
Call loopforge_next with:
  sessionId: from loopforge_start
  output:    your FULL output from this round (including the eval block)
```

If the result has `prompt: null`, the loop has ended. Read `stopReason`:
- `task_complete` — you reported should_continue=false. Work is done.
- `circuit_breaker` — quality flat or declining for 3+ rounds. Review your approach.
- `max_rounds` — hit the round limit. Decide whether to extend or accept.
- `stalled` — no valid self-eval block found. Check your output format.

If the result has a non-null `prompt`, execute it and repeat from Step 2.

## Tool Reference

| Tool | When to call | Key input | Key output |
|------|-------------|-----------|------------|
| `loopforge_start` | Beginning of every loop | `task`, `maxRounds?`, `constraints?` | `sessionId`, round 1 `prompt` |
| `loopforge_next` | After executing every round | `sessionId`, `output` (with eval block) | next `prompt` or `null` + `stopReason` |
| `loopforge_status` | Mid-loop checkpoint, user asks "how's it going" | `sessionId` | `round`, `qualityTrajectory`, `status` |
| `loopforge_stop` | User wants to abort, fatal error | `sessionId` | `roundsCompleted`, final trajectory |
| `loopforge_list` | User asks "what loops are running" | — | `sessions[]` |
| `loopforge_replay` | After loop ends, user asks "show me what happened" | `sessionId` | `timeline[]` with all rounds |

## Quality Signals (Read the Room)

The prompt changes between rounds based on your trajectory. Pay attention to:

- **Compile level** — `l0` (cached, fast path), `l1` (patched, mild drift),
  `l2` (full recompile, significant change). L2 means the compiler detected a
  major shift — read the prompt carefully.
- **Warnings** — constraint violations accumulating, task drift, quality
  decline. These are the compiler begging you to course-correct.
- **Technique rotation** — the compiler may switch from `zero-shot-cot` to
  `tree-of-thought` if quality drops. Follow the new technique.

## Stop Condition Matrix

| Condition | stopReason | What to do |
|-----------|-----------|------------|
| You set `should_continue: false` | `task_complete` | Report final results to user |
| 3+ rounds of flat/declining quality | `circuit_breaker` | Tell user the approach is stuck, suggest a different strategy |
| Round count reached `maxRounds` | `max_rounds` | Summarize progress, ask user whether to extend |
| No `---loopforge-eval` block found | `stalled` | Fix your output format and restart |
| User interrupts or fatal error | (call `loopforge_stop`) | Clean stop with trajectory preserved |

## Rules

1. **Never skip the eval block.** No exceptions. If you forget, the loop stalls.
2. **Be honest in self-evaluation.** Lying about success or hiding violations
   produces a false quality signal. The circuit breaker exists to stop bad
   loops — if you fake quality=5 every round, it fires anyway.
3. **One loop per task.** Don't reuse a sessionId across different tasks.
4. **Execute the prompt you're given.** The compiler may change technique or
   narrow scope between rounds. Trust it — it sees the trajectory.
5. **Call loopforge_next within the same turn.** Don't leave a round hanging
   across conversation turns. The MCP server is in-memory.

## Example

```
User: /loop "Audit the ERC20 token in contracts/Token.sol for security issues"

Agent:
  → loopforge_start({ task: "Audit ERC20 token in contracts/Token.sol for security issues",
                       domain: "solidity",
                       constraints: ["must not break existing tests", "follow check-effects-interactions"] })
  ← { sessionId: "abc-123", round: 1, prompt: "## LoopForge Loop Compile — Round 1\n...", level: "l2" }

  [Executes prompt: reads Token.sol, identifies 4 issues, writes audit notes]

  Output ends with:
  ---loopforge-eval
  {"success":false,"output_summary":"Found 4 potential issues: 2 reentrancy, 1 overflow, 1 access control. Not yet fixed.","constraint_violations":[],"should_continue":true}
  ---end-loopforge-eval

  → loopforge_next({ sessionId: "abc-123", output: <full output> })
  ← { sessionId: "abc-123", round: 2, prompt: "## LoopForge Loop Compile — Round 2\n...", level: "l1" }

  [Executes prompt: fixes 3 issues, 1 needs more investigation]

  ---loopforge-eval
  {"success":false,"output_summary":"Fixed reentrancy in withdraw() and overflow in calcReward(). Access control issue in setOwner() needs design discussion.","constraint_violations":[],"should_continue":true}
  ---end-loopforge-eval

  → loopforge_next({ sessionId: "abc-123", output: <full output> })
  ← { sessionId: "abc-123", round: 3, prompt: "## LoopForge Loop Compile — Round 3\n...", level: "l0" }

  [Executes prompt: documents access control issue for user decision, all fixes pass tests]

  ---loopforge-eval
  {"success":true,"output_summary":"All fixable issues resolved. 1 access control design question flagged for user. 24/24 tests pass.","constraint_violations":[],"should_continue":false}
  ---end-loopforge-eval

  → loopforge_next({ sessionId: "abc-123", output: <full output> })
  ← { sessionId: "abc-123", round: 3, prompt: null, stopReason: "task_complete", quality: 5 }

  Reports to user: "Audit complete in 3 rounds. 3 issues fixed, 1 design question flagged."
```
