/** Shared token helpers — content-addressed ids, contract canonicalization,
 *  normalization, and vault entry accessors.
 *
 *  v3.8.1: `tokenize`, `isCjkCodePoint` and `jaccardSimilarity` are gone.
 *  They existed to grade how alike two strings were, and every caller used
 *  that grade as a relationship (same criterion, same constraint, same
 *  sub-goal, task drift). Relationships now come from stable ids, explicit
 *  refs, normalized-exact text, or content hashes — never from a score.
 */

import { createHash } from "node:crypto";

// ── Dedup helper ───────────────────────────────────────────────────────────

/** Filter null/undefined/empty strings, trim, and deduplicate via Set. */
export function unique(values: Array<string | null | undefined>): string[] {
  return [...new Set(values
    .filter((value): value is string => typeof value === "string")
    .map((value) => value.trim())
    .filter(Boolean))];
}

// ── Type guard ──────────────────────────────────────────────────────────────

/** Narrow `unknown` to a non-array object. Used across storage, MCP, and
 *  transaction modules to validate JSON-deserialized data before field access. */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

// ── Vault entry helpers ────────────────────────────────────────────────────

/** Extract the round number from a vault entry-like object by reading
 *  `loop_lineage.round` (v3.7: the legacy `lineage` alias was removed).
 *  Returns 0 if the entry has no recognizable round field. */
export function entryRound(entry: unknown): number {
  const record = isRecord(entry) ? entry : {};
  const lin = (record.loop_lineage ?? {}) as Record<string, unknown>;
  const rnd = lin.round;
  return typeof rnd === "number" && Number.isInteger(rnd) ? rnd : 0;
}

// ── Stable ID derivation (v2.14: single source of truth) ───────────────────

/** Stable 8-hex item ID derived from normalized text — used for
 *  c-/cr-/sg-XXXXXXXX constraint, criterion, and sub-goal IDs.
 *  Previously copy-pasted in prompt-assembler, canonical-state, and
 *  loop-compiler; consolidation must not change the hash strategy
 *  (deterministic across rounds). */
export function deriveItemId(text: string): string {
  return createHash("sha256")
    .update(text.trim().replace(/\s+/g, " ").toLowerCase())
    .digest("hex")
    .slice(0, 8);
}

/** Stable-ID shape shared by constraint/criterion/sub-goal/contract
 *  references. v3.8 added the contract (rc-) and contract-item (rci-)
 *  namespaces. */
export const STABLE_ID_RE = /^(c|cr|sg|rc|rci)-[a-f0-9]{8}$/;

// ── v3.8: Contract identity (content-addressed, round-independent) ──────────

/** Normalize one contract text field for identity purposes. */
export function normalizeText(text: string): string {
  return text.trim().replace(/\s+/g, " ").toLowerCase();
}

/** The contract-item fields that participate in rci-/rc- identity. Structural
 *  (not imported from protocol.ts) so this module keeps its zero-dependency
 *  position alongside the other pure token helpers. */
export interface ContractIdentityItem {
  description: string;
  criterion_refs: string[];
  subgoal_refs: string[];
  verify_with: string[];
}

/** v3.8: Canonical form of a contract proposal. Identity is CONTENT only —
 *  restating an unchanged contract keeps the same rc-/rci- ids, unlike a
 *  SubGoal whose id includes its declaration round. Array order is part of
 *  the identity. */
export function canonicalContractText(contract: {
  work_item?: string;
  scope: string[];
  items: ContractIdentityItem[];
}): string {
  const canonical = {
    work_item: normalizeText(contract.work_item ?? ""),
    scope: contract.scope.map(normalizeText),
    items: contract.items.map((item) => ({
      description: normalizeText(item.description),
      criterion_refs: item.criterion_refs.map(normalizeText),
      subgoal_refs: item.subgoal_refs.map(normalizeText),
      verify_with: item.verify_with.map(normalizeText),
    })),
  };
  return JSON.stringify(canonical);
}

/** v3.8: rc-XXXXXXXX — loopId + canonical content. */
export function deriveContractId(
  loopId: string,
  contract: Parameters<typeof canonicalContractText>[0],
): string {
  return `rc-${deriveItemId(`${loopId} ${canonicalContractText(contract)}`)}`;
}

/** v3.8: rci-XXXXXXXX — the item's own content plus a duplicate ordinal.
 *  Deliberately independent of the contract id: editing `work_item` or
 *  `scope` must not invalidate every item id the agent already cited. */
export function deriveContractItemId(
  item: ContractIdentityItem,
  duplicateOrdinal: number,
): string {
  const canonical = JSON.stringify({
    description: normalizeText(item.description),
    criterion_refs: item.criterion_refs.map(normalizeText),
    subgoal_refs: item.subgoal_refs.map(normalizeText),
    verify_with: item.verify_with.map(normalizeText),
    duplicate_ordinal: duplicateOrdinal,
  });
  return `rci-${deriveItemId(canonical)}`;
}

/** v3.8: Assign ids to a proposal's items in declaration order. Items with
 *  identical normalized content get distinct ids through their duplicate
 *  ordinal. */
export function deriveContractItemIds(
  items: ReadonlyArray<ContractIdentityItem>,
): string[] {
  const seen = new Map<string, number>();
  return items.map((item) => {
    const key = JSON.stringify({
      description: normalizeText(item.description),
      criterion_refs: item.criterion_refs.map(normalizeText),
      subgoal_refs: item.subgoal_refs.map(normalizeText),
      verify_with: item.verify_with.map(normalizeText),
    });
    const ordinal = seen.get(key) ?? 0;
    seen.set(key, ordinal + 1);
    return deriveContractItemId(item, ordinal);
  });
}

// ── File-path token extraction ──────────────────────────────────────────────

/** File-path-like token pattern (e.g. "src/auth/login.ts"). Previously
 *  duplicated as literals in verification-gate.ts and enforcement-gate.ts;
 *  consolidation must not change the pattern (deterministic matching). */
const FILE_PATH_TOKEN_RE = /[\w./-]+\.[a-z]{2,6}\b/gi;

/** Extract the distinct file-path-like tokens from text. The module-local
 *  /g regex is safe to share across callers: matchAll always consumes the
 *  string to exhaustion, which resets lastIndex before any later use. */
export function extractFilePathTokens(text: string): string[] {
  const found = new Set<string>();
  for (const match of text.matchAll(FILE_PATH_TOKEN_RE)) found.add(match[0]);
  return [...found];
}
