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
export function unique(values) {
    return [...new Set(values
            .filter((value) => typeof value === "string")
            .map((value) => value.trim())
            .filter(Boolean))];
}
/** v3.9.4: deduplicate by the SAME normalized-exact identity the stable ID
 *  derivation uses. `unique` is trim-only, so "Tests pass" and "tests pass"
 *  survived as two entries with one `cr-*` id. The first spelling wins. */
export function uniqueNormalized(values) {
    const seen = new Set();
    const out = [];
    for (const value of values) {
        if (typeof value !== "string")
            continue;
        const text = value.trim();
        if (!text)
            continue;
        const key = normalizeText(text);
        if (seen.has(key))
            continue;
        seen.add(key);
        out.push(text);
    }
    return out;
}
// ── Type guard ──────────────────────────────────────────────────────────────
/** Narrow `unknown` to a non-array object. Used across storage, MCP, and
 *  transaction modules to validate JSON-deserialized data before field access. */
export function isRecord(value) {
    return value !== null && typeof value === "object" && !Array.isArray(value);
}
// ── Vault entry helpers ────────────────────────────────────────────────────
/** Extract the round number from a vault entry-like object by reading
 *  `loop_lineage.round` (v3.7: the legacy `lineage` alias was removed).
 *  Returns 0 if the entry has no recognizable round field. */
export function entryRound(entry) {
    const record = isRecord(entry) ? entry : {};
    const lin = (record.loop_lineage ?? {});
    const rnd = lin.round;
    return typeof rnd === "number" && Number.isInteger(rnd) ? rnd : 0;
}
// ── Stable ID derivation (v2.14: single source of truth) ───────────────────
/** Stable 8-hex item ID derived from normalized text — used for
 *  c-/cr-/sg-XXXXXXXX constraint, criterion, and sub-goal IDs.
 *  Previously copy-pasted in prompt-assembler, canonical-state, and
 *  loop-compiler; consolidation must not change the hash strategy
 *  (deterministic across rounds). */
export function deriveItemId(text) {
    return createHash("sha256")
        .update(text.trim().replace(/\s+/g, " ").toLowerCase())
        .digest("hex")
        .slice(0, 8);
}
/** Stable-ID shape shared by constraint/criterion/sub-goal/contract
 *  references. v3.8 added the contract (rc-) and contract-item (rci-)
 *  namespaces. */
export const STABLE_ID_RE = /^(c|cr|sg|rc|rci)-[a-f0-9]{8}$/;
/** v2.11: Derive a stable criterion ID from its text hash (cr-XXXXXXXX).
 *  Same hash strategy as SubGoal — deterministic across rounds.
 *
 *  v3.8.1: lives here (with the other id helpers) because the criterion fact
 *  derivation and the compiler both need it; it used to sit in loop-compiler,
 *  which would have made `round-facts.ts` ⇄ `loop-compiler.ts` an import
 *  cycle. `loop-compiler.ts` re-exports it, so its public surface is
 *  unchanged. */
export function deriveCriterionId(text) {
    return "cr-" + deriveItemId(text);
}
/** The cr-XXXXXXXX shape — the ONE predicate every criterion-reference reader
 *  uses (round-contract.ts kept an inline copy before v3.8.1). */
export function isCriterionId(ref) {
    return /^cr-[a-f0-9]{8}$/.test(ref);
}
/** v3.9.2: ONE criterion identity rule for the compiler, the prompt and the
 *  submission boundary. A reference matches a criterion when it is the real
 *  cr- id or the exact normalized criterion text. Never similarity. */
export function criterionRefMatches(ref, criterion) {
    const text = typeof criterion === "string" ? criterion : criterion.text;
    const id = typeof criterion === "string"
        ? deriveCriterionId(text)
        : (criterion.id ?? deriveCriterionId(criterion.text));
    if (isCriterionId(ref)) {
        return isCriterionId(text) ? ref === text : ref === id;
    }
    if (isCriterionId(text))
        return deriveCriterionId(ref) === text;
    return normalizeText(ref) === normalizeText(text);
}
/** v3.9.4: the stable identity of one machine finding for prompt coverage.
 *  It is a DERIVED audit key — never persisted as a second finding source and
 *  never read by compile/decision code. `(check, field, ref)` is the same
 *  subject vocabulary `RecurringFlag` groups on; JSON encoding keeps it
 *  unambiguous and deterministic. */
export function findingKey(flag) {
    return JSON.stringify([flag.check, flag.field, flag.ref ?? ""]);
}
// ── v3.8: Contract identity (content-addressed, round-independent) ──────────
/** Normalize one contract text field for identity purposes. */
export function normalizeText(text) {
    return text.trim().replace(/\s+/g, " ").toLowerCase();
}
/** v3.8: Canonical form of a contract proposal. Identity is CONTENT only —
 *  restating an unchanged contract keeps the same rc-/rci- ids, unlike a
 *  SubGoal whose id includes its declaration round. Array order is part of
 *  the identity.
 *
 *  v3.9.5: `work_item` is the slice's deliverable label (optional in this
 *  legacy-readable type); the item list is the acceptance surface. */
export function canonicalContractText(contract) {
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
export function deriveContractId(loopId, contract) {
    return `rc-${deriveItemId(`${loopId} ${canonicalContractText(contract)}`)}`;
}
/** v3.8: rci-XXXXXXXX — the item's own content plus a duplicate ordinal.
 *  Deliberately independent of the contract id: editing `work_item` or
 *  `scope` must not invalidate every item id the agent already cited. */
export function deriveContractItemId(item, duplicateOrdinal) {
    const canonical = JSON.stringify({
        description: normalizeText(item.description),
        criterion_refs: item.criterion_refs.map(normalizeText),
        subgoal_refs: item.subgoal_refs.map(normalizeText),
        verify_with: item.verify_with.map(normalizeText),
        duplicate_ordinal: duplicateOrdinal,
    });
    return `rci-${deriveItemId(canonical)}`;
}
/** v3.9.4: the normalized content identity of ONE contract item (without the
 *  duplicate ordinal). Used by the strict declaration boundary to reject two
 *  semantically identical items, so an `rci-*` citation can never be
 *  ambiguous between restatements. */
export function canonicalContractItemText(item) {
    return JSON.stringify({
        description: normalizeText(item.description),
        criterion_refs: item.criterion_refs.map(normalizeText),
        subgoal_refs: item.subgoal_refs.map(normalizeText),
        verify_with: item.verify_with.map(normalizeText),
    });
}
/** v3.8: Assign ids to a proposal's items in declaration order. Items with
 *  identical normalized content get distinct ids through their duplicate
 *  ordinal. */
export function deriveContractItemIds(items) {
    const seen = new Map();
    return items.map((item) => {
        const key = canonicalContractItemText(item);
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
export function extractFilePathTokens(text) {
    const found = new Set();
    for (const match of text.matchAll(FILE_PATH_TOKEN_RE))
        found.add(match[0]);
    return [...found];
}
//# sourceMappingURL=token-utils.js.map