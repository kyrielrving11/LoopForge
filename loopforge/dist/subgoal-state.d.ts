/** Sub-goal lifecycle — the single implementation (v3.8).
 *
 * A SubGoal is the AGENT's declaration event, not a machine boundary:
 *   - `emerged_subtasks` creates items (always `pending`);
 *   - `subgoal_updates` is the only channel that changes a status;
 *   - machine verification NEVER writes a status. A verified contract item
 *     that references a sub-goal produces a derived `VerifiedSubGoalFact`
 *     (cognitive-facts.ts) instead.
 *
 * Identity (v3.8): `sg-<hash(loopId, declarationRound, declarationOrdinal,
 * normalizedDescription)>`. The round is part of the identity, so
 * re-declaring the same text in a later round creates a NEW sub-goal — the
 * previous one may be terminal, and the old text-only hash silently dropped
 * the re-declaration. Within one round, exactly-equal text keeps only the
 * first entry. Jaccard similarity no longer merges anything: it only feeds
 * the `possible_duplicate_subgoal` diagnostic.
 *
 * Input is committed round views plus the in-flight report — never raw vault
 * envelopes, so there is exactly one history interpretation.
 */
import type { SubGoal, SubGoalUpdate } from "./protocol.js";
/** v3.8: Stable sub-goal id scoped to its declaration event. */
export declare function deriveSubGoalId(loopId: string, declaredAtRound: number, ordinal: number, description: string): string;
/** v3.8: The items a round's emerged list will create, in order. Exact
 *  duplicates within the round keep only their first entry, and ordinals
 *  count the surviving entries — the pre-advance preflight and the compile
 *  path must agree on this list. */
export declare function deriveEmergedItems(loopId: string, declaredAtRound: number, descriptions: ReadonlyArray<string>): Array<{
    id: string;
    description: string;
}>;
/** Closed migration matrix. done/canceled are terminal (no out-edges); the
 *  matrix rejects re-opening. blocked → in_progress is the recovery path. */
export declare const SUBGOAL_TRANSITIONS: Record<SubGoalUpdate["status"], readonly SubGoal["status"][]>;
/** Whether a transition is legal. Same-status is a legal no-op (used by
 *  replay idempotency). References to terminal sub-goals are rejected by
 *  validateSubGoalUpdates before this is consulted. */
export declare function canTransitionSubGoal(from: SubGoal["status"], to: SubGoalUpdate["status"]): boolean;
/** Referential validation of a payload's subgoal_updates against the
 *  derived sub-goal set. Returns one error per invalid entry:
 *  unknown_id | terminal_reference | illegal_transition. */
export declare function validateSubGoalUpdates(subGoals: SubGoal[], updates: SubGoalUpdate[]): Array<{
    id: string;
    reason: string;
}>;
/** One round's declaration channel: what the agent declared, in order.
 *  Field names match CommittedRoundView so views can be passed directly. */
export interface SubGoalDeclarationRound {
    round: number;
    emergedSubtasks?: ReadonlyArray<string>;
    subgoalUpdates?: ReadonlyArray<SubGoalUpdate>;
}
/** v3.8: Derive the full sub-goal set from committed round facts plus the
 *  in-flight round's report. Replays every round in order — older
 *  transitions never regress, and no status is ever inferred. */
export declare function deriveSubGoals(input: {
    loopId: string;
    currentRound: number;
    /** Committed rounds below `currentRound`, ascending, rollback-excluded
     *  (the caller passes CommittedRoundView[] — one history interpretation). */
    rounds: ReadonlyArray<SubGoalDeclarationRound>;
    /** The in-flight round's own report (idempotent replay of the last
     *  committed round on the vault path). */
    currentReport?: SubGoalDeclarationRound | null;
}): SubGoal[];
/** v3.8: Similarity is DIAGNOSTIC ONLY — it never merges or blocks a
 *  declaration. Pairs above the threshold are reported so the prompt can
 *  suggest consolidating them. */
export declare function possibleDuplicateSubGoals(subGoals: ReadonlyArray<SubGoal>, threshold: number): Array<{
    left: string;
    right: string;
    score: number;
}>;
//# sourceMappingURL=subgoal-state.d.ts.map