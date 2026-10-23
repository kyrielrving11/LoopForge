/** v3.8: `loopforge explain` — the per-round "why" view.
 *
 * Read-only projection over the shared read model: committed round views,
 * the contract item reducer, machine observations, verification flags, and
 * the committed enforcement result. It never rebuilds history and never
 * writes. Every fact it prints is one the runtime already derived.
 */
import type { SubmissionReceipt } from "./protocol.js";
import type { VaultEntry } from "./loop-store.js";
export interface ExplainRound {
    round: number;
    roundId: string;
    attempt: number;
    action: string;
    outcome: string | null;
    /** The agent's own report, quoted back for audit. */
    report: {
        output_summary: string;
        success: boolean;
        criterion_claims: Array<{
            criterion_id: string;
            outcome: string;
        }>;
        contract_item_claims: Array<{
            item_id: string;
            outcome: string;
        }>;
    } | null;
    /** What the machine observed this round. */
    observations: Array<{
        providerId: string;
        kind: string;
        phase: string;
        status: string;
        files: string[];
    }>;
    /** The derived before→after delta — never persisted. Raw observations keep
     *  their own `files` in `observations`; this block carries only the change
     *  set, which is null when the boundary pair is not comparable. */
    observationDelta: Array<{
        providerId: string;
        kind: string;
        changedFiles: string[] | null;
        beforeStatus: string | null;
        afterStatus: string | null;
        /** v3.9.9: the provider's derived progress fact for this delta, with its
         *  coverage. This is the same fact the rules select; it is not re-judged. */
        progress: {
            kind: "git" | "custom";
            coverage: {
                domain: string;
                object: string;
                scope: string;
                version: number;
            };
            state: "changed" | "unchanged" | "unknown";
            complete: boolean;
            detail?: string;
        } | null;
    }>;
    /** v3.9.1: the Git boundary facts, from the same shared derivation. */
    files_changed: string[] | null;
    git_change_state: "not_applicable" | "unknown" | "observed";
    head_before: string | null;
    head_after: string | null;
    git_status: string | null;
    coverage: string | null;
    /** v3.9.1: the committed submission's receipt (same derivation as status). */
    submission: SubmissionReceipt;
    /** True when the round committed without a complete observable boundary. */
    evidenceIncomplete: boolean;
    /** Committed verification findings. */
    flags: Array<{
        check: string;
        severity: string;
        detail: string;
        ref?: string;
    }>;
    /** The contract the round executed under, and every item's derived status. */
    contract: {
        id: string;
        declared_at_round: number;
        closure: string;
        items: Array<{
            itemId: string;
            status: string;
            reasons: string[];
        }>;
    } | null;
    /** v3.9.9: this round's explicit contract redirect, report-only. */
    contractTransition: {
        kind: "supersede";
        contract_id: string;
        reason?: string;
    } | null;
}
export interface ExplainResult {
    loopId: string;
    /** Only the requested round when `round` was given. */
    rounds: ExplainRound[];
    /** The contract active for the NEXT round (derived), when one exists. */
    activeContract: {
        id: string;
        work_item?: string;
        itemCount: number;
    } | null;
    /** v3.9.6: committed rollback directives as events, never normal rounds. */
    rollbacks: Array<{
        round: number;
        transactionId: string;
        origin: "agent" | "machine";
        redoRound: number;
        targetCheckpointId: string;
        reason: string;
        skippedFiles: string[];
    }>;
}
/** Build the explain view. Pure and read-only. */
export declare function buildExplain(loopId: string, entries: VaultEntry[], round?: number): ExplainResult;
/** Human-readable rendering of the explain view (CLI default). */
export declare function renderExplain(result: ExplainResult): string;
//# sourceMappingURL=explain.d.ts.map