/** Shared cognitive facts used by typed projections and handoff views. */
import type { CommittedRoundView } from "./committed-round.js";
import type { LoopForgeResponse, LoopProjection } from "./protocol.js";
export interface DerivedCognitiveFacts {
    focus: LoopProjection["focus"];
    todo: LoopProjection["todo"];
    phase: LoopProjection["phase"];
    delegation: LoopProjection["delegation"];
    handoff: LoopProjection["handoff"];
}
export declare function deriveCognitiveFacts(input: {
    compileResponse: LoopForgeResponse | null;
    rounds: ReadonlyArray<CommittedRoundView>;
    verifiedClaims?: string[];
    openGates?: string[];
}): DerivedCognitiveFacts;
//# sourceMappingURL=cognitive-facts.d.ts.map