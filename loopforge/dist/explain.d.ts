/** v3.8: `loopforge explain` — the per-round "why" view.
 *
 * Read-only projection over the shared read model: committed round views,
 * the contract item reducer, machine observations, verification flags, and
 * the committed enforcement result. It never rebuilds history and never
 * writes. Every fact it prints is one the runtime already derived.
 */
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
    /** The derived before→after delta — never persisted. */
    observationDelta: Array<{
        providerId: string;
        files: string[];
    }>;
    /** True when the round committed without after-phase observations. */
    evidenceIncomplete: boolean;
    /** Committed verification findings. */
    flags: Array<{
        check: string;
        severity: string;
        detail: string;
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
}
/** Build the explain view. Pure and read-only. */
export declare function buildExplain(loopId: string, entries: VaultEntry[], round?: number): ExplainResult;
/** Human-readable rendering of the explain view (CLI default). */
export declare function renderExplain(result: ExplainResult): string;
//# sourceMappingURL=explain.d.ts.map