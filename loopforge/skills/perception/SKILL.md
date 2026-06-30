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
- `/perception <task>` — start an autonomous multi-round loop
- "do this in a loop", "keep going until done", "iterate on this"
- Any task that clearly needs 3+ rounds (audit, refactor, migrate, review-and-fix cycles)

Also activate implicitly when the user's request is too large for a single
round (e.g. "audit the entire codebase and fix every issue").

## Core Workflow

```
┌──────────────────────────────────────────────────────────┐
│  1. loopforge_start(task, constraints, maxRounds)         │
│     → sessionId + Round 1 prompt                          │
│                                                           │
│  2. Execute the prompt (read, write, test, fix)           │
│     Prepare a structured self-evaluation                  │
│                                                           │
│  3. loopforge_next(sessionId, evaluation, output?)        │
│     → if prompt: go to step 2                             │
│     → if prompt=null: loop ended, read stopReason         │
│                                                           │
│  After restart: loopforge_resume(loopId)                  │
│     → picks up from last saved round                      │
└──────────────────────────────────────────────────────────┘
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

After executing, prepare a structured self-evaluation. Pass it as the
`evaluation` parameter to `loopforge_next` — do NOT embed it as a text block
in the output. The `evaluation` parameter is a typed object with the fields
described below.

**New (v1.7+): Pass evaluation as a structured tool parameter.**
```json
{
  "success": true,
  "output_summary": "Fixed 3 reentrancy bugs in withdraw() and deposit(). All 12 tests pass.",
  "constraint_violations": [],
  "should_continue": true,
  "discovered_constraints": [],
  "objective_refinement": "",
  "emerged_subtasks": [],
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
```

**Legacy (still supported):** Embed a `---loopforge-eval` block in output text
when the agent cannot pass structured tool parameters. The new parameter form
is preferred — it's validated by the MCP client before reaching the server.

**Field rules:**

| Field | Type | Rule |
|-------|------|------|
| `success` | boolean | `true` ONLY if all hard constraints met AND the task goal achieved |
| `output_summary` | string | Specific, actionable. What was DONE this round — not what was attempted |
| `constraint_violations` | string[] | Constraints the agent actually violated this round. Be honest — hiding violations corrupts the quality signal and defeats the circuit breaker |
| `should_continue` | boolean | `false` ONLY when the ENTIRE task is complete. Partial progress = `true` |
| `discovered_constraints` | string[] | **P0 (optional)** — New constraints discovered this round. They become active guardrails for future rounds. Example: `["All external calls must use SafeERC20"]`. Empty `[]` if none. |
| `objective_refinement` | string | **P1 (optional)** — If this round deepened your understanding of what the task is really about, describe the refinement. APPENDED to (never replaces) the original objective. Empty `""` if unchanged. |
| `emerged_subtasks` | string[] | **P2 (optional)** — Sub-problems that surfaced during execution and need separate attention. Feed into next-round task suggestions. Example: `["Audit upgrade proxy", "Verify timelock"]`. Empty `[]` if none. |
| `execution_evidence` | object | **P4 (recommended)** — Structured record of what actually happened. `files_changed` (string[]), `test_results` ({passed, failed, skipped} | null), `success_criteria_met` (string[]), `success_criteria_remaining` (string[]), `progress_estimate` (0.0–1.0). Use this to give LoopForge real visibility into your progress. |
| `retracted_constraints` | string[] | **P5 (optional)** — Constraints you now believe are wrong. Removed from active guardrails. Only retract with evidence. Empty `[]` if none. |
| `revised_success_criteria` | object[] | **P5 (optional)** — Success criteria that need reformulation. Array of `{old: string, new: string}`. Applied to Loop Objective. Empty `[]` if none. |
| `wrong_assumptions` | string[] | **P5 (optional)** — Assumptions from earlier rounds that turned out to be incorrect. Recorded as key lessons. Empty `[]` if none. |

**Why this matters:** The evaluation is validated by the MCP client before
reaching the server — a missing or malformed evaluation causes an immediate
error, not a silent stall. The circuit breaker uses `success` + `violations`
to compute quality scores — lying here defeats the only mechanism that
prevents infinite loops. The optional fields (P0–P5) enable cognitive
evolution: discovering constraints, deepening understanding, surfacing
sub-problems, tracking real progress, and correcting wrong assumptions as
the loop executes.

**Step 3 — Advance to next round:**
```
Call loopforge_next with:
  sessionId:  from loopforge_start
  evaluation: REQUIRED — structured self-evaluation object (see field table below)
  output:     OPTIONAL — raw output text for audit trail (can be omitted)
```

If the result has `prompt: null`, the loop has ended. Read `stopReason`:
- `task_complete` — you reported should_continue=false. Work is done.
- `circuit_breaker` — quality flat or declining for 3+ rounds. Review your approach.
- `max_rounds` — hit the round limit. Decide whether to extend or accept.
- `stalled` — no valid self-evaluation provided. Check your evaluation parameter.

If the result has a non-null `prompt`, execute it and repeat from Step 2.

## Tool Reference

| Tool | When to call | Key input | Key output |
|------|-------------|-----------|------------|
| `loopforge_start` | Beginning of every loop | `task`, `maxRounds?`, `constraints?` | `sessionId`, round 1 `prompt` |
| `loopforge_next` | After executing every round | `sessionId`, `output` (with eval block) | next `prompt` or `null` + `stopReason` |
| `loopforge_status` | Mid-loop checkpoint, user asks "how's it going" | `sessionId` | `round`, `qualityTrajectory`, `status`, `technique` |
| `loopforge_stop` | User wants to abort, fatal error | `sessionId` | `roundsCompleted`, final trajectory |
| `loopforge_list` | User asks "what loops are running" | — | `sessions[]` (includes vault-persisted) |
| `loopforge_replay` | After loop ends, user asks "show me what happened" | `sessionId` | `timeline[]` with all rounds |
| `loopforge_resume` | Resume a loop after process restart | `loopId` | next `prompt` or `null` + `stopReason` |
| `loopforge_health` | Check loop health mid-run | `loopId` | goal alignment, constraint integrity, drift, strategy |

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

1. **Always pass the evaluation parameter.** `loopforge_next` requires it.
   If you omit it, the MCP client will reject the call with a schema error.
2. **Be honest in self-evaluation.** Lying about success or hiding violations
   produces a false quality signal. The circuit breaker exists to stop bad
   loops — if you fake quality=5 every round, it fires anyway.
3. **One loop per task.** Don't reuse a sessionId across different tasks.
4. **Execute the prompt you're given.** The compiler may change technique or
   narrow scope between rounds. Trust it — it sees the trajectory.
5. **Call loopforge_next within the same turn.** Don't leave a round hanging
   across conversation turns. The MCP server is in-memory.
6. **After process restart, use loopforge_resume.** The session state is saved
   to vault every round. Call `loopforge_resume` with the original `loopId` to
   pick up where you left off — no need to restart from round 1.

## Example

```
User: /perception "Audit the ERC20 token in contracts/Token.sol for security issues"

Agent:
  → loopforge_start({ task: "Audit ERC20 token in contracts/Token.sol for security issues",
                       domain: "solidity",
                       constraints: ["must not break existing tests", "follow check-effects-interactions"] })
  ← { sessionId: "abc-123", round: 1, prompt: "## LoopForge Loop Compile — Round 1\n...", level: "l2" }

  [Executes prompt: reads Token.sol, identifies 4 issues, discovers a new constraint]

  → loopforge_next({ sessionId: "abc-123",
      evaluation: {
        success: false,
        output_summary: "Found 4 potential issues: 2 reentrancy, 1 overflow, 1 access control. Not yet fixed.",
        constraint_violations: [],
        should_continue: true,
        discovered_constraints: ["All _mint() calls must emit Transfer event per ERC20 spec"]
      } })
  ← { sessionId: "abc-123", round: 2, prompt: "## LoopForge Loop Compile — Round 2\n...", level: "l1" }

  [Executes prompt: fixes 3 issues, deepens understanding of access control problem]

  → loopforge_next({ sessionId: "abc-123",
      evaluation: {
        success: false,
        output_summary: "Fixed reentrancy in withdraw() and overflow in calcReward(). Access control in setOwner() needs design discussion — discovered it's part of a larger upgradeability concern.",
        constraint_violations: [],
        should_continue: true,
        objective_refinement: "Access control audit scope expanded: setOwner() is unprotected because the contract follows an upgradeable proxy pattern where owner is set via initializer — need to verify the initializer guard and proxy admin separately",
        emerged_subtasks: ["Audit upgrade proxy initialization flow", "Verify proxy admin is not renounced without recovery path"]
      } })
  ← { sessionId: "abc-123", round: 3, prompt: "## LoopForge Loop Compile — Round 3\n  Suggested Next Task: Audit upgrade proxy initialization flow; Verify proxy admin is not renounced without recovery path\n...", level: "l0" }

  [Executes prompt: audits proxy pattern, documents findings, all fixes pass tests]

  → loopforge_next({ sessionId: "abc-123",
      evaluation: {
        success: true,
        output_summary: "All fixable issues resolved. Proxy initialization verified — initializer modifier prevents double-init. Proxy admin held by multisig — low risk. 24/24 tests pass.",
        constraint_violations: [],
        should_continue: false
      } })
  ← { sessionId: "abc-123", round: 3, prompt: null, stopReason: "task_complete", quality: 5 }

  Reports to user: "Audit complete in 3 rounds. 3 issues fixed, 1 design question flagged. Discovered 1 new constraint during audit. Objective deepened to include proxy pattern verification."
```
