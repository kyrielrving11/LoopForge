/** v3.9.4: prompt coverage — the ID-level proof that the delivered prompt
 *  rendered every active normative object.
 *
 *  This module is deliberately pure and dependency-light: the caller (the
 *  prompt assembler) derives the active set from the SAME `CanonicalLoopState`
 *  the renderer consumed and passes the ids each included section actually
 *  emitted. Nothing here re-derives a fact, reads prose, or becomes a second
 *  source of truth.
 *
 *  If an active normative id is missing, `assertPromptCoverage` throws
 *  `ProjectionCoverageError`; prompt preparation fails closed instead of
 *  delivering a projection that silently dropped a requirement.
 */

import type { PromptCoverage } from "./protocol.js";

export type CoverageKind = PromptCoverage["active"][number]["kind"];

/** Deterministic kind order for the `active` array. */
const KIND_RANK: Readonly<Record<CoverageKind, number>> = {
  recovery: 0,
  contract: 1,
  contract_item: 2,
  criterion: 3,
  constraint: 4,
  subgoal: 5,
  finding: 6,
};

export interface ActiveNormativeId {
  id: string;
  kind: CoverageKind;
}

/** The stable error raised when coverage is incomplete. The structured `code`
 *  is what the engine/handler chain keys on; the coverage is carried for the
 *  diagnostic payload. */
export class ProjectionCoverageError extends Error {
  readonly code = "projection_incomplete";
  readonly coverage: PromptCoverage;

  constructor(coverage: PromptCoverage) {
    const omitted = coverage.omitted
      .map((entry) => `${entry.id} (${entry.reason})`)
      .join(", ");
    super(
      omitted
        ? `prompt projection incomplete — active normative ids were not rendered: ${omitted}`
        : "prompt projection incomplete",
    );
    this.name = "ProjectionCoverageError";
    this.coverage = coverage;
  }
}

/** Deduplicate by id, keeping the strongest (lowest-rank) kind, then sort by
 *  (kind rank, id). */
export function canonicalActiveIds(
  active: ReadonlyArray<ActiveNormativeId>,
): ActiveNormativeId[] {
  const byId = new Map<string, ActiveNormativeId>();
  for (const entry of active) {
    const existing = byId.get(entry.id);
    if (!existing || KIND_RANK[entry.kind] < KIND_RANK[existing.kind]) {
      byId.set(entry.id, entry);
    }
  }
  return [...byId.values()].sort((left, right) =>
    KIND_RANK[left.kind] - KIND_RANK[right.kind] ||
    (left.id < right.id ? -1 : left.id > right.id ? 1 : 0));
}

export function derivePromptCoverage(input: {
  active: ReadonlyArray<ActiveNormativeId>;
  /** Ids emitted by the sections that were actually rendered. */
  rendered: Iterable<string>;
}): PromptCoverage {
  const active = canonicalActiveIds(input.active);
  const renderedSet = new Set(input.rendered);

  // Every normative section is protected. A missing active id is therefore
  // always a renderer defect; there is no level/budget classification that
  // could disguise it.
  const omitted: PromptCoverage["omitted"] = [];
  for (const entry of active) {
    if (renderedSet.has(entry.id)) continue;
    omitted.push({ id: entry.id, reason: "defect" });
  }
  omitted.sort((left, right) =>
    left.id < right.id ? -1 : left.id > right.id ? 1 : 0);

  return {
    active,
    rendered: [...new Set(input.rendered)].sort(),
    omitted,
    complete: omitted.length === 0,
  };
}

/** Fail closed. A caller that has not delivered the prompt yet must let this
 *  throw; no partial prompt/artifact may escape. */
export function assertPromptCoverage(coverage: PromptCoverage): void {
  if (!coverage.complete) throw new ProjectionCoverageError(coverage);
}
