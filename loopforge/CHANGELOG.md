# Changelog

## 3.7.0 (2026-09-05)

The convergence batch — verification domains, one enforcement strategy table,
and the legacy deletion. Same design philosophy: the Vault's committed round
documents remain the single factual source, CanonicalLoopState the single
cognitive source.

**Verification gate: 27 checks → 24, organized into four domains.**
The checks are grouped (documentation + CHECK_DOMAIN map only — run order and
verdict aggregation are unchanged) into evaluation consistency, evidence
integrity, plan & contract, and progress & recovery.
- `progress_regression` removed — self-report-only decoration; machine-side
  progress policing lives in the enforcement stall evaluator.
- `empty_change_with_passing` removed — covered by the success-evidence arms.
- `success_claim_conflict` merged into `outcome_success_contradiction` (error
  when outcome=success contradicts success=false; warn when success=true with
  a non-success outcome — enforcement keys on severity, so the error arm's
  trigger is unchanged).

**Success evidence is one semantic.** Enforcement rule R3 `empty_success` is
gone; its posture moved into `checkSuccessWithoutVerifiedEvidence` as an
empty/missing-evidence arm — an unconditional error evaluated BEFORE the
machine-verified early exit, so neither `machine_backed_success: "warn"` nor a
declared `no_change_reason` downgrades a success claim that recorded no work.
The claims arm keeps its v3.6 severity switch and the `no_change_reason` info
downgrade. One flag, one ladder (reject → reject+notice → terminate).

**One enforcement strategy table.** The `UNLADDERED_REJECT_CHECKS` name-set
patch (a workaround for the unreachable R6 ladder) is replaced by an
in-process RULE_TABLE — 12 rows over four action classes (evidence
contradiction, contract & scope, plan drift, progress recovery). Uniform rows
now attach the escalation notice on repeat rejections that the pre-v3.7
comment promised but never appended; actions are unchanged in every
configuration (locked by a behavior-equality compatibility matrix).

**Progress enforcement merged.** R4 stall and R5 flatline become one
`progress_stall` evaluator; exactly-flat windows are an internal diagnostic
tier of the same row (still reachable under `progress_stall_threshold <= 0`)
and the `progress_flatline` enforcement id is removed. Deadlock guard,
git-motion veto, machine fallback, and the backtrack ladder are unchanged.

**Contract framing.** Round Contract checks are documented as three stages —
Declare (proposal verifiability), Execute (scope and done_when conformance),
Close (completion machine-backing). Documentation only; no phase field.

**Legacy deletion.**
- `prepareSync`, the synchronous `captureGitFileState()`, and the synchronous
  `EvidenceCollector.collect()` are removed; `resume`/`reconcileCommittedRound`
  compile asynchronously like `unpause`.
- The legacy PromptCraft vault migration API (`migrateLegacyVault`, CLI
  `migrate`, `LoopStoreMigrationResult`) is removed.
- Round sequence stamps are mandatory: unstamped rounds are
  `sequence_invalid`; prefix gaps are `sequence_gap` for every loop shape.
- The top-level `lineage` field alias is removed (`loop_lineage` only).
- `loop_policy.json` no longer ships the ignored keys (`injection_mode`,
  `subgoal_auto_in_progress_threshold`, `subgoal_auto_complete_threshold`,
  `constraint_inactive_rounds`); loading it emits no unknown-key warnings.
- The committed `gate-test.log` artifact is deleted.

"27 checks / 14 rules" phrasing is gone from the READMEs — gates are described
by their domains and action classes, not internal counts.

## 3.6.0 (2026-09-02)
