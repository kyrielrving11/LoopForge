/** Shared token helpers — content-addressed ids, contract canonicalization,
 *  normalization, and vault entry accessors.
 *
 *  v3.8.1: `tokenize`, `isCjkCodePoint` and `jaccardSimilarity` are gone.
 *  They existed to grade how alike two strings were, and every caller used
 *  that grade as a relationship (same criterion, same constraint, same
 *  sub-goal, task drift). Relationships now come from stable ids, explicit
 *  refs, normalized-exact text, or content hashes — never from a score.
 */
/** Filter null/undefined/empty strings, trim, and deduplicate via Set. */
export declare function unique(values: Array<string | null | undefined>): string[];
/** v3.9.4: deduplicate by the SAME normalized-exact identity the stable ID
 *  derivation uses. `unique` is trim-only, so "Tests pass" and "tests pass"
 *  survived as two entries with one `cr-*` id. The first spelling wins. */
export declare function uniqueNormalized(values: Array<string | null | undefined>): string[];
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
/** Stable-ID shape shared by constraint/criterion/sub-goal/contract
 *  references. v3.8 added the contract (rc-) and contract-item (rci-)
 *  namespaces. */
export declare const STABLE_ID_RE: RegExp;
/** v2.11: Derive a stable criterion ID from its text hash (cr-XXXXXXXX).
 *  Same hash strategy as SubGoal — deterministic across rounds.
 *
 *  v3.8.1: lives here (with the other id helpers) because the criterion fact
 *  derivation and the compiler both need it; it used to sit in loop-compiler,
 *  which would have made `round-facts.ts` ⇄ `loop-compiler.ts` an import
 *  cycle. `loop-compiler.ts` re-exports it, so its public surface is
 *  unchanged. */
export declare function deriveCriterionId(text: string): string;
/** The cr-XXXXXXXX shape — the ONE predicate every criterion-reference reader
 *  uses (round-contract.ts kept an inline copy before v3.8.1). */
export declare function isCriterionId(ref: string): boolean;
/** v3.9.2: ONE criterion identity rule for the compiler, the prompt and the
 *  submission boundary. A reference matches a criterion when it is the real
 *  cr- id or the exact normalized criterion text. Never similarity. */
export declare function criterionRefMatches(ref: string, criterion: string | {
    id?: string;
    text: string;
}): boolean;
/** v3.9.4: the stable identity of one machine finding for prompt coverage.
 *  It is a DERIVED audit key — never persisted as a second finding source and
 *  never read by compile/decision code. `(check, field, ref)` is the same
 *  subject vocabulary `RecurringFlag` groups on; JSON encoding keeps it
 *  unambiguous and deterministic. */
export declare function findingKey(flag: {
    check: string;
    field: string;
    ref?: string;
}): string;
/** Normalize one contract text field for identity purposes. */
export declare function normalizeText(text: string): string;
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
 *  the identity.
 *
 *  v3.9.5: `work_item` is the slice's deliverable label (optional in this
 *  legacy-readable type); the item list is the acceptance surface. */
export declare function canonicalContractText(contract: {
    work_item?: string;
    scope: string[];
    items: ContractIdentityItem[];
}): string;
/** v3.8: rc-XXXXXXXX — loopId + canonical content. */
export declare function deriveContractId(loopId: string, contract: Parameters<typeof canonicalContractText>[0]): string;
/** v3.8: rci-XXXXXXXX — the item's own content plus a duplicate ordinal.
 *  Deliberately independent of the contract id: editing `work_item` or
 *  `scope` must not invalidate every item id the agent already cited. */
export declare function deriveContractItemId(item: ContractIdentityItem, duplicateOrdinal: number): string;
/** v3.9.4: the normalized content identity of ONE contract item (without the
 *  duplicate ordinal). Used by the strict declaration boundary to reject two
 *  semantically identical items, so an `rci-*` citation can never be
 *  ambiguous between restatements. */
export declare function canonicalContractItemText(item: ContractIdentityItem): string;
/** v3.8: Assign ids to a proposal's items in declaration order. Items with
 *  identical normalized content get distinct ids through their duplicate
 *  ordinal. */
export declare function deriveContractItemIds(items: ReadonlyArray<ContractIdentityItem>): string[];
/** Extract the distinct file-path-like tokens from text. The module-local
 *  /g regex is safe to share across callers: matchAll always consumes the
 *  string to exhaustion, which resets lastIndex before any later use. */
export declare function extractFilePathTokens(text: string): string[];
//# sourceMappingURL=token-utils.d.ts.map