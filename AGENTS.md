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
                        field normalization; the strict contract declaration
                        and item-claim boundary (contract_invalid)
  subgoal-state.ts      Sub-goal lifecycle — round-scoped ids, the closed
                        transition matrix, committed-view replay, and the
                        exact-duplicate declaration diagnostic
  contract-items.ts     Contract item status reducer (pending / insufficient /
                        contradicted / verified) and closure
  round-facts.ts        THE contract-fact derivation — the contract walker,
                        item reducer, verified sub-goals and verification debt
                        as ONE pass over ONE history window
  committed-round.ts    Single read model for committed feedback and hydrated
                        lineage; decoding, ordering, deduplication, rollback
                        exclusion, and transaction extraction. Also the ONE
                        window function every derivation reads
                        (`derivationRounds`)
  cognitive-facts.ts    Derived focus, todo, phase, delegation, and handoff.
                        Consumes the caller's RoundFacts — it derives nothing
                        about contracts
  canonical-state.ts    CanonicalLoopState and deterministic state hashing
  loop-compiler.ts      State evolution and PromptArtifact compilation
  prompt-policy.ts      L0/L1/L2 prompt-density selection
  prompt-assembler.ts   Single-pass PromptArtifact rendering; the fixed
                        section priority and the protected set
  engine.ts             Engine state, feedback, and lineage hydration
  round-driver.ts       Shared round preparation and completion
  round-transaction.ts  Stable round identity, attempts, evidence, and recovery
  round-contract.ts     Active Round Contract derivation; content-addressed
                        rc-/rci- identity and the closure walker
  round-coordinator.ts  Verification, enforcement, recovery, and stop decisions
  verification-gate.ts  Independent evidence and cross-round consistency checks
                        (20 checks in four verification domains: evaluation
                        consistency / evidence integrity / plan & contract /
                        progress & recovery)
  enforcement-gate.ts   Disposition rules over an in-process strategy table,
                        including the bounded verification-debt escalation
  evidence-claims.ts    Derived claim provenance and verified-claim views
  explain.ts            Read-only per-round "why" view over committed facts
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
    submission-boundary.ts THE submission boundary (the five strict checks)
                        plus the compile context it reads; runs before the
                        session queue and the lease heartbeat
    session.ts          Durable leased MCP sessions and read-only views; the
                        runtime's public entry point (index.ts exports it),
                        and where the submission boundary is applied
    round-lifecycle.ts  Session round state machine and crash recovery
    tools.ts             Nine MCP tools and input/output schemas
    server.ts           Synchronous JSON-RPC stdio server
```

## Source boundaries

LoopForge has one factual source and one cognitive source.

- The factual source is the committed typed round documents in the Vault.
  `CommittedRoundView` is the shared internal read model over those documents,
  not a second persistence format. `derivationRounds(entries, N)` in
  `committed-round.ts` is the ONE window every derivation reads — the compile
  path, the projection, the live coordinator, audit and explain all go through
  it, so they cannot disagree about which rounds are this branch's history or
  about how their envelope was interpreted.
- The cognitive source is `CanonicalLoopState`, compiled from committed facts.
  `DerivedCognitiveFacts` supplies focus, todo, phase, delegation, and handoff
  to prompt, state-file, and status projections. It takes the contract facts
  as an INPUT (`RoundFacts`, from `round-facts.ts`) and derives nothing about
  contracts itself — one algorithm, one window, no second answer.
- Replay answers what happened. Audit checks whether facts are complete and
  claims have supporting evidence. Metrics are diagnostic only. These views
  share the committed-round decoder and do not own separate history rules.

### Relationship identity

Everything that affects a fact, a state, a verdict, or a replayed history is
established by: a stable id, an explicit `criterion_refs` / `subgoal_refs` /
`contract_item_id`, normalized-exact text, or a content hash. **Never by a
similarity score.** v3.8.1 deleted the Jaccard implementation, its tokenizer
and its seven thresholds outright; `criteriaMatch`, `matchesConstraintText`
and `matchEmphasize` compare ids or normalized-exact text, and a paraphrase is
a different thing.

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

Two documented exceptions keep strict pre-advance semantics. `subgoal_updates`
is a STRUCTURAL boundary — it carries machine-processable sub-goal state
transitions. Shape errors (bad ids/statuses, `sg-XXXXXXXX` literals in
`emerged_subtasks`), unknown sub-goal references, terminal (done/canceled)
references, and illegal migrations are rejected pre-advance against the SAME
derived sub-goal set the agent saw in its prompt (single derivation, compiled
read-only). It returns `evaluation_invalid` like core-field errors: no session
state, no gates, no rejection counters, same-roundId retry. Worker results and
`gate_ids` stay lenient (entry-level drops / citation checks only).

`round_contract` and `execution_report.contract_item_claims` are the second
strict boundary, returning `contract_invalid` with the same guarantees. The
validator receives its reference space as a context object
(`ContractValidationContext`): the ACTIVE contract's item ids, the known
sub-goal ids (the compiled set plus this submission's own `emerged_subtasks`,
so a sub-goal may be created and referenced in one round), the command
predicate, and an injected workspace-containment check. Each is null when it
cannot be observed, in which case that arm fails open while the shape checks
stay strict. Malformed, duplicated or unknown item ids are rejected
pre-advance against the SAME derived ACTIVE contract the agent saw.
`criterion_claims` stays lenient: unknown or malformed entries are dropped with
a warning, because the criterion layer is advisory while the contract item
layer is the verification skeleton.

v3.8 also renamed the agent's report: `ExecutionEvidence` → `ExecutionReport`
(field `execution_report`), with `criterion_claims` and `contract_item_claims`
replacing the old `success_criteria_met` / `success_criteria_remaining` string
arrays. No field of that report can create a `verified` fact.

An invalid evaluation is handled before `RoundLifecycle.advance()`. It must not
save session state, write the Vault, run verification or enforcement gates,
increment rejection state, or record metrics. Natural-language evaluation
inference is not allowed.

### The submission boundary is the runtime's, not the transport's

All five checks live in `mcp/submission-boundary.ts` and are applied by
`SessionManager.advance` — the runtime's public entry point (`RoundLifecycle`
is internal; the manager is what `index.ts` exports). They used to live in the
MCP tool handler, which made "strict" a property of one transport: a library
caller, a future CLI command, or any direct `mgr.advance()` got none of it, and
a partial copy of two checks sat in the session manager as well.

Two orderings are part of the contract, and both are why the boundary sits
where it does:

- **Before the session is resolved.** A malformed evaluation is a payload
  defect whatever the session's state; answering `session_not_found` for it
  would send the agent after the wrong problem. The reference spaces that need
  a session fail open when there is none, so an unknown session still gets a
  pure shape judgement.
- **Before the queue and the lease heartbeat.** Renewing a lease writes the
  session document, so a payload that is never accepted must not reach it.
  This is the ordering that makes "changes nothing durable" literally true
  rather than nearly true.

Each reference space is `null` — fail open, shape checks still strict — when it
cannot be observed. An unobserved session is NOT the same as a session with no
active contract: the latter is an observed empty space, and an item claim in it
is false.

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
  construction when the redo commit replaces the rollback record. The prompt
  states restore FACTS only — the target HEAD and the files that must be
  reverted — and never prescribes a git command: LoopForge neither mutates the
  working tree nor dictates the means. The agent owns the restore; the gate
  owns the check.
- Terminate returns a terminal result without committing the rejected or
  terminating evaluation as a normal round.

Stop reasons are decided in one order: an explicit blocked declaration
(`outcome: "blocked"`, or `stop_reason: "blocked"` / `"needs_human_input"`)
outranks the success claim, so a contradictory payload can never buy
`completed`. `completed` then requires `effectiveSuccess` AND a contract that
is closed as `verified` (or no active contract at all); a `blocked` closure
does not satisfy it. An unverified success stop is `incomplete`. A contradicted
item never reaches `completed` — closure is `verified` only when every item is
— and turning that posture into a reject/terminate is the enforcement gate's
job, evaluated before the stop decision.

Round IDs prevent lost responses and duplicate submissions from skipping or
double-committing a round. Transaction recovery is idempotent after a process
crash.

## Evidence and gates

The verification gate compares claims with independent Git snapshots, test
output, and explicitly configured command evidence. Its checks are organized
into four verification domains: evaluation consistency, evidence integrity,
plan & contract conformance, and progress & recovery. The enforcement gate
turns verification results into accept, reject, backtrack, or terminate
decisions through one ordered in-process strategy table. The row order IS the
priority, and a row carries exactly two things: the check it reacts to and its
ladder (`uniform` rows share one escalate-then-terminate path, `internal` rows
own theirs). The former `category` field is gone — v3.8 deleted it, so no
document should describe the rows as belonging to a category. Rule numbers are
historical at the same time: v3.8 documents semantics, not numbered rules.
The verification check set is 20 (evaluation_consistency 8, evidence_integrity
7, plan_contract 4, progress_recovery 1). Success evidence is a single policy: a success claim with
no machine-verified observation, or with empty/missing evidence, is handled
by the success-evidence check; `no_change_reason` is that check's escape hatch
for the claims arm only — it does not excuse contract completion, scope drift,
silently dropped contract claims, or a success claim that recorded no
execution evidence at all. Progress enforcement is a single stall evaluator,
and it reads MACHINE facts first: when the git series is observable over the
window it alone decides — a window without machine motion rejects, then
backtracks or terminates — and machine motion only ever EXCUSES (it can veto a
stall it did not create; it can never create one). The agent's own
`progress_estimate` series is the FALLBACK for a loop with no machine history
to read (no git provider, or fewer rounds than the window); there the verdict
can only state a stall the agent's own reports show, and a near-completion
guard keeps it from rejecting a loop that reports itself nearly done. An
agent's rising self-report therefore cannot cancel a machine-derived stall.
One machine fact is exempt by construction: a round whose success is
machine-backed (`deriveEvidenceStatus` → a passed after-phase command the
runtime observed) is the loop FINISHING, not churning — the closing round of
a loop often changes no files at all.

Round Contracts are proposals for the next round, expressed as ITEMS. A
proposal becomes active only after its declaring round commits, and the active
contract is derived from committed rounds on every compile path (retry, resume,
backtrack). Every item binds at least one configured, enabled, after-capable
evidence command; the runtime derives a content-addressed `rc-`/`rci-`
identity, so restating a contract unchanged keeps the ids the agent already
cited. Item statuses — `pending`, `insufficient`, `contradicted`, `verified` —
are machine-derived by `contract-items.ts`: `verified` requires a `met` claim
AND every bound command observed passing in the closing round (after-phase,
entrypoint untampered, same configuration as at declaration — the commit stamps
a `ContractBinding` for exactly this comparison). The contract closes when
every item is `verified`, or when a round reports `outcome: "blocked"`.
Claimed-but-unbacked is `insufficient` and the round still commits; the debt is
surfaced and the enforcement gate's bounded escalation
(`engine.unverified_claim_streak_limit`) handles a persistent pattern by
rejecting, then terminating as `incomplete`. Because closure is derived, a
premature closure is structurally impossible. A different proposal while the
active contract is open is ignored and surfaced as a warning. Scope drift is a
machine fact with no clarification waiver.

The declaration boundary is strict and complete: `contract_invalid` rejects a
contract with no items, over `CONTRACT_LIMITS` (items / scope / per-item refs),
an item with no `verify_with`, an unknown / disabled / non-after-capable
command id, a `scope` entry that is not a string or leaves the workspace
(checked with the same `containInWorkspace` boundary as every other workspace
path), a malformed or over-long `criterion_refs` / `subgoal_refs` entry, and a
`subgoal_refs` id naming a sub-goal the loop does not have. The limits live in
one exported constant used by both the strict validator and the lenient parser,
so a declaration is rejected rather than silently truncated.

`subgoal_refs` sits on the ITEM, not on the contract: a machine-verified item
backs exactly the sub-goals it names. `deriveVerifiedSubGoals` reads the WHOLE
committed history through the shared `deriveRoundContractView` — a verified
item is machine history that survives its contract closing, and reading only
the currently-active contract made the fact vanish at the moment it became
fully true (and turned the debt view into a false accusation). A Round Contract
is the only place sub-goals meet verification; `SubGoal.status` stays the
agent's declaration and is never written by the machine.

`deriveRoundContractView` is the single "what contract did this round execute
under, and where did its items stand" derivation — the live coordinator,
`explain`, and `audit` all call it, so a read-only view cannot disagree with
the live posture. It derives from the rounds BEFORE the one being reported (a
proposal declared in round R is active from R+1, and a contract round R closes
must still be reported as round R's), and folds the round's own report and
observations in as the in-flight slice.

## Prompt levels and projections

L0, L1, and L2 control state density only. They do not choose a reasoning
technique. L0 is a lean same-round retry, L1 is normal continuation, and L2 is
full rehydration. L2 is entered only for reasons that are FACTS about the
round — first round, plan boundary, committed recovery, a machine
contradiction, a checkpoint boundary, or repeated rejection. There is no
round-count timer.

### Budget: fixed priority, protected set, deterministic truncation

`prompt-assembler.ts` owns the order in ONE table (`SECTION_PRIORITY`). A
Section's `mandatory` flag means PROTECTED: never dropped, never truncated,
rendered first regardless of budget. Everything else is optional and is cut
**strictly lowest-priority-first** — greedy first-fit is NOT the rule, because
it can render a small low-priority section into room a larger high-priority one
could not use, so "Blockers" could be missing while "Phase" is present. At most
ONE optional section may be rendered partially, cut at a line boundary.

When the protected set alone exceeds the budget the prompt is rendered anyway
and `PromptArtifact.protectedOverflow` is set: an over-budget prompt is
RECORDED, never silently produced.

The budget is fixed per level (`l0/l1/l2_max_chars`). It does not scale with
round count, milestone count or sub-goal count — a prompt's allowed content
must not depend on how long the loop has been running.

`PromptArtifact` (schema 2) records what THIS prompt did: `level`,
`stateHash`, `promptHash`, round identity, `sections`, `droppedSections`,
`protectedOverflow`, `budget`, `renderedChars`. It records nothing about what
a LATER prompt should do. There is no presentation snapshot: a prompt's content
follows from committed facts, not from what the previous prompt happened to
show. An artifact that does not parse (an older schema version included) is a
HARD break, and `legacyTransactionRounds()` reports the loss rather than
letting the loop look complete while rounds are missing.

### Projections

`LoopProjection` carries `verified_subgoals` — the derived machine facts about
sub-goals a verified contract item backs. It is forwarded from the same
`deriveCognitiveFacts` the canonical state consumes, not re-derived, so the
projection, the prompt and the state file cannot tell different stories about
what the machine verified.

The optional `.loopforge/state/<loopId>-state.md` file is a derived view for
humans, the CLI and external tools. It can be regenerated from the Vault, its
content depends only on committed facts (not on which prompt level compiled),
and it must never become an independent source of truth. Diagnostics live here
— trust, roadmap, the progress dashboard, per-round stats and the full
recurring-flag history are state-file concerns, not prompt concerns. The prompt
carries a bounded recent tail of the recurring facts (`Active Warnings`) and a
one-line phase; a backtrack's Recovery Brief renders in the prompt and in the
state file's Recent tier from ONE set of facts.

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
workspace. Evidence collection is always asynchronous. Providers emit
`MachineObservation`s and every configured provider always yields one —
unavailable, timeout, error and abort are recorded statuses, never filtered
away. A configured name with no registered factory is not dropped either: it
yields an `unavailable` observation, because "the provider is configured but
nothing was recorded" is itself a fact the round has to carry. Capability has
one derivation (`deriveEvidenceCapability`), consumed by `RoundDriver.prepare`
(prepared rounds return it), MCP start/resume/next/status, and the warning
list. It is split so it can be hashed: `ConfiguredCapability` is a pure
function of policy and participates in `stateHash`/`promptHash`, while
provider-REGISTRY readiness (`available`) and live observation statuses are
rendered only and never enter a hash. `doctor` reports readiness; the hash
never encodes it.

MCP errors carry a stable `ToolErrorCode` and a separate human `message`.
`round_id_mismatch` is for places with no held prompt to return (the gate
preflight); `loopforge_next` keeps the v3.0.1 held-prompt recovery instead, so a
mismatched submission there is `ok: true` with a warning.

The round transaction is schema 2 and persists only the before/after
observation collections; the round delta is derived
(`deriveRoundObservationDelta`). A schema-1 envelope is a hard break: the round
is not history, and `legacyTransactionRounds()` reports it in the audit instead
of letting it vanish silently. The same applies to the PromptArtifact schema
(now 2): both versioned envelopes are HARD breaks, and both are REPORTED —
`legacyTransactionRounds()` tags each loss with which envelope rejected it.
A version break that deletes committed history without saying so is the one
outcome this reporting exists to prevent.

The same applies to the policy schema (version 4): `loadPolicy` rejects a file
that declares a different version, or an unknown key, instead of merging it
over the current defaults. The version field used to be read by nothing.

The primary integration is the synchronous MCP server:

```text
loopforge_start       create a session and compile round 1
loopforge_next        submit structured evaluation and advance
loopforge_status      inspect session, loop, all, audit, or explain views
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
  same-round retry coverage — plus proof that the PROTECTED set survives a
  budget below its own size (`protectedOverflow` recorded, not silently
  resolved), that every rendered optional section outranks every dropped one,
  and that identical input yields an identical prompt and artifact.
- Policy changes require the version boundary to hold: a file declaring a
  different schema version, or carrying an unknown key, must be REJECTED
  (`policy_invalid`), never merged over the defaults.
- Protocol or evaluation changes require schema, handler, lifecycle, malformed
  input, same-round retry, and state-unchanged tests.
- Transaction changes require reject, backtrack, replay, concurrent next,
  pause, stop, and restart coverage.
- Store changes require atomicity, sequence-gap, lock ownership, and
  cross-process lease coverage.
- Evidence changes require timeout, abort, unavailable provider, output cap,
  workspace boundary, and contradiction coverage.
- MCP changes require primitive JSON, strict core arguments, structured output,
  the uniform `{ok}` result envelope, stable `ToolErrorCode`s with a message
  that never doubles as the code, and process-level stdio coverage.
- Contract changes require identity stability (a restate keeps its rc-/rci- ids),
  per-item status derivation, derived-fact survival across closure, closure
  reported identically by the coordinator / explain / audit, and
  `contract_invalid` retry coverage.
- Stop-reason changes require the contradictory-payload cases (explicit
  `blocked` next to `success: true`, a contradicted item next to a success
  stop) to be covered — `completed` must stay machine-true.
- Update `loopforge-protocol.json` and `dist/` through the build. Do not edit
  generated artifacts by hand.
