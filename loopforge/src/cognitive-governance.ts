/** v2.12: User/Agent gate classification and governance helpers.
 *
 *  Ported from the 3.x line with the V2 flat-contract adaptation: the MCP
 *  surface works with a flat gate text (the agent's blocker description),
 *  while the structured GateActionDescriptor stays an internal type for
 *  audit display. Only decisions are persisted — gate state is always
 *  re-derivable via deriveGate, so the vault never holds a second truth.
 */

import { createHash } from "node:crypto";
import { computeGoalTextHash } from "./loop-compiler.js";
import type { DerivedGate, GateActionDescriptor } from "./protocol.js";
import type { VaultEntry } from "./loop-store.js";
import { entryRound } from "./token-utils.js";

/** Effects that always require human authorization. */
const USER_EFFECTS = new Set<GateActionDescriptor["effects"][number]>([
  "production", "credentials", "data_migration", "public_api", "publish",
  "payment", "external_communication",
]);

/** High-risk markers, English + Chinese. */
const USER_RISK = /production|prod\b|credential|secret|permission|publish|release|database migration|schema migration|public api break|rm\s+-rf|reset\s+--hard|send email|payment|生产|上线|凭据|密钥|权限|发布|数据迁移|破坏性/i;

/** Stable gate ID from canonicalized gate text (gate- + sha256 slice 12). */
export function deriveGateId(text: string): string {
  return "gate-" + computeGoalTextHash(text).slice(0, 12);
}

/** Stable todo item ID (todo- + sha256 slice 8) for the LoopProjection. */
export function deriveTodoId(text: string): string {
  return "todo-" + computeGoalTextHash(text).slice(0, 8);
}

/** Canonical serialization — sorted scope/effects make the hash stable
 *  across field-order and whitespace differences. */
export function canonicalizeGateAction(action: GateActionDescriptor): string {
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
export function gateActionHash(action: GateActionDescriptor): string {
  return createHash("sha256").update(canonicalizeGateAction(action)).digest("hex").slice(0, 16);
}

/** Classify a structured action descriptor (internal use; audit display). */
export function deriveStructuredGate(
  action: GateActionDescriptor,
): { id: string; actionHash: string; gate: DerivedGate } {
  const actionHash = gateActionHash(action);
  const highRisk = action.authorization === "user_required" ||
    action.reversibility === "irreversible" ||
    action.reversibility === "unknown" ||
    action.effects.some((effect) => USER_EFFECTS.has(effect));
  const userGate = highRisk || action.authorization === "unknown" || action.effects.length === 0;
  return {
    id: `gate-${actionHash}`,
    actionHash,
    gate: userGate
      ? {
          kind: "user",
          question: `Authorize this action: ${action.description}`,
          blockedScope: action.scope.length ? action.scope : [action.description],
          allowedWork: ["Read-only investigation", "Local dry-run", "Prepare verification and rollback evidence"],
        }
      : {
          kind: "agent",
          problem: action.description,
          requiredEvidence: action.scope,
          suggestedResolution: "Resolve the technical blocker and submit concrete evidence in RoundReport.",
        },
  };
}

/** Classify a flat gate text (MCP surface). The id embeds the canonicalized
 *  text hash, so a changed blocker text yields a different gate id and any
 *  previously recorded approval no longer matches. */
export function deriveGate(
  action: string | GateActionDescriptor,
  scope: string[] = [],
): { id: string; gate: DerivedGate; actionHash?: string } {
  if (typeof action !== "string") return deriveStructuredGate(action);
  const normalized = [action, ...scope].join("\n").trim();
  const id = deriveGateId(normalized);
  const gate: DerivedGate = USER_RISK.test(normalized)
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
export function auditOrder(entries: VaultEntry[]): VaultEntry[] {
  return entries
    .map((entry, index) => ({ entry, index }))
    .sort((left, right) => {
      // v2.14: the event_sequence sort layer was removed — no entry in the
      // codebase ever writes that field, so the branch was unreachable.
      const roundDiff = entryRound(left.entry) - entryRound(right.entry);
      if (roundDiff !== 0) return roundDiff;

      const timeLeft = Date.parse(left.entry.timestamp ?? "");
      const timeRight = Date.parse(right.entry.timestamp ?? "");
      const validLeft = Number.isFinite(timeLeft);
      const validRight = Number.isFinite(timeRight);
      if (validLeft && validRight && timeLeft !== timeRight) return timeLeft - timeRight;
      if (validLeft !== validRight) return validLeft ? -1 : 1;

      const key = (entry: VaultEntry): string => [
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
