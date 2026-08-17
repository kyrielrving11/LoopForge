/** Shared token utilities — Jaccard similarity, dedup, vault entry helpers.
 *
 * Single source of truth for tokenization and similarity functions used
 * by the compiler, verification gate, and canonical state renderer.
 *
 * The Unicode token regex covers CJK Unified Ideographs (U+4E00–U+9FFF)
 * plus CJK Extension A (U+3400–U+4DBF), ensuring consistent similarity
 * scores across all modules.
 */
/** Tokenize text into a set of lowercase words and CJK characters.
 *  Regex covers Latin alphanumeric + CJK Unified + CJK Extension A. */
export declare function tokenize(text: string): Set<string>;
/** Jaccard similarity in [0, 1]. Returns 1 when either set is empty
 *  (empty descriptions never match anything, so they don't false-positive). */
export declare function jaccardSimilarity(left: string, right: string): number;
/** Filter null/undefined/empty strings, trim, and deduplicate via Set. */
export declare function unique(values: Array<string | null | undefined>): string[];
/** Derive a stable lowercase text identifier shared by compiler and renderers. */
export declare function deriveStableItemId(text: string, length?: number): string;
/** Narrow `unknown` to a non-array object. Used across storage, MCP, and
 *  transaction modules to validate JSON-deserialized data before field access. */
export declare function isRecord(value: unknown): value is Record<string, unknown>;
/** Extract the round number from the typed loop lineage. */
export declare function entryRound(entry: Record<string, unknown>): number;
//# sourceMappingURL=token-utils.d.ts.map