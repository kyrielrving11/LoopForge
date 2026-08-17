import type { VaultEntry } from "./backends/interface.js";
import type { EnforcementResult, NormalizedRoundEvaluation, VerificationFlag, VerificationResult } from "./protocol.js";
export interface SafeRestorePoint {
    round: number;
    skippedDiscoveries: string[];
}
export declare function findSafeRestorePoint(currentRound: number, vaultEntries: VaultEntry[], maxDepth: number): SafeRestorePoint | null;
export declare function buildBacktrackPrompt(currentRound: number, targetRound: number, trigger: string, discoveries?: string[], files?: string[]): string;
export declare function enforceRound(evaluation: NormalizedRoundEvaluation, verification: VerificationResult, _currentRound: number, vaultEntries: VaultEntry[], consecutiveRejections: number): EnforcementResult;
export declare function buildRejectionPrompt(currentRound: number, task: string, result: EnforcementResult, flags?: VerificationFlag[]): string;
//# sourceMappingURL=enforcement-gate.d.ts.map