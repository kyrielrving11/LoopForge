/** Shared token utilities — Jaccard similarity, dedup, vault entry helpers.
 *
 * Single source of truth for tokenization and similarity functions used
 * by the compiler, verification gate, and canonical state renderer.
 *
 * The Unicode token regex covers CJK Unified Ideographs (U+4E00–U+9FFF)
 * plus CJK Extension A (U+3400–U+4DBF), ensuring consistent similarity
 * scores across all modules.
 */
// ── Tokenization & similarity ──────────────────────────────────────────────
/** Tokenize text into a set of lowercase words and CJK characters.
 *  Regex covers Latin alphanumeric + CJK Unified + CJK Extension A. */
export function tokenize(text) {
    return new Set(text.toLowerCase().match(/[a-z0-9㐀-鿿]+/g) ?? []);
}
/** Jaccard similarity in [0, 1]. Returns 1 when either set is empty
 *  (empty descriptions never match anything, so they don't false-positive). */
export function jaccardSimilarity(left, right) {
    const a = tokenize(left);
    const b = tokenize(right);
    if (a.size === 0 || b.size === 0)
        return 1;
    let intersection = 0;
    for (const value of a)
        if (b.has(value))
            intersection++;
    return intersection / new Set([...a, ...b]).size;
}
// ── Dedup helper ───────────────────────────────────────────────────────────
/** Filter null/undefined/empty strings, trim, and deduplicate via Set. */
export function unique(values) {
    return [...new Set(values
            .filter((value) => typeof value === "string")
            .map((value) => value.trim())
            .filter(Boolean))];
}
/** Derive a stable lowercase text identifier shared by compiler and renderers. */
export function deriveStableItemId(text, length = 8) {
    return createHash("sha256")
        .update(text.trim().replace(/\s+/g, " ").toLowerCase())
        .digest("hex")
        .slice(0, length);
}
// ── Type guard ──────────────────────────────────────────────────────────────
/** Narrow `unknown` to a non-array object. Used across storage, MCP, and
 *  transaction modules to validate JSON-deserialized data before field access. */
export function isRecord(value) {
    return value !== null && typeof value === "object" && !Array.isArray(value);
}
// ── Vault entry helpers ────────────────────────────────────────────────────
/** Extract the round number from the typed loop lineage. */
export function entryRound(entry) {
    const lin = (entry.loop_lineage ?? {});
    const rnd = lin.round;
    return typeof rnd === "number" && Number.isInteger(rnd) ? rnd : 0;
}
import { createHash } from "node:crypto";
//# sourceMappingURL=token-utils.js.map