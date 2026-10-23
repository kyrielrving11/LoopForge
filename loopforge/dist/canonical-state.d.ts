/** Canonical cognitive state used to render both prompts and state projections.
 *
 * The canonical state is data, not Markdown. Prompt and state-file renderers
 * consume the same value so they cannot silently drift apart.
 */
import type { ConstraintMeta, CriterionStatus, RecurringFlag, LoopCompileRequest, LoopCompileResponse, LoopRoundResult, SubGoal, VerificationFlag } from "./protocol.js";
import type { ActiveContractView } from "./round-contract.js";
import type { ContractItemStatusView } from "./contract-items.js";
import type { ConfiguredCapability, VerifiedSubGoalFact } from "./protocol.js";
import type { RoundFacts } from "./round-facts.js";
export declare const CANONICAL_STATE_SCHEMA_VERSION: 4;
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
/** v3.9.4: the ONE active-constraint partition. `criteria` is the active
 *  success-criteria set; `hard` is the active hard set minus criteria;
 *  `other` is every remaining active constraint. The three groups are
 *  mutually exclusive and partition the active constraint texts that are
 *  rendered by the prompt/state file. */
export interface ActiveConstraintPartition {
    criteria: string[];
    hard: string[];
    other: string[];
}
export declare function partitionActiveConstraints(state: {
    successCriteria: ReadonlyArray<string>;
    hardConstraints: ReadonlyArray<string>;
    activeConstraints: ReadonlyArray<string>;
}): ActiveConstraintPartition;
/** v3.9.4: the ONE criterion row renderer for the normative prompt section.
 *  It consumes the same `successCriteria`/`criterionStatuses` pair the state
 *  file and submission boundary use, and reports the exact ids it emitted so
 *  prompt coverage can prove them. */
export declare function formatCriterionRows(statuses: ReadonlyArray<CriterionStatus>, successCriteria: ReadonlyArray<string>): {
    lines: string[];
    ids: string[];
};
/** v3.9.4: the ONE active-sub-goal formatter shared by the prompt and the
 *  state file. Rows past `cap` lose their descriptions but NEVER their ids:
 *  the overflow line lists every remaining `sg-*`. */
export declare function formatActiveSubGoals(subGoals: ReadonlyArray<SubGoal>, round: number, cap?: number, 
/** v3.9.7: objects moved to Critical Context are removed from the rows and
 *  the overflow line, but still count in the totals. */
omitIds?: ReadonlySet<string>): {
    lines: string[];
    ids: string[];
};
/** v3.3/v3.9.7: provider-neutral machine progress over the last committed
 *  rounds. Display-only companion to the stall signal. Optional: absent for
 *  an incomplete window or when no progress provider participated. */
export interface MachineStatus {
    windowRounds: number;
    machineProgress: "changed" | "unchanged" | "unknown" | "not_applicable";
    changedRounds: number;
    providers: string[];
}
export interface CanonicalLoopState {
    schemaVersion: typeof CANONICAL_STATE_SCHEMA_VERSION;
    loopId: string;
    round: number;
    maxRounds: number;
    goalId: string;
    objective: string;
    currentTask: string;
    successCriteria: string[];
    hardConstraints: string[];
    activeConstraints: string[];
    retiredConstraints: string[];
    /** v2.3: Per-constraint lifecycle metadata. */
    constraintMetadata: ConstraintMeta[];
    /** v3.9.5: committed Agent corrections (wrong assumptions). This is a
     *  REPORT, never machine evidence; fallback last_round_result does not
     *  enter this field. LoopForge does not prefix or reframe it. */
    corrections: string[];
    /** Current retry's enforcement notice. A protected protocol fact for the
     *  next prompt, not a committed history field. */
    rejectionNotice: string | null;
    /** Committed rollback recovery brief, present only in a recovery window.
     *  Derived from the pending directive; prompt and state file share it. */
    recoveryBrief?: string[];
    remainingCriteria: string[];
    blockers: string[];
    verificationFlags: VerificationFlag[];
    discoveries: string[];
    /** v2.2: Structured sub-goals with compiler-managed lifecycle. */
    subGoals: SubGoal[];
    /** v3.2: Derived per-criterion status (goal → criteria → evidence view). */
    criterionStatuses: CriterionStatus[];
    /** v3.8.1: THE repeated-fact list (see RecurringFlag). One derivation
     *  replaces the former Lessons list and the rolling summary's
     *  "recurring_issues" window; renderers filter it. */
    recurringFlags: RecurringFlag[];
    stateFilePath: string;
    progress: {
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
/** v3.9.7: the ONE constraint provenance label shared by the state file and
 *  the prompt. A discovered/preserved constraint is an Agent report, never a
 *  machine-verified fact. */
export declare function constraintProvenanceLabel(meta: ConstraintMeta | undefined): string;
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
/** v3.3/v3.4: Render the ACTIVE Round Contract as the Current Task section
 *  body — the single formatting source shared by prompts and the state
 *  file (module contract above). The original objective is NOT here: it
 *  lives in the Objective section. Empty arrays render no line. */
export interface RoundContractFormatOptions {
    /** Omit the whole contract block (the contract itself was moved). */
    omitContract?: boolean;
    /** Omit individual item rows (items moved to Critical Context). */
    omitItemIds?: ReadonlySet<string>;
}
export interface FormattedRoundContract {
    text: string;
    /** IDs this rendering actually emitted (contract id + item ids). */
    emittedIds: string[];
}
export declare function formatRoundContractWithIds(contract: ActiveContractView, 
/** v3.8: the derived item statuses. When given, each item renders with its
 *  machine status — the agent sees the verification debt in its own task. */
statuses?: ContractItemStatusView | null, options?: RoundContractFormatOptions): FormattedRoundContract;
/** Backwards-compatible text-only view used by the state file. */
export declare function formatRoundContract(contract: ActiveContractView, statuses?: ContractItemStatusView | null): string;
/** v3.9.7: one contract item as the prompt renders it. Critical Context uses
 *  the same line when an item is moved, so the text cannot drift. */
export declare function formatContractItemLine(item: ActiveContractView["items"][number], machine?: ContractItemStatusView["items"][number] | null): string;
/** v3.9.7: one active sub-goal row as the prompt renders it. */
export declare function formatSubGoalRow(subGoal: SubGoal, round: number): string;
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
    /** 3.9.3: the compile's ONE previous-round bundle. Structural subset of
     *  `PreviousRoundFacts` so this module never imports the compiler. When
     *  absent (direct/library callers) the request fields remain the
     *  fallback. */
    previousRound?: {
        result: LoopRoundResult | null;
        verificationFlags: VerificationFlag[];
        /** v3.9.5: true only when `result` came from a committed round view.
         *  Agent reports (wrong assumptions, blockers) enter the prompt/state
         *  projection only under this flag; a library fallback is in-flight. */
        committed?: boolean;
    };
    /** v3.9.7: committed recovery brief, derived from the pending rollback
     *  directive. Conditional — absent outside a recovery window. */
    recoveryBrief?: string[];
}): CanonicalLoopState;
//# sourceMappingURL=canonical-state.d.ts.map