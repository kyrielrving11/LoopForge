---
name: forge
description: "LoopForge user manual: drive multi-round coding tasks through LoopForge MCP so objectives, constraints, evidence, and decisions survive context loss and restarts. The external Agent remains responsible for planning, file changes, tools, and execution. Not for one-pass edits."
when_to_use: "多轮任务, 长任务, 上下文压缩, 上下文丢失, 断点续跑, 会话恢复, 可审计过程, 机器验证, 漂移, 回滚, LoopForge, long-running coding task, multi-round, context loss, resume, machine-verified, auditable evidence, backtrack, drift"
dispatch_intent: "Drive long-running coding work through LoopForge so it survives restarts and is machine-verified round by round"
---

# Forge

The LoopForge user manual. Use it when a task needs more than one verified
boundary.

## When to use

Use Forge when any of these is true:

- The task spans several meaningful work slices, not one pass.
- The work must survive a restart, context compression, or a new Agent session.
- Hard constraints, success criteria, and evidence must persist across rounds.
- Success claims need machine verification, not the Agent's word.
- The work needs an auditable record of drift, rejection, backtrack, or a human
  gate.

Do not use it for a single edit, a question, or a task that finishes in one
verified pass. LoopForge adds a round boundary; a single boundary gains little
from durable state. The LoopForge MCP server must be connected
(`loopforge_start`, `loopforge_next`, and the other tools); this skill is the
manual, not the server.

LoopForge has one factual source, committed typed round documents in the Vault,
and one cognitive source, Canonical State compiled from those documents. The
Agent still decides what to do and how to reason. The current prompt and its
`submission_guidance` are the action surface for the held round. A committed
round document is the durable fact; `CanonicalLoopState` is the derived
cognitive view. The optional state file, receipt, replay, audit, and explain
views are projections and must not become a second ledger or instruction
source.

## Source of truth and lifecycle

Keep these meanings separate:

- A **logical round** is one coherent work slice with one `roundId` and one
  before/after evidence boundary.
- An **attempt** is another submission for the same logical round. An
  enforcement rejection increases the attempt count but creates no round
  history. A payload error is rejected before lifecycle state changes.
- A **Round Contract** is an Agent proposal for a future machine-checkable
  slice. It is not a round, a second plan ledger, or a required field.
- A **recovery checkpoint** is the restore check on the first submission after
  backtrack. It is part of that post-backtrack submission, not an extra
  development round.

The lifecycle is:

```text
prepared prompt -> Agent executes work -> loopforge_next(roundId, evaluation)
                                            |-- payload error: no state change;
                                            |   correct and retry same roundId
                                            |-- enforcement reject: same round;
                                            |   attempt increases; no commit
                                            |-- accept/continue: commit round;
                                            |   prepare next round
                                            |-- stop: commit final round/evidence
                                            |-- terminate: terminal result;
                                            |   no normal round commit
                                            |-- backtrack: restore workspace;
                                                submit redo on held roundId
```

LoopForge owns the boundary, persistence, evidence collection, and disposition.
The Agent owns semantic decomposition, tool use, edits, tests, and the choice
of what to do next.

## Start

Call `loopforge_status` with `view: "all"` before starting. Reuse an existing
session for the same objective instead of opening a second loop.

Call `loopforge_start` with:

- `task`: the complete user objective;
- `criteria`: the initial success criteria, each becoming a stable `cr-*`
  anchor rendered in every prompt (omit to keep the default criterion);
- `constraints`: hard boundaries that must survive every round;
- optional `maxRounds`, `domain`, `loopId`, and `planSource`.

Keep the returned `sessionId`, `roundId`, prompt, and level. Pass the latest
`roundId` to every `loopforge_next`; it anchors the submission to the exact
round being reported.

## What is a round?

A round is one coherent work slice that can be described, checked, and
disposed of at the next boundary. It is not a fixed number of files, tokens,
commits, or minutes. A capable Agent may complete a large change in one round
when the change shares one objective, one evidence story, and one recovery
path. Split it when those boundaries diverge.

Before choosing the slice, ask:

1. **Coherence:** does the work serve one immediate objective rather than
   several unrelated goals?
2. **Verifiability:** can the result and its hard constraints be checked with
   the available tests, commands, or other machine observations?
3. **Disposition:** will the boundary produce a clear continuation, stop,
   blocker, rejection, or recovery decision?
4. **Recovery:** can the slice be safely retried or rolled back without
   invalidating unrelated work?

Make a round larger when changes are tightly coupled and can be verified
together. Make it smaller when uncertainty, external effects, evidence gaps,
or rollback risk is high. Do not combine independent objectives merely because
the Agent can edit them in one context. Do not split a single atomic change
only to create more round records.

At the end of a round, inspect the actual diff, relevant tests, hard
constraints, and remaining work. A completed slice is not the same as a
completed task.

## Plan the next slice

For work that spans rounds, submit `round_contract` only when the next slice is
appropriate for a machine-checkable contract and a configured evidence command
is available. Size the slice by what one machine-checkable outcome covers. A
requirements list is not a round list. Coupled changes that share one objective,
one evidence story, and one recovery path belong in the same round.
Bind each item to a configured evidence command with `verify_with`, and limit
`scope` to files or directories that slice may touch. `criterion_refs` must
cite real `cr-*` ids rendered in the current prompt; `subgoal_refs` may cite
only active `sg-*` ids shown in it. A sub-goal declared in this same submission
becomes referenceable next round. Free text, unknown ids, duplicate
refs, and duplicate normalized items are rejected as `contract_invalid`. The
proposal becomes active only after its declaring round commits.
While it is open, you do **not** need to restate it: omitting `round_contract`
continues the active contract. A different proposal is ignored as
`contract_premature`. If this round closes the contract and another slice
follows, declare the successor in this same submission. If the slice is
blocked, report `outcome: "blocked"` with a concrete `blocker` instead of
silently replacing the active contract.

This is a planning aid, not a second gate. LoopForge learns the plan only from
committed evaluation fields, contract proposals, observations, and changes. If
no enabled after-capable command can verify the slice, do not invent a contract
just to make the round look complete; continue with Agent-directed work and
report the available evidence honestly.

## Execute a round

1. Execute the returned prompt and do the repository work.
2. Use the tools and reasoning approach that fit the slice.
3. Check actual evidence before claiming success.
4. Submit exactly one honest structured evaluation attempt with
   `loopforge_next`. Multiple commands, edits, and tests may happen inside one
   round before this submission. A rejected attempt may be corrected and
   resubmitted with the same `roundId`.

After the strict boundary accepts the payload, LoopForge collects before/after
evidence, runs the **verification gate**, then runs the **enforcement gate**.
The verification gate checks evaluation consistency, evidence integrity, plan
and contract conformance, and progress and recovery. The enforcement gate
turns those findings into one disposition: accept, reject, backtrack, or
terminate.

The four core evaluation fields are strict:

| Field | Requirement |
| --- | --- |
| `success` | Boolean. `true` only when the whole objective and hard constraints are satisfied. |
| `output_summary` | String describing what changed and what was verified. |
| `constraint_violations` | Array of real violations, preferably using `c-XXXXXXXX` IDs. |
| `should_continue` | Boolean. `false` only when the whole task is complete or the Agent must stop. |

Optional fields are event-driven declarations, not a completion form. Before
submitting, read the current prompt and `submission_guidance`; use their real
IDs, applicability, and legal shapes. Include a field only when its event
actually happened. Omission is correct when it did not.

The fields fall into four semantic groups. Use the live guidance for their
current applicability and exact shape:

- **Reports:** `execution_report`, `discovered_constraints`,
  `wrong_assumptions`, `worker_results`.
- **State transitions:** `emerged_subtasks`, `subgoal_updates`,
  `objective_refinement`, `retracted_constraints`,
  `revised_success_criteria`.
- **Claims and verification proposals:** criterion claims, active contract
  item claims, and `round_contract`.
- **Prompt and lifecycle controls:** `prompt_requests`,
  `compression_checkpoint` / `checkpoint_label`, `outcome`, `blocker`,
  `stop_reason`, `no_change_reason`, and `gate_ids`.

Reports and claims are not machine evidence. A criterion claim is advisory,
while a contract item becomes verified only from its configured machine
observations. A worker's discoveries remain a report until the main Agent
promotes a finding through the supported top-level field.

`execution_report.files_changed` is the **boundary net change**: paths whose
content or file type differs between round preparation and this submission,
including deletions. A commit alone adds no entry when content is unchanged.
Do not list gitignored paths merely to look complete. The receipt's
`files_reconciliation` block compares your report with the machine change set
and reports match/mismatch/unknown/not_applicable; an unobservable Git boundary
is `unknown`, never an empty diff.

`emerged_subtasks` is the only sub-goal creation channel. It contains plain
descriptions, never `sg-` IDs. `subgoal_updates` changes existing active IDs;
done and canceled are terminal and cannot be reopened. The prompt or
`submission_guidance` renders the real active IDs; never invent one.

`outcome` may be `success`, `partial`, `failed`, or `blocked`. A blocked
outcome needs a concrete `blocker`; `stop_reason` of `blocked` or
`needs_human_input` also stops without claiming success.

Optional malformed values are diagnosed and normalized or dropped. The strict
exceptions are `subgoal_updates`, `round_contract`, and
`execution_report.contract_item_claims`. Shape, reference, duplicate, command,
and workspace-containment errors return `evaluation_invalid` or
`contract_invalid` before advance. Correct the payload and resubmit the same
`roundId`; the invalid attempt is not persisted and no rejection counter moves.
`projection_incomplete` is different: it reports a LoopForge projection defect,
not poor Agent work. Do not retry the evaluation as though it were a payload
error. For `round_id_mismatch`, fetch the current session prompt and use its
current `roundId` rather than replaying a stale submission.

When the round actually changed the workspace or ran relevant tests, report the
corresponding `execution_report`. Do not invent an empty report or test counts
to satisfy a field checklist. A missing or empty report on a success claim is a
reporting gap (a `warn`), not by itself a rejection: acceptance is decided by
machine evidence and contract rules, never by optional-field coverage.
`no_change_reason` is an escape only when no enabled verification command
exists. It never creates evidence and never excuses an open contract.

Agent reports are claims quoted for audit. They never become verified facts.
Do not infer a missing field from natural language, do not fill a field to
satisfy a coverage check, and do not put a guessed evaluation in free text.
When no event occurred, omit the field.

Each prepared response carries `submission_guidance` with the real contract
item ids/statuses, active sub-goal ids, real criterion ids/text, usable
commands and the fields that apply now. Treat it as the authoritative shape for
the current submission, rather than copying examples from an older prompt.
Each submission returns `submission_receipt`, which separates reports that
were saved, derived state that actually changed, and machine verification
results, plus the structured `files_reconciliation` block. A report marked
`saved` is not a verified fact. The receipt is read-only feedback for this
submission; it is never a later prompt's independent fact source.

## IDs and contracts

Prompts render stable IDs beside constraints, criteria, sub-goals, and contract
items. Prefer those IDs for `constraint_violations`, criterion claims, status
updates, and item claims.

Every level renders the same protected normative set, criteria, active
constraints, the active contract and all items, active sub-goal ids, current
findings, and (when present) the recovery brief. Display caps may shorten
descriptions but never remove ids. `prompt_artifact.coverage` records the
proof; a missing active id fails closed with `projection_incomplete` rather
than delivering a partial prompt. A redo prompt carries the restore HEAD and
failed-round file facts in its protected Recovery Brief.

A sub-goal ID belongs to its declaration event. Re-declaring the same text in a
later round creates a new sub-goal. Status changes require the exact active
`sg-` ID; description matching is not a fallback.

A Round Contract is a set of evidence-bound items, not prose. Each item must
bind at least one configured, enabled, after-capable command. The runtime
derives content-addressed `rc-XXXXXXXX` and `rci-XXXXXXXX` IDs, so restating an
unchanged proposal keeps its identity. `subgoal_refs` belongs on the item; a
machine-verified item backs exactly the sub-goals it names, without changing
their declared `SubGoal.status`.

Item status is machine-derived:

- `pending`: not claimed as met;
- `insufficient`: claimed as met but not backed by all required observations;
- `contradicted`: a bound observation fails, or its entrypoint/configuration is
  no longer trustworthy;
- `verified`: the Agent claims `met`, every bound command passes in the closing
  round's after phase, and the declaration binding remains intact.

The contract closes only when every item is `verified` or a round reports
`outcome: "blocked"`. Repeated unbacked claims create bounded verification
debt. The same-check streak escalates at
`engine.unverified_claim_streak_limit` (default 3) instead of retrying forever.

Sub-goals may evolve during execution. LoopForge does not use fuzzy intent or
similarity to judge drift. The enforced boundary is contract `scope`: work
outside it is `round_scope_drift`, a machine fact no explanation waives. Revert
the out-of-scope change, or close the contract as blocked and declare the
expanded scope in a new proposal whose `scope` covers **every** file this round
changed outside the current one, a partial expansion is still drift.

## Evidence commands

Contract items are backed by commands the OPERATOR configures. The Agent never
declares one, and does not discover or run project scripts to invent one. They
live in `loop_policy.json` under `evidence.commands`, in the workspace the
server was started in:

```json
{
  "version": "5",
  "evidence": {
    "commands": [{
      "name": "verify",
      "enabled": true,
      "executable": "node",
      "args": ["scripts/verify.mjs"],
      "cwd": ".",
      "phase": "after",
      "required": true,
      "timeout_ms": 120000,
      "max_output_chars": 8000,
      "success_exit_codes": [0]
    }]
  }
}
```

`executable` and `args` are spawned without a shell and confined to the
workspace. `loopforge doctor` statically checks every configured command,
its name, executable, arguments, timeouts, and workspace containment, and
never executes one.

Every prepared response carries `submission_guidance.contract_commands` and
`submission_guidance.contract_verification_available`; `loopforge_status`
`view=session` also returns the full `capability` object. When verification is
unavailable, no configured command can back a contract item: run rounds without
a contract instead of declaring items that cannot close. The `warnings` list
states the same thing in words.

A command's ENTRYPOINT is the file it names plus `package.json` when a package
manager runs it. It must already be part of the workspace when the round
starts, and it must not change during the round that runs it, the runtime
records those files at round start and compares them afterwards, whether or not
git can see them. A changed entrypoint makes the observation untrustworthy:
restore it to its round-start content. Do not author the verification script
inside the round you expect it to verify. That round cannot be closed by it.

To keep a script that must survive a rollback, it has to be part of the
committed workspace rather than an uncommitted change: the post-backtrack
restore check rejects a skipped file that is still byte-identical to its state
at the rollback, so a script left sitting in the working tree blocks the redo.
Prepare it before the round that depends on it.

## Backtrack and recovery

A progress stall requires observable Git history over the lookback window.
Committed work counts as motion through the Git HEAD change, even when the
closing worktree is clean, and the round you are submitting counts too: if it
moved files or committed, it cancels the verdict. If machine history cannot be
read, no stall verdict is made. A machine-backed success round is finishing,
even if its closing round changes no files.

Backtrack records a rollback directive and restores the round counter to the
last clean committed round. Rejected attempts are never history. The held
post-backtrack prompt is the redo of `restorePoint + 1`; use its `roundId`.
There is no extra recovery round.

The Recovery Brief identifies the trigger, restore point, redo ID, failed
approaches, falsified assumptions, valid discoveries, files to revert, and
target HEAD. It states restoration facts, not a prescribed command.

When backtrack occurs:

1. Restore the workspace before doing more work: the restore point's HEAD,
   with none of the failed rounds' changes left behind. Work in progress the
   restore point already carried may stay.
2. Read the protected Recovery Brief and current prompt. The restore check is
   judged against the restore point's machine snapshot at the redo round's
   start; it permits only the work-in-progress already present there.
3. Continue the redo only after restoring that boundary. Submit its work and
   evidence using the held `roundId`; LoopForge validates restoration before
   the redo can commit.
4. Do not repeat a failed approach without addressing its cause. Carry valid
   discoveries into the redo evaluation.

If the rolled-back work used an active contract, follow the Recovery Brief and
live `submission_guidance` for that contract. Do not blindly restate or replace
it; a successor proposal is subject to the same contract lifecycle rules.

## Interpret results

- Non-null `prompt`: execute it and submit the next evaluation.
- `enforcementAction: "reject"`: retry the same logical round and ID; the
  attempt increases.
- `enforcementAction: "backtrack"`: restore the workspace, then submit the
  first post-backtrack redo evaluation with the held prompt and round ID; the
  runtime checks the restore boundary before that redo commits.
- Null `prompt`: inspect `stopReason`.

Read `submission_guidance` before composing the next evaluation, and read
`verificationStatus`, `roundSuccess`, `level`, `warnings`, and
`enforcementReason` before planning the next slice. In
`submission_receipt.verification`, `contract_status` is the contract-item
posture and `evidence_status` is the round-level machine evidence posture; do
not read "no active contract" as "verified". `submission_receipt.reports`
distinguishes a saved report from derived state that changed and from a machine
verification result; `not_applied` means the submission did not become history.
These are evidence postures, not subjective quality scores.

Errors use `{ok: false, error: {code, message, retryable, ...}}`. Branch on the
stable `code`, not the prose in `message`. Payload errors such as
`evaluation_invalid`, `contract_invalid`, `policy_invalid`, and round-ID
errors are retryable with the same ID. `session_not_found`, `state_unavailable`,
and `gate_disabled` describe state or policy; do not blindly resubmit.

`completed` means success plus every active contract item is `verified`, or
there is no active contract. Explicit `blocked` always wins over success.
`incomplete` means completion was not machine-verified. Other terminal reasons
include `failed`, `max_rounds`, `stalled`, `enforcement_terminated`, `paused`,
and `cancelled`.

## Prompt levels and views

L0 is a lean same-round retry, or follows a committed failed round only when
the runtime proves there was no machine activity and no declared evolution.
Unknown machine activity does not qualify for L0. L1 is normal continuation;
L2 is full rehydration. Levels control state density only, never a reasoning
technique or the set of evaluation fields you
may use: L0/L1/L2 offer the same applicable trigger checklist, including real
`cr-`/`rci-`/`sg-` ids. If this prompt is L0, it does not apply the previous
round's `prompt_requests`; the field you submit in this round can still be
applied to the next prompt. L2 comes from round facts such as the first round,
a plan or checkpoint boundary, recovery, contradiction, or repeated rejection.
It is not a round-count timer.

Use `loopforge_status` with `view: "session"` for the live round,
`view: "loop"` for committed health, `view: "all"` after a restart,
`view: "audit"` for completeness and evidence, and `view: "explain"` for a
round's active contract, observations, flags, and decision. Use
`loopforge_replay` for the committed timeline and diffs.

The optional `.loopforge/state/<loopId>-state.md` is derived and regenerable.
Read it when an L2 prompt points to it, but never treat it as a second source
of truth.

## Gates and delegation

Use `loopforge_pause` for an intentional interruption,
`loopforge_resume` to reconstruct a durable session, and `loopforge_stop` only
for an intentional terminal stop.

The two gate tools are opt-in through `policy.gate.enabled`. When enabled,
`loopforge_gate_check` preflights a structured action with its description,
scope, effects, reversibility, and authorization. Classification is
conservative: anything not provably safe becomes `user_required`. Present the
approval question, record the decision with `loopforge_gate_resolve`, and cite
the approved gate ID in `evaluation.gate_ids`. LoopForge records the process,
but cannot prove that a human was present because the Agent submits the resolve
call. Safe investigation and dry-runs need no gate.

Delegation does not create another LoopForge mode. Give each worker a
self-contained subtask and hard constraints, then place the result in
`worker_results`. A worker result is a report with its source: its
`discoveredConstraints` does **not** enter the global constraint set by itself.
If you accept a worker's finding, state it in top-level
`discovered_constraints`. That is the only promotion channel.

## Avoid these mistakes

- Do not start a new round for each file, command, test, commit, or elapsed
  time interval.
- Do not treat a rejection attempt as a new round or submit it under a new ID.
- Do not fill optional fields to satisfy a checklist; report only events that
  actually occurred.
- Do not create a contract when no configured command can verify it.
- Do not treat a receipt, state file, or agent report as committed machine
  evidence.
- Do not continue coding after backtrack until the restore boundary is in place.
- Do not continue after `prompt: null` without interpreting `stopReason`.

## Rules

1. Execute the prompt instead of generating another prompt.
2. Submit one honest structured evaluation after each completed work slice;
   correct rejected submissions under the same `roundId`.
3. Treat required command evidence and verification findings as authoritative.
4. Restore the workspace before working after backtrack.
5. Keep one loop focused on one user objective.
6. Do not advance a paused or stopped session through another process.
7. Continue in the same Agent task when possible. LoopForge preserves state but
   does not create a background Agent.
