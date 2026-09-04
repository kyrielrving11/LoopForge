/** Canonical read model for committed rounds.
 *
 * Durable documents remain the source of truth. This module is the only
 * place that interprets their transaction envelope or the compiler's merged
 * lineage representation. Consumers receive one stable, read-only view.
 */
import type { ProviderSnapshot } from "./evidence-provider.js";
import type { VaultEntry } from "./loop-store.js";
import type { ExecutionEvidence, PromptArtifact, RoundContract, RoundOutcome, SelfEvaluation, VerificationFlag } from "./protocol.js";
import type { RoundProcessResult } from "./round-coordinator.js";
export type CommittedAction = "continue" | "stop" | "backtrack";
export interface CommittedRoundView {
    readonly source: "feedback" | "merged";
    readonly sourceEntry: VaultEntry | Record<string, unknown>;
    readonly loopId: string;
    readonly round: number;
    readonly roundId: string;
    readonly sequence?: number;
    readonly attempt: number;
    readonly promptArtifact: PromptArtifact | null;
    readonly evaluation: SelfEvaluation | null;
    readonly executionEvidence: ExecutionEvidence | null;
    readonly verificationFlags: VerificationFlag[];
    readonly result: RoundProcessResult | null;
    readonly action: CommittedAction;
    readonly success: boolean;
    readonly outcome: RoundOutcome | null;
    readonly contractProposal: RoundContract | null;
    readonly beforeEvidence: ProviderSnapshot[];
    readonly afterEvidence: ProviderSnapshot[];
    readonly roundEvidence: ProviderSnapshot[];
    /** Normalized round-level declarations used by compiler projections. */
    readonly outputSummary?: string;
    readonly constraintViolations?: string[];
    readonly discoveredConstraints?: string[];
    readonly activeConstraints?: string[];
    readonly retractedConstraints?: string[];
    readonly emergedSubtasks?: string[];
    readonly completedSubtasks?: string[];
    readonly blockedSubtasks?: string[];
    readonly canceledSubtasks?: string[];
}
/** Decode a durable :feedback entry. Reject/terminate/in-flight envelopes are
 * not committed history and therefore do not produce a view. */
export declare function decodeCommittedRound(entry: VaultEntry): CommittedRoundView | null;
/** Decode an in-memory lineage entry after the engine merged its committed
 * feedback. The merged shape is intentionally accepted only when stamped
 * with committed_action. */
export declare function decodeMergedRound(entry: unknown): CommittedRoundView | null;
/** Normalize committed history: rollback directives disappear, later records
 * replace earlier records for the same logical round, and output is ascending. */
export declare function historyRounds(views: Iterable<CommittedRoundView | null>, beforeRound?: number): CommittedRoundView[];
export declare function committedRoundsFromEntries(entries: VaultEntry[], beforeRound?: number): CommittedRoundView[];
export declare function mergedRoundsFromEntries(entries: unknown[], beforeRound?: number): CommittedRoundView[];
/** Machine-observed git motion for the most recent contiguous window.
 * Consumers must decode durable or hydrated entries before calling this;
 * transaction-envelope interpretation stays confined to this module. */
export declare function machineGitMotionSeries(rounds: ReadonlyArray<CommittedRoundView>, currentRound: number, lookback: number): boolean[] | null;
//# sourceMappingURL=committed-round.d.ts.map