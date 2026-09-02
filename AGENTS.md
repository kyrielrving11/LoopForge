# LoopForge

LoopForge is a cognitive state runtime for external AI coding Agents. It keeps
objectives, constraints, evidence, decisions, and recovery state stable across
Agent-driven rounds. It does not provide a model or unattended executor.

## Design philosophy

Long-horizon agent tasks face three mutually-reinforcing failure modes:

1. **Summary cascade** — each compression cycle loses information silently.
   After 3–4 cycles the agent's "memory" is a summary of a summary of a summary.
   LoopForge severs this chain: prompts are recompiled from typed vault entries,
   not from the previous prompt's summary.

2. **Self-correction failure** — models cannot reliably improve themselves
   through introspection (Google DeepMind). Effective recovery requires an
   external verifier that never shares the agent's context. LoopForge provides
   this via the verification gate (28 evidence cross-checks) and enforcement
   gate (14 cognitive-integrity rules).

3. **Compound error (p^N)** — each step's error becomes the next step's input.
   LoopForge partially addresses this via backtrack (v2.10: roll back to last
   clean round with lessons injected) and enforcement (stop before errors
   compound into catastrophe). Full solution requires in-execution guards,
   which is future work.

LoopForge is NOT a memory system, a context compressor, or a constraint tracker.
It is an **external cognitive infrastructure** — the perspective the agent
cannot provide for itself.

## Project rules

- TypeScript only.
- Node.js 18 or newer.
- Zero runtime dependencies.
- The npm package is in `loopforge/` and is currently `3.5.0`.
- Preserve user changes in a dirty worktree.
- Edit `src/protocol.ts`, then run the build to regenerate
  `loopforge-protocol.json`.
- Do not restore MCP Tasks, prompt-technique routing, automatic memory discovery,
  PromptCraft vault writes, or Markdown lineage fallback.

## Commands

```bash
cd LoopForge
npm run check
npm run verify:artifacts  # dist/ + protocol schema freshness gate (also runs in prepack)
npm run build
npm test
npm pack --dry-run --json
```

Run the full test suite in a temporary mirror when generated files in the active
worktree must remain untouched.

## Current architecture

```text
LoopForge/src/
  canonical-state.ts    CanonicalLoopState and deterministic hashing
                        (v3.3: Roadmap look-ahead view, round stats +
                        machine-status dashboard rows)
                        (v3.4: formatRoundContract renders the ACTIVE Round
                        Contract as the Current Task — derived state, never
                        the submission's proposal field)
  token-utils.ts        Shared Jaccard similarity, dedup, entry helpers (v2.5)
                        (v3.3: machineGitMotionSeries — per-round git motion
                        for the R4/R5 exculpatory cross-check and dashboard)
  prompt-policy.ts      L0/L1/L2 view selection
  prompt-assembler.ts   Single-pass PromptArtifact renderer
                        (v2.9: prompt_requests — model-expressed information needs)
  loop-compiler.ts      State evolution and prompt compilation
                        (v2.1: hierarchical summary with milestones)
                        (v2.2: sub-goal structured tracking with 5-state lifecycle)
                        (v2.3: time-aware constraint decay + auto-reactivation)
                        (v2.4–v2.5: adaptive L2 budget scaling)
                        (v2.5: agent trust score — derived from verification flags)
                        (v3.3: derived round stats + machine status; Round
                        Contract restatement in the L1/L2 eval template)
                        (v3.4: ACTIVE Round Contract derived from committed
                        rounds — drives the Current Task and the L1/L2
                        restatement template on every compile path)
                        (v3.5: L2 contract declaration nudge —
                        prompt.contract_nudge_on_l2, default true)
  engine.ts             Engine state, feedback, and lineage projection
  round-driver.ts       Shared Runtime and MCP round preparation/completion
  round-transaction.ts  Stable round ID, attempts, evidence, commit recovery
  round-contract.ts     v3.4: ACTIVE Round Contract derivation (proposal vs
                        active walker, shared item matcher); v3.5: shared
                        committedContractRounds raw-vault adapter — one
                        adapter + one walker serve the gate, session views,
                        and replay (view parity is test-locked)
  round-coordinator.ts  Verify, enforce, backtrack, and stop decision pipeline
                        (v2.10: backtrack action — roll back to last clean round)
  verification-gate.ts  Cross-round and evidence consistency checks (28 checks)
                        (v2.2: subgoal_drift; v2.10: safe restore point detection)
                        (v2.12: claim provenance + backtrack git HEAD)
                        (v3.3: verification-domain integrity — entrypoint
                        tampering / test-file changes; Round Contract checks —
                        underspecified / unverifiable / scope drift /
                        premature boundary; R4/R5 exculpatory cross-check)
                        (v3.5: contract_completion_unverified — closing a
                        contract is a success-class claim; contract_premature
                        warn — premature replacement is no longer silent)
  enforcement-gate.ts   Accept, reject, backtrack, or terminate rules (14 rules)
                        (v2.14: R-EVID — required command failure /
                        self-contradictory claims reject before commit)
                        (v2.10: R4/R5 escalate to backtrack instead of terminate)
                        (v2.12: R8 evidence-less success, R9 workspace restore)
                        (v3.3: R4/R5 exculpatory machine cross-check —
                        git motion or a newly met criterion vetoes a stall)
                        (v3.3: R-C1 premature boundary — contract done_when
                        claimed without machine evidence; R-C2 scope drift —
                        out-of-scope git changes with clarification exemption)
                        (v3.5: contract completion rule outranks R-C1;
                        backtrack header names the blocked+revision channel
                        for a stalled restored contract)
  evidence-claims.ts    v2.12: Derived claim provenance (verified/claimed/contradicted)
  cognitive-governance.ts v2.12: User/Agent gate classification + audit order
  loop-projection.ts    v2.12: Typed cognitive state projection (focus/todo/phase/…)
  audit.ts              v2.12: Read-only end-of-loop verification audit
  loop-store.ts         The single storage spine (v2.13: VaultBackend removed).
                        Typed, atomic per-loop JSON persistence and migration
                        (v2.12: round sequence stamps + corruption severity)
  evidence-provider.ts  Git, custom async, and explicit command evidence
  replay.ts             Typed round timeline and diff queries
  policy.ts             Runtime policy and safe derived state-file writes
  observability.ts      Structured tracing
  policy-metrics.ts     Verification and round outcome metrics
  cli.ts                Unified loopforge command
  mcp/
    session.ts          Durable leased MCP sessions
                        (v2.10: backtrack result builder + crash recovery)
                        (v2.12: gates, projection, audit accessors)
                        (v2.14: registry + leases + entry points only; the round
                        state machine moved to round-lifecycle.ts)
    round-lifecycle.ts  v2.14: Round state machine extracted from SessionManager —
                        crash recovery (reconstructSession, reconcileCommittedRound),
                        transaction execution, disposition result building, and the
                        advance pipeline. SessionManager owns "who may touch a
                        session"; this owns "what happens to a session".
    tools.ts            Nine validated tools and output schemas
                        (v2.9: prompt_requests in loopforge_next schema)
                        (v2.12: status views, gate_check/gate_resolve)
                        (v3.3: round_contract in the loopforge_next schema)
    server.ts           Synchronous JSON-RPC stdio server
```

### Long-Horizon Protocol Types (v2.1–v2.10)

```text
protocol.ts additions:
  MilestoneSummary      Phase-boundary snapshots (agent_declared | criteria_milestone | auto)
  SubGoal               Structured sub-goal with 5-state lifecycle (pending→done/canceled)
  ConstraintMeta        Per-constraint time metadata with source classification
  PromptRequests        Model-expressed information needs for the next prompt (v2.9)
  +3 SelfEvaluation fields: completed_subtasks, blocked_subtasks, canceled_subtasks
  +1 SelfEvaluation field: prompt_requests (v2.9)
  +2 LoopCompileResponse fields: constraints_inactive, constraint_metadata
  +4 RoundProcessResult fields: backtrackPrompt, backtrackTarget,
    backtrackSkippedDiscoveries, backtrackTriggerRule (v2.10)
  RoundContract         v3.3: optional per-round contract
                        (work_item / done_when / verification_plan / scope /
                        boundary_reason) on SelfEvaluation + LoopRoundResult
                        (v3.4: a submission's round_contract is a PROPOSAL
                        for the next round — it becomes ACTIVE only after the
                        declaring round commits, drives the Current Task and
                        the scope/premature checks until a committed eval
                        completes or blocks it. No longer carried in
                        last_round_result.)
```

## Invariants

- One canonical state produces one PromptArtifact per attempt.
- v3.0.1: every `loopforge_next` submission carries the roundId of the round
  it reports on. A mismatched roundId (the round already committed — lost
  response or duplicate call) is never processed: the held prompt is returned
  with a warning. Rejections keep the roundId, so retries match normally.
- v3.0.1: compile hydration is cached per engine and read incrementally (one
  round document per round boundary). The cache is derived, never persisted;
  `coveredRound` counts contiguous committed rounds only, so a fresh engine
  hydrates fully once and a warm cache can never serve unmerged state.
- v3.0.1: L1 milestone sampling keeps the oldest `milestone_head_count` and
  newest `milestone_tail_count` milestones plus an even middle sample when the
  cap is exceeded. L2 (full rehydration) never samples — the recovery view
  keeps every milestone as the loop's memory skeleton.
- v3.2: every L1/L2 Verification Gate flag (error/warn) carries an actionable
  continuation line (`→ Fix:` / `→ Action:`) mapped per check name; L0 stays
  byte-identical and info flags stay informational.
- v3.2: L1 collapses UNCHANGED presentation (vs the previous round's persisted
  `presented_*` snapshot on the lineage entry) into one-line state-file
  pointers; changed content renders in full; emphasized items never collapse.
  The diff baseline is durable (restart-deterministic); L2 never collapses.
  Kill switch: `prompt.l1_collapse_enabled` (default true).
- v3.2: the Goal → Criteria vertical view (`criterion_statuses`) and the
  Lessons Learned list (`lessons`) are compiler-derived, zero-persistence,
  presentation fields — they never upgrade or create enforcement outcomes.
  v3.3: where derived completion information participates in enforcement
  (the R4/R5 exculpatory cross-check), it is **exculpatory only**: it may
  veto a delta-based stall verdict when the machine window shows git motion
  or a newly met criterion, and it never constitutes new grounds for
  rejection or termination. Criterion IDs follow `constraint_id_enabled`
  like every other ID-rendering path.
- v3.2: the runtime derives a machine-verification status per round
  (`deriveEvidenceStatus`: providerStatus verified/unavailable/absent) from
  the already-collected snapshots — the agent supplies no new fields.
  A success claim without a machine-verified observation fires the
  `success_unverified` warn (never self-skips, even on heuristic extraction);
  the round still commits, but its success never enters the success
  trajectory and trust drops. `no_change_reason` is the escape hatch.
- v3.2: R4/R5 on the heuristic-extraction path fall back to machine progress
  (`machineProgressSeries`: per-round git observations rebuilt from committed
  feedback snapshots) instead of self-skipping — three consecutive rounds
  without git changes is a stall. No git signal → the rule keeps skipping
  (the machine cannot observe).
- v3.3: on the evidence path (`skipEvidenceRules=false`) the delta-based
  stall verdict additionally consults the machine window before it fires —
  when committed git snapshots cover the window, observed git motion OR a
  newly met criterion within the window (`hasNewCriteriaCompletion`, ID-first
  matching over committed `:feedback` entries only) means the round is
  NOT stalled; the rejection/backtrack reason then annotates the missing
  machine signal. When the machine signal is unavailable the legacy
  delta verdict stands unchanged. Exculpatory only — never new punishment.
- v3.4: **Round Contracts are proposals, not reports.** An eval without
  `round_contract` leaves all four contract checks silent and rendering
  byte-identical to a contract-less round (the canonical `roundContract`
  field is conditionally present — hash-neutral). A contract declared at
  round d becomes the ACTIVE contract for round d+1 (rendered as the
  Current Task via `formatRoundContract`, replacing the original task text
  in that section — the original objective stays in the Objective section)
  and stays active until a committed eval closes it. Close conditions,
  evaluated per committed eval executed under the active contract:
  (i) **complete** — every active `done_when` item appears in that eval's
  `success_criteria_met` (claims-based matching via the shared
  `contractItemMatches`; per-item machine backing is future work); or
  (ii) **blocked** — the eval's `outcome === "blocked"`. On close the
  closing eval's own proposal (if any) becomes active; with none the
  Current Task reverts to the original task text. A different proposal
  declared while the active contract is NOT closed is ignored (premature
  replacement — silent in v3.4, surfaced as a contract_premature warn in
  v3.5; the durable work item wins either way). The
  declaration round's own met claims never satisfy its own proposal. The
  derivation (round-contract.ts) is pure over committed evals — rejected
  and in-flight submissions never participate.
- v3.4: contract checks are purely mechanical and split by target.
  `round_underspecified` / `round_unverifiable` (warn, at declaration)
  validate the submission's own proposal — done_when non-empty and every
  verification_plan name a configured, enabled evidence command.
  `round_scope_drift` (warn) and `premature_boundary` (error) evaluate the
  ACTIVE contract the round actually executed under — derived from the
  committed evals of earlier rounds, never the submission's proposal — and
  stay silent when no active contract exists, including round 1 (no
  declaration off-by-one noise). Scope drift compares the round's
  fingerprint-narrowed git diff against the active scope and accepts a
  substantive drift_clarification (R7-style anchors, ≥ 20 chars);
  premature_boundary fires when success is claimed while active done_when
  items are claimed met without round-level machine verification, or
  silently dropped (neither met nor remaining). `no_change_reason`
  downgrades premature_boundary to info (the R8 escape-hatch family) but
  NEVER exempts scope_drift — it is a fact check, not a success-class
  claim.
- v3.4: rejection/retry (L0/L2), resume, unpause, and backtrack compiles
  derive the same ACTIVE contract from committed rounds (no
  `last_round_result` needed), so a contract round's re-compiles keep
  showing the contract as the Current Task. L0 retry templates still never
  inject the `round_contract` restatement block (lean), and contract-less
  rounds stay byte-identical. Current Task replacement is driven solely by
  the derived active contract — `last_round_result.round_contract` is
  never populated (buildLoopRequest stopped forwarding it) and must never
  be read as a contract source again: the field's only truth lives in the
  committed snapshot's `evaluation`, and the derivation is its single
  consumer.
- v3.5: **closing a Round Contract is a success-class claim and must be
  machine-backed.** When a submission's met claims satisfy every done_when
  of the ACTIVE contract whose verification_plan is non-empty,
  `contract_completion_unverified` fires (error; warn under
  `evidence.machine_backed_success: "warn"`) unless EVERY plan command name
  was observed passing (after-phase command snapshot, untampered) in the
  same round — regardless of the success flag. `no_change_reason` never
  downgrades it: all done_when met contradicts "no change". Plan names no
  longer configured+enabled are not required (fail open — cannot observe).
  The enforcement rule rejects on the first occurrence and terminates on
  the second consecutive (R-C1-style ladder) and is registered before R-C1.
  The check observes that the commands ran, not what they verified — R-C1's
  round-uniform claim model remains the content bound.
- v3.5: a different contract proposed while the ACTIVE contract is open is
  no longer silent — `contract_premature` (warn) fires when the eval
  neither completes (all done_when met) nor blocks the ACTIVE contract yet
  proposes a different one (equality is key-order-insensitive and
  normalized through parseRoundContract on both sides). The walker still
  ignores the premature proposal — the warn only surfaces the ignored
  state. Completion and blocked rounds never warn (closure is checked
  first, mirroring the walker's branch order).
- v3.5: L2 contract-less prompts append a short suggestion to declare a
  Round Contract for the next round when remaining work spans several
  rounds. The prose is L2-only, never contains the JSON key name, and
  L0/L1 prompts stay byte-identical to v3.4; L2 contract-less prompt
  hashes intentionally change. Kill switch: `prompt.contract_nudge_on_l2`
  (default true).
- v3.5: after a backtrack, a restored Current Task that is a stalled Round
  Contract is closed by declaring `outcome="blocked"` + blocker and
  proposing the revised contract in the same submission (the walker
  activates it next round); the backtrack header and the L2 eval template
  both instruct this, and silently restating the stalled contract is
  forbidden.
- v3.2.1: a committed backtrack decision is a roll-back directive, not the
  round's outcome — the advance path's idempotency replay skips it, so the
  redo submission (same roundId) is evaluated, not replayed; crash recovery
  (`recover()` → `reconcileCommittedRound`) still replays it to reset the
  round counter.
- v3.2.1: `findSafeRestorePoint` and the backtrack file list judge only
  committed feedback entries (`task_type !== "loop_lineage"`) — compile-time
  lineage entries hardcode `success: true` and carry no decision. A clean
  round is one whose committed decision is not reject/terminate/backtrack
  with no error-level verification flags; the agent's self-reported success
  does not disqualify it (a progress-stall round is a valid restore target).
- v3.2.1: after a backtrack committed for the current round, R4/R5 include
  the redo submission's own `progress_estimate` in the stall window
  (`progressWindow`) — the pre-rollback history would otherwise reject the
  redo forever and terminate spuriously. A redo that is still stalled keeps
  the window flat and hits the normal reject → terminate ladder.
- v3.3.1: R5 (`progress_stall_terminal`) is the flat-severity TIER, not an
  independently scheduled rule: its flatness predicate is a strict subset of
  R4's stall predicate and it is evaluated after R4, so under the default
  ladder every flat run is handled by R4 with the same reject →
  backtrack/terminate rhythm as any stall (backtrack-e2e locks that rhythm
  for exactly-flat runs). R5's own steeper ladder (terminate on the second
  consecutive flatline) becomes the active guard only when R4's delta gate
  is closed (`evolution.progress_stall_threshold <= 0` — R4 then fires only
  on regression, i.e. negative deltas) or after a future window/threshold
  split. It is the reserved severity tier, not dead code; do not delete it
  without first covering the threshold-0 configuration.
- v3.2.1: `autoFeedback`'s "already committed" idempotency check ignores
  backtrack decisions — the redo's feedback replaces the stale backtrack
  entry in the round document.
- v3.2.1: current-round `constraint_violations` (last_round_result) feed the
  constraint lifecycle — `last_violated_at_round` reaches the current round
  (drives the L1 collapse "(violated this round)" annotation) and a decayed
  discovered constraint violated this round re-activates.
- v3.2.1: emphasize is a pure reorder for hard constraints and success
  criteria too — matched items are removed from BOTH their source sections
  (Active Hard Constraints / Success Criteria) and the active list before
  Critical Context renders them.
- v3.2.1: sub-goal lifecycle fields (completed/blocked/canceled subtasks)
  persist on committed feedback entries — subgoal_drift reads them
  cross-round.
- v3.2.1: the drift clarification streak is touched only when R7
  participated in the decision (`clarificationAccepted` set on the continue
  path) — a higher-priority rule's rejection never increments it.
- v3.2.1: `create()` pre-flights the cross-process lease before compiling
  (compile writes round-1 lineage + state file) and rolls back its in-memory
  registration when the save-time lease race is lost — a conflict never
  pollutes another process's vault nor deadlocks later creates.
- L0, L1, and L2 control state density, not reasoning technique.
- Rejection keeps the logical round ID, increments attempt, and commits nothing.
- Backtrack resets the round counter to (last clean round + 1), commits nothing
  from the skipped rounds, preserves valid discoveries from skipped rounds, and
  injects a "why this path failed" diagnosis. Only R4 (progress stall) and R5
  (flat terminal) trigger backtrack. R6 (max rejections) still terminates.
  R9 (workspace not restored) backtracks again instead of accepting unrestored
  work; the restore point's git HEAD is captured and enforced. v2.14: if a
  backtrack already committed at or after the current round, R9 terminates
  instead of backtracking again — backtracks do not increment the rejection
  counter, so a non-restoring agent would otherwise cycle forever.
- v2.14: if a backtrack already committed at or after the current round, the
  next R4/R5 escalation terminates instead of backtracking again — a
  persistently stalled loop cannot cycle reject↔backtrack forever.
- v2.14: a committed round's full decision (verification flags, round success,
  and the agent's SelfEvaluation) is merged into the compile-time lineage entry
  when the loop context is hydrated — milestones, constraint decay, sub-goal
  accumulation, and restore-point selection all derive from it.
- All round processing goes through the SessionManager → RoundLifecycle →
  RoundDriver → RoundCoordinator path.
- Typed JSON session and round documents are the durable truth.
- v2.12: round documents carry a monotonic `sequence` stamp; write-time
  continuity and load-time gap detection (`checkRoundSequence`) enforce crash
  consistency. Corrupt JSON/format/sequence violations surface as
  `StorageCorruptionError` with severity — never silently repaired.
- v2.14: `checkRoundSequence` runs on session reconstruction (resume /
  unpause / auto-resume), not just audit. Auto-resume skips recoverable
  gaps and continues; explicit resume surfaces them. A stamped loop WITH a
  session document must start at round 1 — missing prefix rounds are
  deletion, not legacy import.
- v2.14: `writeSession` stamps `metadata.json` so created-but-uncommitted
  loops are discoverable; `listLoopIds` recovers loop IDs from the session
  document when metadata is missing. A lock directory without `owner.json`
  (crash between mkdir and owner write) self-heals after a short grace.
- v2.12: claim provenance is derived, not persisted — re-derivable from the
  committed transaction snapshot. Only machine evidence upgrades a claim.
- v2.12: gates are a record layer. Only decisions persist; gate state is
  re-derived via `deriveGate`. Gates never block the round decision flow.
- v2.14: rounds committed with action "backtrack" are rolled back — the
  audit and vault-derived metrics exclude them from the final history (their
  error flags cannot flip the verdict). The round document is replaced when
  the redo commits.
- v2.14: R7's no-clarification drift counts toward the SAME streak as weak
  clarifications (`drift_clarification_max_streak` consecutive un-explained
  drifts terminate) — the global rejection counter is not used, so an
  unrelated earlier rejection cannot terminate the loop on the first drift.
- v2.14: policy-metrics `roundAttempts` includes this process's uncommitted
  rejects/terminates (they never commit, so the vault cannot see them);
  `terminatedRounds` comes from the live snapshot (vault-derived is
  structurally 0).
- `.loopforge/state/<loopId>-state.md` is an optional derived view.
- Session and round writes are atomic and protected by owned locks.
- MCP mutations are serialized per session and fenced by renewable leases.
- The external Agent owns long-running work. LoopForge does not implement MCP
  Tasks or a background Agent.
- Context providers, terminal sinks, trace sinks, and checkpoint sinks are
  explicit. Never auto-discover integrations.
- Command evidence is disabled by default, uses executable plus args with
  `shell: false`, and may only run inside the workspace.
- A required command failure contradicts a success claim before commit.
- prompt_requests is consumed each round — not durable across rounds.
  The Compiler honors requests within safety boundaries (mandatory sections
  are never removed, budget is never bypassed). L0 ignores all requests.

## Storage layout

```text
.loopforge/
  loops/<sha256(loopId)>/
    metadata.json
    session.json
    rounds/<round>.json   # carries a v2.12 `sequence` stamp
  state/<loopId>-state.md
  migrations/
```

v2.12: round documents carry a monotonic `sequence` stamp. Write-time
continuity (round N requires N-1) and load-time gap detection
(`checkRoundSequence`, recoverable `sequence_gap` / corrupted
`sequence_invalid`) enforce crash consistency. Legacy loops without stamps
are exempt.

Legacy `.promptcraft/prompt_vault.json` is read only by the explicit migration
command. Migration must not delete the source.

## CLI

```bash
loopforge mcp
loopforge init --client claude|codex|generic [--target DIR] [--force]
loopforge doctor [--json]
loopforge inspect LOOP_ID [--round N] [--prompt] [--json]
loopforge migrate [--from PATH] [--json]
```

## Before changing a hotspot

- Prompt changes require PromptArtifact budget, hashing, and same-round retry
  coverage.
- Transaction changes require reject, backtrack, commit replay, concurrent next,
  pause, stop, and restart tests.
- Store changes require prefix isolation, live and stale lock ownership,
  migration idempotence, and cross-process lease tests.
- Evidence changes require timeout, abort, unavailable provider, output cap,
  workspace boundary, and verification contradiction tests.
- MCP changes require primitive JSON, strict arguments, structured output, and
  process-level stdio tests.
- v2.14: every tool's declared outputSchema is enforced — the MCP server
  validates each handler output before returning it; a schema-violating
  output is a contract bug surfaced as a JSON-RPC error, not silently shipped.
- v2.14: `loopforge inspect` without `--prompt` strips every prompt-text field
  (substring match on "prompt", including nested renderedPrompt) — prompt
  artifacts are reduced to their metadata (level, hashes).
- Long-horizon compiler features (milestones, sub-goals, constraint decay,
  adaptive budgets, trust scores, prompt_requests, backtrack) are derived from
  vault entries each round — no new persistence formats.
  - Hard/plan/criteria constraints never auto-decay.
  - Milestone triggers follow priority: agent_declared > criteria_milestone > auto.
  - Sub-goal status is compiler-derived; the agent owns execution.
  - All Jaccard similarity thresholds are policy-driven (v2.5).
  - prompt_requests is transient — consumed each round, not persisted in
    canonical state. Emphasize is pure reorder (zero token overhead). L0 ignores
    all requests.
  - v2.14: emphasize items matched against active state are MOVED to the
    Critical Context section — the source sections lose them, so the total
    token count is unchanged; unmatched emphasizes are dropped.
  - v2.14: agent-declared retractions of plan/hard/criteria constraints stay
    out of the active set for `constraints.retire_window` rounds (derived
    from vault entries), then return — hard/plan/criteria never auto-decay;
    only the retraction's memory expires.
  - v2.14: a committed backtrack for the current round forces L2 rehydration
    (recovery boundary).
  - Backtrack safe restore point is computed on-demand from vault entries.
    Max search depth is policy-controlled (default: 3). Only R4 and R5 trigger
    backtrack; R6 still terminates.
- CheckpointSummary is deprecated in v2.5; use MilestoneSummary with
  kind: "agent_declared" instead. The checkpoint_summary field on
  LoopCompileResponse is always null.
- Agent trust score and stop_reason are derived fields — trust from
  verification gate flags, stop_reason from SelfEvaluation. Neither
  requires new persistence.
