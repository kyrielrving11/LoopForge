# Changelog

## 3.0.0 (2026-08-14)

**Planning-first workflow and evidence-governed completion.** LoopForge is now
positioned as the state, constraint, plan-execution, and evidence governance
layer for long-horizon tasks, while the external Agent remains responsible for
all code reading, editing, testing, and engineering decisions.

- Added process-level workspace/store binding to `loopforge_start` and
  `loopforge_resume`, canonical workspace identity, recovery diagnostics, and
  a non-authoritative Store locator without increasing the 12-tool MCP surface.
- Routed policy, Git/command evidence, typed Store paths, and Markdown
  projections through the bound workspace. Typed JSON remains the only
  recoverable truth; incomplete or corrupt Stores stop recovery.
- Added CLI `--workspace` and `--store-dir` support for MCP, doctor, inspect,
  migrate, and explicit client registration.

- Added workflow phases: planning, awaiting approval, executing, auditing, and
  terminal. New sessions always use the v3 planning/report contract.
- Added session-scoped approval policies: `risk_only` (the default) lets
  low-risk revisions and stage refinements proceed automatically, while
  `every_revision` enables explicit user review at every plan version. Fixed
  high-risk tags remain mandatory approval gates in both modes.
- Added structured versioned plans with stable `ps-*` IDs, DAG validation,
  rolling refinement, acceptance/evidence requirements, and a 50-step limit.
- Added fixed high-risk approval tags and exact `approvalId`/`planVersion`
  fencing for destructive, migration, production, credential, external-side-
  effect, and public API breaking work.
- Added `loopforge_plan_submit`, `loopforge_plan_update`, and
  `loopforge_plan_approve`; all advancing responses now include workflow state
  and `requiredAction`.
- Added one-active-step execution, structured step outcomes, plan-aware drift
  priority, final audit gating, plan-aware replay/status/state Markdown, and
  backtrack restoration of the effective plan revision.
- Replaced the pre-release self-evaluation payload with a compact fenced
  `roundId + report` contract. Runtime Git/command evidence is normalized into
  a typed evidence envelope with stable `ac-*`, `er-*`, and `cr-*` claims.
- Added deterministic `step_start`, `step_continue`, `step_retry`,
  `refine_plan`, and `audit` prompt modes. Prompts remain per-attempt artifacts,
- Added the adaptive `minimal`/`full` planning profiles, deterministic plan
  change impact classification, structured plan-linter diagnostics, and
  bounded repair hints for planning/refinement failures.
- Added derived `ro-*` regression obligations from verified evidence checks;
  later step completion and audit evidence now protect earlier passing checks
  without adding a second persistence store.
  while the approved step stays stable until its evidence closure is accepted.
- Replaced subjective v3 progress stall checks with material evidence movement,
  added derived workflow readiness/progress, capability preflight on
  start/resume, and exact external-gate recovery through `loopforge_resume`.
- Made the material-evidence stall window honor
  `evolution.progress_stall_rounds` with a three-round default, and compare Git
  content fingerprints so unchanged dirty paths do not reset the window.
- Removed the audit-only requirement for a runtime check when every audit claim
  already has other runtime-verified evidence. Agent-claimed checks remain
  insufficient, and required commands and `ro-*` obligations still require a
  verified passing check.
- Replaced the JSON-in-string compiler `plan_source` bridge with a typed prompt
  compilation context; removed dead Agent-trust and lexical-alignment compiler
  state; and retained useful v3 outcomes/milestones as `ExecutionHistorySummary`.
- Renamed the packaged skill to `$loopforge`. Client registration now requires
  explicit `--register` and uses the installed absolute Node/CLI path.
- Added workflow doctor checks, GitHub Actions CI, contribution/security
  policies, UTF-8/LF attributes, and synchronized English/Chinese docs.
- Removed pre-release session compatibility, embedded evaluation parsing,
  direct-execution mode, the internal SelfEvaluation/sub-goal task model, and
  dead v2 policy controls. Schema 1 and missing-workflow sessions remain
  untouched on disk and are reported under `incompatibleSessions`.
- Reduced the root package API to supported v3 plan/report/workflow types,
  pure validators, stable claim IDs, and replay. Removed the
  `loopforge/compiler` export; Engine, Compiler, SessionManager, normalized
  evidence, and transaction types are internal implementation details.
- Upgraded typed session and round transaction documents to schema 3. Report
  parsing is strict at every nested level, and `contextRequest` now has one
  canonical wire shape: `emphasize` and `confusion_points`.
- Added refinement lineage (`refinesStepId`/`refinementLinks`), typed workflow
  events, deterministic read-only governance graph replay, graph diagnostics,
  and active-step graph-slice prompt context. The graph is derived only and
  never schedules work or becomes a second persistence truth.
- Version sources are unified at `3.0.0`. Zero runtime dependencies remain.

## 2.11.0 (2026-08-05)

**Stable IDs across constraints and criteria, strengthened drift clarification, and
backtrack workspace restore.** Three reinforcing improvements that eliminate
Jaccard false positives/negatives from constraint matching, prevent R7
clarification abuse, and close the state-vs-filesystem consistency gap after
backtrack.

### Constraint & Criterion ID System — v2.11

The sub-goal pattern (`sg-XXXXXXXX`, stable hash-derived IDs used for exact
matching with Jaccard fallback) is now extended to constraints and criteria.
This eliminates the four remaining Jaccard-only matching sites that caused
false positives and false negatives.

- **`ConstraintMeta.id`** — stable constraint ID (`c-XXXXXXXX`) derived from
  text hash, populated by `manageConstraintLifecycle()`.
- **`deriveConstraintId()` / `deriveCriterionId()` / `isConstraintId()` /
  `isCriterionId()`** — ID derivation and pattern-matching helpers, same hash
  strategy as `deriveSubGoalId()`.
- **ID-first matching** — `findDiscoveredRound()`, `findLastViolatedRound()`,
  `detectNewCriteria()`, and `matchEmphasize()` all try exact ID match first,
  then fall back to Jaccard for backward compatibility.
- **IDs rendered everywhere** — L1 prompts, L2 state file (Success Criteria,
  Hard Constraints, Active Constraints, Inactive Constraints), and the
  self-eval template all show IDs with `\`c-XXXXXXXX\`` / `\`cr-XXXXXXXX\`` tags.
- **`constraint_id_enabled`** — new `EvolutionPolicy` field (default `true`).
  Set to `false` to restore pre-v2.11 pure-Jaccard behavior.
- **470 tests** (was 460). IDs are deterministic — same text always produces
  same ID across rounds.

### Drift Clarification Strengthening — v2.12

R7 previously waived rejection for any `drift_clarification` ≥ 20 characters —
trivially gameable with filler text. Now requires a **semantic anchor** and
tracks consecutive weak clarifications.

- **`hasSemanticAnchor()`** — checks for constraint/criterion/sub-goal IDs
  (`c-`/`cr-`/`sg-XXXXXXXX`) or file paths in the clarification text.
- **Substantive clarification = length ≥ 20 + anchor present** → accept,
  `clarification_accepted: true` on EnforcementResult.
- **Weak clarification = length ≥ 20 but no anchor** → increment streak.
  Streak 1: reject with stronger instructions. Streak ≥
  `drift_clarification_max_streak` (default 3): terminate.
- **`driftClarificationStreak`** — new field on `McpSession`, persisted in
  vault. Reset to 0 on any round without intent_drift.
- **`drift_clarification_max_streak`** — new `EnginePolicy` field (default 3).
  Set to 0 to disable the streak limit (pre-v2.12 behavior).
- **479 tests** (was 470). Streak tracks substantiveness — genuine pivots with
  recognized IDs don't count against the agent.

### Backtrack Workspace Restore — v2.13

Backtrack previously only reset LoopForge's vault state — the physical
working directory retained changes from the failed rounds. Now the backtrack
prompt includes concrete restore instructions, and the verification gate
enforces the check on the next submission.

- **Git HEAD capture** — `GitEvidenceProvider` now captures `git rev-parse HEAD`
  as `head` in `ProviderSnapshot.data` for restore point tracking.
- **Backtrack prompt rewrite** — `buildBacktrackPrompt()` now includes a
  dedicated "Workspace Restore Required" section with concrete commands
  (`git checkout -- . && git clean -fd`, `git stash` option), affected file
  lists from skipped rounds, non-git fallback, and a verification warning.
- **`checkBacktrackWorkspaceRestore()`** — new verification gate check. Compares
  the agent's `files_changed` against skipped-round files. ≥ 3 overlap → error
  flag → enforcement reject. 1–2 overlap → warn.
- **`backtrackSkippedFiles`** — threaded through session → round driver →
  round transaction → verification gate. Persisted in vault for crash recovery.
- **`backtrack_auto_restore`** — new `EnginePolicy` field (default `false`).
  DANGEROUS: when true, LoopForge auto-executes `git stash + reset --hard`
  on backtrack. Default-off — the prompt + verification approach is the safe
  default.
- **491 tests** (was 479).

### Policy additions

```json
{
  "engine": {
    "drift_clarification_max_streak": 3,
    "backtrack_auto_restore": false
  },
  "evolution": {
    "constraint_id_enabled": true
  }
}
```

## 2.10.0 (2026-08-05)

**Prompt Requests and Backtrack.** Two interlocking mechanisms that give the
model structured influence over its own prompts and a way to recover from dead
ends without human intervention.

### Prompt Requests (`prompt_requests` — v2.9)

The model can now express information needs at the end of each round via a new
optional `prompt_requests` field in SelfEvaluation:

- **`emphasize`** — constraints, discoveries, or decisions the model needs
  highlighted. Matched via Jaccard similarity against active state, pulled into
  a "Critical Context" section. Pure reordering — zero token overhead.
- **`expand`** — structured sections (`milestones`, `sub_goals`,
  `constraint_lifecycle`, `agent_trust`, `progress`, `loop_synthesis`) the model
  needs in full L2 detail while in L1 mode. Max 1 section in L1.
- **`confusion_points`** — things the model is confused about. Rendered at the
  prompt top as "Confusion Alerts" with auto-matched state section pointers.

Level behavior: L2 honors all (emphasize ≤5, confusion ≤3). L1 honors limited
(emphasize ≤3, expand ≤1, confusion first entry only). L0 ignores all.

### Backtrack (`backtrack` — v2.10)

When the enforcement gate detects a dead end (progress stall R4, flat terminal
R5), instead of terminating the loop, the agent is now rolled back to the last
**clean round** — an accepted round with no error-level verification flags:

- **Safe restore point** — computed on-demand from vault entries. Scans
  backwards from the current round, max depth 3 (policy-controlled). Skips
  rounds with errors, rejections, or regressions.
- **Lessons injected** — the backtrack prompt includes a "Why This Happened"
  diagnosis and "What Must Change" guidance, specific to the trigger rule.
- **Preserved discoveries** — `discovered_constraints` from skipped rounds
  are merged into the restored state's active constraints.
- **Terminate fallback** — if no clean round is found within maxDepth,
  backtrack falls through to terminate.

Backtrack only triggers from R4 and R5. R6 (max rejections), R1 (fake success),
R3 (empty success), and R7 (intent drift) behavior is unchanged.

### Policy additions

```json
{
  "engine": {
    "backtrack_enabled": true,
    "backtrack_max_depth": 3,
    "backtrack_preserve_discoveries": true
  },
  "prompt": {
    "max_emphasize_l2": 5,
    "max_emphasize_l1": 3,
    "max_expand_l1": 1,
    "max_confusion_points": 3
  }
}
```

## 2.8.0 (2026-08-05)

**L2 Pointer Mode, Sub-Goal ID referencing, and Drift Clarification.** Three
independent improvements that together reduce MCP tool result size by ~60% at
L2, eliminate Jaccard-based semantic guessing for sub-goal matching, and give
the agent a way to explain intentional pivots before enforcement rejects them.

### L2 Pointer Mode (`l2_pointer_enabled`)

When an L2 prompt's full state blob (~40K chars) is returned as an MCP tool
result, it is a prime target for context compaction — and when it disappears,
the agent loses all cognitive state. The pointer mode solves this by keeping
the full state exclusively in `.loopforge/state/<loopId>-state.md` and
rendering a structured dashboard in the prompt instead.

- **New policy field `l2_pointer_enabled`** (default `true`). When enabled, L2
  prompts skip the inline `fullStateMarkdown` blob and rely on the structured
  path B sections. The state file remains the durable source of truth — it is
  written every round regardless of level.
- **Four missing sections added to L2 path B** (previously only available in
  the full state markdown):
  - **Progress Dashboard** — criteria met/remaining, completion estimate, test
    results, files changed.
  - **Retired Constraints** — constraints the agent has withdrawn, shown
    struck-through.
  - **Inactive Constraints** — discovered constraints demoted after prolonged
    inactivity, with decay metadata (last violated, rounds inactive).
  - **Agent Trust** — current trust score with visual bar, plus trend over the
    last 10 rounds.
- **L2 prompt size reduced from ~25–40K to ~15K** (60% reduction). The
  structured dashboard is small enough to survive context compaction, and the
  "⚠️ Read the full state file before acting" instruction (from P1) now has
  genuine force — the model must read the file for complete state.
- **`compileLoop()`** conditionally passes `fullStateMarkdown: undefined` when
  `l2_pointer_enabled && level === "l2"`, forcing `l2Sections()` to take the
  structured path B.
- Backward compatible: set `"l2_pointer_enabled": false` in `loop_policy.json`
  to restore the pre-2.8 inline blob behavior.

### L0 / L1 / L2 Behavior Matrix

| Level | Trigger | Prompt Content | ~Size | State File |
|-------|---------|----------------|-------|------------|
| **L0** | Retry after rejection, empty failed round | Objective + task + hard constraints + verification flags + retry requirements + optional changes | ~3K | Always written (full canonical state) |
| **L1** | Normal continuation | L0 base + active constraints + remaining criteria + blockers + compact sub-goal dashboard (max 5, with IDs) + discoveries + rolling outcomes + recurring issues + next_action | ~7K | Always written |
| **L2 (pointer)** | First round, plan boundary, recovery, periodic refresh, drift | L1 base + full structured dashboard: milestones, full sub-goal dashboard (with IDs), Progress Dashboard, Retired/Inactive Constraints, Agent Trust, loop synthesis | ~15K | Always written (sole source of full detail) |
| **L2 (blob)** | `l2_pointer_enabled: false` | L1 base + monolithic full state markdown inline | ~40K | Always written (redundant with inline blob) |

### Sub-Goal ID Referencing

Sub-goals have always had stable IDs (`sg-XXXXXXXX` derived from description
hash), but the agent never saw them — so `matchSubGoal()` had to guess which
sub-goal the agent meant using Jaccard token similarity on natural-language
descriptions. Now IDs are visible and matchable.

- **Sub-goal IDs rendered in prompts** — L1 compact dashboard, L2 full
  dashboard, and the state file all show `[\`sg-XXXXXXXX\`]` before each
  sub-goal description. The agent can copy-paste IDs into its self-evaluation.
- **`matchSubGoal()` now tries exact ID match first**, then falls back to
  Jaccard similarity on descriptions. If the agent writes `"sg-a3f2b1c0"` in
  `completed_subtasks`, it matches deterministically without any semantic guesswork.
- **`buildSelfEvalBlock()` template updated** — placeholder values for
  `completed_subtasks` / `blocked_subtasks` / `canceled_subtasks` now show the
  ID format and reference the Sub-Goal Dashboard.
- **Fully backward compatible** — the agent can still use natural-language
  descriptions; Jaccard fallback is unchanged.

### Drift Clarification

When the verification gate detects intent-action drift (the agent said it would
do X but did Y), the enforcement gate R7 would reject the round immediately —
even if the pivot was intentional and well-reasoned. Now the agent gets a chance
to explain.

- **New `drift_clarification` field** on `SelfEvaluation` and
  `LoopRoundResult`. Carried through the full pipeline: self-eval parsing →
  vault persistence → round compilation.
- **Conditional prompt injection** — `buildSelfEvalBlock()` now accepts an
  optional `prevDriftFlags` parameter. When the previous round had
  `intent_drift` or `subgoal_drift` flags, the self-eval template includes a
  `drift_clarification` field and a "⚠️ Drift Detected" notice asking the
  agent to explain the pivot.
- **R7 enforcement softened** — `enforceIntentDrift()` now checks
  `drift_clarification`. If the agent provides a substantive explanation (≥ 20
  characters), the rejection is waived. Empty, absent, or too-short
  clarifications still trigger the normal reject → terminate path.
- **Clarification is not a free pass** — consecutive drift flags without
  meaningful clarification still escalate to termination. And the verification
  gate still produces drift flags honestly; only enforcement is affected.

### File-Level Changes

| File | Changes |
|------|---------|
| `protocol.ts` | `drift_clarification` field on `SelfEvaluation` + `LoopRoundResult`; sub-goal field comments updated for ID usage |
| `self-eval.ts` | Parse `drift_clarification` in `buildSelfEvaluation()` |
| `policy.ts` | New `l2_pointer_enabled` field on `PromptPolicy` (default `true`) |
| `prompt-assembler.ts` | Sub-goal IDs in L1/L2 dashboards; 4 new sections in L2 path B (Progress, Retired, Inactive Constraints, Agent Trust) |
| `canonical-state.ts` | Sub-goal IDs in state file sub-goal dashboard |
| `loop-compiler.ts` | `matchSubGoal()` ID-first matching; `buildSelfEvalBlock()` drift injection + ID hints; `compileLoop()` L2 pointer mode |
| `enforcement-gate.ts` | R7 accepts `drift_clarification` ≥ 20 chars |
| `engine.ts` | Propagate `drift_clarification` to `LoopRoundResult` |
| `mcp/session.ts` | Propagate `drift_clarification` through session pipeline |

**429 tests (was 415). Zero new dependencies, zero new persistence formats,
zero breaking protocol changes.**

**Enforcement diagnostic feedback and human-in-the-loop escalation.** The
enforcement gate now tells the agent *exactly* which claims don't match
evidence, and escalating rules (R4/R5/R6) issue a "Seek Human Guidance"
notice before terminating — giving the agent one more chance to course-correct.

### Diagnostic Feedback

- **`buildDiagnosticGap()`** — new helper that translates `VerificationFlag[]`
  into a structured "Evidence Gap" section in the rejection prompt. Each
  error/warn flag becomes a concrete claim-vs-evidence mismatch statement
  (`🚫 [check] field — detail`), so the agent knows precisely what to fix
  instead of retrying blindly.
- **`buildRejectionPrompt()` now accepts `verificationFlags`** (optional,
  default `[]`). When flags are present, the "Evidence Gap" section is
  inserted between the enforcement reason and the required fix instructions.
- **`RoundCoordinator.processRound()`** passes verification flags through to
  `buildRejectionPrompt()` so the diagnostic gap is always populated on reject.

### Enforcement Escalation ("Soft Pause")

- **`enforcement_escalation_enabled`** — new `EnginePolicy` field (default
  `true`). When enabled, enforcement rules that would destroy the loop now
  issue one final escalated rejection urging the agent to seek human guidance.
- **`buildEscalationNotice()`** — appends a "🆘 Escalation — Seek Human
  Guidance" block to `fix_instructions`, telling the agent to pause and ask
  a human before its next attempt.
- **R4 (`enforceProgressStall`):** 2nd consecutive rejection now escalates
  instead of terminating; 3rd terminates. (Was: 2nd → terminate.)
- **R5 (`enforceProgressStallTerminal`):** now accepts `consecutiveRejections`;
  1st detection escalates, 2nd terminates. (Was: immediate terminate.)
- **R6 (`enforceMaxRejections`):** escalation on → 2 rejections escalate,
  3 terminate. (Was: 2 rejections → terminate.) Disabled mode unchanged.

Set `enforcement_escalation_enabled: false` to restore the pre-2.7 behaviour
(exact same termination thresholds as 2.6).

**412 tests (was 410). No protocol or persistence format changes.**

## 2.6.0 (2026-07-27)

**Slim-down release.** Eight redundant or dead-code areas removed — approximately
400 lines deleted with zero functional loss.

### Removed

- **`CheckpointSummary`** — superseded by `MilestoneSummary` (kind: `agent_declared`)
  since v2.5. Type, factory, and all exports deleted.
- **`interop.ts`** — experimental cognitive checkpoint bridge with zero consumers.
  `addCheckpointSink()` and all sink notification logic removed from `SessionManager`.
- **`feedbackWriteBuffer`** — batch-write buffer in `LoopForgeEngine` that was
  always flushed immediately. Replaced with direct `appendEntry()` write.
- **`circuit_breaker_count`** — dead field on `SessionState` left over from the
  v2.5 circuit breaker removal.
- **`EngineMetrics` dead fields** — `vaultWriteTimeouts`, `vaultWriteBytes`,
  `silentAnalysisErrors`, `hydrateCacheMisses` were initialised to 0 and never
  incremented. Removed from metrics snapshots and MCP status output.
- **`heuristicSelfEvaluation`** — 20-line keyword-matching fallback in
  `self-eval.ts`. If the agent can't produce a structured self-evaluation,
  the round now stalls immediately instead of guessing.
- **`ReplayBackend.diff()`** — ~100-line round-to-round diff method with no
  MCP tool or library API consumer.
- **`observability.ts` span abstraction** — `startSpan` / `TraceSink` /
  `TraceSpan` / `TraceContext` removed. The `TraceSink` pattern was called
  once in production code. `logEvent` retained for structured lifecycle events.
- **`feedbackBufferFlushes` / `feedbackBufferMaxSize`** — metrics removed along
  with the write buffer.

**410 tests (was 422). Protocol `$defs`: 29 (was 30).**

## 2.5.0 (2026-07-27)

**Code quality, documentation and functional enhancements** — six technical debt fixes plus
four feature improvements across the compiler, enforcement gate, session pipeline, and policy layer.

### Bug Fixes & Technical Debt (v2.5.0)

- **Unified Jaccard similarity** (`token-utils.ts`): single `jaccardSimilarity()` function with
  consistent CJK tokenization (`[a-z0-9㐀-鿿]+` covering Extension A). Replaces three duplicated
  implementations with diverging Unicode ranges across `loop-compiler.ts`, `verification-gate.ts`,
  and `canonical-state.ts`.
- **Shared vault helpers**: `unique()` and `entryRound()` moved to `token-utils.ts`, eliminating
  duplicated implementations across four source files.
- **MemoryBackend prefix disambiguation**: `queryEntries()` no longer matches `r10`–`r19` when
  the caller queries for `r1`. Only applies the digit-guard when the prefix itself ends with a digit.
- **`progress_stall_threshold` reads from policy**: `enforcement-gate.ts` R4 now calls
  `getPolicy().evolution.progress_stall_threshold` instead of hard-coding `0.05`.
- **`VaultBackendLoopStore.readRound()` returns complete documents**: now parses `lineage`,
  `feedback`, `transaction`, and `promptArtifact` — same structure as `FileLoopStore.readRound()`.
- **`buildLoopRequest` uses factory**: `session.ts` now calls `makeLoopRoundResult()` instead
  of inline object literal, eliminating drift risk when new `LoopRoundResult` fields are added.
- **`replay.ts` removes phantom field access**: `entry.task` fallback removed — `VaultEntry`
  does not have a top-level `task` property.
- **`evidenceLatencyAvgMs` metric added**: `PolicyMetricsSnapshot` now includes
  `evidenceLatencyAvgMs` (derived from `evidenceLatencyMs / evidenceCaptures`), replacing
  the meaningless monotonically-accumulating raw sum.
- **IEEE 754 epsilon comparison**: `enforceProgressStallTerminal()` (R5) switched from
  strict `===` to `Math.abs(a - b) < 1e-10`, preventing false negatives from JSON round-trip
  float drift.
- **Unknown policy key warning**: `deepMerge()` now logs `console.warn` for keys not present
  in the default policy — a typo like `"max_round"` instead of `"max_rounds"` is no longer silent.
- **Removed legacy circuit breaker**: `shouldBreak()` method and all call sites deleted from
  `engine.ts`. Stall detection is exclusively handled by enforcement gate R4/R5 using
  `progress_estimate` gradients. `StopReason."circuit_breaker"` retained for backward-compat.
- **`parseWarnings` replaced by structured data**: deleted the regex-based warning extractor
  in `session.ts`. Warnings now flow from `LoopCompileResponse.warnings` → `LoopForgeResponse`
  → `PreparedRound` → `McpSession.currentWarnings`. No more fragile prompt-format dependency.
- **10 similarity thresholds externalized to policy**: six new `EvolutionPolicy` fields
  (`criteria_dedup_threshold`, `subgoal_dedup_threshold`, `subgoal_match_threshold`,
  `subgoal_auto_in_progress_threshold`, `constraint_match_threshold`,
  `subgoal_drift_alignment_threshold`) replace hard-coded magic numbers in `loop-compiler.ts`
  and `verification-gate.ts`.
- **`withoutPrompts` pattern-based filtering**: replaced manual allow-list with regex
  `\bprompt\b` match — any new prompt-text field is automatically redacted from CLI output.
- **Heuristic mode partial enforcement**: `enforcement-gate.ts` now runs for ALL extractions,
  not just structured ones. R3/R4/R5 self-skip when `skipEvidenceRules=true`; R1/R2/R6/R7
  always execute, giving heuristic-mode loops minimum enforcement protection.
- **Windows PID lease detection**: `isLeaseOwnerAlive()` now accepts optional
  `leaseExpiresAt` parameter — on Windows where `process.kill(pid, 0)` returns ambiguous
  `EPERM`, an expired lease overrides the "alive" assumption. `FileLoopStore` lock recovery
  receives the same treatment.

### Functional Enhancements (v2.5.0)

- **L2 adaptive budget sub-goal factor**: formula extended to
  `base + round×200 + milestones×1000 + subGoals×100`, capped at 40000.
  Policy: `prompt.l2_adaptive_subgoal_factor` (default 100).
- **Agent trust score**: `agent_trust_score` and `agent_trust_trend` derived from
  verification gate flags each round. Formula: `1.0 - errors×0.15 - warns×0.03`.
  Rendered in state file as "## Agent Trust" bar + trend line. Zero new persistence.
- **Milestone/Checkpoint unification**: `CheckpointSummary` deprecated in favor of
  `MilestoneSummary` (kind: `agent_declared`). `checkpoint()` function removed from
  compiler (~30 lines). `canonical-state.ts` derives checkpoints from milestones.
- **Stop reason refinement**: `SelfEvaluation.stop_reason` field added
  (`"gave_up"` | `"blocked"` | `"needs_human_input"`). `"blocked"` maps to
  `StopReason."blocked"` (previously unused). Backward-compat: absent `stop_reason`
  defaults to `"failed"` behavior.

### Documentation

- Verification gate check count corrected (10 → 11) across all docs
- Enforcement gate rules listed as R1–R7 throughout
- Test count updated (417) in both README and Chinese README
- Version references in `AGENTS.md` and `loopforge/README.md`

**422 tests (was 417 in 2.4.0).**

## 2.4.0 (2026-07-27)

**Long-Horizon Task Infrastructure** — four compiler-level features that make LoopForge
viable for 100+ round, multi-session agent tasks.

### Hierarchical Summary (v2.1)

Flat rolling-window summary replaced with three-tier hierarchical summary:

- **Tier 1 — Recent Window**: detailed last N rounds (preserves existing `buildRollingSummary` behavior)
- **Tier 2 — Milestone Summaries**: phase-boundary snapshots that survive window eviction. Three trigger signals in priority order: `agent_declared` (compression_checkpoint) > `criteria_milestone` (new success criteria detected via Jaccard semantic dedup at threshold 0.45) > `auto` (safety net every 20 rounds)
- **Tier 3 — Loop Synthesis**: formulaic paragraph summarizing total rounds, phase count, overall progress, and constraint summary

Milestones are rebuilt from vault entries each round — zero new persistence. Rendered in L2 prompts and always written to state file.

**New types**: `MilestoneSummary` (label, round_range, outcome, carried/resolved constraints, progress_at_boundary, kind). Extended `RollingSummary` with `milestones` and `loop_synthesis`.

**Policy**: `summary.milestone_interval` (20), `summary.max_milestones` (10), `summary.enable_loop_synthesis` (true).

### Sub-Goal Structured Tracking (v2.2)

`emerged_subtasks` upgraded from flat `string[]` to compiler-managed `SubGoal[]` with five-state lifecycle: `pending → in_progress → done | blocked | canceled`.

- **Agent declares** via three new `string[]` fields: `completed_subtasks`, `blocked_subtasks`, `canceled_subtasks` — string arrays matched by description similarity, no structured JSON burden on agent
- **Compiler derives**: `in_progress` from `next_action` match, `done` from `completed_subtasks` or `success_criteria_met` auto-complete, `blocked`/`canceled` from agent declarations
- **Sub-Goal Dashboard**: rendered in L2 (full: in_progress + pending by age desc + blocked + recent 5 done + stats line) and L1 (compact: active only, max 5)
- **Verification Gate**: new `checkSubGoalDrift` — warns when 3+ pending sub-goals exist but `next_action` aligns with none
- **Milestone bridge**: all sub-goals done → auto `criteria_milestone` — no agent declaration needed

**New types**: `SubGoal` (id, description, status, declared_at_round, status_changed_at_round, completed_at_round, priority). Extended `SelfEvaluation` and `LoopRoundResult`.

**Policy**: `evolution.subgoal_auto_complete_threshold` (0.4), `evolution.subgoal_stale_rounds` (10), `evolution.max_subgoals_in_prompt` (10), `evolution.max_done_subgoals_in_prompt` (5).

### Time-Aware Constraint Management (v2.3)

Discovered constraints auto-demote to `inactive` after prolonged inactivity — removed from prompts but kept in state file.

- **Source classification**: `constraintSource()` identifies hard/plan/criteria/discovered origin. Only discovered constraints auto-decay
- **Inactivity detection**: scans vault entries for `last_violated_at_round`. No violation for `constraint_inactive_rounds` (default 15) → demote to inactive
- **Re-activation**: inactive constraint violated again → auto re-promote to active
- **Effect on prompts**: inactive constraints removed from `constraints_active` → automatically absent from L1/L2 prompts. State file renders full "Inactive Constraints" section with age metadata
- **Zero new persistence**: all metadata reconstructed from vault entries each round

**New types**: `ConstraintMeta` (text, discovered_at_round, last_violated_at_round, source, status). Extended `LoopCompileResponse`.

**Policy**: `evolution.constraint_inactive_rounds` (15).

### Adaptive L2 Prompt Budget (v2.4)

L2 budget scales with loop complexity instead of static 18k chars:

```
adaptiveL2 = min(base + round × 200 + milestones × 1000, cap=40000)
```

- L0 (3000) and L1 (7000) unchanged — only L2 adapts
- Short tasks (≤ 5 rounds): negligible change (19k)
- Long tasks (80 rounds, 8 milestones): 40k budget (2.2× more context)
- Hard cap at 40k prevents unbounded growth

**Policy**: `prompt.l2_adaptive_enabled` (true), `prompt.l2_adaptive_round_factor` (200), `prompt.l2_adaptive_milestone_factor` (1000), `prompt.l2_adaptive_max_chars` (40000).

### Cumulative scope

All four features are compiler-level — no new storage formats, no sub-loop execution, no agent autonomy violation. The agent still owns execution; LoopForge provides progressively better cognitive infrastructure as tasks grow longer.

**14 new protocol types, 298 tests (was 288 in 2.0.2).**

## 2.0.2 (2026-07-23)

### Changed

- **Enforcement gate: progress-based stall detection replaces binary circuit breaker.**
  The old binary-success circuit breaker (3 consecutive failures → stop) has been
  removed from `RoundCoordinator`. It is replaced by two enforcement gate rules:
  - **R4 `progress_stall`**: progress_estimate delta < 5% over 3 rounds → reject
    on first occurrence (agent gets a chance to change approach), terminate on repeat.
  - **R5 `progress_stall_terminal`**: progress_estimate delta = 0 for N consecutive
    rounds → terminate immediately (agent is making zero forward motion).
    These rules use `progress_estimate`, not the binary success flag, so they correctly
    distinguish "task not done yet" from "agent is stuck".

- **Removed `runtime` module** (`runtime.ts`) — the standalone event-driven Agent
  executor is no longer part of LoopForge. All round processing now goes through
  the MCP session path (`SessionManager → RoundDriver → RoundCoordinator`).

- **Removed `RuntimePolicy`** from `loop_policy.json`. `max_rounds` moved to
  `engine` policy section.

- **Extracted `self-eval.ts`** — self-evaluation parsing helpers (`parseExecutionEvidence`,
  `parseCriterionRevisions`, `parseWorkerResults`, `extractSelfEvaluation`,
  `buildSelfEvaluation`, `heuristicSelfEvaluation`) moved from `engine.ts` to a
  dedicated module.

- **Added `loop-extras-parser.ts`** — typed request extraction pipeline with
  structured error collection, replacing inline `Record<string, unknown>` casts in
  `engine.ts`.

- **MCP `evaluation` parameter** now includes `compression_checkpoint`, `checkpoint_label`,
  and `next_action` fields.

- **`AdvanceResult.stopDetail`** field added to provide human-readable context when a
  loop stops.

- **Intent-action drift detection** — the `next_action` field is no longer decorative.
  Verification Gate check 11 (`intent_drift`) compares the previous round's declared
  `next_action` with the current round's `output_summary` via Jaccard token similarity.
  Below the configurable threshold (`evolution.intent_drift_threshold`, default 0.15),
  a warn-level flag is raised. Enforcement Gate R7 (`intent_drift`) rejects on first
  occurrence (agent must explain the pivot), terminates on repeat. This closes the
  loop between "what I said I would do" and "what I actually did."

### Added

- **7 enforcement rules** (was 5): R1 success_with_remaining_criteria, R2 recurring_violation,
  R3 empty_success, R4 progress_stall, R5 progress_stall_terminal, R6 max_rejections,
  R7 intent_drift.

- **10 verification checks**: check `intent_drift` detects when the agent
  performs work unrelated to its declared next_action from the previous round.

- **`evolution.intent_drift_threshold`** policy field (default: 0.15) — Jaccard token
  similarity threshold for intent-action alignment.

## 2.0.1 (2026-07-21)

### Removed

- **Deprecated `quality` field** from `AdvanceResult`. The `quality` field was
  marked `@deprecated` in 2.0.0 and always derived from `roundSuccess`. MCP tool
  consumers should use `roundSuccess` instead.

### Added

- **`stopDetail` field** in `AdvanceResult`. Each stop reason now carries a
  human-readable explanation of what happened, giving the external Agent enough
  context to decide its next action without LoopForge prescribing behavior.

- **`## How to Complete This Round` section** in every compiled prompt. The
  prompt now includes explicit instructions on how to submit results via
  `loopforge_next`, what `success` and `should_continue` mean, and what to do
  when a round is rejected.

- **31 new tests** for the typed extraction pipeline (`loop-extras-parser.ts`).
- **3 new tests** covering prompt hash determinism, attempt differentiation,
  and L0 budget enforcement.

### Changed

- **Git evidence capture is now async and parallel.** Three git commands
  (`diff`, `diff --cached`, `ls-files`) run concurrently via `execFile` instead
  of sequentially via `execSync`. Wall-clock time drops from sum(3) to max(1)
  command duration. A unified `AbortController` timeout replaces per-command
  timeouts. All git commands are now shell-free (`execFile`, not `exec`).

- **`engine.ts` extras parsing** extracted to `loop-extras-parser.ts`. The
  `ExtractionContext` class provides typed field extraction with per-field
  error collection — never throws, always returns best-effort defaults.

- **`advanceUnlocked()` split** into 6 focused private methods
  (`extractEvaluation`, `executeRoundTransaction`, `buildRejectionResult`,
  `buildTerminationResult`, `buildStopResult`, `advanceToNextRound`).
  The orchestrator is now ~40 lines.

- **Self-evaluation template** now explicitly warns the Agent to replace
  placeholder values with actual data.

- `interop.ts` marked as `@experimental` in JSDoc and both README files.
- Test count: 237 → 271.

## 2.0.0 (2026-07-13)

This release changes LoopForge from a prompt-technique framework into
a recoverable cognitive state runtime driven by an external Agent.

### Breaking changes

- Replaced `loopforge-mcp` with the unified `loopforge` command. Start the MCP
  server with `loopforge mcp`.
- Removed `Technique`, `Analysis`, `vault_config`, strategy routing, the
  prompt-technique catalog, MCP Tasks, automatic memory discovery, and Markdown
  lineage recovery.
- Replaced the shared PromptCraft vault with typed per-loop JSON documents under
  `.loopforge/loops/`. Use `loopforge migrate` to import a legacy vault without
  deleting it.

### Runtime and prompts

- Added one canonical loop state and one prompt assembly pass. L0, L1, and L2
  now control state density only.
- Added stable round IDs, prompt artifacts, attempt numbers, before and after
  evidence, zero-commit rejection, and idempotent recovery of committed rounds.
- Runtime and MCP now share the same RoundDriver and round transaction path.
- Fixed pause, resume, stop, concurrent next, timeout, stalled executor, signal,
  and terminal cleanup state combinations.

### Storage, evidence, and observability

- Added atomic, locked, hash-isolated `FileLoopStore` session and round
  documents. Markdown state files remain optional derived views.
- Added async evidence isolation and explicit `CommandEvidenceProvider` support
  with shell-free execution, workspace cwd checks, output limits, abort, and
  required-command verification.
- Added structured tracing, policy metrics, renewable cross-process session
  leases, and portable checkpoint sinks without runtime dependencies.

### MCP and CLI

- Added strict runtime validation for MCP tool arguments and safe handling of
  primitive JSON-RPC input.
- MCP tools return structured output and serialized text. MCP Tasks are not
  implemented because the client Agent owns long-running execution.
- Added `init`, `doctor`, `inspect`, and `migrate` CLI commands.

## v1.19.0 (2026-07-12)

Execution Strategy Hints — L1 advisory mode gets lightweight, task-aware execution guidance
instead of the single `"direct"` label. Perception SKILL.md trimmed from 310 to 203 lines
with corrected L1 behavior description.

### Execution Strategy Hints
- **`ExecutionStrategy` type** — New type in `builder.ts`. Five strategies: `direct`,
  `investigate`, `decompose`, `compare`, `verify`. Each provides a 2–3 sentence hint
  without imposing a full reasoning technique framework.
- **`detectStrategySignals(task)`** — New function. Keyword-based signal detection returning
  `{ bug, rootCause, multiStep, compare, verify }` booleans. Uses prefix matching (`\bword`
  without trailing `\b`) so "crashes", "errors", "migration" match correctly.
- **`selectExecutionStrategy(task, override?)`** — New function. Priority-ordered heuristic:
  rootCause → investigate, multiStep → decompose, compare → compare, verify → verify,
  default → direct. `override` parameter allows users to pin a specific strategy via policy.
- **`buildStrategyHintBlock(decision)`** — New function. Formats a markdown block with
  `### Execution Strategy: [name]`, the hint text, and `"Execute the task directly.
  Do not generate another prompt."` — an anti-meta-prompt guarantee.
- **`SpecialistOpts.strategyHintBlock`** — New optional field. When provided, replaces the
  generic "Execution Instructions" block in `compileGeneric()`. Undefined by default
  (backward compatible).
- **`compileL1()` advisory block** — When `technique.mode` is `"advisory"` (default),
  computes a strategy hint via `selectExecutionStrategy()` + `buildStrategyHintBlock()`
  and passes it to `compileGeneric()`. Legacy and disabled modes are unaffected.
- **`TechniquePolicy.execution_strategy`** — New policy field. Accepts `"auto"` (default,
  heuristic-driven) or a specific strategy name (`"direct"`, `"investigate"`, etc.).
  Only applies in advisory mode; ignored in legacy and disabled modes.
- **`loop_policy.json`** — Added `"execution_strategy": "auto"` to technique block.

### Perception SKILL.md
- **P1 Fix** — L1 description corrected from "technique keyword-routed from Tier 1" to
  "direct execution (advisory mode, default) or keyword-routed Tier 1 (legacy mode)".
  L2 technique selection softened from mandatory "read" to conditional "if available, read".
  Rule 5 updated to say "follow the compiled prompt instructions" instead of "follow the
  keyword-routed technique."
- **P2 Trimming** — Trimmed from 310 lines to 203 lines. Removed marketing language,
  legacy `---loopforge-eval` block note, standalone Tool Reference table (merged into
  step-by-step). Collapsed Delegation Helpers from 44 lines to ~12 lines. Shortened
  full worked example from 47 to ~18 lines. Condensed "Why this matters" editorial
  to 2 sentences.

### Tests
- **332 tests** (was 286). 46 new tests:
  - `strategy.test.ts` (new file): 16 signal detection tests + 18 strategy selection tests
    (including priority ordering and override behavior) + 3 hint format tests.
  - `loop-compiler.test.ts`: 9 integration tests covering L1 strategy hint injection
    (investigate, direct, decompose, verify), legacy/disabled mode exclusion, policy
    override, multi-round persistence, and anti-meta-prompt guarantee.

### Documentation
- Root README.md and README.zh-CN.md: v1.19 hero banner, Philosophy block, L1 description
  in How It Works, Recompile Levels table, Execution Strategy Hints feature section,
  Agent Technique Autonomy section updated. Test count: 286 → 332.

---

## v1.18.0 (2026-07-12)

Pause/Resume + EvidenceProvider Interface — two structural improvements that build on the
Phase 2 RoundCoordinator unification and mandatory evidence enforcement.

### Pause/Resume
- **`RuntimeStatus.PAUSED`** — New runtime status. Loop is suspended at round boundary,
  signal handlers stay registered, memory writeback is skipped. Resumable from `currentRound`.
- **`LoopRuntime.pause()` / `resume()`** — Pause suspends the loop at the next iteration;
  resume re-enters via `_continue()` which picks up from `currentRound` without reset.
  Paused loops keep heartbeat and signal handlers registered.
- **SIGINT Double-Tap** — First `Ctrl+C` pauses (safe), second within `pause_double_tap_ms`
  (default 3000ms) forces stop. Configurable via policy; set to 0 to disable (always stop).
- **`SessionManager.pause()` / `unpause()`** — Pause persists session to vault with status
  `"paused"`. Unpause reconstructs from vault and compiles the next prompt. `autoResumeAll()`
  recovers both `"running"` and `"paused"` sessions on MCP server startup.
- **`loopforge_pause` MCP tool** — New tool. Pause a running session with vault persistence.
- **`loopforge_resume`** — Extended to handle both crash-recovery (running) and paused sessions.
  First tries `resume()` for crash-recovery, falls back to `unpause()` for paused sessions.
- **`McpSession.status`** — Added `"paused"` to status union. `McpSessionSummary` updated.
- **`StopReason."paused"`** — New stop reason. `STOP_REASON_OUTCOME_MAP` and
  `LoopMemoryWriteback.outcome` updated.
- **`RuntimePolicy.pause_double_tap_ms`** — New policy field (default 3000).

### EvidenceProvider Interface
- **`EvidenceProvider`** — New interface. `name: string` + `capture(): ProviderSnapshot | null`.
  Providers return null when unavailable (e.g. git not installed) — pipeline degrades gracefully.
- **`ProviderSnapshot`** — New type. `{ provider, timestamp, files, data }`. Carries structured
  evidence from each provider into the verification pipeline.
- **`EvidenceCollector`** — Runs all configured providers, silently skips unavailable ones.
  Used by both `runtime.ts` and `session.ts` instead of direct `captureGitModifiedFiles()` calls.
- **`GitEvidenceProvider`** — Built-in provider wrapping `captureGitFileState()`. Captures
  tracked, staged, and untracked file changes into a structured `ProviderSnapshot`.
- **`extractFilesFromSnapshots()`** / `diffSnapshots()`** — Utility functions. Extract merged
  file list from snapshots (backward compat with `runtimeFilesChanged`), and compute
  before→after diffs for `runtime.ts`.
- **`round-coordinator.ts`** — `RoundProcessInput` gains optional `evidenceSnapshots` field.
  Passed through to `verifySelfEvaluation()`.
- **`verification-gate.ts`** — `verifySelfEvaluation()` gains optional `evidenceSnapshots`
  parameter. New `checkEvidenceIntegrity()` cross-validates agent-reported `files_changed`
  against git provider snapshot. 7 checks total (was 6).
- **`EvidencePolicy`** — New policy section. `providers: string[]` — which providers to enable.
  Default: `["git"]`. Added to `DEFAULT_POLICY` and `loop_policy.json`.
- **`runtime.ts` / `session.ts`** — Replaced direct `captureGitModifiedFiles()` calls with
  `EvidenceCollector` + `GitEvidenceProvider`. Unused import removed from both files.

### Exports
- **`index.ts`** — New exports: `EvidenceCollector`, `GitEvidenceProvider`,
  `extractFilesFromSnapshots`, `diffSnapshots` (values), `ProviderSnapshot`,
  `EvidenceProvider` (types).

### Tests
- 286 tests (was 284). All existing tests pass without modification.

---

## v1.16.0 (2026-07-12)

Cognitive State Runtime — the project repositions from "Prompt Compiler" to
"State Runtime." Three Runtime-ification improvements make state management a
Runtime guarantee instead of a Prompt request.

### State File Inline Injection
- **`StateFilePolicy.inline_in_prompt`** — New policy field (default `true`). When
  enabled, the full state file content is prepended directly into the prompt —
  the Agent no longer needs to remember to read `.loopforge/state/{id}-state.md`.
  State injection is now a Runtime guarantee, not a Prompt request.
- **`compileL1()` / `compileL2()`** — Conditionally inline state file content
  based on `inline_in_prompt` policy. File is still written to disk as fallback.

### Git Diff Auto-Detection
- **`captureGitModifiedFiles()`** — New function in `verification-gate.ts`. Captures
  `git diff --name-only` before and after each agent execution round.
- **`checkFilesIntegrity()`** — New verification check. Compares agent-reported
  `files_changed` against git reality. Raises `warn` flag on mismatch.
  Gracefully degrades when git is unavailable (returns null → check skipped).
- **`verifySelfEvaluation()`** — New optional 5th parameter `runtimeFilesChanged`.
  Integrated into `runtime.ts` execute cycle.

### Evidence Block
- **`EvidenceSnapshot`** — New protocol type. Four categories: ✅ Verified,
  🔄 Pending, ❌ Invalidated, 💡 Discovered — aggregated from accumulated
  SelfEvaluation data.
- **`buildEvidenceSnapshot()`** — New function in `loop-compiler.ts`. Derives
  evidence from loop objective, last round result, and rolling summary.
- **`renderStateFile()`** — Renders `## Evidence` section in state file with
  four-quadrant view (empty categories hidden).

### Agent Reflection — next_action
- **`SelfEvaluation.next_action`** — New optional field. Agent declares its
  intended next step ("下一轮我要调查缓存层").
- **`LoopRoundResult.next_action`** — Carries the declaration forward.
- **`renderStateFile()`** — Renders `## Agent's Declared Next Action` in state file.
- **`compileL1()` / `compileL2()`** — Injects `### Your Declared Next Step`
  block into the prompt.

### Brand Repositioning
- README, CLAUDE.md, package.json, README.zh-CN.md, perception SKILL.md —
  repositioned from "Loop-Time Intelligence Layer / Prompt Compiler" to
  "Cognitive State Runtime."

---

## v1.15.1 (2026-07-09)

Bug fixes and policy completeness for the Thin Prompt architecture.

### Bug Fixes
- **`state_file.enabled` now respected** — State files were written to disk regardless of the
  `state_file.enabled` policy flag. Fixed in `runtime.ts` and `mcp/session.ts` (3 call sites)
  to check `getPolicy().state_file.enabled` before writing.
- **`enforcement-gate.ts` git tracking** — The enforcement gate module was untracked despite
  being imported by `runtime.ts` and `mcp/session.ts`. Now staged in git.

### Policy
- **`loop_policy.json`** — Added missing `state_file` configuration section with defaults
  (`enabled: true`, `directory: ".loopforge/state"`, `max_checkpoints: 5`, `max_summary_rounds: 5`).
- **`write_on_outcomes`** — Corrected from `"completed"` to `"task_complete"` to match the
  actual `StopReason` enum value. Previously `"completed"` never matched any stop reason.

---

## v1.15.0 (2026-07-09)

Agent Technique Autonomy at L2 — the Agent now freely chooses reasoning strategies
by reading the technique catalog instead of having LoopForge auto-select via keyword routing.

### L2 Restart Rework
- **`buildL2Prompt()`** — New function. Generates L2 prompts with a Technique Selection block
  that instructs the Agent to read `skills/prompt-techniques/SKILL.md`, freely choose the
  best technique based on loop state, read the corresponding reference file, and apply it
  directly. No technique skeleton is embedded — the skill reference files are the Agent's
  working manual.
- **`compileL2()`** — No longer calls `routeTechniqueAdaptive()` or dispatches to specialist
  compilers. Uses `buildL2Prompt()` instead. `technique_used` set to `"agent-selected"`,
  `reference_file` set to `"skills/prompt-techniques/SKILL.md"`.

### Strategy Collapse Removal
- **`strategyCollapse()`** — Removed. The "3 consecutive failures → force L2" gate in
  `decideLevel()` is gone. The decision to restart strategy belongs to the Agent (via
  checkpoint declaration), not to a failure counter.
- **`decideLevel()` Gate 4** — Removed. L2 now triggers on: Round 1, plan_source,
  checkpoint boundary, goal_id change.
- **`computeAdvisories()` strategy_collapse warning** — Removed.

### Tier Escalation Removal
- **`countConsecutiveFailures()`** — Removed from `builder.ts`.
- **`routeTechniqueAdaptive()` escalation branch** — Removed. No longer counts failures
  or forces Tier 2 techniques. Simplified to: checkpoint → all 7 techniques, normal → Tier 1 only.
- **`tier2_escalation_failures`** — Deprecated in `policy.ts`. Field retained for config
  compatibility but no longer consumed.

### Specialist Compilers
- `compileStepBack`, `compileLeastToMost`, `compileToT`, `compileGeneric` — All **preserved**.
  Still used by L1 for keyword-routed technique prompts. Only L2 no longer calls them.

### Observability
- **`tier2_escalation`** event — Deprecated. No longer emitted.

---

## v1.9.0 (2026-07-01)

Multi-Agent Delegation Support — LoopForge now tracks and injects sub-agent delegation
history into compiled prompts. Works with AgentTool sub-agents and Coordinator Workers
without requiring a separate "mode."

### Delegation Helpers (AgentTool Mode)
- **`filterConstraintsForSubTask(allConstraints, subTask, threshold?)`** — Pure function.
  Filters relevant constraints for a sub-agent task using Jaccard token similarity.
  Default threshold 0.15 (inclusive — lower than the 0.3 warn threshold).
- **`formatDelegationPrompt(subTask, subAgentType, constraints, options?)`** — Pure function.
  Produces self-contained prompts for Explore / General-purpose / Plan sub-agent types.
  All outputs are self-contained (no "based on above" references) — matching the
  AgentTool contract: "Workers can't see your conversation."
- **`recordDelegation(loopId, round, entries)`** — Engine method. Writes delegation
  journal entries to vault as `task_type: "delegation_journal"`.

### Worker Results (Coordinator / Multi-Agent)
- **`WorkerResult` interface** — `{ agentId, subAgentType, subTask, resultSummary, success, discoveredConstraints? }`.
  Added to `SelfEvaluation.worker_results` and `LoopRoundResult.worker_results`.
- **Auto-detection** — `buildSelfEvaluation()` parses `worker_results` from raw evaluation JSON.
  `autoFeedback()` automatically calls `recordDelegation()` when `worker_results` are present.
- **MCP schema** — `loopforge_next` evaluation schema updated with `worker_results` array property.
- **Cross-round injection** — `buildDelegationSummary(vaultContext)` scans vault for delegation
  journal entries and formats them as a `### Delegation History` table injected into the
  next round's compiled prompt.
- **Constraint flow** — Workers discover constraints → Coordinator reports via `worker_results` →
  LoopForge records to vault → next round's `Active Constraints` includes them →
  Coordinator passes them to future Workers.

### Design Principle
No `MultiAgentMode` enum. No `compileCoordination()` function. LoopForge does not
distinguish between single-agent and multi-agent execution. The main agent —
whether a single agent, an AgentTool user, or a Coordinator — receives compiled
prompts, executes, and reports results. LoopForge records, compresses, and injects.

### Protocol Changes (v1.8→v1.9)
- **1 new interface**: `WorkerResult`.
- **`SelfEvaluation.worker_results`** — optional array. Main agent reports sub-agent
  delegation results.
- **`LoopRoundResult.worker_results`** — optional array. Forwarded through
  `buildLoopRequest()` for compiler access.

### Tests
- 251 tests (was 241). 10 new tests: protocol factory defaults, constraint filtering
  (8 cases incl. CJK), delegation prompt formatting (6 cases incl. self-containment),
  delegation summary (null vault, multi-round table, failed delegations, backward compat,
  pipe escaping), schema count update.

## v1.8.0 (2026-07-01)

Memory System Integration — bidirectional bridge between LoopForge and Agent long-term memory.

### Memory Injection (Retrieval)
- **Tiered Injection Strategy** — injection frequency scales with loop length. Short loops (≤10 rounds)
  get 1 injection (Phase 1 only). Medium loops (11–20 rounds) get 2 injections (Phase 1 + Phase 3).
  Long loops (21+ rounds) get all 3 phases. Configurable via `round_tiers` in policy.
- **Refined Phase Thresholds** — Phase 2 fires at 40% progress (was 30% — too early).
  Phase 3 fires at 70% progress (was 60% — still in execution). Better alignment with real task cadence.
- **Jaccard Deduplication** — subsequent injections deduped against previous contexts (threshold 0.6).
  Prevents redundant retrieval when memory returns stale/similar results.
- **Phase-Aware Query Construction** — each phase uses a different query composition:
  Phase 1 queries task + constraints, Phase 2 queries current focus + failure patterns,
  Phase 3 queries remaining criteria + key lessons + edge cases.
- **Configurable Policy** — `memory_injection` section in `loop_policy.json`:
  `enabled`, `min_rounds_between_injections`, `phase_thresholds` (progress-based trigger points),
  `round_tiers` (tiered phase allowance by maxRounds), `dedup_threshold`, `max_context_length`.
- **Zero-Cost at L0/L1** — memory retrieval only fires when compiler level is L2.
  L0 (cache hit) and L1 (patch) rounds have zero memory overhead.

### Memory Writeback
- **Automatic on Loop End** — distilled knowledge written back to Agent memory on every stop reason
  (task_complete, circuit_breaker, max_rounds, stalled, stopped). Configurable via `memory_writeback.write_on_outcomes`.
- **Structured Payload** — `LoopMemoryWriteback` interface: 1 project entry (outcome + key discoveries), 
  ≤5 feedback entries (rule + Why + How to apply, matching claude-mem's feedback format), 
  1 reference entry (pointer to LoopForge vault).
- **Format Alignment** — feedback entries follow claude-mem's requirement of structured body: 
  rule statement + `**Why:**` + `**How to apply:**`. Project entries store absolute dates 
  (relative→absolute conversion on write).
- **Minimal Principle** — only writes what cannot be derived from current code state. 
  Code patterns stay in code; decisions, discoveries, and tactical lessons go to memory.

### Protocol Changes (v1.7→v1.8)
- **5 new interfaces**: `MemoryProviderContext`, `LoopMemoryWriteback`, `LoopMemoryWritebackProjectEntry`, 
  `LoopMemoryWritebackFeedbackEntry`, `LoopMemoryWritebackReferenceEntry`.
- **`LoopCompileRequest.external_context`** — optional field for memory context injection 
  (ignored by L0/L1, formatted into L2 prompt with priority disclaimer).
- **`RuntimeConfig.memoryProvider` / `memoryWriter`** — optional callbacks for custom memory system integration.
  Auto-detected when running with claude-mem; users can override.
- **`LoopPolicy.memory_injection` / `memory_writeback`** — externalized configuration.

### Compiler Changes
- **`formatExternalContext()`** — formats memory context as a marked section in L2 prompts with 
  explicit priority disclaimer: "If any insight contradicts the Loop Objective or Active Constraints, 
  LoopForge takes absolute precedence."
- **`tokenize()` / `jaccard()` exported** — for dedup use by runtime and MCP session manager.

### Runtime & MCP
- **`LoopRuntime`**: phase tracking (`injectionCount`, `lastInjectionRound`, `injectedContexts`, 
  `phase2Triggered`/`phase3Triggered`), `shouldInjectMemory()`, `buildAccumulatedContext()`, 
  `dedupAndStoreContext()`, `buildWritebackPayload()`.
- **`SessionManager`**: `memoryProvider`/`memoryWriter` callbacks, `doWriteback()` helper, 
  memory state persisted to vault via `loop_lineage` (injection_count, phase2_triggered, etc.).
- **`McpSession`**: 5 new memory tracking fields.
- **Async upgrade**: `create()`, `advance()`, and all MCP tool handlers now async. 
  `dispatch()` and stdin handler also async.

### Memory Bridge — Auto-Detection & Filesystem Integration
- **`memory-bridge.ts`** (~250 lines) — zero-config auto-detection of claude-mem via local filesystem.
  Scans `~/.claude/projects/{hash}/memory/` for project hash (computed from git root path,
  matching claude-mem's `[^a-zA-Z0-9] → -` algorithm). No REST API dependency, no auth tokens.
- **Retrieval via filesystem** — `createMemoryProvider()` reads `*.md` memory files directly,
  scores by keyword overlap against phase-aware query terms (Phase 1: task terms, Phase 2: + issues/patterns,
  Phase 3: + remaining criteria/lessons). Returns top-3 memories concatenated. Strips YAML frontmatter.
- **Writeback via filesystem** — `createMemoryWriter()` writes project/feedback/reference `.md` files
  in claude-mem's exact format (YAML frontmatter + structured body). Appends to `MEMORY.md` index.
  mkdir-based file lock prevents concurrent write corruption.
- **Two integration paths**:
  - MCP: `autoConfigureMemory(mgr)` sets `memoryProvider`/`memoryWriter` on `SessionManager`.
    Called automatically in `McpServer` constructor — zero user configuration.
  - Library: `tryAutoConfigure()` returns `{ memoryProvider?, memoryWriter? }`.
    Called automatically in `resolveConfig()` when no explicit callbacks provided.
- **Silent degradation** — if claude-mem is not installed or the project has no memory directory,
  both functions are no-ops. LoopForge continues normally without memory integration.
- **Explicit overrides** — user-provided `memoryProvider`/`memoryWriter` callbacks always take
  precedence over auto-detection.

### Design Rationale
- **LoopForge is not a memory system — it's a prompt compiler.** Agent memory answers "what did you do before"; 
  LoopForge answers "what should you do next, and how should you think about it." They are different layers 
  of the same cognitive stack: long-term memory (cross-session) vs working memory + executive control (within-task).
- **Not a replacement — a complement.** Agent memory cannot replace LoopForge's constraint lifecycle, 
  technique routing, or verification gate. LoopForge cannot replace Agent memory's cross-session semantic search. 
  Together they form a complete cognitive architecture: memory IN → LoopForge → memory OUT.

### Tests
- 227 tests (was 202 — 25 new memory-bridge tests covering detection, retrieval, writeback, edge cases).

## v1.3.1 (2026-06-27)

Session recovery, success criteria enforcement, and MCP tool expansion.

### Session Durability
- **`save()` / `resume()` in SessionManager** — session state persisted to vault as `session_state` entries (upsert per loop). Process restart → `resume(loopId)` reconstructs session from vault lineage and compiles the next round's prompt.
- **Auto-save in `create()` and `advance()`** — every state change (compile, stop, stall, task_complete) writes to vault automatically.
- **`loopforge resume <loop-id>` CLI command** — restore loop from vault and print the next-round prompt.

### MCP Tool Expansion (6 → 8 tools)
- **`loopforge_resume`** — resume a loop from vault after process restart. Returns next-round prompt or stopReason.
- **`loopforge_health`** — standalone loop health check: goal alignment, constraint integrity, drift detection, strategy stability, task continuity.
- **`loopforge_list`** — now scans vault for persisted sessions in addition to in-memory sessions. Shows all loops available for resume after a restart.

### Success Criteria as Hard Constraints
- `compileL2()` now merges `loop_objective.success_criteria` into `constraints_active` alongside `hard_constraints`. Success criteria are tracked, retired, and checked for violations like any other constraint — no longer decorative text.

### Bug Fix
- **`last_technique` was never written** — `loopforge_status` always returned `null` for `technique`. Fixed: `invokeLoopCompile` now writes `this.state.last_technique = response.technique_used`.

### Code Hygiene
- Removed 5 unused imports across `cli.ts`, `loop-compiler.ts`, `backends/fs.ts`.
- Deleted 48 stale build artifacts (36 in `src/`, 12 orphan files in `dist/`).
- Added `.gitignore` patterns for `src/**/*.{js,d.ts,js.map,d.ts.map}`.
- Annotated `globalVaultPath` and `global_vault_path` as `v2: federation (not yet implemented)`.

### New Tests
- 10 new tests: success criteria → constraints_active, session persistence (save/resume round-trip, stopped/stalled states), MCP resume/health/list-vault handlers, status technique fix.

## v1.3.0 (2026-06-26)

MCP Server — Model Context Protocol integration for AI coding agents.

### MCP Server
- **`McpServer`** — JSON-RPC over stdio transport (`node:readline`), handles `initialize` / `tools/list` / `tools/call`
- **`SessionManager`** — manages `Map<sessionId, McpSession>`, each session = one complete multi-round loop with its own `LoopForgeEngine`
- **6 MCP tools**: `loopforge_start`, `loopforge_next`, `loopforge_status`, `loopforge_stop`, `loopforge_list`, `loopforge_replay`
- **`loopforge-mcp` binary** — `npx loopforge-mcp` entry point, registers with `claude mcp add loopforge -- npx loopforge-mcp`
- **Zero new dependencies** — stdlib only (`node:readline`, `node:crypto`)
- **8 existing source files unchanged** — engine, compiler, builder, policy, replay, backends, adapter, runtime all reused directly

### New files
- `src/mcp/session.ts` — SessionManager + advance() cycle (~230 lines)
- `src/mcp/tools.ts` — 6 tool schemas + handler registry (~190 lines)
- `src/mcp/server.ts` — JSON-RPC transport (~100 lines)
- `src/mcp-server.ts` — entry point
- `src/tests/mcp.test.ts` — 9 integration tests

### Modified
- `package.json` — bin `loopforge-mcp`, exports `./mcp`
- `src/index.ts` — exports `McpServer`, `SessionManager`, `McpSession` types

## v1.2.0 (2026-06-26)

Loop Runtime — event-driven autonomous loop driver.

### Loop Runtime
- **`run()` convenience function** — 2 required fields (`task`, `execute`), everything else automatic
- **`LoopRuntime` class** (EventEmitter) — `start()`, `stop()`, `getCurrentRound()`, `getQualityTrajectory()`
- **Heartbeat monitoring** — configurable interval (`heartbeatIntervalMs`, default 30s), emits per-round elapsed/progress
- **Round timeout** — sets `ctx.signal.aborted = true` when `roundTimeoutMs` (default 10 min) exceeded
- **Stall detection** — timeout + `stallGraceMs` (default 5 min) → status becomes STALLED
- **Executor failure breaker** — `maxConsecutiveErrors` (default 3) consecutive `execute()` throws → stop
- **SIGINT/SIGTERM graceful shutdown** — stops loop, cleans up timers
- **Interactive mode** — `interactive: true` disables timeout/stall (human-in-the-loop CLI scenarios)
- **Auto loopId** — derived from task text if not provided

### Removed
- **`autonomous.ts`** — replaced by `runtime.ts`
- **`cmdHookStop`** — removed hook-stop CLI command (runtime replaces hook-based integration)
- **`loopforge/autonomous`** export path — removed from package.json `exports`

### API
- `run(config): Promise<RunResult>` — primary user-facing API
- `LoopRuntime` — advanced class with EventEmitter events: `start`, `round:start`, `round:complete`, `heartbeat`, `timeout`, `stalled`, `done`, `stop`
- 9 new protocol types: `RuntimeStatus`, `RoundContext`, `AgentExecutor`, `StopReason`, `RoundStartInfo`, `RoundCompleteInfo`, `HeartbeatInfo`, `TimeoutInfo`, `HealthWarning`, `RuntimeConfig`, `RunResult`
- `RuntimePolicy` added to `loop_policy.json` — all configurable with sensible defaults

### Tests
- 165 total (was 150). 12 new runtime tests covering: minimal config, task_complete, circuit_breaker, max_rounds, executor_failure, timeout, stall, stop(), heartbeat events, reportProgress, extraction_failure, auto-generated loopId.

## v1.0.0 (2026-06-25)

Initial TypeScript reference implementation of the LoopForge protocol v3.5.

### Core Compiler
- **4-gate hard router**: force_level → first-call/plan_source → goal_id stability → failure/constraint signals
- **L0 Fast Path**: reuses cached prompt from previous round, auto-escalates to L2 when no cache available
- **L1 Patch**: incremental constraint injection with rolling summary context
- **L2 Full Recompile**: technique routing, loop objective anchoring, meta-instruction generation

### Features
- **Constraint Retirement (v3.5)**: auto-retires stale constraints after 3 inactive rounds
- **Rolling Summary (v3.5)**: deterministic cross-round knowledge distillation from last 5 rounds
- **Adaptive Technique Routing (v3.5)**: quality-driven fallback from keyword heuristic
- **Loop Objective Anchoring**: auto-generated at round 1 from task/plan_source, checked every round
- **Task Alignment**: Jaccard-based advisory drift detection (aligned/warn/block)
- **Circuit Breaker**: stalls after 3 consecutive no-improvement iterations

### Storage
- **VaultBackend interface**: pluggable storage abstraction (9 methods)
- **FSBackend**: filesystem implementation with dual-write (JSON vault + Markdown lineage)
- **ReplayBackend**: time-travel queries — getRound, replay, timeline, diff

### CLI
- `loopforge init` — initialise vault
- `loopforge compile` — loop_compile mode (L0/L1/L2)
- `loopforge feedback` — execution recording with quality scoring
- `loopforge replay` — loop timeline with technique/quality history
- `loopforge diff` — field-level round comparison
- `loopforge review` — structural prompt audit
- `loopforge status` — vault health summary

### API
- Zero runtime dependencies — stdlib only (Node.js built-ins)
- Full TypeScript strict mode with declaration files
- Tree-shakeable exports: protocol, compiler, replay, policy, builder, engine, adapter
