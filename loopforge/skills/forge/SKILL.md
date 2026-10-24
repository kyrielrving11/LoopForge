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
  evaluation's `compression_checkpoint`, which is only an Agent declaration /
  L2 boundary reason.

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

## Start

Call `loopforge_status` with `view: "all"` before starting. Reuse an existing
session for the same objective instead of opening a second loop.

Call `loopforge_start` with:

- `task`: the complete user objective;
- `criteria`: the initial success criteria, each becoming a stable `cr-*`
  anchor rendered in every prompt (omit to keep the default criterion);
- `constraints`: hard boundaries that must survive every round;
- optional `maxRounds`, `domain`, `loopId`, and `planSource`.

Keep the returned `sessionId` and `submissionHandle`. The handle bundles the
session, the logical round, and the exact held attempt. Pass it **unchanged** to
every `loopforge_next`, `loopforge_checkpoint`, and `loopforge_gate_check`. A
rejection keeps the round but rebinds the attempt and returns a new handle; an
invalid evaluation keeps the same handle. An old handle never submits work.
If the response was lost, call `loopforge_status` or `loopforge_resume` to fetch
the current handle; never edit or reconstruct it.

## What is a round?

A round is one coherent work slice that can be described, checked, and disposed
of at the next boundary. It is not a fixed number of files, tokens, commits, or
minutes. A capable Agent may complete a large change in one round when the
change shares one objective, one evidence story, and one recovery path. Split
it when those boundaries diverge.

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
together. Make it smaller when uncertainty, external effects, evidence gaps, or
rollback risk is high. Do not combine independent objectives merely because the
Agent can edit them in one context. Do not split a single atomic change only to
create more round records.

At the end of a round, inspect the actual diff, relevant tests, hard
constraints, and remaining work. A completed slice is not the same as a
completed task.

## Execute a round

1. Execute the returned prompt and do the repository work.
2. Use the tools and reasoning approach that fit the slice.
3. Check actual evidence before claiming success.
4. Submit exactly one honest structured evaluation attempt with
   `loopforge_next`, using the current `submissionHandle`.

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
Agent promotes a finding through the supported top-level field.

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
outcome needs a concrete `blocker`; `stop_reason` of `blocked` or
`needs_human_input` also stops without claiming success.

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
  **new** handle; the attempt increases. The old handle only returns the
  current retry prompt with a warning.
- `enforcementAction: "backtrack"` (machine) or `"recovery"` (Agent):
  LoopForge already restored and verified the workspace. Execute the held redo
  prompt and submit with its new handle. If the response instead is `stalled`
  with `restore_failed`, call `loopforge_resume` to retry the same pending
  directive.
- A post-commit compile failure or another stalled result with no prompt is
  recovered with `loopforge_resume`; do not resubmit an old handle.
- Null `prompt`: inspect `stopReason`.

Read `submission_guidance` before composing the next evaluation, and read
`verificationStatus`, `roundSuccess`, `level`, `warnings`, and
`enforcementReason` before planning the next slice. In
`submission_receipt.verification`, `contract_status` is the contract-item
posture and `evidence_status` is the round-level machine evidence posture; do
not read "no active contract" as "verified". `submission_receipt.reports`
distinguishes a saved report from derived state that changed and from a machine
verification result; `not_applied` means the submission did not become history.

Errors use `{ok: false, error: {code, message, retryable, ...}}`. Branch on the
stable `code`, not the prose in `message`. `evaluation_invalid`,
`contract_invalid`, `policy_invalid`, and `submission_handle_required` are
retryable with a corrected payload/current handle. `submission_handle_mismatch`
means the handle no longer names the held attempt: fetch the current prompt and
handle, then resubmit. `session_not_found`, `state_unavailable`, and
`gate_disabled` describe state or policy; do not blindly resubmit.

`completed` means success plus every active contract item is `verified`, or
there is no active contract. Explicit `blocked` always wins over success.
`incomplete` means completion was not machine-verified. Other terminal reasons
include `failed`, `max_rounds`, `stalled`, `enforcement_terminated`, `paused`,
and `cancelled`.

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
  levels, read-only views, gates/delegation, and the derived state file. Read
  before requesting recovery/backtrack, interpreting L0/L1/L2, or using
  status/replay/audit/explain/gates.
