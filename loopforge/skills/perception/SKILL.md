---
name: perception
description: Drive a recoverable multi-round coding task through LoopForge MCP while the Agent remains the execution owner.
---

# Perception

Use LoopForge when a coding task needs several rounds, must survive context
compression or process restart, or benefits from an auditable record of goals,
constraints, evidence, and decisions.

LoopForge maintains cognitive state. You remain the Agent that reads files,
edits code, runs commands, delegates work, and decides how to reason.

## Start

Call `loopforge_start` with:

- `task`: the complete user objective.
- `constraints`: hard boundaries that must survive every round.
- `maxRounds`: optional safety limit. The default is 20.
- `domain`: optional context label.

Keep the returned `sessionId`, `roundId`, prompt, and level.

## Execute a round

1. Execute the returned prompt. Do real repository work.
2. Use the available tools and reasoning approach that best fit the task.
3. Check actual evidence before claiming success.
4. Call `loopforge_next` with `sessionId` and a structured `evaluation`.

Minimal evaluation:

```json
{
  "success": false,
  "output_summary": "Implemented the parser and added 8 passing tests.",
  "constraint_violations": [],
  "should_continue": true
}
```

Important fields:

| Field | Rule |
| --- | --- |
| `success` | Use `true` only when the whole objective and every hard constraint are satisfied. |
| `output_summary` | State what changed and what was verified. |
| `constraint_violations` | Report real violations. Do not hide them to force progress. |
| `should_continue` | Use `false` only when the entire task is complete. |
| `execution_evidence` | Report changed files, test counts, met and remaining criteria, and progress when known. |
| `discovered_constraints` | Add newly discovered guardrails. |
| `objective_refinement` | Refine the objective when repository evidence changes its meaning. |
| `wrong_assumptions` | Record assumptions disproved this round. |
| `worker_results` | Record delegated subtask results and discoveries. |

Do not embed an evaluation marker in ordinary output when the MCP client accepts
the structured `evaluation` argument.

## Interpret the result

If `prompt` is non-null, execute it and submit the next evaluation.

If `enforcementAction` is `reject`, redo the same logical round. The round ID
stays stable and the attempt number increases. Follow the retry requirements;
the rejected attempt has not been committed.

If `prompt` is null, inspect `stopReason`:

| Reason | Meaning |
| --- | --- |
| `task_complete` | The complete objective was reported finished. |
| `circuit_breaker` | Repeated failed rounds require a different approach or user input. |
| `max_rounds` | The safety limit was reached. Summarize remaining work. |
| `stalled` | Evaluation or execution did not produce a usable next state. |
| `enforcement_terminated` | Repeated invalid claims or stalled progress terminated the loop. |
| `paused` | The durable session remains available for resume. |

## Prompt levels

- L0 is a same-round retry with the rejection reason and changed evidence.
- L1 is the normal compact continuation view.
- L2 is a full rehydration for the first round, a checkpoint, or a goal change.

These levels control state density only. LoopForge does not choose a reasoning
technique for you.

## Recovery and control

- Use `loopforge_status` to inspect the live round and trajectory.
- Use `loopforge_pause` before an intentional interruption.
- Use `loopforge_resume` with the loop ID to reconstruct a durable session.
- Use `loopforge_list` after a client restart to find recoverable sessions.
- Use `loopforge_replay` for the committed timeline.
- Use `loopforge_health` to inspect goal alignment and drift.
- Use `loopforge_stop` only for an intentional terminal stop.

The optional `.loopforge/state/<loopId>-state.md` file is a readable derived
view. The typed JSON session and round documents are the recovery truth. If the
state file exists, it can help you review the full state, but do not assume it is
enabled.

## Delegation

Delegation does not create a separate LoopForge mode. Give each worker a
self-contained subtask and relevant hard constraints. Add the returned result to
`worker_results` so discoveries can enter the next canonical state.

## Rules

1. Execute the prompt instead of generating another prompt.
2. Submit one honest structured evaluation after each attempt.
3. Treat required command evidence and verification errors as authoritative.
4. Keep one loop focused on one user objective.
5. Do not advance a paused or stopped session through another process.
6. Continue within the same Agent task when possible; LoopForge preserves state,
   but it does not create a background Agent.
