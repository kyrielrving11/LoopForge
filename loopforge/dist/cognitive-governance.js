/** v2.12/v3.7.1: User/Agent gate classification and governance helpers.
 *
 *  v3.7.1: loopforge_gate_check is a STRUCTURED preflight over
 *  GateActionDescriptor (preflightStructuredGate — the single classifier
 *  behind both the tool and the round-blocking check). The flat-text
 *  classifier (deriveGate / USER_RISK) survives only for blocked-round
 *  auto-records, which stay a record-layer convenience that never blocks.
 *  Only decisions are persisted; gate state is always re-derivable from
 *  the canonical action, so the vault never holds a second truth.
 */
import { createHash } from "node:crypto";
import { computeGoalTextHash } from "./loop-compiler.js";
import { entryRound } from "./token-utils.js";
/** Effects that always require human authorization. */
const USER_EFFECTS = new Set([
    "production", "credentials", "data_migration", "public_api", "publish",
    "payment", "external_communication",
]);
/** High-risk markers, English + Chinese. */
const USER_RISK = /production|prod\b|credential|secret|permission|publish|release|database migration|schema migration|public api break|rm\s+-rf|reset\s+--hard|send email|payment|生产|上线|凭据|密钥|权限|发布|数据迁移|破坏性/i;
/** Stable gate ID from canonicalized gate text (gate- + sha256 slice 12). */
export function deriveGateId(text) {
    return "gate-" + computeGoalTextHash(text).slice(0, 12);
}
/** Stable todo item ID (todo- + sha256 slice 8) for the LoopProjection. */
export function deriveTodoId(text) {
    return "todo-" + computeGoalTextHash(text).slice(0, 8);
}
/** Canonical serialization — sorted scope/effects make the hash stable
 *  across field-order and whitespace differences. */
export function canonicalizeGateAction(action) {
    return JSON.stringify({
        description: action.description.trim(),
        scope: [...action.scope].map((value) => value.trim()).filter(Boolean).sort(),
        effects: [...action.effects].sort(),
        reversibility: action.reversibility,
        authorization: action.authorization,
    });
}
/** 16-hex hash binding an approval to the exact action text — an edited
 *  action produces a different hash, so old approvals expire automatically. */
export function gateActionHash(action) {
    return createHash("sha256").update(canonicalizeGateAction(action)).digest("hex").slice(0, 16);
}
/** Classify a structured action descriptor (internal use; audit display). */
export function deriveStructuredGate(action) {
    const verdict = preflightStructuredGate(action);
    return {
        id: verdict.gateId,
        actionHash: verdict.actionHash,
        gate: verdict.kind === "user"
            ? {
                kind: "user",
                question: verdict.approvalQuestion,
                blockedScope: verdict.blockedScope,
                allowedWork: verdict.allowedBeforeApproval,
            }
            : {
                kind: "agent",
                problem: action.description,
                requiredEvidence: verdict.requiredEvidence,
                suggestedResolution: verdict.suggestedResolution,
            },
    };
}
/** v3.7.1: the structured gate preflight — the SINGLE classifier behind
 *  loopforge_gate_check and the round-blocking check. Conservative by
 *  default: anything that cannot be proven safe is user_required, with
 *  stable reason codes instead of keyword guessing. `gateId` binds the
 *  canonical action, so any field change produces a new id and expires old
 *  approvals. */
export function preflightStructuredGate(action) {
    const actionHash = gateActionHash(action);
    const gateId = `gate-${actionHash}`;
    const reasonCodes = [];
    const highRiskEffects = action.effects.filter((effect) => USER_EFFECTS.has(effect));
    for (const effect of highRiskEffects)
        reasonCodes.push(`effects:${effect}`);
    if (action.reversibility === "irreversible")
        reasonCodes.push("reversibility:irreversible");
    if (action.reversibility === "unknown")
        reasonCodes.push("reversibility:unknown");
    if (action.authorization === "user_required")
        reasonCodes.push("authorization:user_required");
    if (action.authorization === "unknown")
        reasonCodes.push("authorization:unknown");
    if (action.effects.length === 0)
        reasonCodes.push("effects_empty");
    if (action.scope.length === 0)
        reasonCodes.push("scope_empty");
    const explicitHighRisk = action.authorization === "user_required" ||
        action.reversibility === "irreversible" ||
        action.reversibility === "unknown" ||
        highRiskEffects.length > 0;
    // Conservative default: unknown authorization or an empty effects list
    // cannot be proven safe → user_required (risk unknown, not low).
    const userRequired = explicitHighRisk || action.authorization === "unknown" ||
        action.effects.length === 0;
    const risk = userRequired
        ? (explicitHighRisk ? "high" : "unknown")
        : "low";
    return {
        gateId,
        actionHash,
        kind: userRequired ? "user" : "agent",
        risk,
        decision: userRequired ? "user_required" : "agent_allowed",
        reasonCodes,
        ...(userRequired
            ? {
                approvalQuestion: `Authorize this action: ${action.description}`,
                blockedScope: action.scope.length ? action.scope : [action.description],
                allowedBeforeApproval: [
                    "Read-only investigation",
                    "Local dry-run",
                    "Prepare verification and rollback evidence",
                ],
            }
            : {
                requiredEvidence: action.scope,
                suggestedResolution: "Resolve the technical blocker and submit concrete evidence in the round evaluation.",
            }),
    };
}
/** Classify a flat gate text (MCP surface). The id embeds the canonicalized
 *  text hash, so a changed blocker text yields a different gate id and any
 *  previously recorded approval no longer matches. */
export function deriveGate(action, scope = []) {
    if (typeof action !== "string")
        return deriveStructuredGate(action);
    const normalized = [action, ...scope].join("\n").trim();
    const id = deriveGateId(normalized);
    const gate = USER_RISK.test(normalized)
        ? {
            kind: "user",
            question: `Authorize this high-risk action: ${action}`,
            blockedScope: scope.length ? scope : [action],
            allowedWork: ["Read-only investigation", "Local dry-run", "Prepare verification and rollback evidence"],
        }
        : {
            kind: "agent",
            problem: action,
            requiredEvidence: scope,
            suggestedResolution: "Resolve the technical blocker and submit concrete evidence in RoundReport.",
        };
    return { id, gate };
}
/** Deterministic replay order for audit — backends may return entries in
 *  different physical orders, so insertion order can never decide which
 *  gate decision or verification result wins. */
export function auditOrder(entries) {
    return entries
        .map((entry, index) => ({ entry, index }))
        .sort((left, right) => {
        // v2.14: the event_sequence sort layer was removed — no entry in the
        // codebase ever writes that field, so the branch was unreachable.
        const roundDiff = entryRound(left.entry) - entryRound(right.entry);
        if (roundDiff !== 0)
            return roundDiff;
        const timeLeft = Date.parse(left.entry.timestamp ?? "");
        const timeRight = Date.parse(right.entry.timestamp ?? "");
        const validLeft = Number.isFinite(timeLeft);
        const validRight = Number.isFinite(timeRight);
        if (validLeft && validRight && timeLeft !== timeRight)
            return timeLeft - timeRight;
        if (validLeft !== validRight)
            return validLeft ? -1 : 1;
        const key = (entry) => [
            entry.task_type ?? "",
            entry.task_id ?? entry.id ?? "",
            entry.gate_id ?? "",
            entry.approved === true ? "1" : entry.approved === false ? "0" : "",
        ].join("\0");
        const keyDiff = key(left.entry).localeCompare(key(right.entry));
        return keyDiff !== 0 ? keyDiff : left.index - right.index;
    })
        .map(({ entry }) => entry);
}
//# sourceMappingURL=cognitive-governance.js.map