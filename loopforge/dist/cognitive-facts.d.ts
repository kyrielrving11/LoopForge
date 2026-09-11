/** Shared cognitive facts used by typed projections and handoff views. */
import type { CommittedRoundView } from "./committed-round.js";
import type { LoopForgeResponse, LoopProjection } from "./protocol.js";
import type { RoundFacts } from "./round-facts.js";
export interface DerivedCognitiveFacts {
    focus: LoopProjection["focus"];
    todo: LoopProjection["todo"];
    phase: LoopProjection["phase"];
    delegation: LoopProjection["delegation"];
    handoff: LoopProjection["handoff"];
    /** v3.8: forwarded, not re-derived — the same facts the canonical state
     *  embeds, so the projection and the prompt cannot disagree. */
    verified_subgoals: LoopProjection["verified_subgoals"];
}
/** Re-exported from round-facts.ts. The contract-fact derivation (walker,
 *  item reducer, verified sub-goals, verification debt) lives with the bundle
 *  every consumer reads — one implementation, one history window. */
export { deriveVerifiedSubGoals, deriveVerificationDebt } from "./round-facts.js";
export declare function deriveCognitiveFacts(input: {
    compileResponse: LoopForgeResponse | null;
    rounds: ReadonlyArray<CommittedRoundView>;
    /** v3.8.1: the contract facts, REQUIRED and already derived by the caller via
     *  `deriveRoundFacts`. This function used to run the same reducers again over
     *  its own window, which let the projection and the prompt disagree about
     *  what the machine had verified. */
    facts: RoundFacts;
    verifiedClaims?: string[];
    openGates?: string[];
}): DerivedCognitiveFacts;
//# sourceMappingURL=cognitive-facts.d.ts.map