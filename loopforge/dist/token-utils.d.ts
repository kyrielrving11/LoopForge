/** Shared token utilities — Jaccard similarity, dedup, vault entry helpers.
 *
 * Single source of truth for tokenization and similarity functions used
 * by the compiler, verification gate, and canonical state renderer.
 *
 * Latin alphanumerics tokenize as whole words; consecutive CJK characters
 * tokenize as overlapping 2-grams (a lone CJK character is its own token)
 * so CJK similarity takes intermediate values instead of collapsing to
 * 0/1. The ranges cover Unified Ideographs, Compatibility Ideographs and
 * Extensions B–F (surrogate-pair code points the legacy regex missed).
 */
/** Tokenize text into a set of lowercase ASCII words and CJK bigrams.
 *  Scripts are tokenized independently, so mixed text yields per-script
 *  tokens (e.g. "修复bug重入" → {修复, bug, 重入}). */
export declare function tokenize(text: string): Set<string>;
/** Jaccard similarity in [0, 1]. Returns 0 when either side is empty —
 *  an empty description carries no information and must not match
 *  everything (a score of 1 would make `[""]` a wildcard that falsely
 *  marks sub-goals done or suppresses criteria milestones). */
export declare function jaccardSimilarity(left: string, right: string): number;
/** Filter null/undefined/empty strings, trim, and deduplicate via Set. */
export declare function unique(values: Array<string | null | undefined>): string[];
/** Narrow `unknown` to a non-array object. Used across storage, MCP, and
 *  transaction modules to validate JSON-deserialized data before field access. */
export declare function isRecord(value: unknown): value is Record<string, unknown>;
/** Extract the round number from a vault entry-like object by reading
 *  `loop_lineage.round` (v3.7: the legacy `lineage` alias was removed).
 *  Returns 0 if the entry has no recognizable round field. */
export declare function entryRound(entry: unknown): number;
/** Stable 8-hex item ID derived from normalized text — used for
 *  c-/cr-/sg-XXXXXXXX constraint, criterion, and sub-goal IDs.
 *  Previously copy-pasted in prompt-assembler, canonical-state, and
 *  loop-compiler; consolidation must not change the hash strategy
 *  (deterministic across rounds). */
export declare function deriveItemId(text: string): string;
/** Stable-ID shape shared by constraint/criterion/sub-goal references. */
export declare const STABLE_ID_RE: RegExp;
//# sourceMappingURL=token-utils.d.ts.map