# LoopForge agent instructions

This file is the working contract for agents changing this repository. The
root README explains the product; this file records the constraints that code
changes must preserve.

## Non-negotiable rules

- TypeScript only.
- Node.js 18 or newer.
- Zero runtime dependencies.
- The npm package lives in `loopforge/`; its version comes only from
  `loopforge/package.json`.
- Preserve user changes in a dirty worktree.
- Edit `loopforge/src/protocol.ts` before changing protocol fields, then run the
  build to regenerate `loopforge-protocol.json` and `loopforge/dist/`.
- Do not restore MCP Tasks, prompt-technique routing, automatic memory
  discovery, PromptCraft vault writes, or Markdown lineage fallback.

## Source-of-truth invariants

LoopForge has one factual source and one cognitive source.

- The factual source is committed typed round documents in the Vault.
- `CommittedRoundView` is the shared read model over those documents.
- `derivationRounds(entries, N)` is the one history window used by compilation,
  projections, gates, audit, explain, and metrics.
- The cognitive source is `CanonicalLoopState`, compiled from committed facts.
- `DerivedCognitiveFacts` supplies focus, todo, phase, delegation, and handoff
  to the prompt, state-file, and status projections.
- Replay, Audit, Metrics, and Explain are read-only views. They must not create
  a second history or independent derivation rule.

Relationships use stable IDs, explicit references, normalized-exact text, or a
content hash. Never reintroduce similarity matching or fuzzy identity.
Rejected and in-flight attempts are not committed history. A backtrack is a
rollback directive and is excluded from final history after its redo commits.

## Evaluation and submission boundary

The runtime submission boundary is in `loopforge/src/mcp/submission-boundary.ts`
and is applied by `SessionManager.advance`, before session resolution,
queueing, or lease renewal.

The four strict core evaluation fields are:

- `success`: boolean
- `output_summary`: string
- `constraint_violations`: array of strings
- `should_continue`: boolean

Missing or mistyped core fields return `evaluation_invalid`. An invalid
evaluation must not save session state, write the Vault, run verification or
enforcement, increment rejection state, or record metrics. The same `roundId`
can retry the corrected payload.

Optional fields are normalized by `buildSelfEvaluation()`. The structural
exceptions are `subgoal_updates`, `round_contract`, and
`execution_report.contract_item_claims`:

- Sub-goal shape, ID, terminal-reference, and transition errors are rejected
  before advance against the same derived sub-goal set shown to the agent.
- Contract shape, limits, command bindings, workspace containment, references,
  and duplicate item IDs are rejected as `contract_invalid` before advance.
- `criterion_claims` is advisory and lenient; malformed or unknown entries are
  dropped with a warning.
- Worker results and `gate_ids` remain lenient apart from entry-level checks.

Reference spaces fail open only when they cannot be observed (`null`). An
observed session with no active contract is an empty reference space, not an
unobserved one.

## Round lifecycle invariants

All mutations follow:

```text
SessionManager -> RoundLifecycle -> RoundDriver -> RoundCoordinator
```

- A valid submission collects before/after evidence, validates the transaction,
  runs verification and enforcement, then applies one disposition.
- Accept or stop commits the transaction and evidence.
- Reject keeps the logical round ID, increments the attempt, and commits no
  round.
- Backtrack commits a rollback decision, restores the round counter to the last
  clean committed round, preserves valid discoveries, and requires workspace
  restoration before the redo.
- Terminate returns a terminal result without committing the rejected or
  terminating evaluation as a normal round.
- Stop decisions prioritize an explicit blocked declaration. `completed`
  requires effective success and a verified contract, or no active contract.
  A blocked or contradicted contract cannot produce `completed`.
- `declaresBlocked` (self-eval.ts) is the ONE definition of "this round
  declares itself blocked" (`outcome: "blocked"`, or `stop_reason` of `blocked`
  or `needs_human_input`). It is read by both the stop decision and the
  scope-drift waiver, so the two boundaries cannot mean different things.
- `finalizeStopReason` is the completion-truth guard: it runs in the
  coordinator BEFORE the transaction commits (the committed round document
  carries `result.stopReason`) and again at the lifecycle end where the reason
  becomes client-visible. A violation is a code defect, so it downgrades to
  `blocked` and reports rather than throwing.

Round IDs prevent lost responses and duplicate submissions. Transaction
recovery must remain idempotent after process interruption.

## Evidence and contract invariants

The verification gate has 20 checks in four domains: evaluation consistency,
evidence integrity, plan and contract, and progress and recovery. The
enforcement gate uses one ordered strategy table; row order is priority and a
row owns its escalation ladder. Do not add a category field or revive numbered
rule semantics.

Agent reports are claims, never machine evidence. A success claim needs an
independent machine observation, normally a passed after-phase command whose
entrypoint and configuration are untampered. `no_change_reason` is an escape
only when no verification command is configured. Machine progress can excuse a
stall verdict; self-reported progress cannot create or cancel a machine stall.

The entrypoint check has two arms, unioned. The git-delta arm is unchanged. The
absolute arm compares each entrypoint file's current content against a trusted
baseline captured from the FILESYSTEM when the round was prepared
(`captureEntrypointTrust`) — git only lists dirty tracked files, so a gitignored
entrypoint is in no git diff, and a baseline re-derived from the current tree
would compare tampered state against itself. The baseline lives in the session
state entry (`entrypoint_trust`, read back leniently), never in committed round
history; it is seeded only for a round being PREPARED, never for a same-round
retry, and its absence means "no absolute arm", never a lost round. An
entrypoint created during the round cannot back that round: restore it, or take
the rollback so the work is redone where it is part of the starting state.
Repeated non-restoration backtracks; it does not terminate.

Every configured evidence provider emits one typed observation, including
`unavailable`, `timeout`, `error`, or `aborted`. Do not silently filter failed or
unavailable observations. Transactions persist before/after observation
collections; the round delta is derived.

Round Contract rules:

- A proposal is item-based and becomes active only after its declaring round
  commits.
- Each item has at least one configured, enabled, after-capable evidence
  command.
- Contract and item IDs are content-addressed (`rc-` and `rci-`); restating an
  unchanged contract preserves identity.
- Item states are `pending`, `insufficient`, `contradicted`, or `verified`.
- `verified` requires a `met` claim and every bound command passing in the
  closing round with the declaration's binding intact.
- A contract closes only when every item is verified or a round reports
  `outcome: "blocked"`.
- A different proposal while the active contract is open is ignored and
  surfaced as `contract_premature`.
- A claimed-but-unbacked item is recorded as verification debt. The bounded
  escalation uses `engine.unverified_claim_streak_limit` and the same-check
  streak only.
- Scope drift is a machine fact with no clarification waiver. Its one legal
  exit is a blocked round that declares a successor contract covering EVERY
  drifted file: that waives the rejection, never the fact, and the flag still
  lands on the committed round. The coverage files come from
  `roundDriftFiles()` — never from a flag's truncated `detail`. The waiver
  removes the drift rejection only; contract debt, machine stalls, and
  unrestored workspaces still apply, and a waived round does not reach the
  rejection-counter catch-all.

`deriveRoundContractView` is the shared contract derivation for the live
coordinator, explain, and audit. `deriveVerifiedSubGoals` reads the whole
committed history so verified facts survive contract closure.

## Prompt and projection invariants

L0, L1, and L2 select prompt density only. L2 is entered for factual round
conditions such as first round, plan boundary, committed recovery, machine
contradiction, checkpoint boundary, or repeated rejection; there is no
round-count timer.

`prompt-assembler.ts` owns one fixed `SECTION_PRIORITY` table. Mandatory
sections are protected: they render first and are never dropped or truncated.
Optional sections are removed strictly from lowest priority first, with at most
one partial optional section. If the protected set exceeds the budget, render
it and record `PromptArtifact.protectedOverflow`.

`PromptArtifact` schema 2 records the current prompt only: level, state hash,
prompt hash, round identity, sections, dropped sections, overflow, budget, and
rendered characters. It must not encode what a later prompt should do. An
unparseable artifact or schema-1 transaction is a hard break reported by
`legacyTransactionRounds()`, never silently discarded.

The optional state file is derived from committed facts and is regenerated
without depending on prompt level. `LoopProjection.verified_subgoals` must be
forwarded from the same cognitive derivation used by canonical state.

## Storage and integration invariants

Storage is under `.loopforge/loops/<sha256(loopId)>/` with `metadata.json`,
`session.json`, and `rounds/<round>.json`; derived state is under
`.loopforge/state/`. Round documents carry `sequence === round`; missing or
unstamped rounds are corruption or recoverable gaps and must be reported.

Writes are atomic and protected by owned locks. MCP mutations are serialized per
session and fenced by renewable cross-process leases. Command evidence is
disabled by default, uses an executable plus arguments with `shell: false`, and
is restricted to the workspace. `deriveEvidenceCapability` is the single
capability derivation used by preparation, MCP views, and `doctor`; registry
readiness and live statuses do not enter state or prompt hashes.

The store lock's three staleness rules are three DIFFERENT rules — ownerless
lock directory, dead owner, and Windows EPERM — each named separately with its
own reason. The wait budget must exceed the dead-owner grace or the reclaim
branch is unreachable, and it must stay well below the live-owner case, which
blocks the single-threaded server and must fail fast. Attempts sleep between
retries; the loop is never a CPU spin.

Policy loading distinguishes "no file" from "defective file": ENOENT falls
through to the defaults, while unreadable, unparseable, or non-object
content throws with the stable `policy_invalid` code and the file path. The CLI
reports that code at the `mcp` startup boundary with a `doctor` pointer. The
`--target` flag selects the client skill location only; `--workspace` is the
runtime boundary and sets `process.cwd()` before any runtime object is
constructed.

The MCP server is synchronous JSON-RPC over stdio. Public tools are
`start`, `next`, `status`, `stop`, `pause`, `resume`, `replay`, `gate_check`,
and `gate_resolve`; gate tools are hidden and return `gate_disabled` unless
`policy.gate.enabled` is true. Tool responses use the uniform `{ok}` envelope
with a stable error `code` and separate human `message`.

Policy schema is version 4. Unknown keys or a mismatched version are
`policy_invalid`; do not merge invalid policy over defaults.

## Required commands

Run from `loopforge/`:

```bash
npm run check
npm run build
npm test
npm pack --dry-run --json
npm run verify:artifacts
git diff --check
```

Use a temporary clean mirror when `verify:artifacts` needs a HEAD comparison in
a dirty worktree.

## Hotspot checklist

- Prompt changes: cover budgets, hashing, density levels, same-round retry,
  protected overflow, deterministic truncation, rendered-vs-dropped priority,
  and identical-input determinism.
- Policy changes: cover schema version and unknown-key rejection.
- Protocol or evaluation changes: cover schema, handlers, lifecycle, malformed
  input, same-round retry, and unchanged state.
- Transaction changes: cover reject, backtrack, replay, concurrent next,
  pause, stop, and restart.
- Evidence changes: cover timeout, abort, unavailable provider, output caps,
  workspace boundaries, and contradictions.
- MCP changes: cover primitive JSON arguments, strict core arguments,
  structured output, uniform envelopes, stable error codes, and stdio.
- Contract changes: cover identity stability, item statuses, verified-fact
  survival after closure, coordinator/explain/audit agreement, and
  `contract_invalid` retry.
- Stop-reason changes: cover explicit blocked plus success and contradicted
  item plus success; `completed` must remain machine-true only.
- Scope-drift waiver changes: cover a covering blocked proposal being accepted,
  a non-covering one still being rejected, the waiver holding at a counter that
  would otherwise terminate, and the independent rows (contract debt, stall,
  unrestored workspace) still applying.
- Entrypoint-trust changes: cover a modified entrypoint, one created during the
  round (including a gitignored one git cannot see), restoration making the
  same round pass, backtrack on repeated non-restoration, a corrupt or absent
  baseline degrading to the git-delta arm, and the baseline surviving a
  restart.
- Store-lock timing changes: cover a lock left by a process that died moments
  ago being reclaimed, a live owner still failing fast, the ownerless grace,
  and the lock's release staying ownership-checked.
