import type { VaultBackend } from "./backends/interface.js";
import type { ProviderSnapshot } from "./evidence-provider.js";
import type { NormalizedRoundEvaluation, StopReason, VerificationFlag } from "./protocol.js";
export interface RoundProcessInput {
    loopId: string;
    task: string;
    currentRound: number;
    maxRounds: number;
    evaluation: NormalizedRoundEvaluation;
    previousEvaluation?: NormalizedRoundEvaluation;
    consecutiveRejections: number;
    evidenceSnapshots?: ProviderSnapshot[];
    successTrajectory?: boolean[];
    backtrackSkippedFiles?: string[];
}
export interface RoundProcessResult {
    action: "continue" | "stop" | "reject" | "terminate" | "backtrack";
    stopReason?: StopReason;
    rejectionPrompt?: string;
    backtrackPrompt?: string;
    backtrackTarget?: number;
    backtrackSkippedDiscoveries?: string[];
    backtrackTriggerRule?: string;
    verificationFlags: VerificationFlag[];
    enforcementAction?: "accept" | "reject" | "terminate" | "backtrack";
    enforcementReason?: string;
    roundSuccess: boolean;
    gateContradicted: boolean;
    newConsecutiveRejections: number;
    rejectionCheck?: string;
    newLastEvaluation?: NormalizedRoundEvaluation;
    shouldPushSuccessTrajectory: boolean;
    backtrackTargetGitHead?: string;
    backtrackSkippedFiles?: string[];
}
export declare class RoundCoordinator {
    private readonly backend?;
    constructor(backend?: VaultBackend | undefined);
    processRound(input: RoundProcessInput): RoundProcessResult;
}
//# sourceMappingURL=round-coordinator.d.ts.map