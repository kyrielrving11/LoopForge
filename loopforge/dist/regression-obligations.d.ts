import type { VaultEntry } from "./backends/interface.js";
import type { RegressionObligation } from "./protocol.js";
/** Rebuilds regression obligations from accepted workflow events. No obligation
 * state is stored separately, so replay/backtrack remains deterministic. */
export declare function deriveRegressionObligations(entries: VaultEntry[], throughRound?: number): RegressionObligation[];
export declare function regressionSummary(obligations: RegressionObligation[]): {
    total: number;
    verified: number;
    gaps: number;
};
//# sourceMappingURL=regression-obligations.d.ts.map