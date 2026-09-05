---
name: perception
description: Drive a recoverable multi-round coding task through LoopForge MCP while the external Agent remains the execution owner.
---

# Perception

Use LoopForge when a coding task needs several rounds, must survive context
compression or process restart, or benefits from an auditable record of goals,
constraints, evidence, and decisions.

LoopForge has one factual source, the committed typed round documents in the
Vault, and one cognitive source, the Canonical State compiled from them. You
remain the Agent that reads files, edits code, runs commands, delegates work,
and decides how to reason.

## Start

Call `loopforge_start` with:

- `task`: the complete user objective.
- `constraints`: hard boundaries that must survive every round.
- `maxRounds`: optional positive safety limit. The default is 20.
- `domain`: optional context label.

Keep the returned `sessionId`, `roundId`, prompt, and level. Always pass the
most recent `roundId` to `loopforge_next`. It anchors the submission to the
exact round being reported.

## Plan round boundaries

LoopForge does not decide how the Agent thinks about a large task. The Agent
chooses the next useful slice of work, while LoopForge checks the submitted
facts and evidence at the round boundary. Do not try to predict an exact number
of rounds before inspecting the repository. Re-plan after each committed round.

Choose a round around a coherent, verifiable change:

1. Start with the dependency or discovery work that determines later choices.
2. Group changes that must be edited and tested together; split unrelated work
   or work with different rollback risks.
3. End the round when its slice has a concrete result, a known blocker, or a
   machine-checkable next boundary. A round may be small when uncertainty or
   risk is high, and larger when the changes are tightly coupled.
4. Before submitting, check the actual diff, relevant tests, hard constraints,
   and the next action. Do not mark the whole task complete because one slice
   is complete.

For work that spans several rounds, declare a `round_contract` as a proposal for
the next slice. Keep its `work_item` narrow, list observable `done_when` items,
name only configured evidence commands in `verification_plan`, and constrain
`scope` to the files or directories that slice may touch. The proposal becomes
active only after the current round commits. If the slice is blocked, report
`outcome: "blocked"` with a concrete `blocker`; do not silently replace the
active contract.

This is a granularity preflight, not another gate: ask whether the slice has a
clear boundary, evidence, and recovery path. LoopForge cannot see an implicit
plan inside the model. It learns only from committed evaluation fields,
Round Contract proposals, observed evidence, and the resulting changes. A
reasonable split may therefore be revised by the next prompt, a verification
finding, or a backtrack diagnosis.

## Execute a round

1. Execute the returned prompt and do real repository work.
2. Use the tools and reasoning approach that fit the task.
3. Check actual evidence before claiming success.
4. Submit one structured `evaluation` with `loopforge_next`.

The four core evaluation fields are strict:

| Field | Rule |
| --- | --- |
| `success` | Boolean. Use `true` only when the whole objective and every hard constraint are satisfied. |
| `output_summary` | String. State what changed and what was verified this round. |
| `constraint_violations` | Array of strings. Report real violations; prefer constraint IDs such as `c-XXXXXXXX`. |
| `should_continue` | Boolean. Use `false` only when the entire task is complete. |

All other evaluation fields are optional and normalized by LoopForge. Useful
fields include `execution_evidence`, `discovered_constraints`,
`emerged_subtasks`, `completed_subtasks`, `blocked_subtasks`,
`canceled_subtasks`, `next_action`, `drift_clarification`, `prompt_requests`,
`outcome`, `blocker`, `round_contract`, `retroactiveClaims`, and
`worker_results`.

Optional malformed values are ignored or defaulted. They do not turn a valid
submission into a transport error. Missing or mistyped core fields return
`evaluation_invalid` with `details.missing` and `details.invalid`. Correct the
payload and resubmit the same `roundId`. This does not save session state,
write a round, enter either gate, increment rejection state, or record metrics.

Minimal evaluation:

```json
{
  "success": false,
  "output_summary": "Implemented the parser and added 8 passing tests.",
  "constraint_violations": [],
  "should_continue": true,
  "execution_evidence": {
    "files_changed": ["src/parser.ts", "tests/parser.test.ts"],
    "test_results": { "passed": 8, "failed": 0, "skipped": 0 },
    "success_criteria_met": [],
    "success_criteria_remaining": ["All parser edge cases covered"],
    "progress_estimate": 0.4
  }
}
```

Do not put a guessed evaluation in free text. The structured object is the
authoritative submission; `output` is optional supporting context.

If a submission warns that its `roundId` no longer matches, the reported round
already committed. Use the returned held prompt and its `roundId` rather than
submitting against a later round.

## Stable IDs and contracts

Prompts render stable IDs beside constraints, criteria, and sub-goals:

- Constraints: `[c-a3f2b1c0] No plaintext passwords`
- Criteria: `[cr-b5a6c7d8] Unit test coverage >= 90%`
- Sub-goals: `[sg-f1e2d3c4] Add error handling to login`

Prefer IDs for `constraint_violations`, criteria lists, subtask status changes,
and drift clarifications. Natural-language matching remains a policy-controlled
fallback when an ID is unavailable.

An optional `round_contract` is a proposal for the next round. It becomes
active only after the declaring round commits. While active, its `done_when`,
`verification_plan`, and `scope` govern the current task until a committed eval
completes it or reports `outcome: "blocked"`. A verification plan must be
observed passing in the closing round.

## Backtrack

A progress stall (stalled or exactly-flat window over the lookback rounds)
can trigger backtrack to the last clean committed round. The prompt includes a
diagnosis and workspace-restore requirements.

When backtrack occurs:

1. Restore the workspace exactly as requested before doing more work.
2. Read the restored prompt and derived state.
3. Do not repeat the failed approach without addressing the diagnosis.
4. Keep valid discoveries from skipped rounds in later evaluations.

If the workspace is not restored, the next submission is rejected with
`backtrack_workspace_not_restored`. A stalled active contract should be closed
with `outcome: "blocked"` and a blocker while proposing the revision.

## Drift

The verification gate compares the previous `next_action` with the current
work. When intentionally changing direction, provide a substantive
`drift_clarification` with a concrete constraint, criterion, sub-goal ID, or
file path that actually exists in your report or the vault. Three consecutive
weak clarifications terminate the loop.

## Interpret results

- `prompt` is non-null: execute it and submit the next evaluation.
- `enforcementAction: "reject"`: redo the same logical round. The round ID is
  stable and the attempt increases.
- `enforcementAction: "backtrack"`: restore the workspace, then continue from
  the restored prompt and round.
- `prompt` is null: inspect `stopReason`.

`completed` means the task ended with success. `failed` means the Agent gave
up. `blocked` means current constraints prevent progress. `max_rounds` is the
safety limit. `stalled` means no usable next state was produced.
`enforcement_terminated` means repeated integrity failures reached a terminal
ladder. `paused` means the durable session remains available for resume.

## Prompt levels and views

L0 is a lean same-round retry, L1 is normal continuation, and L2 is full
rehydration. They control state density only and never prescribe a reasoning
technique. Mandatory prompt sections and the token budget remain enforced.

Use `loopforge_status` with `view: "session"` for the live round and typed
projection, `view: "loop"` for alignment and drift, `view: "all"` after a
restart, and `view: "audit"` for the read-only completeness and evidence audit.
Use `loopforge_replay` for the committed timeline and round diffs. Replay
answers what happened; Audit checks whether facts and claims are supported.

The optional `.loopforge/state/<loopId>-state.md` file is derived and can be
regenerated. Read it in L2 pointer mode when the prompt asks for full context,
but do not treat it as an independent source of truth.

## Control and delegation

Use `loopforge_pause` before an intentional interruption,
`loopforge_resume` to reconstruct a durable session, and `loopforge_stop` only
for an intentional terminal stop. Use `loopforge_gate_check` and
`loopforge_gate_resolve` for recorded human or agent gates.

Delegation does not create a separate LoopForge mode. Give each worker a
self-contained subtask and relevant hard constraints, then place its result in
`worker_results` so discoveries can enter the next Canonical State.

## Rules

1. Execute the prompt instead of generating another prompt.
2. Submit one honest structured evaluation after each attempt.
3. Restore the workspace before working after backtrack.
4. Treat required command evidence and verification errors as authoritative.
5. Keep one loop focused on one user objective.
6. Do not advance a paused or stopped session through another process.
7. Continue within the same Agent task when possible. LoopForge preserves state
   but does not create a background Agent.
