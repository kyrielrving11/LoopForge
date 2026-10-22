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
export interface ActiveNormativeId {
    id: string;
    kind: CoverageKind;
}
/** The stable error raised when coverage is incomplete. The structured `code`
 *  is what the engine/handler chain keys on; the coverage is carried for the
 *  diagnostic payload. */
export declare class ProjectionCoverageError extends Error {
    readonly code = "projection_incomplete";
    readonly coverage: PromptCoverage;
    constructor(coverage: PromptCoverage);
}
/** Deduplicate by id, keeping the strongest (lowest-rank) kind, then sort by
 *  (kind rank, id). */
export declare function canonicalActiveIds(active: ReadonlyArray<ActiveNormativeId>): ActiveNormativeId[];
export declare function derivePromptCoverage(input: {
    active: ReadonlyArray<ActiveNormativeId>;
    /** Ids emitted by the sections that were actually rendered. */
    rendered: Iterable<string>;
}): PromptCoverage;
/** Fail closed. A caller that has not delivered the prompt yet must let this
 *  throw; no partial prompt/artifact may escape. */
export declare function assertPromptCoverage(coverage: PromptCoverage): void;
//# sourceMappingURL=prompt-coverage.d.ts.map