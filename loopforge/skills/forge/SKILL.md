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
verified pass. The LoopForge MCP server must be connected
(`loopforge_start`, `loopforge_next`, and the other tools); this skill is the
manual, not the server.

LoopForge has one factual source, committed typed round documents in the Vault,
and one cognitive source, Canonical State compiled from those documents. The
Agent still decides what to do and how to reason. The current prompt and its
`submission_guidance` are the action surface for the held round. The optional
state file, receipt, replay, audit, and explain views are projections and must
not become a second ledger or instruction source.

## Source of truth and lifecycle

Keep these meanings separate:

- A **logical round** is one coherent work slice with one round identity and
  one before/after evidence boundary.
- An **attempt** is another submission for the same logical round. An
  enforcement rejection increases the attempt count but creates no round
  history. A payload error is rejected before lifecycle state changes.
- A **Round Contract** is an Agent proposal for a future machine-checkable
  slice. It is not a round, a second plan ledger, or a required field.
- A **workspace checkpoint** is the before-image of a prepared round or an
  explicit mid-round savepoint (`loopforge_checkpoint`). It is recovery
  material, not a round, a commit, or progress. This is different from an
  evaluation's `subtask_boundary` / `subtask_boundary_label`, which is only an
  Agent declaration / L2 boundary reason.

The lifecycle is:

```text
prepared prompt -> Agent executes work -> loopforge_next(submissionHandle, evaluation)
                                            |-- payload error: no state change;
                                            |   correct and retry same handle
                                            |-- enforcement reject: same round;
                                            |   attempt increases; no commit;
                                            |   use the NEW handle
                                            |-- accept/continue: commit round;
                                            |   prepare next round
                                            |-- stop: commit final round/evidence
                                            |-- terminate: terminal result;
                                            |   no normal round commit
                                            |-- backtrack/recovery: LoopForge
                                                restores + verifies, then
                                                issues the redo prompt
```

LoopForge owns the boundary, persistence, evidence collection, and disposition.
The Agent owns semantic decomposition, tool use, edits, tests, and the choice
of what to do next.

## Context strategies and Working Memory

A clean context and a failed retry are not the same axis. Every prompt header
names its derived strategy; the enum values below are transport facts, and the
strategy label is what the host follows:

```text
Context: clean context — next round (fresh_invocation; workspace continues)
Context: clean context repair (fresh_invocation; rejection_escalation; same logical round; rejected posture is attempt-time only)
Context: in-context repair (same_round_retry; enforcement_retry; continue original invocation if alive; lessons injected)
Context: clean context after restore (fresh_invocation; recovery_redo; lessons carried)
```

- **clean context** (`fresh_invocation`): start a NEW Agent invocation with only
  this prompt, the `loopId`, `sessionId`, and `submissionHandle`. Do not carry
  the previous transcript, tool logs, or uncommitted reasoning. It is not a
  workspace reset: committed files, git state, and the session continue. It may
  be the next logical round, the first round, a recovery redo, or the SAME
  logical round on a `rejection_escalation` retry.
- **in-context repair** (`same_round_retry`, `enforcement_retry`): a retry in
  the original context, independent of prompt density.
  Continue the current invocation if it exists; the rejection notice, findings
  and failure reason are injected. If it is gone, start a new one from this
  self-contained prompt, but keep the same round and attempt.
- **clean context repair** (`fresh_invocation`, `rejection_escalation`): start a
  new invocation; the retry notice, findings, transient rejected posture and
  committed memory are already
  in the prompt.
- **clean context after restore**: recovery redo. LoopForge has already restored
  and verified the workspace; the Recovery Brief and failure lessons are in the
  prompt. Never continue the abandoned transcript.

Read `contextMode`, `contextReason` and the strategy label together; L0/L1/L2
select density and do not determine the invocation boundary.

The executable round division and submission rules live in every prompt's
`## Round Boundary` section and in the MCP server instructions. This manual
does not copy them. Re-delivering the same held prompt (`status`, `resume`,
`unpause`) is not a new boundary: the same `promptHash` and handle continue the
same attempt.

A clean-context prompt may render **bounded Working Memory** derived only from the
current branch's committed rounds and committed rollback directives: the
latest report, earlier reports in the fixed window, falsified
assumptions/retractions, open questions, consumed recoveries, and contract
redirects. Source windows and per-item limits are code constants, not policy.
L1 and L2 render the same full fixed projection; L0 stays compact. The default
prompt ceilings are 5,000 / 50,000 / 100,000 characters for L0 / L1 / L2.
These are safety ceilings, not targets for routine memory omission. Working
Memory is an indivisible optional section and may be dropped whole when the
prompt cannot fit it; the prompt artifact records its rendered state and
source/rendered/omitted counts. Each item is a labelled Agent report or
committed event, not machine evidence, and it never enters the verification
gate.

For older history, do not ask the user to restate the task and do not assume
the prompt remembered it. Use:

- `loopforge_replay` with `loopId` (optional `start`/`end`; default last 10
  committed rounds, at most 50 in an explicit window);
- `loopforge_status` with `view: "explain"` (optionally `round`);
- the state file, when the prompt names one. If its hash differs from the
  prompt header, treat it as stale and re-align with status or resume.

## Start

Call `loopforge_status` with `view: "all"` before starting. If a loop already
covers this objective, do not open a second one: take its `loopId` and call
`loopforge_resume` (this works after a process restart). Start a new loop only
when no existing loop covers the objective.

Call `loopforge_start` with:

- `task`: the complete user objective;
- `criteria`: the initial success criteria, each becoming a stable `cr-*`
  anchor rendered in every prompt (omit to keep the default criterion);
- `constraints`: hard boundaries that must survive every round;
- optional `maxRounds`, `loopId`, and `planSource`; the live
  `loopforge_start` tool schema is the authoritative argument list.

Keep the returned `loopId` and `submissionHandle`. The `loopId` is the durable
loop identity: it survives restarts and is what `loopforge_resume` and the
per-loop `loopforge_status` views use. `sessionId` names the live session
only; use it for live controls (`loopforge_stop`, `loopforge_pause`). The
handle bundles the session, the logical round, and the exact held attempt.
Pass it **unchanged** to every `loopforge_next`, `loopforge_checkpoint`, and
`loopforge_gate_check`. A rejection keeps the round but rebinds the attempt and
returns a new handle; an invalid evaluation keeps the same handle. An old
handle never submits work.
If only the `submissionHandle` was lost while the current prompt is still in
context, call `loopforge_status` with the live `sessionId` or durable `loopId`.
It returns the current handle without re-delivering the prompt. If the prompt
was also lost, or status reports no live session or no current handle, call
`loopforge_resume` with the `loopId`; resume rebuilds the session and re-delivers
the held prompt. Never edit or reconstruct a handle.

| ID | Lifetime | Use |
| --- | --- | --- |
| `loopId` | Durable Vault identity; survives a restart | `loopforge_resume`, `loopforge_status` views session/loop/audit/explain, duplicate-loop checks, live-session handle re-anchor |
| `sessionId` | Live session key in the current process; `loopforge_resume` rebuilds it | `loopforge_stop`, `loopforge_pause`, `loopforge_status` view=session |
| `submissionHandle` | The exact held attempt; changes after a rejection | `loopforge_next`, `loopforge_checkpoint`, `loopforge_gate_check`; re-anchor a lost one with `loopforge_status` |

If a call returns `session_not_found`, the process restarted or the live session
is gone: call `loopforge_status` with `view: "all"`, take the matching `loopId`,
and either re-anchor with `loopforge_status` (if the prompt is still in context
and a live session now exists) or call `loopforge_resume` with that `loopId`.
Status is read-only and cannot re-deliver a lost prompt. Do not start a new loop
for the same objective. If `loopforge_resume` returns `legacy_history`, the loop
is read-only; start a new loop with a new `loopId`.

A paused or stalled session may still show a `submissionHandle`; submissions are
refused until `loopforge_resume` unpauses or retries the session.

## What is a round?

A round is one coherent work slice with one before/after evidence boundary: it
can be described, checked, and disposed of at that boundary. It is not a fixed
number of files, tokens, commits, or minutes, and it is not an Agent invocation,
session, checkpoint, or elapsed-time interval.

A completed slice is not the same as a completed task.

The runtime division and submission rules are not restated here. Every prompt
carries them in `## Round Boundary`, and the MCP server instructions carry the
host contract; those two are the only executable sources.

## Execute a round

1. Execute the returned prompt and do the repository work.
2. Use the tools and reasoning approach that fit the slice.
3. Check actual evidence before claiming success.
4. Submit one honest structured evaluation for the held attempt with
   `loopforge_next`, using the current `submissionHandle`. An invalid
   submission is corrected on the same handle and does not increment the
   attempt; only an enforcement rejection does.

After the strict boundary accepts the payload, LoopForge collects before/after
evidence, runs the verification gate, then the enforcement gate, and applies one
disposition: accept, reject, backtrack, or terminate.

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

Use `submission_guidance` for the current applicability and exact shape of
every field; `references/evidence-and-contracts.md` groups the optional fields
conceptually. Reports and claims are not machine evidence. A criterion claim is
advisory, while a contract item becomes verified only from its configured
machine observations. A worker's discoveries remain a report until the main
Agent promotes a finding through top-level `discovered_constraints`.

`execution_report.files_changed` is the **boundary net change**: paths whose
content or file type differs between round preparation and this submission,
including deletions. A commit alone adds no entry when content is unchanged. Do
not list gitignored paths merely to look complete. The receipt's
`files_reconciliation` block compares your report with the machine change set
and reports match/mismatch/unknown/not_applicable; an unobservable Git boundary
is `unknown`, never an empty diff.

`emerged_subtasks` is the only sub-goal creation channel. It contains plain
descriptions, never `sg-` IDs. `subgoal_updates` changes existing active IDs;
done and canceled are terminal and cannot be reopened. The prompt or
`submission_guidance` renders the real active IDs; never invent one.

`outcome` may be `success`, `partial`, `failed`, or `blocked`. A blocked
outcome needs a concrete `blocker`; `agent_stop_reason` of `blocked` or
`needs_human_input` also stops without claiming success. It is the Agent's
report, never LoopForge's terminal reason.

Optional malformed values are diagnosed and normalized or dropped. The strict
exceptions are `subgoal_updates`, `round_contract`, and
`execution_report.contract_item_claims`. Shape, reference, duplicate, command,
and workspace-containment errors return `evaluation_invalid` or
`contract_invalid` before advance. Correct the payload and resubmit with the
same handle; the invalid attempt is not persisted and no rejection counter
moves. `projection_incomplete` is different: it reports a LoopForge projection
defect, not poor Agent work.

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
item ids/statuses, active sub-goal ids, real criterion ids/text, usable commands
and the fields that apply now. Treat it as the authoritative shape for the
current submission, rather than copying examples from an older prompt. Each
submission returns `submission_receipt`, which separates reports that were
saved, derived state that actually changed, and machine verification results,
plus the structured `files_reconciliation` block. A report marked `saved` is
not a verified fact. The receipt is read-only feedback for this submission; it
is never a later prompt's independent fact source.

## Interpret results

- Non-null `prompt`: execute it and submit the next evaluation with the
  `submissionHandle` returned alongside it.
- `enforcementAction: "reject"`: retry the same logical round with the
  **new** handle; the attempt increases. Follow the returned context strategy:
  `same_round_retry` keeps the original invocation; `fresh_invocation` with
  `rejection_escalation` starts a clean invocation for the same logical round.
  Prompt density does not choose between them. The old handle only
  returns the current retry prompt with a warning. A retry prompt may carry the
  rejected attempt's transient Machine Evidence, explicitly marked
  `not committed`.
- `enforcementAction: "backtrack"` (machine) or `"recovery"` (Agent):
  LoopForge already restored and verified the workspace. Execute the held redo
  prompt and submit with its new handle. If the response instead is `stalled`
  with `restore_failed`, call `loopforge_resume` to retry the same pending
  directive.
- A post-commit compile failure or another stalled result with no prompt is
  recovered with `loopforge_resume`. If only the handle was lost while the
  prompt is still in context, use `loopforge_status` instead. Do not resubmit
  an old handle.
- Null `prompt`: read `stopReason` (LoopForge's terminal reason),
  `sessionStatus` (a live session condition such as `paused`/`stopped`/
  `stalled`, not a terminal reason), and `agentStopReason` (the Agent's own
  report). `stopDetail` renders the Agent report, the LoopForge decision and
  the Machine evidence as separate fact blocks.
- After a loop is stopped, `loopforge_status` with its `loopId` returns the
  committed terminal facts read-only (`status`, `loopStopReason`,
  `last_submission`) without resuming or reopening it. A manual
  `loopforge_stop` reports `loopStopReason: cancelled` in that response only;
  because it is not a committed round fact, later status/resume report "no
  committed terminal reason".

Read `submission_guidance` before composing the next evaluation, and read
`agentSuccessClaim`, `agentOutcome`, `agentStopReason`, `agentShouldContinue`,
`evidencePosture`, `level`, `warnings`, and `enforcementReason` before planning
the next slice.
The Agent's claim and the machine posture are separate: `evidencePosture.status`
is evidence coverage, not task success, and
`evidencePosture.machineBackedSuccess` is only the verification gate's fact. In
`submission_receipt.verification`,
`evidence_posture` is the ONE persisted posture; do not read "no active
contract" as "verified". `submission_receipt.reports` distinguishes a saved
report from derived state that changed and from a machine verification result;
`not_applied` means the submission did not become history.

Errors use `{ok: false, error: {code, message, retryable, ...}}`. Branch on the
stable `code`, not the prose in `message`. `evaluation_invalid`,
`contract_invalid`, `policy_invalid`, and `submission_handle_required` are
retryable with a corrected payload/current handle. `submission_handle_mismatch`
means the handle no longer names the held attempt: a `loopforge_next`/`recover`
response re-delivers the current prompt and handle; if the prompt was lost, use
`loopforge_resume`. `session_not_found`, `state_unavailable`, and `gate_disabled`
describe state or policy; do not blindly resubmit.

`completed` is the loop lifecycle result of your stop declaration passing the
existing gates: `success` plus every active contract item `verified`, or no
active contract. It is not a machine-verified task-success verdict; terminal
output reports it as `loop_stop_reason` in the LoopForge decision block and
renders the persisted posture separately in the Machine evidence block.
Explicit `blocked` always wins over success. `incomplete` means you stopped
without machine closure. Other terminal reasons include `failed`, `max_rounds`,
`stalled`, `enforcement_terminated`, and `cancelled`. `paused` is a session
status, not a committed loop reason. `loopforge_stop` returning `success: true`
means the tool call succeeded, not that the task was achieved.

## Avoid these mistakes

- Do not start a new round for each file, command, test, commit, or elapsed
  time interval.
- Do not treat a rejection attempt as a new round or submit it under a new
  handle other than the one the rejection returned.
- Do not fill optional fields to satisfy a checklist; report only events that
  actually occurred.
- Do not create a contract when no configured command can verify it.
- Do not turn criteria into a function/implementation checklist; keep them at
  acceptance granularity and use sub-goals for the execution plan.
- Do not create a sub-goal just to fill `emerged_subtasks`; zero is correct
  when the current criteria/contract already cover the work.
- Do not treat a receipt, state file, or agent report as committed machine
  evidence.
- Do not continue coding after backtrack until the restore boundary is in place.
- Do not continue after `prompt: null` without interpreting `stopReason`.

## Rules

1. Execute the prompt instead of generating another prompt.
2. Submit one honest structured evaluation after each completed work slice;
   correct rejected submissions under the same handle.
3. Treat required command evidence and verification findings as authoritative.
4. Restore the workspace before working after backtrack.
5. Keep one loop focused on one user objective.
6. Do not advance a paused or stopped session through another process.
7. Continue in the same Agent task when possible. LoopForge preserves state but
   does not create a background Agent.

## References

Read these only when the slice needs the detail; field applicability, legal
shapes, real ids, and usable commands always come from the live
`submission_guidance`.

- [`references/evidence-and-contracts.md`](references/evidence-and-contracts.md):
  Round Contract proposal/transition, IDs, item status and closure, evidence
  commands, entrypoint trust, and scope drift. Read before proposing or
  redirecting a contract, or relying on a verification command.
- [`references/recovery-and-views.md`](references/recovery-and-views.md):
  backtrack/Agent recovery, checkpoint authority, pending restore, prompt
  levels, read-only views, the optional gate, worker reports, and the derived
  state file. Read
  before requesting recovery/backtrack, interpreting L0/L1/L2, or using
  status/replay/audit/explain/gates.
