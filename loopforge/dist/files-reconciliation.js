/** The ONE agent-report vs machine-observation file reconciliation.
 *
 *  The agent's `execution_report.files_changed` is a report; the Git
 *  `ObservationDelta.changedFiles` is the machine fact. This module compares
 *  them with exact, set-based path semantics (no fuzzy matching, no path
 *  normalization) and is shared by the verification gate, the submission
 *  receipt and the replay metrics. It is a pure projection: nothing here is
 *  persisted or fed back into a later prompt.
 */
import { FILES_RECONCILIATION_SCOPE } from "./protocol.js";
import { gitDeltaState } from "./evidence-provider.js";
export function deriveFilesReconciliation(report, deltas, options = {}) {
    const reported = [...(report?.files_changed ?? [])];
    const attempted = options.attempted ?? report != null;
    const git = gitDeltaState(deltas);
    if (git.state === "not_applicable") {
        return {
            status: "not_applicable",
            scope: FILES_RECONCILIATION_SCOPE,
            attempted,
            reported,
            observed: null,
            unreported: [],
            unconfirmed: [],
        };
    }
    if (git.state === "unknown") {
        return {
            status: "unknown",
            scope: FILES_RECONCILIATION_SCOPE,
            attempted,
            reported,
            observed: null,
            unreported: [],
            unconfirmed: [],
        };
    }
    const observed = [...git.changedFiles].sort();
    const reportedSet = new Set(reported);
    const unreported = observed.filter((file) => !reportedSet.has(file));
    const unconfirmed = [...reportedSet]
        .filter((file) => !git.changedFiles.has(file))
        .sort();
    const status = !attempted && unreported.length === 0
        ? "not_applicable"
        : unreported.length > 0 || unconfirmed.length > 0
            ? "mismatch"
            : "match";
    return {
        status,
        scope: FILES_RECONCILIATION_SCOPE,
        attempted,
        reported,
        observed,
        unreported,
        unconfirmed,
    };
}
//# sourceMappingURL=files-reconciliation.js.map