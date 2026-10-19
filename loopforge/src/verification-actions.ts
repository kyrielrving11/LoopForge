/** The ONE actionable instruction table for verification checks.
 *
 *  Kept separate from the prompt assembler so the evaluation-field guidance
 *  can quote the same action without depending on a renderer. Keys are the
 *  plain check-name strings (NOT imported from verification-gate.ts — it
 *  already imports loop-compiler, which imports the prompt layer, so
 *  importing back would cycle). Full coverage of every CHECK_* constant is
 *  enforced by a test that iterates the verification-gate module's CHECK_
 *  exports; a new constant can never silently lack an action entry.
 */

export const VERIFICATION_ACTIONS: Readonly<Record<string, string>> = {
  success_with_remaining_criteria:
    "Complete the remaining criteria before claiming success, or set success=false and report what remains.",
  success_without_verified_evidence:
    "Back the success claim with machine-verifiable evidence: run tests or a required verification command and report the actual output. If you genuinely performed no work, provide execution_report and declare no_change_reason.",
  outcome_success_contradiction:
    "Reconcile the declared outcome with the success flag and resubmit an honest evaluation.",
  blocked_without_blocker:
    "State the concrete blocker, or drop the blocked outcome.",
  retroactive_claim_bad_round:
    "Correct the referenced round number, or withdraw the retroactive claim.",
  retroactive_claim_unverified:
    "Provide evidence for the retroactive claim, or withdraw it.",
  duplicate_constraint_discovery:
    "Update the existing constraint entry instead of duplicating it.",
  recurring_violation:
    "Explain why this violation keeps recurring and try a different approach — do not repeat the failed strategy.",
  retract_fresh_constraint:
    "Justify the retraction explicitly, or restore the constraint.",
  // 3.9.3: the reported-vs-observed fix is spelled out. The committed flag
  // already carries the `unreported` / `unconfirmed` path sets; this is the
  // action that turns the receipt's mismatch into a correct next report.
  evidence_integrity:
    "Report only the net boundary change: add every machine-observed path you omitted, remove every path the machine did not observe, and include deletions.",
  required_command_failed:
    "Re-run the required verification command and report its actual output before claiming success.",
  command_evidence_mismatch:
    "Report the true command output and reconcile the mismatch.",
  backtrack_workspace_not_restored:
    "Restore the skipped-round files and the expected git HEAD, then resubmit.",
  criteria_claims_unverified:
    "Provide evidence for each claimed success criterion.",
  // v3.3 — Round Contract checks (and the three v3.3 checks that predated
  // this table entry and fell back to the generic action).
  verification_entrypoint_modified:
    "Re-run the verification command on the changed entrypoint, or revert the entrypoint change and re-run.",
  test_files_modified:
    "Re-run the verification command after the test-file changes and report the fresh output.",
  round_scope_drift:
    "Revert the out-of-scope file changes, or close the active contract and declare the extended scope in a new proposal. Scope drift is a machine fact and is not waivable by explanation.",
  // v3.8 — item model: claimed-but-unverified debt
  contract_items_unverified:
    "Run the bound command(s) for each claimed item so they are observed passing, or report the item as remaining (or declare outcome=\"blocked\").",
  contract_premature:
    "The ACTIVE contract is still open — restate it unchanged to continue it; a different contract is ignored until every item is verified or the round reports blocked.",
  // v3.7.1 — opt-in gate layer: cited gates need an approved human decision
  user_gate_unresolved:
    "The round cites a high-risk action without an approved human decision. Run loopforge_gate_check, present the approval question, call loopforge_gate_resolve after the human decides, and resubmit with the approved gate id in evaluation.gate_ids.",
};

/** Fallback for unmapped check names (forward-compat with future checks). */
const VERIFICATION_ACTION_FALLBACK =
  "Re-examine the flagged claim and correct your evaluation before resubmitting.";

export function verificationActionFor(check: string): string {
  return VERIFICATION_ACTIONS[check] ?? VERIFICATION_ACTION_FALLBACK;
}
