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

LoopForge maintains durable cognitive state and an auditable round transaction
for a task the external Agent executes. Work decomposition comes from committed
round facts and Canonical State — never from a parallel notion of progress.

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

Optional fields are normalized and lenient. Three are structural exceptions —
`subgoal_updates`, `round_contract`, and `execution_report.contract_item_claims`
— validated BEFORE advance against the same derived set the agent was shown,
and rejected rather than normalized (`contract_invalid` for contract shape,
limits, command bindings, workspace containment, references, or duplicate item
IDs). Everything else — `criterion_claims`, worker results, `gate_ids` — is
advisory, and malformed entries are dropped.

No optional value is dropped silently. `normalizeSelfEvaluation` returns a
stable diagnostic list (field path, reason code, handling, correction) and the
known submitted-field manifest. Unknown and retired fields are diagnosed and
dropped; they are never treated as accepted. Valid submissions persist their
diagnostics and manifest in the transaction snapshot. Strict failures return
the same diagnostic vocabulary for that attempt only and still happen before
any persistence or side effect. `worker_results.discoveredConstraints` is a
REPORT: only top-level `discovered_constraints` promotes a finding into the
global constraint stream.

Field accounting separates **attempted** from **retained**. `submittedFields`
is the attempted manifest: known paths present in the raw payload.
`deriveFieldAccounting` derives the retained set at read time from the persisted
manifest, diagnostics and normalized evaluation; it never re-parses the raw
payload and is never persisted. A committed transaction always carries its
manifest. A field is retained when it was attempted, has no exact-path
whole-field drop, and carries a value; a partial array loss remains retained
with its diagnostic visible. `attemptedFieldUsage` and `retainedFieldUsage` are
separate metrics; `retainedFieldUsage` is the adoption metric and must be shown
with its round coverage, never as a bare count.

`criterion_claims` references are matched against the criterion set the compile
rendered: a real `cr-` id or the exact normalized text. A reference the prompt
did not render is dropped with a diagnostic (`unknown_id`, or
`all_entries_dropped` when none survive), never a rejection. An unobservable
reference space fails open; an observed empty one drops every claim. The
display cap does not narrow validation.

A success claim with an empty/missing `execution_report` is a reporting gap
(warn), never an acceptance gate: acceptance is decided by machine evidence and
contract rules, not optional-field coverage. The machine-evidence warn still
keeps an unbacked success out of the success trajectory.

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
  restoration before the redo. The first post-rollback submission is a recovery
  checkpoint: it proves the restore, and only then may the redo commit work.
  Restoration is judged against the restore point's OWN machine snapshot — the
  same HEAD and no dirty file the restore point did not already have — so
  unrelated work in progress is never read as a failed restore.
- Terminate returns a terminal result without committing the rejected or
  terminating evaluation as a normal round.
- Stop decisions prioritize an explicit blocked declaration. `completed`
  requires effective success and a verified contract, or no active contract.
  A blocked or contradicted contract cannot produce `completed`.
- One definition of "this round declares itself blocked" serves the stop
  decision and the scope-drift waiver both.
- The completion-truth guard runs before the transaction commits and again at
  the lifecycle end. A violation is a code defect: it downgrades to `blocked`
  and reports, rather than throwing.

Round IDs prevent lost responses and duplicate submissions. Transaction
recovery must remain idempotent after process interruption.

## Evidence and contract invariants

Verification checks are pure functions of their inputs. The enforcement gate
uses one ordered strategy table; row order is priority and a row owns its
escalation ladder. Do not add a category field or revive numbered rule
semantics.

Agent reports are claims, never machine evidence. A success claim needs an
independent machine observation, normally a passed after-phase command whose
entrypoint and configuration are untampered. `no_change_reason` is an escape
only when no verification command is configured. A stall verdict is a machine
judgement: only an observable Git history over the lookback window can produce
one, and only machine motion can cancel one — the submitted round's own motion
included. File delta, HEAD movement, and a HEAD back at the rollback's restore
point are the whole of that motion, from one shared definition, and no agent
report can create or cancel a stall.

The entrypoint check has two arms, unioned. The absolute arm compares each
entrypoint file's current content against a trusted baseline captured from the
FILESYSTEM when the round was prepared — git cannot see a gitignored
entrypoint, and a baseline re-derived from the current tree would compare
tampered state against itself. The baseline lives in session state, never in
committed round history; it is seeded only for a round being PREPARED, never
for a same-round retry, and its absence means "no absolute arm", never a lost
round. An entrypoint created during the round cannot back that round: restore
it, or take the rollback so the work is redone where it is part of the
starting state. Repeated non-restoration backtracks; it does not terminate.

Every configured evidence provider emits one typed observation, including
`unavailable`, `timeout`, `error`, or `aborted`. Do not silently filter failed or
unavailable observations. Transactions persist before/after observation
collections; the round delta is derived.

The Git observation is the COMPLETE boundary: every tracked path plus every
non-ignored untracked path, content-fingerprinted (regular file, symlink link
text, gitlink index commit, directory, missing, unreadable). The round delta is
the union-key comparison of the before/after maps — never the dirty-files list,
and never a re-read of the last commit. `execution_report.files_changed` uses
the same boundary meaning, including deletions; a commit alone adds no entry
when content is unchanged. An unavailable/timeout/error/aborted boundary is
unobservable and fails open; it must not read as an empty diff or an agent
omission. Gitignored paths and submodule contents are outside the declared
coverage; the filesystem entrypoint-trust baseline remains independent.

`MachineObservation.files` is observation-local display data: the Git dirty
list, always-empty command files, or provider-defined custom metadata. It is
never the round change set. The derived `ObservationDelta.changedFiles` is the
only change set. `[]` is an observed no-change; `null` is unknown and must never
be read as empty or as a pass. Git has three states: `not_applicable` (no Git
provider participated), `unknown` (a Git boundary pair cannot be compared), and
`observed`. A contract item requires `observed`; `unknown` makes a passed
command `insufficient`, while `not_applicable` leaves the entrypoint arm out.
Stall motion is tri-state: HEAD movement can prove motion, but unknown files
with no HEAD evidence produce no verdict. `evidenceIncomplete` is true for a
no-baseline Git round.

Round Contract rules:

- A proposal is item-based and becomes active only after its declaring round
  commits.
- Each item has at least one configured, enabled, after-capable evidence
  command.
- Contract and item IDs are content-addressed; restating an unchanged contract
  preserves identity.
- Item states are `pending`, `insufficient`, `contradicted`, or `verified`.
- `verified` requires a `met` claim and every bound command passing in the
  closing round with the declaration's binding intact.
- A contract closes only when every item is verified or a round reports
  `outcome: "blocked"`.
- A different proposal while the active contract is open is ignored and
  surfaced as `contract_premature`.
- A claimed-but-unbacked item is recorded as verification debt, escalated
  after a bounded run of rounds and counted on the same check's streak only.
- Scope drift is a machine fact with no clarification waiver. Its one legal
  exit is a blocked round that declares a successor contract covering EVERY
  drifted file: that waives the rejection, never the fact, and the flag still
  lands on the committed round. The coverage set is derived, never read from a
  flag's truncated detail. The waiver removes the drift rejection only;
  contract debt, machine stalls, and unrestored workspaces still apply, and a
  waived round does not reach the rejection-counter catch-all.

The live coordinator, explain, and audit share one contract derivation, and
verified sub-goal facts read the whole committed history so they survive
contract closure.

## Prompt and projection invariants

`submission-guidance.ts` is the single source for evaluation-field meaning,
applicable events, legal examples and downstream effects. The tool schema,
the prompt's evaluation block, `submission_guidance` and the receipt all read
it; none owns a second copy. Prompt examples may cite only real ids rendered by
the current prompt or the live guidance — never a fabricated `sg-`/`rci-` id.

The prompt's evaluation block uses a compact trigger checklist built from the
same `GUIDES` table. `isFieldApplicable` is the one semantic applicability rule;
`isFieldPrompted` is the level-aware presentation subset. There is no
hand-maintained optional-field list. Real criterion ids/text come from the
compile's `criterion_statuses`; the full legal shapes remain in
`submission_guidance`. Optional fields are opportunities, not a coverage
checklist — omission stays correct. `round_contract`, `contract_item_claims`
and `subgoal_updates` keep their dedicated renderers with real ids.

`submission_guidance` and `submission_receipt` are read-only projections of
current/committed facts. They are not persisted as a second ledger. The
receipt separates saved reports, derived-state effects and machine verification;
a rejected/terminated attempt is `not_applied`, and a backtrack reports only
what it actually preserved. `submission_receipt.files_reconciliation` is the
one reported-vs-observed comparison (`deriveFilesReconciliation`) over the
shared `ObservationDelta.changedFiles`: exact path sets, `[]` = observed no
change, `null` = unknown, and `unknown`/`not_applicable` never become a
mismatch. It is receipt-only and never next-prompt input. `promptRequestEffects`
records what the CURRENT prompt did — it must never be read by compile or
decision code as an instruction for a later prompt.

L0, L1, and L2 select prompt density only. L2 is entered for factual round
conditions such as first round, plan boundary, committed recovery, machine
contradiction, checkpoint boundary, or repeated rejection; there is no
round-count timer.

One fixed section-priority table owns prompt assembly. Mandatory sections are
protected: they render first and are never dropped or truncated. Optional
sections are removed strictly from lowest priority first, with at most one
partial optional section. If the protected set exceeds the budget, render it
and record the overflow on the artifact.

The prompt artifact records the current prompt only. It must not encode what a
later prompt should do. An unparseable artifact, an unsupported transaction
or observation schema, or a missing embedded transaction snapshot is a
hard break that is reported, never silently discarded.

The optional state file is derived from committed facts and is regenerated
without depending on prompt level. Its verified sub-goals are forwarded from
the same cognitive derivation used by canonical state.

## Storage and integration invariants

Round documents carry `sequence === round`; missing or unstamped rounds are
corruption or recoverable gaps and must be reported. Derived state is separate
from committed rounds and from the session document.

Writes are atomic and protected by owned locks. MCP mutations are serialized per
session and fenced by renewable cross-process leases. Command evidence is
disabled by default, uses an executable plus arguments with `shell: false`, and
is restricted to the workspace. One capability derivation serves preparation,
MCP views, and `doctor`; registry readiness and live statuses do not enter
state or prompt hashes.

The store lock's three staleness rules are three DIFFERENT rules — ownerless
lock directory, dead owner, and Windows EPERM — each named separately with its
own reason. The wait budget must exceed the dead-owner grace, and it must fail
fast for a live owner. Attempts sleep between retries; the loop is never a CPU
spin.

Policy loading distinguishes "no file" from "defective file": ENOENT falls
through to the defaults, while unreadable, unparseable, or non-object
content throws with the stable `policy_invalid` code and the file path. The
`--target` flag selects the client skill location only; `--workspace` is the
runtime boundary and sets `process.cwd()` before any runtime object is
constructed.

The MCP server is synchronous JSON-RPC over stdio. Public tools are
`start`, `next`, `status`, `stop`, `pause`, `resume`, `replay`, `gate_check`,
and `gate_resolve`; gate tools are hidden and return `gate_disabled` unless
`policy.gate.enabled` is true. Tool responses use the uniform `{ok}` envelope
with a stable error `code` and separate human `message`.

The policy schema version is a boundary: unknown keys or a mismatched version
are `policy_invalid`, and the version moves whenever the key surface changes.
Never merge an invalid policy over the defaults.

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
a dirty worktree. `npm pack --dry-run` runs `prepack` (`verify:artifacts` +
build), so in a dirty worktree run the inventory with `--ignore-scripts` and
run the scripted prepack in the clean mirror.

## Hotspot checklist

- Prompt changes: cover budgets, hashing, density levels, same-round retry,
  protected overflow, deterministic truncation, rendered-vs-dropped priority,
  and identical-input determinism.
- Field-decision changes: cover the compact trigger checklist (max seven
  fields), semantic applicability vs level-aware prompting, real `cr-` ids and
  texts, the L0 subset, no fabricated ids, and omission-stays-correct.
- Criterion-claim changes: cover real-id and exact-text matches, unknown
  references dropped with diagnostics, partial/all drops, fail-open on an
  unobservable reference space, and an observed-empty space.
- Policy changes: cover schema version and unknown-key rejection.
- Protocol or evaluation changes: cover schema, handlers, lifecycle, malformed
  input, same-round retry, and unchanged state.
- Transaction changes: cover reject, backtrack, replay, concurrent next,
  pause, stop, and restart.
- Evidence changes: cover timeout, abort, unavailable provider, output caps,
  workspace boundaries, and contradictions.
- Files-reconciliation changes: cover match/mismatch/unknown/not_applicable,
  omitted vs explicit-empty reports, duplicate reported paths, multiple Git
  deltas, exact-path semantics, gate/receipt/metrics agreement, and live vs
  committed rebuilds.
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
- Stall-detection changes: cover committed work with a clean worktree counting
  as motion through HEAD, an unobservable Git round yielding no verdict, the
  submitted round's own motion excusing a stalled window, a round that moved
  nothing keeping the verdict, and the deadlock guard still terminating a
  stalled round that a rollback already moved.
- Backtrack-restore changes: cover work in progress that the restore point
  already carried being accepted, a file the failed rounds left dirty being
  rejected even behind a matching HEAD, the before-snapshot arm, and an
  absent restore-point baseline degrading to HEAD equality.
- Diagnostics changes: cover unknown/retired fields, wrong types, caps,
  truncation, deterministic order, the strict-error vocabulary, unchanged
  state after a same-round retry, and the attempted→retained invariant for
  every field (partial loss, explicit empty, whole-field drop, truncated
  diagnostics).
- Field-accounting changes: cover metric coverage, receipt labels, and the
  absence of any second retained ledger.
- Observation-delta changes: cover before-only/after-only, missing before,
  non-observed statuses, malformed fingerprints, duplicate keys, non-Git
  providers, clean-worktree commits, and unknown vs observed-no-change.
- Guidance/receipt changes: cover no fabricated ids, real contract/sub-goal
  ids, rejected/terminated `not_applied`, backtrack only-preserved facts,
  lost-response replay, and report-vs-verification separation.
- Boundary-observation changes: cover a committed change, amend/HEAD move,
  deletion, rename, pre-existing dirt unchanged/changed, non-ASCII path,
  gitignored coverage, non-repository, timeout and no silent omission.
- Read-view changes: every new projection consumes `readOnlyRounds` and the
  existing `derive*` functions; unsupported envelope versions are reported,
  never dropped silently.
