# Recovery, Prompt Levels, and Read-Only Views

This reference explains concepts and flows. The live `submission_guidance`
remains the only source for field applicability, legal shapes, real ids, and
usable commands.

## Backtrack and Agent recovery

A progress stall requires observable Git history over the lookback window. Only
the Git workspace coverage participates: a custom evidence provider's
changed/unknown facts are recorded and displayed but cannot prevent a stall or
keep the prompt at L1. Committed work counts as motion through the Git HEAD
change, even when the closing worktree is clean, and the round you are
submitting counts too: if it moved files or committed, it cancels the verdict.
If machine history cannot be read, no stall verdict is made.

LoopForge can trigger a machine backtrack when a rule requires it. The Agent may
also abandon the current branch deliberately by submitting a top-level
`recovery: { target_checkpoint_id, reason }` instead of an `evaluation`, using
the current `submissionHandle`.

Recovery is an action, not an evaluation:

- it requires none of the four core evaluation fields;
- it requires the current handle and a non-empty reason;
- the target must resolve to a checkpoint ref visible through the held
  transaction or a committed evaluation transaction on the current branch;
- error-level verification findings on the target round do not disqualify it,
  because it is recovery material, not a success claim;
- the reason is recorded verbatim and rendered in the Recovery Brief as
  report-only text, never as a LoopForge instruction.

LoopForge commits the rollback directive, executes the restore itself, verifies
the complete Git fingerprint boundary and recorded HEAD, then compiles the redo
prompt. A failed restore leaves the directive pending, sets the session to
`stalled`, and `resume` retries the SAME directive. The directive survives the
redo as an audit event. A restore is not round progress and never satisfies a
redo-time verification check.

When backtrack occurs:

1. Read the protected Recovery Brief and the current prompt. Do not restore the
   workspace yourself: LoopForge already did, and re-running git reset/stash/
   checkout would move outside the verified target.
2. The redo prompt is already compiled from the verified post-restore baseline.
   Submit its work and evidence using the new `submissionHandle` returned with
   it.
3. Do not repeat a failed approach without addressing its cause. Carry valid
   discoveries into the redo evaluation.

If the rolled-back work used an active contract, follow the Recovery Brief and
live `submission_guidance` for that contract. Do not blindly restate or replace
it; a successor proposal is subject to the same contract lifecycle rules.

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
- Re-capturing the same state is idempotent; distinct savepoints are capped.
- Checkpoints never feed Canonical State, prompts, acceptance, progress, or
  stall.

## Prompt levels

L0, L1, and L2 select prompt density only. They never control the set of
evaluation fields you may use.

- **L0** is a same-round retry, or a committed failed round whose freshness
  derivation proves no machine activity and no declared evolution.
- **L1** is normal continuation.
- **L2** is boundary rehydration: first round, plan/checkpoint boundary, deep or
  shallow committed recovery, machine contradiction, or repeated rejection.

An unobservable boundary stays L1; unknown machine activity never downgrades to
L0. L2 is not a round-count timer.

Every level renders the same protected normative set: active criteria, every
active constraint, the active contract and all its items, every active sub-goal
id, every current verification finding, the committed recovery brief, and the
previous committed round's **Machine Evidence**. Display caps may shorten
descriptions but never remove ids. If a protected active id is missing,
LoopForge fails closed with `projection_incomplete` instead of delivering a
partial prompt. The delivered prompt equals the compiled `renderedPrompt` on
every path.

A `fresh_round` prompt may render a bounded **Working Memory** section derived
from committed history. L1 and L2 render the same full fixed projection: up to
five reports, eight assumptions, six open questions, three recoveries and
three contract redirects, with per-item text limits. L0 stays compact (one
report, two assumptions, two questions, one recovery and one redirect). The
underlying source window is five committed rounds for reports, assumptions,
questions and redirects; recovery directives have their own fixed limit. These
limits are code constants, not policy. The default whole-prompt ceilings are
5,000 / 50,000 / 100,000 characters for L0 / L1 / L2. They are safety ceilings,
not routine targets for memory omission.

Working Memory is optional but INDIVISIBLE: if it cannot fit, it is dropped
whole, and the artifact records `rendered:false` with source counts. Every
omission has source/rendered/omitted counts and a deterministic abbreviation
notice. It declares no normative ids and never changes coverage, level,
freshness, gates or success. An L0 `same_round_retry` renders none; it relies on
the rejection notice and Verification Gate. An L2 rehydrate retry is
`fresh_round` and may render the previous posture plus the rejected attempt's
transient, explicitly `not committed` posture. The state file carries the full
fixed Working Memory window.

## Read-only views

Use these to inspect, never to advance:

- `loopforge_status` `view: "session"`: live session status, current round,
  the current held `submissionHandle`, `machineBackedSuccessTrajectory`,
  `evidencePosture`/`machineBackedSuccess`, checkpoints, capability, current
  guidance, and the latest committed receipt. Accepts the
  live `sessionId` or the durable `loopId`. It never returns the held prompt: a
  null handle, a missing live session, or a lost prompt means call
  `loopforge_resume`. A paused or stalled session may still show its handle, but
  submissions are refused until resume.
- `loopforge_status` `view: "loop"`: committed health counts.
- `loopforge_status` `view: "all"`: every persisted loop summary.
- `loopforge_status` `view: "audit"`: end-of-loop verification completeness.
- `loopforge_status` `view: "explain"` (with `round`): the per-round "why" view
  over committed facts, including the committed report (even without an
  execution_report), context boundary, assumptions, open questions, blocker,
  the persisted `evidencePosture`, full before/after command observations,
  committed checkpoints and restore marker, and rollback digest facts.
- `loopforge_replay`: committed round timeline and diffs. Pass `loopId` (or a
  live `sessionId`) and optional `start` / `end`. With no window it returns the
  last 10 committed rounds; an explicit window may span at most 50 rounds. The
  response includes `window: { start, end, totalRounds, hasBefore, hasAfter }`
  and each round's `attempt`, `context_mode`, `context_reason`, `outcome`,
  bounded `report`, `wrong_assumptions`, `retracted_constraints`,
  `open_questions`, `blocker` and `contract_redirect`. `rollbacks` carries
  `failedRounds`, `approaches` and `wrongAssumptions`. Legacy envelope rows stay
  visible instead of disappearing.
- `loopforge_status` `view: "session"` / `view: "loop"` / `view: "audit"`: live
  and committed health views.

The optional `.loopforge/state/<loopId>-state.md` is derived and regenerable.
Read it when the prompt points to it (current governance + bounded Working
Memory + diagnostic views), but never treat it as a second source of truth:
committed typed rounds are authoritative, the file's Agent-reported summaries
are claims, and a state hash that differs from the prompt header means the file
is stale. Re-align with status or resume.

## Gates and delegation

The two gate tools are opt-in through `policy.gate.enabled`. When enabled:

- `loopforge_gate_check` preflights a structured action with its description,
  scope, effects, reversibility, and authorization. It takes the current
  `submissionHandle` and the action; it never executes or approves anything.
- Classification is conservative: anything not provably safe becomes
  `user_required`.
- Present the approval question, record the decision with
  `loopforge_gate_resolve` (`sessionId` + `gateId`), and cite the approved gate
  id in `evaluation.gate_ids`.
- LoopForge records the process, but cannot prove a human was present because
  the Agent submits the resolve call.
- Safe investigation and dry-runs need no gate.

Delegation does not create another LoopForge mode. Give each worker a
self-contained subtask and hard constraints, then place the result in
`worker_results` with `agentId`, `subTask`, `resultSummary`, and `outcome`.
The result is saved with the committed transaction as an audit report. It does
not enter the global constraint set by itself. If you accept a worker's finding,
state it in top-level `discovered_constraints`; that is the only promotion
channel.
