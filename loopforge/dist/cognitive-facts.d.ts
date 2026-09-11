/** Shared cognitive facts used by typed projections and handoff views. */
import type { CommittedRoundView } from "./committed-round.js";
import type { LoopForgeResponse, LoopProjection, SubGoal, VerifiedSubGoalFact } from "./protocol.js";
import type { CommandEvidencePolicy } from "./policy.js";
import type { ContractItemStatusView } from "./contract-items.js";
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
/** v3.8: Machine-verified sub-goal facts. DERIVED, never persisted. It never
 *  writes `SubGoal.status`: `done` stays the agent's declaration, and the fact
 *  is the machine's separate statement about it.
 *
 *  Derived from the WHOLE committed history, not from the currently-open
 *  contract. A verified item is machine history — once proven, it stays
 *  proven — while the active contract necessarily disappears the moment its
 *  last item verifies. Deriving from the active contract alone made the fact
 *  vanish at exactly the moment it became fully true, and turned the
 *  verification-debt view into a false accusation ("agent reported done,
 *  machine verification absent") against a sub-goal the machine had just
 *  verified. Each round is read through `deriveRoundContractView`, the same
 *  derivation the coordinator, explain and audit use — one history
 *  interpretation, no second read model. That re-derivation is quadratic in the
 *  round count (≈40ms at 120 rounds) and is deliberately bought: an incremental
 *  walker would be a second implementation of the closure rule, which is the
 *  one thing this module must never grow.
 *
 *  Attribution is per ITEM (`ContractItemProposal.subgoal_refs`), not per
 *  contract: an item backs exactly the sub-goals it references, so a contract
 *  whose item A verifies SubGoal 1 and whose item B verifies SubGoal 2 yields
 *  two facts with disjoint `contract_item_ids` instead of both sub-goals
 *  claiming every verified item. */
export declare function deriveVerifiedSubGoals(input: {
    subGoals: ReadonlyArray<SubGoal>;
    /** Committed rounds (rollback-excluded), ascending. */
    rounds: ReadonlyArray<CommittedRoundView>;
    commands: ReadonlyArray<CommandEvidencePolicy>;
}): VerifiedSubGoalFact[];
/** v3.8: Sub-goals the agent declared `done` that no verified contract item
 *  backs — verification debt, surfaced in the handoff's open risks. */
export declare function deriveVerificationDebt(subGoals: ReadonlyArray<SubGoal>, verified: ReadonlyArray<VerifiedSubGoalFact>, statuses: ContractItemStatusView): string[];
export declare function deriveCognitiveFacts(input: {
    compileResponse: LoopForgeResponse | null;
    rounds: ReadonlyArray<CommittedRoundView>;
    verifiedClaims?: string[];
    openGates?: string[];
}): DerivedCognitiveFacts;
//# sourceMappingURL=cognitive-facts.d.ts.map