# LoopForge agent instructions

This file is the working contract for agents changing this repository. It holds
only boundaries that the compiler, tests, or source comments cannot enforce.
Behavior is specified by the code, the tests under `loopforge/src/tests/`, and
the typed comments in `loopforge/src/protocol.ts`; read those before changing a
boundary. Do not grow this file with behavior that a test can state instead.

## Non-negotiable rules

- TypeScript only.
- Node.js 18 or newer.
- Zero runtime dependencies.
- The npm package lives in `loopforge/`; its version comes only from
  `loopforge/package.json`.
- Preserve user changes in a dirty worktree.
- Edit `loopforge/src/protocol.ts` before changing protocol fields, then run the
  build to regenerate `loopforge-protocol.json` and `loopforge/dist/`.
- Do not reintroduce removed capabilities: MCP Tasks, prompt-technique routing,
  automatic memory discovery, PromptCraft vault writes, Markdown lineage
  fallback, `LoopProjection`/todo/handoff, automatic phase milestones,
  external-context injection, Agent revision/retraction of operator
  acceptance, `prompt_requests`, `objective_refinement`, custom progress
  snapshots/selectors, the delegation journal, or contract `subgoal_refs`.

## Boundaries

### 1. One factual source, one cognitive source

Committed typed round documents in the Vault are the only factual source.
Compiling never writes the Vault; only `RoundTransactionCoordinator` commits a
round. `CommittedRoundView` is the only history interpretation and
`loadCommittedHistory` the only runtime read path; compile, projections, gates,
audit, explain, replay and metrics share that window. `CanonicalLoopState` is
compiled from it. Work decomposition never comes from a parallel notion of
progress. Replay, Audit, Metrics and Explain are read-only views: they must not
write history or derive an independent rule.

### 2. Stable identity only

Relationships use stable IDs, explicit references, normalized-exact text, or a
content hash. Never reintroduce similarity matching or fuzzy identity.

### 3. Agent reports are claims, never machine evidence

`SelfEvaluation.success`/`outcome`, `execution_report`, `output_summary`,
`open_questions`, `worker_results`, `retroactiveClaims` and `no_change_reason`
are Agent claims. A read surface names them `agentSuccessClaim`/`agentOutcome`
or labels them as reports; it never displays them as machine evidence.

`machineBackedSuccess` has exactly ONE definition and ONE source: the
verification gate's `VerificationResult`, derived from an effective success
claim plus an untampered passed after-phase command. It is persisted only inside
the round's `EvidencePosture`; no consumer re-derives it. `completed` remains
the Agent's stop declaration passing the existing gates, not a machine
verification verdict.

A success claim needs an independent machine observation, normally a passed
after-phase command whose entrypoint and configuration are untampered.
`no_change_reason` is an escape only when no verification command is configured.
A configured provider always records its outcome, including `unavailable`,
`timeout`, `error` and `aborted`; never filter a failed observation out.

### 4. The submission handle is a derived projection

`submissionHandle` is never persisted and never enters a prompt, receipt,
guidance or transaction. Compare it exactly with the held snapshot before
payload validation, queueing or lease renewal, and re-check it inside the queue.
A stale handle has zero side effects. `transactionId` derives from `promptHash`,
so embedding the handle in a prompt would be circular. The handle is not a
security token: the session lease plus exact comparison remain the authority.
Responses and transaction recovery stay idempotent; an old handle never
re-submits a committed round.

### 5. Recovery and checkpoints are not history or progress

Recovery is a first-class action, not an evaluation: it fabricates no evaluation
and bypasses ordinary verification of the abandoned work. A checkpoint is
recovery material; its authority is the `CheckpointRef` inside the transaction
snapshot, never a manifest alone. A restore is not round progress and never
satisfies a redo-time verification check. A rollback directive is never
overwritten by its redo.

### 6. Contract items are acceptance conditions, not a checklist

Each item binds its own evidence commands and becomes `verified` only from
machine facts. The runtime validates structure, command bindings and references;
it never judges whether a `work_item` is a real deliverable, whether an item
matches a command semantically, or whether a command is the right acceptance
test. A contract closes only when every item is verified or a blocked round
closes it; closure priority is `blocked > superseded > verified > open`.
Operator criteria and hard constraints are immutable; the Agent may retract only
an active Agent-discovered constraint.

### 7. The prompt is a current-governance projection

It carries committed current-governance facts, compact Machine Evidence, and a
BOUNDED Agent-report Working Memory. Agent memory and session history are
background, never an input.

Machine Evidence renders the previous committed round's persisted
`EvidencePosture` in a protected section (status, `machineBackedSuccess`,
workspace/files counts, provider/command statuses, contract items, findings).
It is not Working Memory and declares no normative ids.

Working Memory is derived from the current branch's committed rounds and
committed rollback directives: recent reports, falsified assumptions /
retractions, open questions, consumed recoveries and contract redirects. Reports
and assumptions use a 5-round window; open questions remain active across the
branch until resolved; recoveries are consumed committed directives. Caps are
fixed code constants. Source counts are measured before cap/dedupe, rendered
counts after; every omission is stated, and an abbreviated body carries a
fixed notice. The prompt section is optional but INDIVISIBLE: `allowPartial:
false`, so it is dropped whole rather than rendered half, and the artifact
records `rendered:false` with source counts.

The projection is part of `CanonicalLoopState`; it is not a second history, is
never persisted as its own store, and never feeds a gate, success, contract
closure or machine evidence. Full rehydrated state, unbounded round history,
failed-pattern history and LoopForge-generated phase narratives do not render.
An in-context retry renders no Working Memory and no Machine Evidence. A clean
retry may render the previous committed posture plus the rejected attempt's
transient, clearly `not committed` posture; this posture describes that attempt,
not the current workspace. The state file is derived and is never the source of
truth.
The current user instruction defines the task.

Every prompt carries a derived context boundary in its artifact and a strategy
label in its header. Prompt density and context boundary are independent.
`fresh_invocation` is a new Agent invocation, never a workspace reset; it is
used for round boundaries, recovery redo, or repeated same-check rejection
escalation, and may describe the same logical round. `same_round_retry` keeps
the current invocation below that escalation threshold, regardless of prompt
density. A rejected posture is attempt-time evidence; the Agent checks the
current workspace before acting. The one prose source is
`src/round-guidance.ts`; the skill keeps definitions and a pointer, never a
second copy of the executable rules.

### 8. `submission-guidance.ts` is the single source of field meaning

The tool schema, the prompt evaluation block, `submission_guidance` and the
receipt all read it. Never keep a second copy of field semantics. The full legal
shape stays in guidance; optional fields are opportunities, not a coverage
checklist.

### 9. Empty, unknown and not-applicable are three different states

`[]` is an observed no-change; `null` is unknown; `not_applicable` means the
provider did not participate. `unknown` never reads as empty, as no-change or as
a pass, and never downgrades a prompt level. An evidence posture's `unknown`
never degrades to `verified` or to an empty result. A commit alone adds no
change when content is unchanged.

### 10. Persistence boundaries

State writes are atomic and protected by owned locks. MCP mutations are
serialized per session and fenced by renewable cross-process leases. Derived
state is separate from committed rounds and from the session document. Schema
versions are boundaries: older documents are reported, never silently migrated
or dropped. An invalid policy is never merged over the defaults.

### 11. Evidence posture is a transaction projection, not a second store

`EvidencePosture` is derived ONCE by the coordinator from one round's raw
facts, persisted inside that round's result, and read by every surface. It is
not a second factual source and must never be re-derived by a read surface.
The contract-item snapshot inside it is the status at commit time; later policy
or command-configuration changes must not rewrite it. Current compile-time
contract status is a separate `current verification capability` projection.
Rejected attempts keep a transient posture only in `RetryContext`; it never
enters the Vault or Working Memory.

## Changing a boundary

Run from `loopforge/`:

```bash
npm run check
npm run build
npm test
npm pack --dry-run --json
npm run verify:artifacts
git diff --check
```

`npm pack --dry-run` runs `prepack` (`verify:artifacts` + build). In a dirty
worktree, run the inventory with `--ignore-scripts` and run the scripted prepack
in a clean mirror.

Add or rename a test so its name states the invariant. For stale handles,
invalid payloads, rejected/terminated attempts and pause/lease conflicts, assert
zero side effects: no Vault entry, session save, gate/checkpoint, metric or
round advance.

Put type and field meaning in `protocol.ts` comments. If a rule can be enforced
by a test, enforce it there instead of adding prose here.
