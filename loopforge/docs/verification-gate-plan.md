# Verification Gate — Implementation Plan

**Status**: approved, pending implementation.
**Date**: 2026-06-28

## Building

A Layer 1 cross-round consistency verification gate that validates agent self-evaluations against the loop's own lineage before they enter the compiler. Three verdict levels — trusted / suspect / contradicted — with distinct downstream behaviors. Does NOT modify quality scores. Contradicted rounds are omitted from the quality trend; suspect rounds carry forward as warnings in the next prompt, asking the agent to clarify.

## Not Building

- Layer 2 (vault cross-reference) or Layer 3 (filesystem verification) — deferred to future phases.
- A `trust_discount` multiplier on quality scores — rejected. The gate does not fabricate adjusted scores.
- Changes to the compiler's internal routing logic (L0/L1/L2 decision) — the gate feeds flags, not level decisions.

## Approach

Pure-function module `verification-gate.ts` with one public export: `verifySelfEvaluation(selfEval, loopId, vaultContext) → VerificationResult`.

Insertion point: `SessionManager.advance()`, between `extractSelfEvaluation()` and `autoFeedback()`. The verification result is passed through to the compiler via a new field on the request, and the compiler injects the flags as warnings into the prompt.

Rejected alternative: embedding verification inside `autoFeedback()` — that would couple verification to scoring when they are orthogonal concerns. Verification is about data quality; scoring is about task quality.

## Files Changed (5 files, 1 new)

| File | Action | Lines |
|------|--------|-------|
| `src/protocol.ts` | Add `VerificationFlag`, `VerificationResult` types + factories | ~45 |
| `src/verification-gate.ts` | **New.** Pure-function module, 6 check functions + `verifySelfEvaluation()` | ~220 |
| `src/engine.ts` | Accept `verification` on request, inject flags into prompt Warnings + Loop Health section | ~25 |
| `src/mcp/session.ts` | Call `verifySelfEvaluation()` in `advance()`, skip quality trend for contradicted | ~30 |
| `src/tests/verification-gate.test.ts` | **New.** 20 test cases covering all 6 checks | ~200 |

Total: ~520 lines, 5 files changed (1 new).

## Data Flow (after change)

```
SessionManager.advance()
  │
  ├─ 1. extractSelfEvaluation(output)
  │
  ├─ 2. verifySelfEvaluation(selfEval, loopId, vaultContext)  ← NEW
  │       │
  │       ├─ checkProgressRegression()
  │       ├─ checkEmptyChangeWithPassing()
  │       ├─ checkSuccessWithRemainingCriteria()
  │       ├─ checkDuplicateConstraintDiscovery()
  │       ├─ checkRecurringViolation()
  │       └─ checkRetractFreshConstraint()
  │
  ├─ 3. autoFeedback(selfEval, loopId, round, task)
  │       └─ if verdict === "contradicted": skip quality_trend.push()
  │          else: normal flow
  │
  ├─ 4. Stop conditions (unchanged)
  │
  └─ 5. invokeLoopCompile(request + verification flags)
          └─ engine bundles flags into prompt Warnings section
```

## Six Checks (Layer 1)

| # | Check | Trigger | Severity | Verdict |
|---|-------|---------|----------|---------|
| 1 | Progress Regression | `progress_estimate` drops > 0.2 from previous round | warn | suspect |
| 2 | Empty Change + All Passing | `files_changed: []` AND `test_results.failed === 0` AND `success === true` | warn | suspect |
| 3 | Success With Remaining | `success: true` BUT `success_criteria_remaining` is non-empty | error | contradicted |
| 4 | Duplicate Constraint Discovery | `discovered_constraints` contains constraints already in previous rounds | warn | suspect |
| 5 | Recurring Violation | Same `constraint_violation` appears 3 consecutive rounds | error | contradicted |
| 6 | Retract Fresh Constraint | `retracted_constraints` contains a constraint discovered in the immediately previous round | warn | suspect |

## Key Decisions

1. **Quality score is never modified.** The gate does not produce adjusted scores. It either allows the score into the trend (trusted/suspect) or skips it (contradicted). This keeps the audit trail clean — every quality score in the trend is the real `scoreQuality()` output.

2. **Verdict does not stop the loop.** The gate informs; the circuit breaker stops. Separation of concerns: gate = data quality, breaker = loop termination.

3. **Suspect flags become warnings in the next prompt.** The agent sees them and can clarify. This turns verification from a judgment into a dialogue — the agent gets a chance to correct its report.

4. **Contradicted rounds skip the quality trend, but the round still counts.** The loop continues; the compiler just doesn't use a potentially fabricated quality score for trend-based decisions. Circuit breaker sees one fewer data point, which is safer than seeing bad data.

5. **Verification gate is a pure function.** It takes data in, returns a result. No side effects, no state, no filesystem access. This makes it trivially testable.

## Assumptions (premise collapse)

- **Assumption**: Cross-round consistency is a reliable signal of self-evaluation quality. If the agent systematically fabricates consistent (but false) self-evaluations across rounds, Layer 1 will not catch it. **Mitigation**: This is why Layer 2 (vault cross-reference) and Layer 3 (filesystem) exist as future phases. Layer 1 catches careless errors; Layer 2+3 catch deliberate ones.

## Test Plan

All in `verification-gate.test.ts`, using `node:test` + `node:assert/strict`:

### Happy path
1. `trusted verdict — all checks pass with consistent data`
2. `trusted verdict — first round (no previous round to compare)`

### Per-check tests
3. `progress regression — flagged when estimate drops > 0.2`
4. `progress regression — not flagged when estimate drops ≤ 0.2`
5. `progress regression — not flagged when estimate increases`
6. `empty change with passing — flagged when files_changed empty + tests all pass + success true`
7. `empty change with passing — not flagged when tests have failures`
8. `success with remaining — flagged when success=true but criteria remain`
9. `success with remaining — not flagged when success=true and criteria empty`
10. `duplicate constraint — flagged when discovered constraint already in previous round`
11. `duplicate constraint — not flagged when constraint is genuinely new`
12. `recurring violation — flagged when same violation 3 consecutive rounds`
13. `recurring violation — not flagged after only 2 consecutive rounds`
14. `retract fresh constraint — flagged when retracting constraint discovered last round`
15. `retract fresh constraint — not flagged when retracting older constraint`

### Verdict aggregation
16. `single suspect flag → verdict: suspect`
17. `single error flag → verdict: contradicted`
18. `multiple warn flags + one error → verdict: contradicted`
19. `no flags → verdict: trusted`

### Edge cases
20. `null progress_estimate — treated as 0, no regression flag against previous non-null`

## Implementation Order

1. `protocol.ts` — add types (no deps, visible to everything else)
2. `verification-gate.ts` — write module + all 6 checks
3. `verification-gate.test.ts` — write all 20 tests
4. `engine.ts` — wire verification into `invokeLoopCompile()` prompt assembly
5. `session.ts` — insert gate call in `advance()`, handle quality trend skip
6. Run `npm test` — validate no regressions + new tests pass

## Verification After Implementation

```bash
cd loopforge
npm test              # all 92 existing + ~20 new tests must pass
npx tsc --noEmit      # type-check must be clean
```

## Rollback

All changes are additive or gated behind new optional fields. No existing API surface changes. Removing the `verification-gate.ts` file and reverting the 3 call sites restores previous behavior. No data migration needed — the vault format is unchanged.
