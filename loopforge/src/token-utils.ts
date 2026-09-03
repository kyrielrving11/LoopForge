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

/** v3.3: Per-round machine git motion — whether git observed file changes
 *  in each of the last `lookback` committed rounds, rebuilt from the
 *  feedback entries' roundEvidence snapshots (already persisted at commit).
 *  v3.5.1: also reads the merged lineage stamp (lineage.round_evidence) the
 *  engine writes at hydration — the compile-time view never sees raw
 *  :feedback entries, so without the stamp the Machine (git) dashboard row
 *  silently vanished in production prompts. The gate side (raw vault
 *  entries) keeps reading the transaction path; raw lineage entries carry
 *  no stamp and are skipped either way.
 *  Returns null when fewer than `lookback` rounds carry git snapshots — the
 *  machine signal is unavailable and callers (R4/R5) keep their legacy
 *  verdict. Lives in token-utils so both the enforcement gate and the
 *  compiler can read the signal without an import cycle; the snapshot
 *  shape is parsed defensively because no storage type must be imported
 *  here. */
export function machineGitMotionSeries(
  entries: readonly Record<string, unknown>[],
  currentRound: number,
  lookback: number,
): boolean[] | null {
  const byRound = new Map<number, boolean>();
  for (const entry of entries) {
    const rnd = entryRound(entry);
    if (rnd <= 0 || rnd >= currentRound) continue;
    const lin = isRecord(entry.loop_lineage) ? entry.loop_lineage : null;
    const rt = lin && isRecord(lin.round_transaction) ? lin.round_transaction : null;
    const snapshot = rt && isRecord(rt.snapshot) ? rt.snapshot : null;
    // v3.5.1: two evidence arms — the raw :feedback transaction path and
    // the merged lineage stamp written by engine hydration. An entry with
    // neither carries no machine observation and is skipped (raw lineage
    // entries on disk have no stamp).
    const roundEvidence = Array.isArray(snapshot?.roundEvidence)
      ? snapshot.roundEvidence
      : Array.isArray(lin?.round_evidence)
        ? lin.round_evidence
        : null;
    if (!roundEvidence) continue;
    const git = (roundEvidence as unknown[]).find((value) =>
      isRecord(value) && value.provider === "git");
    if (!git) continue;
    const gitFiles = (git as Record<string, unknown>).files;
    byRound.set(rnd, Array.isArray(gitFiles) && gitFiles.length > 0);
  }
  if (byRound.size < lookback) return null;
  const sorted = [...byRound.keys()].sort((a, b) => a - b);
  const recent = sorted.slice(-lookback);
  // Continuity: the recent rounds must be the actual last `lookback` rounds.
  if (recent[0] < currentRound - lookback) return null;
  return recent.map((round) => byRound.get(round)!);
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
