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
import { FILES_RECONCILIATION_SCOPE } from "./protocol.js";
import type { ObservationDelta } from "./evidence-provider.js";
import { gitDeltaState } from "./evidence-provider.js";

export interface FilesReconciliationOptions {
  /** The raw submission named execution_report.files_changed. Defaults to
   *  "an execution report exists"; receipt callers pass the exact manifest. */
  attempted?: boolean;
}

export function deriveFilesReconciliation(
  report: Pick<ExecutionReport, "files_changed"> | null | undefined,
  deltas: ReadonlyArray<ObservationDelta>,
  options: FilesReconciliationOptions = {},
): FilesReconciliation {
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

  const status: FilesReconciliation["status"] =
    !attempted && unreported.length === 0
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
