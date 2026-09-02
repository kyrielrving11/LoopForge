/** v2.12: User/Agent gate classification and governance helpers.
 *
 *  Ported from the 3.x line with the V2 flat-contract adaptation: the MCP
 *  surface works with a flat gate text (the agent's blocker description),
 *  while the structured GateActionDescriptor stays an internal type for
 *  audit display. Only decisions are persisted — gate state is always
 *  re-derivable via deriveGate, so the vault never holds a second truth.
 */
import type { DerivedGate, GateActionDescriptor } from "./protocol.js";
import type { VaultEntry } from "./loop-store.js";
export declare function entryRound(entry: VaultEntry): number;
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
/** Classify a structured action descriptor (internal use; audit display). */
export declare function deriveStructuredGate(action: GateActionDescriptor): {
    id: string;
    actionHash: string;
    gate: DerivedGate;
};
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