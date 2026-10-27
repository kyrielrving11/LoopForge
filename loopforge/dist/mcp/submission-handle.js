/** v4.0.0: the ONE submission-handle projection and validator.
 *
 *  A handle bundles the three identities a held-round call needs. It is derived
 *  from the persisted session snapshot on every response and is never written
 *  to durable state. This module is deliberately free of I/O and of the
 *  `McpSession` import: `round-lifecycle.ts` needs the factory, so importing
 *  that module here would create a cycle.
 */
/** THE held-prompt predicate. A snapshot is held only when it names the current
 *  round and the exact prompted attempt the artifact was rendered for. A
 *  committed/terminated/stopped/retrying snapshot must never expose a handle:
 *  returning a stale prompt as "held" is the failure mode this predicate
 *  closes. */
export function heldPromptSnapshot(session) {
    if (!session || session.status === "stopped")
        return null;
    const snapshot = session.roundSnapshot;
    if (!snapshot)
        return null;
    if (snapshot.kind !== "evaluation")
        return null;
    if (snapshot.round !== session.currentRound)
        return null;
    if (snapshot.phase !== "prompted")
        return null;
    const artifact = snapshot.promptArtifact;
    if (!artifact)
        return null;
    if (artifact.roundId !== snapshot.roundId)
        return null;
    if (artifact.round !== snapshot.round)
        return null;
    if (artifact.attempt !== snapshot.attempt)
        return null;
    if (typeof artifact.renderedPrompt !== "string" || artifact.renderedPrompt.length === 0) {
        return null;
    }
    return snapshot;
}
/** Derive the handle from the held snapshot. Never recomputes the transaction
 *  id (the snapshot's identity is the authority), never reads the vault, and
 *  never mutates the session. */
export function makeSubmissionHandle(session) {
    const snapshot = heldPromptSnapshot(session);
    if (!snapshot || !session)
        return null;
    const { roundId, transactionId } = snapshot;
    if (typeof session.sessionId !== "string" || session.sessionId.length === 0)
        return null;
    if (typeof roundId !== "string" || roundId.length === 0)
        return null;
    if (typeof transactionId !== "string" || transactionId.length === 0)
        return null;
    return {
        sessionId: session.sessionId,
        roundId,
        transactionId,
    };
}
/** Strict shape parsing: a plain object with exactly the three non-empty
 *  string fields. No trimming, case folding, prefix matching, or defaults. */
export function parseSubmissionHandle(raw) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw))
        return null;
    const record = raw;
    const keys = Object.keys(record);
    if (keys.length !== 3)
        return null;
    if (!keys.includes("sessionId") || !keys.includes("roundId") ||
        !keys.includes("transactionId")) {
        return null;
    }
    const { sessionId, roundId, transactionId } = record;
    if (typeof sessionId !== "string" || sessionId.length === 0)
        return null;
    if (typeof roundId !== "string" || roundId.length === 0)
        return null;
    if (typeof transactionId !== "string" || transactionId.length === 0)
        return null;
    return { sessionId, roundId, transactionId };
}
/** Exact comparison against the held snapshot. The caller resolves the session
 *  by `handle.sessionId`; this function owns every field comparison so no
 *  second anchor rule can appear in the lifecycle or transport. */
export function validateSubmissionHandle(raw, session) {
    const parsed = parseSubmissionHandle(raw);
    if (!parsed) {
        return {
            ok: false,
            code: "submission_handle_required",
            reason: "shape",
            mismatched: [],
            current: null,
            detail: "submissionHandle must be an object with exactly sessionId, roundId, " +
                "and transactionId as non-empty strings.",
        };
    }
    if (!session) {
        return {
            ok: false,
            code: "session_not_found",
            reason: "session",
            mismatched: [],
            current: null,
            detail: `No session exists for sessionId "${parsed.sessionId}". Call ` +
                `loopforge_status with view="all" to find the loopId; if the held ` +
                `prompt is still in context, call loopforge_status with that loopId ` +
                `to fetch the current handle; otherwise call loopforge_resume with it.`,
        };
    }
    const current = makeSubmissionHandle(session);
    if (!current) {
        return {
            ok: false,
            code: "submission_handle_mismatch",
            reason: "no_held_prompt",
            mismatched: [],
            current: null,
            detail: "No held prompt exists for this session. Call loopforge_resume with " +
                "the loopId to recover the current prompt; loopforge_status is " +
                "read-only and cannot create one.",
        };
    }
    const mismatched = [];
    if (parsed.sessionId !== current.sessionId)
        mismatched.push("sessionId");
    if (parsed.roundId !== current.roundId)
        mismatched.push("roundId");
    if (parsed.transactionId !== current.transactionId)
        mismatched.push("transactionId");
    if (mismatched.length === 0) {
        const snapshot = heldPromptSnapshot(session);
        // `current` is non-null only when the predicate holds; the assertion is
        // local and keeps the success branch total.
        if (!snapshot) {
            return {
                ok: false,
                code: "submission_handle_mismatch",
                reason: "no_held_prompt",
                mismatched: [],
                current: null,
                detail: "No held prompt exists for this session. Call loopforge_resume with " +
                    "the loopId to recover the current prompt; loopforge_status is " +
                    "read-only and cannot create one.",
            };
        }
        return { ok: true, handle: current, snapshot };
    }
    const reason = mismatched.length > 1
        ? "attempt"
        : mismatched[0] === "sessionId"
            ? "session"
            : mismatched[0] === "roundId"
                ? "round"
                : "transaction";
    return {
        ok: false,
        code: "submission_handle_mismatch",
        reason,
        mismatched,
        current,
        detail: "submissionHandle does not match the current held attempt " +
            `(mismatched: ${mismatched.join(", ")}). Use the submissionHandle ` +
            "returned with the current prompt; do not reconstruct it.",
    };
}
/** The one deterministic warning used whenever a stale handle returns the
 *  held prompt. It names no ids and never changes with the attempt. */
export function staleHandleWarning() {
    return ("Submitted submissionHandle does not match the current held attempt — " +
        "returning the current prompt. Use the submissionHandle returned with it.");
}
//# sourceMappingURL=submission-handle.js.map