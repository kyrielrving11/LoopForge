# LoopForge

LoopForge is a cognitive state runtime for external AI coding agents. It keeps
objectives, constraints, evidence, decisions, and recovery state stable across
agent-driven rounds. It does not provide a model or an unattended executor.

## Design philosophy

Long-horizon work fails through summary cascade, self-correction failure, and
compound error. LoopForge addresses those failures at the round boundary:

- Prompts are compiled from typed committed facts, not from the previous prompt
  or a summary of a summary.
- Evidence and decisions are checked by components outside the agent's context.
- Rejection, backtrack, and durable recovery prevent an incorrect path from
  silently becoming the input to every later round.

LoopForge is external cognitive infrastructure. The agent still owns planning,
file changes, tool use, and reasoning.

## Project rules

- TypeScript only.
- Node.js 18 or newer.
- Zero runtime dependencies.
- The npm package is in `loopforge/`; its current version is the `version`
  field of `loopforge/package.json` (single source — do not duplicate it in
  prose).
- Preserve user changes in a dirty worktree.
- Edit `loopforge/src/protocol.ts` before changing protocol fields, then run the
  build to regenerate `loopforge-protocol.json` and `loopforge/dist/`.
- Do not restore MCP Tasks, prompt-technique routing, automatic memory
  discovery, PromptCraft vault writes, or Markdown lineage fallback.

## Commands

Run from `loopforge/`:

```bash
npm run check
npm run build
npm test
npm pack --dry-run --json
npm run verify:artifacts
git diff --check
```

`verify:artifacts` checks generated `dist/` files and the protocol schema
against the current commit. In a dirty worktree, validate generated files in a
temporary clean mirror when a HEAD comparison is required.

## Current architecture

```text
loopforge/src/
  protocol.ts           Public protocol types and constructors
  self-eval.ts          Structured evaluation validation and lenient optional
                        field normalization
  committed-round.ts    Single read model for committed feedback and hydrated
                        lineage; decoding, ordering, deduplication, rollback
                        exclusion, and transaction extraction
  cognitive-facts.ts    Derived focus, todo, phase, delegation, and handoff
  canonical-state.ts    CanonicalLoopState and deterministic state hashing
  loop-compiler.ts      State evolution and PromptArtifact compilation
  prompt-policy.ts      L0/L1/L2 prompt-density selection
  prompt-assembler.ts   Single-pass PromptArtifact rendering
  engine.ts             Engine state, feedback, and lineage hydration
  round-driver.ts       Shared round preparation and completion
  round-transaction.ts  Stable round identity, attempts, evidence, and recovery
  round-contract.ts     Active Round Contract derivation and item matching
  round-coordinator.ts  Verification, enforcement, recovery, and stop decisions
  verification-gate.ts  Independent evidence and cross-round consistency checks
                        (four verification domains: evaluation consistency /
                        evidence integrity / plan & contract / progress &
                        recovery)
  enforcement-gate.ts   Disposition rules over an in-process strategy table
                        (four action classes: evidence contradiction / contract
                        & scope / plan drift / progress recovery)
  evidence-claims.ts    Derived claim provenance and verified-claim views
  cognitive-governance.ts User and agent gate classification
  loop-projection.ts    Typed adapter over DerivedCognitiveFacts
  audit.ts              Read-only completeness and evidence audit
  replay.ts             Read-only committed timeline and diff queries
  loop-store.ts         Atomic typed JSON persistence
  evidence-provider.ts  Git, custom, and explicit command evidence providers
  policy.ts             Runtime policy and derived state-file writes
  observability.ts      Structured tracing
  policy-metrics.ts     Diagnostic round and verification metrics
  cli.ts                Unified loopforge command
  mcp/
    session.ts          Durable leased MCP sessions and read-only views
    round-lifecycle.ts  Session round state machine and crash recovery
    tools.ts             Nine MCP tools and input/output schemas
    server.ts           Synchronous JSON-RPC stdio server
```

## Source boundaries

LoopForge has one factual source and one cognitive source.

- The factual source is the committed typed round documents in the Vault.
  `CommittedRoundView` is the shared internal read model over those documents,
  not a second persistence format.
- The cognitive source is `CanonicalLoopState`, compiled from committed facts.
  `DerivedCognitiveFacts` supplies focus, todo, phase, delegation, and handoff
  to prompt, state-file, and status projections.
- Replay answers what happened. Audit checks whether facts are complete and
  claims have supporting evidence. Metrics are diagnostic only. These views
  share the committed-round decoder and do not own separate history rules.

Rejected and in-flight attempts are not committed history. A backtrack decision
is a rollback directive and is excluded from final history after the redo.

## Evaluation boundary

`loopforge_next` requires a structured `evaluation` object. These four fields
are the only strict field boundary:

- `success` must be boolean.
- `output_summary` must be string.
- `constraint_violations` must be an array of strings.
- `should_continue` must be boolean.

Optional fields are normalized by `buildSelfEvaluation()`. Malformed optional
values are ignored or defaulted and do not reject a submission. Missing or
mistyped core fields return `evaluation_invalid` with details and may be retried
with the same `roundId`.

One documented exception keeps `evaluation_invalid` semantics: `subgoal_updates`
is a strict STRUCTURAL boundary — it carries machine-processable sub-goal state
transitions. Shape errors (bad ids/statuses, `sg-XXXXXXXX` literals in
`emerged_subtasks`), unknown sub-goal references, terminal (done/canceled)
references, and illegal migrations are rejected pre-advance against the SAME
derived sub-goal set the agent saw in its prompt (single derivation, compiled
read-only). It returns `evaluation_invalid` like core-field errors: no session
state, no gates, no rejection counters, same-roundId retry. Worker results and
`gate_ids` stay lenient (entry-level drops / citation checks only).

An invalid evaluation is handled before `RoundLifecycle.advance()`. It must not
save session state, write the Vault, run verification or enforcement gates,
increment rejection state, or record metrics. Natural-language evaluation
inference is not allowed.

## Round lifecycle

All mutations follow:

```text
SessionManager -> RoundLifecycle -> RoundDriver -> RoundCoordinator
```

The lifecycle collects before and after evidence, validates the transaction,
runs verification and enforcement, and then applies one disposition:

- Accept or stop commits the transaction and its evidence.
- Reject keeps the logical round ID, increments the attempt, and commits no
  round. The retry uses the same round ID.
- Backtrack commits a rollback decision, restores the round counter to the last
  clean committed round, preserves valid discoveries, and requires workspace
  restoration before the next submission. The rollback decision carries a
  derived Recovery Brief — trigger, restore point, the redo round id, failed
  rounds with their approaches, and falsified assumptions. Its sources are
  COMMITTED rounds above the restore point plus the in-flight attempt; rejected
  payloads are not durable history and never become a source. The brief renders
  in the backtrack prompt and the state file's Recent tier, and exits by
  construction when the redo commit replaces the rollback record.
- Terminate returns a terminal result without committing the rejected or
  terminating evaluation as a normal round.

Round IDs prevent lost responses and duplicate submissions from skipping or
double-committing a round. Transaction recovery is idempotent after a process
crash.

## Evidence and gates

The verification gate compares claims with independent Git snapshots, test
output, and explicitly configured command evidence. Its checks are organized
into four verification domains: evaluation consistency, evidence integrity,
plan & contract conformance, and progress & recovery. The enforcement gate
turns verification results into accept, reject, backtrack, or terminate
decisions through one ordered in-process strategy table; its rows fall into
four action classes (evidence contradiction, contract & scope, plan drift,
progress recovery). Rule numbers are historical — v3.7 documents semantics,
not numbered rules. Success evidence is a single policy: a success claim with
no machine-verified observation, or with empty/missing evidence, is handled
by the success-evidence check; `no_change_reason` is that check's escape hatch
for the claims arm only — it does not excuse contract completion, scope drift,
silently dropped contract claims, or a success claim that recorded no
execution evidence at all. Progress enforcement is a single stall evaluator:
a window without machine git motion and without self-reported progress motion
rejects, then backtracks or terminates; git motion can excuse a stall verdict,
agent-reported progress alone cannot create or cancel one.

Round Contracts are proposals for the next round. A proposal becomes active
only after its declaring round commits. The active contract is derived from
committed rounds on every compile path, including retry, resume, and backtrack.
Contract checks are framed in three stages — Declaration (proposal
verifiability: done_when and verification_plan), Execution (scope conformance,
done_when not dropped), Closure (every done_when met and the verification plan
observed passing) — a documentation framing only; no phase field exists. It
closes when a committed evaluation completes its `done_when` items or reports
`outcome: "blocked"`. A verification plan must be observed passing in the
closing round. A different proposal while the active contract is open is
ignored and surfaced as a warning.

## Prompt levels and projections

L0, L1, and L2 control state density only. They do not choose a reasoning
technique. L0 is a lean same-round retry, L1 is normal continuation, and L2 is
full rehydration. Mandatory prompt sections remain present and the token budget
is enforced.

The optional `.loopforge/state/<loopId>-state.md` file is a derived view. It can
be regenerated from the Vault and must never become an independent source of
truth.

## Storage and integration

```text
.loopforge/
  loops/<sha256(loopId)>/
    metadata.json
    session.json
    rounds/<round>.json
  state/<loopId>-state.md
```

Every round document carries a monotonic sequence stamp (`sequence === round`);
unstamped rounds are corrupted and missing rounds are a recoverable gap. The
legacy PromptCraft vault migration API and CLI command were removed in v3.7 —
imported legacy loops are no longer supported. Writes are atomic and protected
by owned locks. MCP mutations are serialized per session and fenced by
renewable cross-process leases. Command evidence is disabled by default, uses
an executable plus arguments with `shell: false`, and is restricted to the
workspace. Evidence collection is always asynchronous.

The primary integration is the synchronous MCP server:

```text
loopforge_start       create a session and compile round 1
loopforge_next        submit structured evaluation and advance
loopforge_status      inspect session, loop, all, or audit views
loopforge_stop        intentionally stop a session
loopforge_pause       pause a session
loopforge_resume      reconstruct a durable session
loopforge_replay      read the committed timeline
loopforge_gate_check  preflight a structured high-risk action (opt-in)
loopforge_gate_resolve record a human gate decision (opt-in)
```

`loopforge_gate_check` / `loopforge_gate_resolve` are opt-in: when
`policy.gate.enabled` is false (the default) they are hidden from `tools/list`
and direct calls return a stable `gate_disabled` error; existing gate records
stay readable through replay and audit. When enabled, `gate_check` is a
structured preflight over a `GateActionDescriptor` (conservative: anything not
provably safe is `user_required` with reason codes), a `user_required` verdict
persists a `gate_opened` record, and a round that cites an unapproved gate via
`evaluation.gate_ids` is rejected (`user_gate_unresolved`). Trust model:
`gate_resolve` is called by the Agent, so LoopForge can never machine-verify
that a human is present — the gate layer is process governance plus an
auditable decision record, not a human-presence proof.

Do not add background execution or automatic integration discovery. The
external agent remains the execution owner.

## Before changing a hotspot

- Prompt changes require PromptArtifact budget, hashing, density-level, and
  same-round retry coverage.
- Protocol or evaluation changes require schema, handler, lifecycle, malformed
  input, same-round retry, and state-unchanged tests.
- Transaction changes require reject, backtrack, replay, concurrent next,
  pause, stop, and restart coverage.
- Store changes require atomicity, sequence-gap, lock ownership, and
  cross-process lease coverage.
- Evidence changes require timeout, abort, unavailable provider, output cap,
  workspace boundary, and contradiction coverage.
- MCP changes require primitive JSON, strict core arguments, structured output,
  and process-level stdio coverage.
- Update `loopforge-protocol.json` and `dist/` through the build. Do not edit
  generated artifacts by hand.
