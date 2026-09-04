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

import { createHash } from "node:crypto";

// ── Tokenization & similarity ──────────────────────────────────────────────

/** CJK ranges: Unified Ideographs (U+3400–U+9FFF), Compatibility Ideographs
 *  (U+F900–U+FAFF), Extensions B–F (U+20000–U+2FA1F). */
function isCjkCodePoint(code: number): boolean {
  return (code >= 0x3400 && code <= 0x9fff)
    || (code >= 0xf900 && code <= 0xfaff)
    || (code >= 0x20000 && code <= 0x2fa1f);
}

/** Tokenize text into a set of lowercase ASCII words and CJK bigrams.
 *  Scripts are tokenized independently, so mixed text yields per-script
 *  tokens (e.g. "修复bug重入" → {修复, bug, 重入}). */
export function tokenize(text: string): Set<string> {
  const tokens = new Set<string>();
  let ascii = "";
  let cjk: string[] = [];
  const flushAscii = (): void => { if (ascii.length > 0) { tokens.add(ascii); ascii = ""; } };
  const flushCjk = (): void => {
    if (cjk.length === 1) tokens.add(cjk[0]);
    else for (let i = 0; i + 1 < cjk.length; i++) tokens.add(cjk[i] + cjk[i + 1]);
    cjk = [];
  };
  for (const ch of text.toLowerCase()) {
    const code = ch.codePointAt(0) ?? 0;
    if ((code >= 0x30 && code <= 0x39) || (code >= 0x61 && code <= 0x7a)) { flushCjk(); ascii += ch; }
    else if (isCjkCodePoint(code)) { flushAscii(); cjk.push(ch); }
    else { flushAscii(); flushCjk(); }
  }
  flushAscii();
  flushCjk();
  return tokens;
}

/** Jaccard similarity in [0, 1]. Returns 0 when either side is empty —
 *  an empty description carries no information and must not match
 *  everything (a score of 1 would make `[""]` a wildcard that falsely
 *  marks sub-goals done or suppresses criteria milestones). */
export function jaccardSimilarity(left: string, right: string): number {
  const a = tokenize(left);
  const b = tokenize(right);
  if (a.size === 0 || b.size === 0) return 0;
  let intersection = 0;
  for (const value of a) if (b.has(value)) intersection++;
  return intersection / new Set([...a, ...b]).size;
}

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
 *  `loop_lineage.round` (with `lineage.round` fallback). Returns 0 if
 *  the entry has no recognizable round field. */
export function entryRound(entry: Record<string, unknown>): number {
  const lin = (entry.loop_lineage ?? entry.lineage ?? {}) as Record<string, unknown>;
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

/** Stable-ID shape shared by constraint/criterion/sub-goal references. */
export const STABLE_ID_RE = /^(c|cr|sg)-[a-f0-9]{8}$/;
