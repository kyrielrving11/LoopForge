---
name: forge
description: "LoopForge user manual: drive multi-round coding tasks through LoopForge MCP so objectives, constraints, evidence, and decisions survive context loss and restarts. The external Agent remains responsible for planning, file changes, tools, and execution. Not for one-pass edits."
when_to_use: "多轮任务, 长任务, 上下文压缩, 上下文丢失, 断点续跑, 会话恢复, 可审计过程, 机器验证, 漂移, 回滚, LoopForge, long-running coding task, multi-round, context loss, resume, machine-verified, auditable evidence, backtrack, drift"
dispatch_intent: "Drive long-running coding work through LoopForge so it survives restarts and is machine-verified round by round"
---

# Forge

Use this skill when work needs more than one verified boundary. It is a pointer
manual: the MCP server instructions, the live prompt (including
`## Round Boundary`), the `initialize`/`tools/list` schemas, and the per-round
`submission_guidance` are authoritative. This file defines terms and routes; it
does not restate executable rules.

## When to use

Use Forge when work needs several meaningful slices, must survive a restart or
context loss, carries constraints or acceptance criteria across rounds, or
needs machine-backed observations and an auditable record.

LoopForge has one factual source: committed typed round documents in the Vault.
Canonical State is compiled from those documents and is the cognitive source.
Prompts, receipts, state files, replay, audit, and explain are projections. The
Agent owns meaning, planning, tools, edits, tests, and the choice to recover.

## Round lifecycle definitions

Keep these boundaries separate:

- A **logical round** is one coherent work slice with one before/after
  boundary.
- An **attempt** is a submission for that round. An enforcement rejection
  increases the attempt but does not create round history; an invalid payload
  has no lifecycle side effects.
- A **Round Contract** is an optional proposal for the next bounded,
  machine-checkable slice. It is not a second plan ledger and does not decide
  the current round boundary.
- A **workspace checkpoint** is recovery material: an automatic before-image or
  an explicit `loopforge_checkpoint` savepoint. It is not progress or history.

```text
prepared prompt -> Agent works -> loopforge_next(handle, evaluation | recovery)
  invalid: same handle, no change | reject: new attempt/handle | accept: commit
  stop: final commit | recovery: restore, verify, then redo
```

LoopForge owns persistence, evidence, validation, and disposition.

## Context and continuity

Every prompt declares `contextMode`, `contextReason`, and a strategy label in
its header. Read them with the prompt's `## Round Boundary`; do not infer the
boundary from prompt size or an older transcript.

- `fresh_invocation` starts a new model conversation. It is not a host-runtime
  restart requirement and not a workspace reset: the same loop/session identity
  and modified workspace continue. Continuity comes from the prompt's committed
  projection and any explicitly carried retry or recovery lessons.
- `same_round_retry` is in-context repair. Continue the original invocation if
  it exists; the rejection notice and findings are already in the prompt. If
  that invocation is gone, use the route stated in the prompt's
  `## Round Boundary` section.

Prompts render bounded **Working Memory** separately from **Machine Evidence**.
Both are projections, not independent history: Agent reports are claims, and
Machine Evidence is a machine observation. Read the live labels in the prompt;
read `references/recovery-and-views.md` for the concepts.

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

Pass `submissionHandle` unchanged; the live prompt, `submission_guidance`, and
tool schema state the current handle rules. If only the handle is lost, re-anchor
it with `loopforge_status`; if the prompt or live session is gone, use
`loopforge_resume` with the durable `loopId`. Stopped and legacy loops are
read-only.

`currentUserInstruction` is invocation input only; it never rewrites the task,
objective, criteria, constraints, contract, or goal identity. The live prompt
and tool schema state its scope. Never infer it from an older transcript.

## Execute a round

1. Execute the returned prompt and do the work in the workspace.
2. Check actual workspace and configured command evidence before claiming
   success.
3. Submit exactly one evaluation or one Agent-requested recovery with the
   current handle. They are mutually exclusive.

The prompt's `## Round Boundary` and live `submission_guidance` define required
fields, applicability, real ids, legal shapes, and usable commands. Read them
before submitting. Include an optional field only when its event happened; a
claim alone never verifies anything, and only machine observations do. Never
invent an id.

Use the evidence/contract reference before proposing or redirecting a contract,
and the recovery reference before requesting recovery or interpreting a
backtrack. Recovery is an action, not an evaluation; LoopForge restores and
verifies the target before issuing the redo prompt. Never restore the workspace
yourself after backtrack.

## Interpret results

- A non-null `prompt` is the next held slice; execute it and submit with the
  returned handle.
- Branch on the structured `error.code`, not message prose. `enforcementAction`,
  `recovery`, `stopReason`, and `sessionStatus` are live result facts.
- `submission_receipt.verification.evidence_posture` carries persisted Machine
  Evidence; `machineBackedSuccess` is the gate's single machine-backed success
  fact. Keep both separate from `agentOutcome`/`agentSuccessClaim`.
- `completed` is a lifecycle result, not universal proof of correctness.

## References

Read these only when the current slice needs the detail. The live prompt,
`submission_guidance`, and `tools/list` schema remain authoritative.

- [`references/evidence-and-contracts.md`](references/evidence-and-contracts.md):
  contract concepts, item closure, evidence commands, ids, judgment boundaries.
- [`references/recovery-and-views.md`](references/recovery-and-views.md):
  recovery/backtrack, checkpoints, prompt density, views, gates, delegation.
