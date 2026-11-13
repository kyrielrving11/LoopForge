# Recovery, Prompt Levels, and Read-Only Views

This reference explains concepts and flows. The live prompt,
`submission_guidance`, and the `tools/list` schema are authoritative for
applicability, legal shapes, real ids, limits, and usable commands. This file
is not a second rule set.

## Backtrack and Agent recovery

LoopForge can trigger a machine backtrack when a configured rule requires it.
The Agent may also deliberately abandon the current branch by submitting a
top-level `recovery` instead of an `evaluation`, using the current
`submissionHandle`. The live tool schema states the required fields.

Recovery is an action, not an evaluation. It is not a success claim, and the
target is recovery material rather than proof of progress. LoopForge commits
the rollback directive, executes the restore itself, verifies the complete Git
boundary and recorded HEAD, then compiles the redo prompt. A failed restore
leaves the directive pending and the session stalled; `resume` retries the same
directive. A restore is not round progress and never satisfies a redo-time
verification check.

When a backtrack occurs, read the protected Recovery Brief and the current
prompt. Do not restore the workspace yourself: LoopForge already did, and
running git reset/stash/checkout would move outside the verified target. The
redo prompt is already compiled from the verified post-restore baseline; submit
its work and evidence with the new `submissionHandle` returned with it. Do not
repeat a failed approach without addressing its cause; carry valid discoveries
into the redo evaluation.

If the rolled-back work used an active contract, follow the Recovery Brief and
live `submission_guidance` for that contract. Do not blindly restate or replace
it; a successor proposal is subject to the same contract lifecycle.

## Workspace checkpoints

A workspace checkpoint is recovery material, not history. Its authority is the
`CheckpointRef` inside a transaction snapshot; the content-addressed manifest
and blobs hold only what HEAD cannot reproduce.

- The before-image is captured automatically when a round is prepared.
- `loopforge_checkpoint` creates an explicit mid-round savepoint. The call is
  the Agent's decision that this state is worth restoring to.
- A checkpoint creates no round, no commit, and no progress. It is visible as a
  recovery target only through the held transaction's ref list.
- A successful checkpoint leaves the `submissionHandle` unchanged.
- Checkpoints never feed Canonical State, prompts, acceptance, progress, or
  stall.

The live tool schema and migration rules own idempotence, caps, and manifest
validation. Do not infer them from this concept page.

## Prompt levels

L0, L1, and L2 select prompt density only; they never control which evaluation
fields you may use. Each density can accompany a clean-context model
conversation or an in-context retry. Read the prompt header's `contextMode`,
`contextReason`, and strategy label, plus its `## Round Boundary` section and
the MCP server instructions. This reference does not restate those rules.

The optional `currentUserInstruction` on `loopforge_next` / `loopforge_resume`
is invocation input: it is rendered in the prompt and recorded in that prompt's
artifact, and never rewrites the task, Objective, criteria, constraints, or
Round Contract. Omitting it makes the prompt say it was not provided; never
infer it from an old task or transcript.

Every level renders the same protected normative set: active criteria, every
active constraint, the active contract and its items, every active sub-goal id,
every current verification finding, and the committed recovery brief. Display
caps may shorten descriptions but never remove ids. If a protected active id is
missing, LoopForge fails closed with `projection_incomplete` instead of
delivering a partial prompt. The delivered prompt equals the compiled
`renderedPrompt` on every path.

A clean-context (`fresh_invocation`) prompt may render a bounded **Working
Memory** section derived from committed history. Working Memory is optional but
indivisible: if it cannot fit, it is dropped whole, and the artifact records
`rendered:false` with source/rendered/omitted counts. Every omission has a
deterministic abbreviation notice. It declares no normative ids and never
changes coverage, level, freshness, gates, or success. A `same_round_retry`
renders neither Working Memory nor Machine Evidence; it relies on the rejection
notice and Verification Gate. A fresh retry may render the previous committed
posture plus the rejected attempt's transient, explicitly `not committed`
posture. The live prompt and artifact state which sections actually rendered;
this reference does not restate windows, caps, or ceilings.

## Read-only views

Use these to inspect, never to advance:

- `loopforge_status` `view: "session"`: live session status, current round, the
  current held `submissionHandle`, machine-backed success trajectory,
  evidence posture, checkpoints, capability, current guidance, and the latest
  committed receipt. Accepts the live `sessionId` or durable `loopId`. A
  persisted STOPPED loop is readable by `loopId` without resuming. A
  running/paused/stalled loop without a live session means call
  `loopforge_resume`. It never returns the held prompt.
- `loopforge_status` `view: "loop"`: committed health counts.
- `loopforge_status` `view: "all"`: every persisted loop summary.
- `loopforge_status` `view: "audit"`: end-of-loop verification completeness.
- `loopforge_status` `view: "explain"` (with `round`): the per-round "why" view
  over committed facts, including the committed report, context boundary,
  assumptions, open questions, blocker, persisted evidence posture, command
  observations, checkpoints and restore marker, and rollback digest facts.
- `loopforge_replay`: committed round timeline and diffs. The live tool schema
  states the accepted window. Each round carries its attempt, context mode and
  reason, outcome, bounded report, wrong assumptions, retracted constraints,
  open questions, blocker, and contract redirect. Legacy envelope rows stay
  visible instead of disappearing.

The optional `.loopforge/state/<loopId>-state.md` is derived and regenerable.
Read it when the prompt points to it, but never treat it as a second source of
truth: committed typed rounds are authoritative, the file's Agent-reported
summaries are claims, and a state hash that differs from the prompt header
means the file is stale. Re-align with status or resume.

## Gates and delegation

The gate tools are opt-in through `policy.gate.enabled`. When enabled, use the
live tool schema for `loopforge_gate_check` and `loopforge_gate_resolve`: the
check preflights an action and never executes or approves anything; the resolve
records a human decision. Present the approval question, then cite the approved
gate id where the evaluation schema asks for it. LoopForge records the process
but cannot prove a human was present because the Agent submits the resolve
call.

Delegation does not create another LoopForge mode. Give each worker a
self-contained subtask and hard constraints, then place the result in the
evaluation's worker-results field. The result is saved with the committed
transaction as an audit report. It does not enter the global constraint set by
itself. If you accept a worker's finding, state it in top-level
`discovered_constraints`; that is the only promotion channel. The live
`submission_guidance` states the current legal shape.
