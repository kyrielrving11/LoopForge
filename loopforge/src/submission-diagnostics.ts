/** Stable diagnostic codes shared by the normalizer and the field-accounting
 *  read model. Keeping them here avoids a second string vocabulary drifting
 *  between the writer (`self-eval.ts`) and the reader (`field-accounting.ts`). */

/** A submitted array had entries but none survived normalization. Distinct
 *  from `invalid_entry`, which means a partial loss. */
export const DIAG_ALL_ENTRIES_DROPPED = "all_entries_dropped";

/** A submitted value was structurally valid but carried no content (an empty
 *  object/string that normalizes to "not set"). */
export const DIAG_EMPTY_VALUE = "empty_value";

/** The diagnostics collector hit its cap; the loss list is incomplete. */
export const DIAG_DIAGNOSTICS_TRUNCATED = "diagnostics_truncated";
