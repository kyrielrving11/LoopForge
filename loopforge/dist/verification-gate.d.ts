/** Verification Gate — Layer 1 cross-round consistency checks.
 *
 * Pure-function module. Validates an agent's SelfEvaluation against the
 * loop's own lineage before it enters the compiler.
 *
 * Verdict semantics:
 * - trusted:      all checks passed; flags are informational only.
 * - suspect:      one or more warn-level flags; flags become warnings in
 *                 the next prompt so the agent can clarify.
 * - contradicted: one or more error-level flags; the success flag for
 *                 this round is excluded from the success trend (NOT
 *                 modified). Flags become hard constraints — the agent
 *                 must respond in the next round.
 */
import type { VaultEntry } from "./backends/interface.js";
import type { ProviderSnapshot } from "./evidence-provider.js";
import type { SelfEvaluation, VerificationResult } from "./protocol.js";
/** Extract the round number from a vault entry's loop_lineage.
 *  Returns 0 if the entry has no lineage or no round field.
 *  In practice, persistLoopLineage always writes round ≥ 1, so 0
 *  unambiguously means "not a valid round entry" in this context.
 *  Exported for reuse by enforcement-gate.ts. */
export declare function entryRound(entry: VaultEntry): number;
/** v1.17: Result of capturing git file state across all three categories. */
export interface GitFileState {
    /** Tracked files modified but unstaged (git diff --name-only). */
    tracked: string[];
    /** Files in the staging area (git diff --cached --name-only). */
    staged: string[];
    /** Untracked files not yet known to git (git ls-files --others --exclude-standard). */
    untracked: string[];
}
/** v1.17: Capture all git file state — modified, staged, and untracked.
 *  Returns null if git is unavailable. Each list is sorted.
 *  5-second timeout per command prevents hanging on large repos. */
export declare function captureGitFileState(): GitFileState | null;
/** v1.16: Capture the current set of modified files according to git.
 *  Returns a sorted array of relative file paths, or null if git is unavailable.
 *  Delegates to `git diff --name-only` — no staging or committing.
 *  5-second timeout prevents hanging on large repos.
 *  @deprecated v1.17 — Use captureGitFileState() for full staged/untracked coverage. */
export declare function captureGitModifiedFiles(): string[] | null;
/** Verify a SelfEvaluation against the loop's cross-round lineage.
 *
 * @param selfEval             The agent's self-evaluation for the current round.
 * @param currentRound         The current round number (1-based).
 * @param vaultEntries         Vault entries for this loop (non-feedback only).
 * @param prevSelfEval         The agent's self-evaluation from the previous round
 *                             (null for round 1).
 * @param runtimeFilesChanged  v1.16: Files detected as changed by git diff between
 *                             before/after execute. null if git is unavailable.
 *                             Used by checkFilesIntegrity to cross-validate
 *                             agent-reported files_changed against reality.
 * @param evidenceSnapshots    v1.18: Evidence snapshots from configured providers.
 *                             Used by checkEvidenceIntegrity for multi-provider
 *                             cross-validation. Defaults to empty array. */
export declare function verifySelfEvaluation(selfEval: SelfEvaluation, currentRound: number, vaultEntries: VaultEntry[], prevSelfEval?: SelfEvaluation | null, runtimeFilesChanged?: string[] | null, evidenceSnapshots?: ProviderSnapshot[]): VerificationResult;
//# sourceMappingURL=verification-gate.d.ts.map