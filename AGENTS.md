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

It carries committed current-governance facts only. Agent memory and session
history are background, never an input. A fresh prompt also carries BOUNDED
Working Memory derived from the current branch's committed rounds and
committed rollback directives: recent reports, falsified assumptions /
retractions, open questions, consumed recoveries and contract redirects, each
under a fixed window and character cap. That projection is part of
`CanonicalLoopState`; it is not a second history, is never persisted as its own
store, and never feeds a gate, success, contract closure or machine evidence.
Full rehydrated state, unbounded round history, failed-pattern history and
LoopForge-generated phase narratives do not render. A same-round retry renders
no Working Memory. The state file is derived and is never the source of truth.
The current user instruction defines the task. Every prompt carries a derived
context boundary (`fresh_round` / `same_round_retry`) in its artifact; the host
starts a new Agent invocation for `fresh_round`, which is not a workspace reset.

### 8. `submission-guidance.ts` is the single source of field meaning

The tool schema, the prompt evaluation block, `submission_guidance` and the
receipt all read it. Never keep a second copy of field semantics. The full legal
shape stays in guidance; optional fields are opportunities, not a coverage
checklist.

### 9. Empty, unknown and not-applicable are three different states

`[]` is an observed no-change; `null` is unknown; `not_applicable` means the
provider did not participate. `unknown` never reads as empty, as no-change or as
a pass, and never downgrades a prompt level. A commit alone adds no change when
content is unchanged.

### 10. Persistence boundaries

State writes are atomic and protected by owned locks. MCP mutations are
serialized per session and fenced by renewable cross-process leases. Derived
state is separate from committed rounds and from the session document. Schema
versions are boundaries: older documents are reported, never silently migrated
or dropped. An invalid policy is never merged over the defaults.

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
