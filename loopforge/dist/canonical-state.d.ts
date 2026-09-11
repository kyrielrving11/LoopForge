/** Canonical cognitive state used to render both prompts and state projections.
 *
 * The canonical state is data, not Markdown. Prompt and state-file renderers
 * consume the same value so they cannot silently drift apart.
 */
import type { ConstraintMeta, CriterionStatus, RecurringFlag, LoopCompileRequest, LoopCompileResponse, MilestoneSummary, SubGoal, VerificationFlag } from "./protocol.js";
import type { ActiveContractView } from "./round-contract.js";
import type { ContractItemStatusView } from "./contract-items.js";
import type { ConfiguredCapability, VerifiedSubGoalFact } from "./protocol.js";
import type { RoundFacts } from "./round-facts.js";
export declare const CANONICAL_STATE_SCHEMA_VERSION: 1;
/** v3.7.1: Presentation view of sub-goals shared by prompts and the state
 *  file (one derivation, no second copy). Only ACTIVE items render as rows
 *  — pending/in_progress/blocked — ordered blocked → in_progress → pending
 *  (priority ascending, then most recently changed first) and trimmed to
 *  `cap`. done/canceled never render as items: they stay in the vault, in
 *  replay, and in these counts. */
export declare function activeSubGoalView(subGoals: SubGoal[], cap: number): {
    active: SubGoal[];
    activeTotal: number;
    done: number;
    canceled: number;
    total: number;
};
/** v3.3: Machine git-motion cross-check over the last committed rounds.
 *  Display-only companion to the R4/R5 exculpatory signal. Optional:
 *  absent when no committed rounds carry git snapshots — the object, when
 *  present, always carries definite values (v3.6: the null arms were dead —
 *  the derive path returns undefined wholesale instead of null fields). */
export interface MachineStatus {
    windowRounds: number;
    gitMotion: boolean;
    motionRounds: number;
}
export interface CanonicalLoopState {
    schemaVersion: typeof CANONICAL_STATE_SCHEMA_VERSION;
    loopId: string;
    round: number;
    maxRounds: number;
    goalId: string;
    objective: string;
    objectiveVersion: number;
    currentTask: string;
    successCriteria: string[];
    hardConstraints: string[];
    activeConstraints: string[];
    retiredConstraints: string[];
    /** v2.3: Per-constraint lifecycle metadata. */
    constraintMetadata: ConstraintMeta[];
    changesSinceLastRound: string[];
    remainingCriteria: string[];
    blockers: string[];
    verificationFlags: VerificationFlag[];
    discoveries: string[];
    rollingOutcomes: string[];
    failedPatterns: string[];
    /** v2.1: Phase-boundary milestone summaries that survive window eviction. */
    milestones: MilestoneSummary[];
    /** v2.2: Structured sub-goals with compiler-managed lifecycle. */
    subGoals: SubGoal[];
    /** v3.2: Derived per-criterion status (goal → criteria → evidence view). */
    criterionStatuses: CriterionStatus[];
    /** v3.8.1: THE repeated-fact list (see RecurringFlag). One derivation
     *  replaces the former Lessons list and the rolling summary's
     *  "recurring_issues" window; renderers filter it. */
    recurringFlags: RecurringFlag[];
    externalContext: string;
    stateFilePath: string;
    progress: {
        estimate: number | null;
        criteriaMet: string[];
        criteriaRemaining: string[];
        filesChanged: string[];
        tests: {
            passed: number;
            failed: number;
            skipped: number;
        } | null;
    };
    /** v3.3: Machine git-motion cross-check for the progress dashboard.
     *  Conditional presence: absent when no committed git snapshots exist. */
    machineStatus?: MachineStatus;
    /** v3.4: The ACTIVE Round Contract this round executes under —
     *  compile-derived from committed rounds (never the submission's own
     *  round_contract, which is a proposal for the NEXT round). Conditional
     *  presence: absent without an active contract — keeps state hashes
     *  byte-identical for contract-less rounds. */
    roundContract?: ActiveContractView;
    /** v3.8: The derived item statuses of the ACTIVE contract — the runtime's
     *  statement about what the agent claimed under it. Conditional presence:
     *  absent without an active contract. */
    contractItemStatuses?: ContractItemStatusView;
    /** v3.8: Sub-goals a verified contract item backs. DERIVED, never
     *  persisted — the machine's separate statement about a `done` sub-goal. */
    verifiedSubGoals?: VerifiedSubGoalFact[];
    /** v3.8: The static verification capability (policy-derived). Unconditional:
     *  it is part of the round's verification context, so every state hash
     *  changes once, deliberately. */
    capability: ConfiguredCapability;
}
/** Deterministic JSON serialization used by state and prompt hashes. */
export declare function stableStringify(value: unknown): string;
export declare function hashCanonicalState(state: CanonicalLoopState): string;
/** v3.8.1: the one-line phase position — which phase the loop is in, and how
 *  far the next boundary is.
 *
 *  This is all that survives of v3.3's "roadmap": of its four lines, three
 *  (met/remaining criteria with ids, sub-goal activity) were already rendered
 *  in full by the sections that own them. Returns "" when no milestone exists,
 *  so the caller renders no section at all — bare position is already in the
 *  prompt header.
 *
 *  Shared by the state-file and prompt renderers so they cannot drift apart
 *  (module contract above). Presentation only; never feeds enforcement. */
export declare function buildPhaseLine(state: CanonicalLoopState): string;
/** v3.3/v3.4: Render the ACTIVE Round Contract as the Current Task section
 *  body — the single formatting source shared by prompts and the state
 *  file (module contract above). The original objective is NOT here: it
 *  lives in the Objective section. Empty arrays render no line. */
export declare function formatRoundContract(contract: ActiveContractView,
/** v3.8: the derived item statuses. When given, each item renders with its
 *  machine status — the agent sees the verification debt in its own task. */
statuses?: ContractItemStatusView | null): string;
/** Milestone heading line ("**🏁 Round 7** (Rounds 3–7, 60%)"). Shared by the
 *  L2 Phase History and the detailed L1 renderer; the L1 copy previously
 *  rendered the range as "R3–R7", a format only this heading used. */
export declare function milestoneHeading(milestone: MilestoneSummary): string;
/** Options that vary per render: the retry attempt (single version of the
 *  file across attempts is impossible — the attempt IS part of the derived
 *  view) and the recovery-window Recovery Brief lines (W5, present only
 *  while a committed backtrack decision is the current round's record). */
export interface StateFileRenderOptions {
    attempt?: number;
    recoveryBrief?: string[];
}
/** Human/Agent-readable materialized view. It is always reproducible from the
 *  canonical state and is never consulted as transaction truth.
 *
 *  v3.8.1: this is where the diagnostics live — the progress dashboard, the
 *  criterion list, round stats, the FULL recurring-flag history and the phase
 *  history. The prompt carries only what the next round needs. */
export declare function renderCanonicalStateMarkdown(state: CanonicalLoopState, options?: StateFileRenderOptions): string;
export declare function createCanonicalLoopState(request: LoopCompileRequest, response: LoopCompileResponse, stateFilePath: string,
/** v3.3: Display-only derived data. Optional 4th param — callers that
 *  predate v3.3 stay on 3-arg calls. */
derived?: {
    machineStatus?: MachineStatus;
    /** v3.8.1: the contract-fact bundle — the ACTIVE Round Contract (drives
     *  the Current Task; never the submission's own `round_contract` field,
     *  which is a proposal for the NEXT round), its derived item statuses, and
     *  the machine-verified sub-goal facts, all from ONE `deriveRoundFacts`
     *  call. Taking them as a bundle makes it structurally impossible to
     *  assemble a state out of values derived over different history windows —
     *  v3.4/v3.8 passed them as three independent options. */
    roundFacts?: RoundFacts;
}): CanonicalLoopState;
//# sourceMappingURL=canonical-state.d.ts.map