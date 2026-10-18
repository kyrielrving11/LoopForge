/** The ONE agent-report vs machine-observation file reconciliation.
 *
 *  The agent's `execution_report.files_changed` is a report; the Git
 *  `ObservationDelta.changedFiles` is the machine fact. This module compares
 *  them with exact, set-based path semantics (no fuzzy matching, no path
 *  normalization) and is shared by the verification gate, the submission
 *  receipt and the replay metrics. It is a pure projection: nothing here is
 *  persisted or fed back into a later prompt.
 */
import type { ExecutionReport, FilesReconciliation } from "./protocol.js";
import type { ObservationDelta } from "./evidence-provider.js";
export interface FilesReconciliationOptions {
    /** The raw submission named execution_report.files_changed. Defaults to
     *  "an execution report exists"; receipt callers pass the exact manifest. */
    attempted?: boolean;
}
export declare function deriveFilesReconciliation(report: Pick<ExecutionReport, "files_changed"> | null | undefined, deltas: ReadonlyArray<ObservationDelta>, options?: FilesReconciliationOptions): FilesReconciliation;
//# sourceMappingURL=files-reconciliation.d.ts.map