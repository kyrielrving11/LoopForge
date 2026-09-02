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

Keep the returned `sessionId`, `roundId`, prompt, and level. The `roundId`
anchors your next submission to the exact round it reports on — always pass it
back with `loopforge_next`.

## Execute a round

1. Execute the returned prompt. Do real repository work.
2. Use the available tools and reasoning approach that best fit the task.
3. Check actual evidence before claiming success.
4. Call `loopforge_next` with `sessionId`, the `roundId` from the most recent
   response, and a structured `evaluation`.

If a submission comes back with a warning that its `roundId` does not match the
current round, the round it reported on has already committed — the returned
prompt is the one you missed (e.g. a lost response). Work from it and resubmit
with its `roundId`.

### Evaluation fields

| Field | Rule |
| --- | --- |
| `success` | `true` only when the whole objective and every hard constraint are satisfied. |
| `output_summary` | State what changed and what was verified this round. |
| `constraint_violations` | Report real violations. Use constraint IDs (`c-XXXXXXXX`) for exact matching. Do not hide violations to force progress. |
| `should_continue` | `false` only when the entire task is complete. |
| `execution_evidence` | `files_changed`, `test_results`, `success_criteria_met`, `success_criteria_remaining`, `progress_estimate`. Use criterion IDs (`cr-XXXXXXXX`) in `success_criteria_met`/`_remaining`. |
| `discovered_constraints` | New guardrails found this round. Will be assigned stable IDs by the compiler. |
| `objective_refinement` | Refine the objective when repository evidence changes its meaning. |
| `emerged_subtasks` | New sub-problems that surfaced. Use clear, distinct descriptions. |
| `completed_subtasks` | Sub-goal IDs (`sg-XXXXXXXX`) or descriptions you finished this round. |
| `blocked_subtasks` | Sub-goal IDs or descriptions that cannot proceed. |
| `canceled_subtasks` | Sub-goal IDs or descriptions that are no longer needed. |
| `retracted_constraints` | Constraints the agent now believes are wrong or irrelevant. |
| `revised_success_criteria` | Old → new revisions for criteria discovered to be incorrect. |
| `wrong_assumptions` | Assumptions disproved this round. |
| `next_action` | What you plan to do in the next round. Be specific — the verification gate compares this against your actual output. |
| `compression_checkpoint` | Set `true` and include `checkpoint_label` when you complete a major phase. |
| `drift_clarification` | Required when you pivot from your declared `next_action`. Must include specific constraint/criterion/sub-goal IDs or file paths. Filler text without concrete references will be rejected. |
| `prompt_requests` | `emphasize` (what to highlight next round), `expand` (sections to expand), `confusion_points` (what you're confused about). |
| `stop_reason` | When `should_continue=false` and `success=false`: `"gave_up"`, `"blocked"`, or `"needs_human_input"`. |
| `outcome` | Optional v2.12 tri-state: `"success" | "partial" | "failed" | "blocked"`. Derived from `success` when absent; `partial`/`blocked` are explicit-only. Declare `blocked` + `blocker` instead of fighting the success checks. |
| `blocker` | Flat description, required when `outcome="blocked"`. High-risk blockers feed the user/agent gate classification. |
| `retroactiveClaims` | Optional: `[{"round": 3, "claim": "fixed src/a.ts in round 3"}]` — claims that a PRIOR round satisfied a criterion; verified against that round's git evidence. |
| `no_change_reason` | When claiming `success` with no machine-verifiable evidence (e.g. docs-only round), declare why — downgrades the evidence check from error to info. |
| `worker_results` | Record delegated subtask results and discoveries from sub-agents. Each entry may carry `outcome: "success" | "partial" | "failed"`. |

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

**Declared outcomes win.** With `outcome: "partial"`, the success-class
checks stay silent even if `success` is left `true` — declare the truth,
don't fight the gates.

## Using stable IDs

The prompt renders stable IDs beside every constraint, criterion, and sub-goal:

- **Constraints:** `[c-a3f2b1c0] No plaintext passwords`
- **Criteria:** `[cr-b5a6c7d8] Unit test coverage ≥ 90%`
- **Sub-goals:** `[sg-f1e2d3c4] Add error handling to login`

**Prefer IDs over descriptions** in `constraint_violations`, `success_criteria_met`/`_remaining`, `completed_subtasks`, `blocked_subtasks`, `canceled_subtasks`, and `drift_clarification`. Exact ID matching eliminates ambiguity — Jaccard similarity is a fallback, not the primary path.

## Backtrack — when the loop rewinds

When progress stalls for multiple rounds, LoopForge triggers a **backtrack**:
the round counter rolls back to the last clean round, failed work is discarded,
and a diagnosis is injected into the prompt.

**When you receive a backtrack prompt:**

1. **Restore your workspace first.** The prompt includes a "Workspace Restore
   Required" section with exact `git checkout -- . && git clean -fd` commands.
   Your working directory still contains changes from the failed rounds —
   you MUST discard them before working.
2. **Read the restored state.** The prompt reflects the clean round's vault
   state. The state file shows the correct full picture.
3. **Do NOT repeat the failed approach.** The diagnosis explains why the
   previous path failed. Choose a different technique or decomposition.
4. **Preserved discoveries** from skipped rounds are merged into the active
   constraints — they remain valid even though the rounds were discarded.

If you skip the workspace restore and work on dirty files, the verification
gate will **reject** your next submission with a `backtrack_workspace_not_restored`
flag.

## Drift — when you change direction

The verification gate compares your `next_action` from the previous round
against your actual `output_summary` this round. A mismatch triggers an
`intent_drift` flag.

**If you intentionally pivoted**, set `drift_clarification` with:
- A specific reason for the pivot.
- At least one concrete reference: a constraint ID (`c-XXXXXXXX`),
  criterion ID (`cr-XXXXXXXX`), sub-goal ID (`sg-XXXXXXXX`), or changed
  file path.

✅ Good: `"Pivoted because constraint c-a3f2b1c0 was already satisfied by src/auth.ts. The CSS fix was higher priority."`

❌ Rejected: `"I changed direction because I felt this approach was better."`

Three consecutive weak clarifications (no concrete references) will
**terminate the loop**.

## Interpret the result

If `prompt` is non-null, execute it and submit the next evaluation.

If `enforcementAction` is `reject`, redo the same logical round. The round ID
stays stable and the attempt number increases. Follow the retry requirements;
the rejected attempt has not been committed.

If `enforcementAction` is `backtrack`, the loop has been rolled back. Restore
your workspace (see Backtrack section above), then work from the restored
prompt at the new round number.

If `prompt` is null, inspect `stopReason`:

| Reason | Meaning |
| --- | --- |
| `completed` | The complete objective was reported finished. |
| `failed` | The agent gave up (`should_continue=false`, `success=false`). |
| `blocked` | Work cannot proceed under current constraints. Human input may be needed. |
| `max_rounds` | The safety limit was reached. Summarize remaining work. |
| `stalled` | Evaluation or execution did not produce a usable next state. |
| `enforcement_terminated` | Repeated invalid claims, stalled progress, or weak clarifications terminated the loop. |
| `paused` | The durable session remains available for resume. |

## Prompt levels

- **L0** — Same-round retry with the rejection reason and changed evidence. ~3K chars.
- **L1** — Normal compact continuation. ~7K chars.
- **L2** — Full rehydration: first round, checkpoint, goal change, or recovery. In L2 pointer mode (default), the prompt shows a structured dashboard; the full state lives in `.loopforge/state/<loopId>-state.md`. Read it before acting.

These levels control state density only. LoopForge does not choose a reasoning
technique for you.

## Recovery and control

- Use `loopforge_status` with `view: "session"` (default) to inspect the live round, trajectory, and the typed projection (focus/todo/phase/delegation/handoff facts).
- Use `loopforge_status` with `view: "all"` after a client restart to find recoverable sessions.
- Use `loopforge_status` with `view: "loop"` to inspect goal alignment and drift.
- Use `loopforge_status` with `view: "audit"` for the read-only end-of-loop verification audit (claims, gates, verdict, sequence integrity).
- Use `loopforge_pause` before an intentional interruption.
- Use `loopforge_resume` with the loop ID to reconstruct a durable session.
- Use `loopforge_replay` for the committed timeline.
- Use `loopforge_gate_check` / `loopforge_gate_resolve` to classify and record human decisions for high-risk actions.
- Use `loopforge_stop` only for an intentional terminal stop.

The `.loopforge/state/<loopId>-state.md` file is the authoritative full-state
view in L2 pointer mode. Read it at the start of each L2 round — the prompt
dashboard is a summary, not the complete picture.

## Delegation

Delegation does not create a separate LoopForge mode. Give each worker a
self-contained subtask and relevant hard constraints. Add the returned result to
`worker_results` so discoveries can enter the next canonical state.

## Rules

1. Execute the prompt instead of generating another prompt.
2. Submit one honest structured evaluation after each attempt.
3. Use stable IDs (`c-`/`cr-`/`sg-XXXXXXXX`) for exact matching whenever possible.
4. When backtrack occurs, restore the workspace before working.
5. When you pivot from your `next_action`, explain with concrete references in `drift_clarification`.
6. Treat required command evidence and verification errors as authoritative.
7. Keep one loop focused on one user objective.
8. Read the state file at the start of L2 rounds — it holds the complete picture.
9. Do not advance a paused or stopped session through another process.
10. Continue within the same Agent task when possible; LoopForge preserves state,
    but it does not create a background Agent.
