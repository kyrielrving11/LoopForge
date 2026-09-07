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
import type { DerivedGate, GateActionDescriptor } from "./protocol.js";
import type { VaultEntry } from "./loop-store.js";
/** Stable gate ID from canonicalized gate text (gate- + sha256 slice 12). */
export declare function deriveGateId(text: string): string;
/** Stable todo item ID (todo- + sha256 slice 8) for the LoopProjection. */
export declare function deriveTodoId(text: string): string;
/** Canonical serialization — sorted scope/effects make the hash stable
 *  across field-order and whitespace differences. */
export declare function canonicalizeGateAction(action: GateActionDescriptor): string;
/** 16-hex hash binding an approval to the exact action text — an edited
 *  action produces a different hash, so old approvals expire automatically. */
export declare function gateActionHash(action: GateActionDescriptor): string;
/** v3.7.1: outcome of the structured gate preflight. */
export type GateVerdict = "agent_allowed" | "user_required";
export interface StructuredGateVerdict {
    gateId: string;
    actionHash: string;
    kind: "user" | "agent";
    risk: "low" | "high" | "unknown";
    decision: GateVerdict;
    reasonCodes: string[];
    approvalQuestion?: string;
    blockedScope?: string[];
    allowedBeforeApproval?: string[];
    requiredEvidence?: string[];
    suggestedResolution?: string;
}
/** Classify a structured action descriptor (internal use; audit display). */
export declare function deriveStructuredGate(action: GateActionDescriptor): {
    id: string;
    actionHash: string;
    gate: DerivedGate;
};
/** v3.7.1: the structured gate preflight — the SINGLE classifier behind
 *  loopforge_gate_check and the round-blocking check. Conservative by
 *  default: anything that cannot be proven safe is user_required, with
 *  stable reason codes instead of keyword guessing. `gateId` binds the
 *  canonical action, so any field change produces a new id and expires old
 *  approvals. */
export declare function preflightStructuredGate(action: GateActionDescriptor): StructuredGateVerdict;
/** Classify a flat gate text (MCP surface). The id embeds the canonicalized
 *  text hash, so a changed blocker text yields a different gate id and any
 *  previously recorded approval no longer matches. */
export declare function deriveGate(action: string | GateActionDescriptor, scope?: string[]): {
    id: string;
    gate: DerivedGate;
    actionHash?: string;
};
/** Deterministic replay order for audit — backends may return entries in
 *  different physical orders, so insertion order can never decide which
 *  gate decision or verification result wins. */
export declare function auditOrder(entries: VaultEntry[]): VaultEntry[];
//# sourceMappingURL=cognitive-governance.d.ts.map