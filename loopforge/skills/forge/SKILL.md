---
name: forge
description: "LoopForge user manual: drive multi-round coding tasks through LoopForge MCP so objectives, constraints, evidence, and decisions survive context loss and restarts. The external Agent remains responsible for planning, file changes, tools, and execution. Not for one-pass edits."
when_to_use: "多轮任务, 长任务, 上下文压缩, 上下文丢失, 断点续跑, 会话恢复, 可审计过程, 机器验证, 漂移, 回滚, LoopForge, long-running coding task, multi-round, context loss, resume, machine-verified, auditable evidence, backtrack, drift"
dispatch_intent: "Drive long-running coding work through LoopForge so it survives restarts and is machine-verified round by round"
---

# Forge

Use this skill when work needs more than one verified boundary. It is the
operating guide for LoopForge MCP; it does not replace the MCP server instructions,
the prompt's `## Round Boundary`, or live `submission_guidance`.

## When to use

Use Forge when the task needs several meaningful slices, must survive a restart
or context loss, carries constraints or acceptance criteria across rounds, or
needs machine-backed observations and an auditable record of rejection,
recovery, drift, or approval. Do not use it for a one-pass edit, a question, or
a task that finishes in one verified pass.

LoopForge has one factual source: committed typed round documents in the Vault.
Canonical State is compiled from those documents and is the cognitive source.
Prompts, receipts, state files, replay, audit, and explain are projections; do
not treat them as a second ledger. The Agent still owns meaning, planning,
tool use, edits, tests, and the choice to request recovery.

## Round lifecycle

Keep these boundaries separate:

- A **logical round** is one coherent work slice with one before/after evidence
  boundary.
- An **attempt** is a submission for that round. An enforcement rejection
  increases the attempt but does not create round history; an invalid payload
  has no lifecycle side effects.
- A **Round Contract** is an optional proposal for the next bounded,
  machine-checkable slice. It is not a second plan ledger and does not decide
  the current round boundary. With an enabled after-capable command, a
  continuing round with a successor available must leave an active contract.
- A **workspace checkpoint** is recovery material: an automatic before-image or
  an explicit `loopforge_checkpoint` savepoint. It is not progress or history.

```text
prepared prompt -> Agent works -> loopforge_next(handle, evaluation | recovery)
                                   |-- invalid payload: same handle, no state change
                                   |-- reject: same round, new attempt and handle
                                   |-- accept/continue: commit and prepare next round
                                   |-- stop: commit the final round/evidence
                                   |-- recovery/backtrack: restore and verify, then redo
```

LoopForge owns persistence, evidence collection, validation, and disposition.
The Agent owns the work and the semantic decisions.

## Context and continuity

Every prompt that holds a round declares `contextMode`, `contextReason`, and a
human-readable strategy label. Follow those values together:

```text
Context: clean context — next round (fresh_invocation; workspace continues)
Context: clean context repair (fresh_invocation; rejection_escalation; same logical round; rejected posture is attempt-time only)
Context: clean context repair + invocation recovery (fresh_invocation; invocation_recovery; same logical round; retry lessons carried)
Context: in-context repair (same_round_retry; enforcement_retry; continue original invocation if alive; lessons injected)
Context: clean context after restore (fresh_invocation; recovery_redo; lessons carried)
```

- `fresh_invocation` starts a new model conversation without the prior
  transcript, tool outputs, or uncommitted reasoning. It does not restart the
  host — it is not a host-runtime restart requirement — or reset the workspace:
  the same loop/session identity and modified workspace continue. Continuity
  comes from the prompt's committed projection and any explicitly carried retry
  or recovery lessons.
- `same_round_retry` is in-context repair below the repeated same-check
  rejection threshold. Continue the original invocation if it exists; the
  rejection notice and findings are already provided. If it is gone, call
  `loopforge_resume(loopId, invocationLost: true)` and use the resulting
  `fresh_invocation / invocation_recovery` prompt for the same round and
  attempt.

Rejection escalation, recovery redo, and invocation recovery use a new model
conversation. Prompt density (`L0`, `L1`, `L2`) is independent of this
boundary. Stable MCP material (`initialize` instructions, `tools/list` schemas,
and installed skill files) may stay warm; LoopForge does not manage provider
caches or implicit model habits. Read the prompt and
`references/recovery-and-views.md` when the distinction matters.

Working Memory is bounded, derived from committed branch history and rollback
directives, and report-only. Machine Evidence is a separate protected
projection. Neither is an independent history; Agent reports never become
machine evidence.

## Start or resume

1. Call `loopforge_status` with `view: "all"`.
2. If an existing loop covers the objective, resume it; do not start a second
   loop for the same objective.
3. Otherwise call `loopforge_start` with the complete `task`, initial
   `criteria`, hard `constraints`, and any applicable `maxRounds`, `loopId`, or
   `planSource`. The live tool schema is authoritative.

Keep the returned identifiers:

| ID | Lifetime | Use |
| --- | --- | --- |
| `loopId` | Durable Vault identity | `loopforge_resume`, durable status views, replay, explain |
| `sessionId` | Live process session | stop, pause, and live session controls |
| `submissionHandle` | Exact held round/attempt | `loopforge_next`, `loopforge_checkpoint`, `loopforge_gate_check` |

Pass `submissionHandle` unchanged. A rejection returns a new handle; an invalid
evaluation keeps the same one. A stale handle has no side effects. If only the
handle is lost, re-anchor it with `loopforge_status`; if the prompt or live
session is gone, use `loopforge_resume` with the durable `loopId`. A paused or
stalled session must be resumed before submission.
Stopped and legacy loops are read-only; status and replay do not reopen them.

`currentUserInstruction` on `loopforge_next` or `loopforge_resume` is input for
that invocation only. It never rewrites the task, objective, criteria,
constraints, Round Contract, or goal identity. Never infer it from an older
transcript.

## Execute a round

1. Execute the returned prompt and do the work in the workspace.
2. Check actual workspace and configured command evidence before claiming
   success.
3. Submit exactly one evaluation or one Agent-requested recovery with the
   current handle. They are mutually exclusive.

The required evaluation fields are:

| Field | Meaning |
| --- | --- |
| `outcome` | `success`, `partial`, `failed`, or `blocked`; `success` and `blocked` require `should_continue=false`, and `blocked` requires a non-empty `blocker`. |
| `output_summary` | What changed and what was verified this round. |
| `constraint_violations` | Real violations, preferably using rendered `c-*` ids. |
| `should_continue` | Whether the Agent requests a successor round; false only when the objective is complete or the Agent must stop. |

A completed slice does not necessarily complete the whole task.

Optional fields are event-driven reports, not a checklist. Read the current
`submission_guidance` for applicability, real ids, legal shapes, and usable
commands. Omit fields for events that did not happen. In particular:

- `execution_report.files_changed` is the net workspace change from round
  preparation, including deletions; a commit alone is not a file change.
- There is no Agent-reported test count. Configured command observations are
  the test facts.
- `execution_report.claims` is the single claims channel. Claims cite rendered
  criterion or active contract-item ids, but a claim alone verifies nothing.
- Never invent ids; use only ids rendered in the prompt or guidance. Unknown or
  unavailable observations stay unknown, never a pass or an empty change set.
- `no_change_reason` is allowed only when no verification command is configured;
  it does not create evidence. Agent reports and receipts are not evidence.

Use the evidence and contract reference before proposing or redirecting a Round
Contract. Use the recovery reference before requesting recovery, interpreting
backtrack, or relying on prompt-level details. A recovery request is an action,
not an evaluation; LoopForge restores and verifies the target before issuing
the redo prompt. Never restore the workspace yourself after backtrack.

## Interpret results

- A non-null `prompt` is the next held work slice; execute it and submit with
  the returned handle.
- `enforcementAction: "reject"` keeps the logical round and returns a new
  handle. Follow its context strategy; never resubmit the old handle.
- `enforcementAction: "backtrack"` or Agent `recovery` with a non-null `prompt`
  means LoopForge restored and verified the workspace; continue only from the
  new redo prompt. A failed restore returns no prompt, keeps the directive
  pending, and is retried with `loopforge_resume`.
- A stalled result with no prompt is handled with `loopforge_resume`; use
  `loopforge_status` only to re-anchor a handle when the prompt is still live.
- When `prompt` is null, read `stopReason`, `sessionStatus`, and the Agent's
  stop facts. `completed` is a lifecycle result of the Agent's stop declaration
  passing the configured gates; it is not machine-verified task success.

Read `submission_receipt.verification.evidence_posture` for the persisted
Machine Evidence and `machineBackedSuccess` for the verification gate's single
machine-backed success fact. Keep it separate from `agentOutcome`,
`agentSuccessClaim`, and `agentShouldContinue`.

Errors are structured. Branch on `error.code`, not message prose. Correct
retryable `evaluation_invalid`, `contract_invalid`, `policy_invalid`, or handle
errors with the current handle. Do not blindly resubmit for
`session_not_found`, `state_unavailable`, or `gate_disabled`.

## Rules to keep

- Keep one loop focused on one user objective; do not create a round for every
  file, command, test, commit, or elapsed interval.
- Use the handle returned for the current attempt and never edit or reconstruct
  it.
- Report only events that happened; do not fill optional fields for coverage.
- Do not invent a contract when no configured command can verify it.
- Do not treat a receipt, state file, or Agent report as committed evidence.
- Restore the verified boundary before continuing after backtrack.
- Do not continue after `prompt: null` without interpreting the stop facts.

## References

Read these only when the current slice needs the detail. The live
`submission_guidance` remains authoritative for field applicability, legal
shapes, real ids, and usable commands.

- [`references/evidence-and-contracts.md`](references/evidence-and-contracts.md):
  Round Contracts, item closure, evidence commands, ids, and Agent/operator
  judgment boundaries.
- [`references/recovery-and-views.md`](references/recovery-and-views.md):
  recovery and backtrack, checkpoint authority, prompt levels, read-only views,
  gates, delegation, and the derived state file.
