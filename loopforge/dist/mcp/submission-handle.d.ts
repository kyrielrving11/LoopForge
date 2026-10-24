/** v4.0.0: the ONE submission-handle projection and validator.
 *
 *  A handle bundles the three identities a held-round call needs. It is derived
 *  from the persisted session snapshot on every response and is never written
 *  to durable state. This module is deliberately free of I/O and of the
 *  `McpSession` import: `round-lifecycle.ts` needs the factory, so importing
 *  that module here would create a cycle.
 */
import type { SubmissionHandle } from "../protocol.js";
import type { RoundTransactionSnapshot } from "../round-transaction.js";
/** The structural session view the handle predicate needs. */
export interface HeldSessionView {
    sessionId: string;
    currentRound: number;
    status: "running" | "stopped" | "stalled" | "paused";
    roundSnapshot?: RoundTransactionSnapshot | null;
}
/** THE held-prompt predicate. A snapshot is held only when it names the current
 *  round and the exact prompted attempt the artifact was rendered for. A
 *  committed/terminated/stopped/retrying snapshot must never expose a handle:
 *  returning a stale prompt as "held" is the failure mode this predicate
 *  closes. */
export declare function heldPromptSnapshot(session: HeldSessionView | undefined): RoundTransactionSnapshot | null;
/** Derive the handle from the held snapshot. Never recomputes the transaction
 *  id (the snapshot's identity is the authority), never reads the vault, and
 *  never mutates the session. */
export declare function makeSubmissionHandle(session: HeldSessionView | undefined): SubmissionHandle | null;
/** Strict shape parsing: a plain object with exactly the three non-empty
 *  string fields. No trimming, case folding, prefix matching, or defaults. */
export declare function parseSubmissionHandle(raw: unknown): SubmissionHandle | null;
export type SubmissionHandleMismatchReason = "no_held_prompt" | "session" | "round" | "transaction" | "attempt";
export type SubmissionHandleFailure = {
    ok: false;
    code: "submission_handle_required";
    reason: "shape";
    mismatched: [];
    current: null;
    detail: string;
} | {
    ok: false;
    code: "session_not_found";
    reason: "session";
    mismatched: [];
    current: null;
    detail: string;
} | {
    ok: false;
    code: "submission_handle_mismatch";
    reason: SubmissionHandleMismatchReason;
    mismatched: string[];
    current: SubmissionHandle | null;
    detail: string;
};
export type SubmissionHandleCheck = {
    ok: true;
    handle: SubmissionHandle;
    snapshot: RoundTransactionSnapshot;
} | SubmissionHandleFailure;
/** Exact comparison against the held snapshot. The caller resolves the session
 *  by `handle.sessionId`; this function owns every field comparison so no
 *  second anchor rule can appear in the lifecycle or transport. */
export declare function validateSubmissionHandle(raw: unknown, session: HeldSessionView | undefined): SubmissionHandleCheck;
/** The one deterministic warning used whenever a stale handle returns the
 *  held prompt. It names no ids and never changes with the attempt. */
export declare function staleHandleWarning(): string;
//# sourceMappingURL=submission-handle.d.ts.map