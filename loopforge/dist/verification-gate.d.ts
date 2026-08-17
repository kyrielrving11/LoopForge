import type { VaultEntry } from "./backends/interface.js";
import type { ProviderSnapshot } from "./evidence-provider.js";
import type { NormalizedRoundEvaluation, VerificationResult } from "./protocol.js";
export declare function entryRound(entry: VaultEntry): number;
export declare function verifiedClaimEvidenceMissing(evaluation: NormalizedRoundEvaluation, requiredClaimIds: string[]): string[];
export declare function verifyRoundEvaluation(evaluation: NormalizedRoundEvaluation, currentRound: number, vaultEntries: VaultEntry[], _previous?: NormalizedRoundEvaluation | null, evidenceSnapshots?: ProviderSnapshot[], skippedFiles?: string[]): VerificationResult;
export interface ParsedTestCounts {
    passed: number;
    failed: number;
    skipped: number;
}
export declare function parseTestOutput(stdout: string): ParsedTestCounts | null;
//# sourceMappingURL=verification-gate.d.ts.map