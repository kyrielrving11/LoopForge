/** Attempted → retained accounting over the normalizer's persisted output.
 *
 *  `submittedFields` records what appeared in the raw payload. This module
 *  answers the second question: which of those values did the normalizer
 *  actually retain in `SelfEvaluation`? It reads ONLY persisted facts —
 *  the manifest, the diagnostics, and the normalized evaluation — so a
 *  committed round can be rebuilt without re-parsing the raw payload and
 *  without a second ledger.
 *
 *  A path is retained when it was attempted, no whole-field drop diagnostic
 *  exists, and the evaluation carries a value attributable to it. Partial
 *  losses (some array entries dropped) leave the field retained; their
 *  diagnostics remain visible in the receipt.
 */
import type { SelfEvaluation, SubmissionDiagnostic } from "./protocol.js";
export interface FieldAccountingSource {
    submittedFields: readonly string[];
    normalizationDiagnostics: readonly SubmissionDiagnostic[];
    evaluation: SelfEvaluation | null;
}
export interface FieldAccounting {
    /** FIELD_ORDER order. */
    retained: string[];
    /** Diagnostics were truncated, the evaluation is missing, or an attempted
     *  path is neither retained nor whole-field dropped. Never a normal state. */
    incomplete: boolean;
}
export declare function deriveFieldAccounting(source: FieldAccountingSource): FieldAccounting;
//# sourceMappingURL=field-accounting.d.ts.map