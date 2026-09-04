/** Canonical cognitive state used to render both prompts and state projections.
 *
 * The canonical state is data, not Markdown. Prompt and state-file renderers
 * consume the same value so they cannot silently drift apart.
 */
import type { ConstraintMeta, CriterionStatus, Lesson, LoopCompileRequest, LoopCompileResponse, MilestoneSummary, RoundContract, SubGoal, VerificationFlag } from "./protocol.js";
export declare const CANONICAL_STATE_SCHEMA_VERSION: 1;
/** v3.2: Durable snapshot of what an L1 prompt actually presented last round.
 *  Used as the diff baseline for L1 collapse. Persisted inside the lineage
 *  entry's loop_lineage (field extension — no new persistence format) and
 *  carried on PromptArtifact for the compile-to-persist round-trip. */
export interface PresentedStateSnapshot {
    /** Round whose presentation this snapshot describes (the baseline round). */
    round: number;
    /** Stable IDs (c-XXXXXXXX) of constraints rendered in the L1 Active
     *  Constraints section (post-emphasize, non-hard). */
    constraintIds: string[];
    /** [sub-goal id, status] pairs rendered in the L1 Active Sub-Goals section
     *  (in_progress + pending only). Statuses enable transition detection. */
    subGoals: Array<[string, string]>;
    /** [start, end] round ranges of all milestones at presentation time. */
    milestoneRanges: Array<[number, number]>;
}
/** v3.3: Per-round statistics for the display (files changed, rejected
 *  attempts, self-reported progress delta). Compiler-derived from committed
 *  entries — zero persistence. Optional: absent when no committed rounds. */
export interface RoundStat {
    round: number;
    filesChangedCount: number | null;
    rejectedAttempts: number | null;
    progressDelta: number | null;
}
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
    /** v2.3: Constraints demoted to inactive after prolonged inactivity. */
    inactiveConstraints: string[];
    /** v2.3: Per-constraint lifecycle metadata. */
    constraintMetadata: ConstraintMeta[];
    changesSinceLastRound: string[];
    remainingCriteria: string[];
    blockers: string[];
    verificationFlags: VerificationFlag[];
    discoveries: string[];
    nextAction: string;
    rollingOutcomes: string[];
    recurringIssues: string[];
    failedPatterns: string[];
    /** v2.1: Phase-boundary milestone summaries that survive window eviction. */
    milestones: MilestoneSummary[];
    /** v2.2: Structured sub-goals with compiler-managed lifecycle. */
    subGoals: SubGoal[];
    /** v3.2: Derived per-criterion status (goal → criteria → evidence view). */
    criterionStatuses: CriterionStatus[];
    /** v3.2: Deterministic lessons learned (repeated violations / failures). */
    lessons: Lesson[];
    /** v2.5: Agent trust score [0, 1] from verification flags. */
    agentTrustScore: number | undefined;
    /** v2.5: Trust trend over last 10 rounds. */
    agentTrustTrend: number[];
    suggestedNextTask: string;
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
    /** v3.3: Display-only round stats over the last committed rounds.
     *  Conditional presence: absent when there are no committed rounds. */
    roundStats?: RoundStat[];
    /** v3.3: Machine git-motion cross-check for the progress dashboard.
     *  Conditional presence: absent when no committed git snapshots exist. */
    machineStatus?: MachineStatus;
    /** v3.4: The ACTIVE Round Contract this round executes under —
     *  compile-derived from committed rounds (never the submission's own
     *  round_contract, which is a proposal for the NEXT round). Conditional
     *  presence: absent without an active contract — keeps state hashes
     *  byte-identical for contract-less rounds. */
    roundContract?: RoundContract;
}
/** Deterministic JSON serialization used by state and prompt hashes. */
export declare function stableStringify(value: unknown): string;
export declare function hashCanonicalState(state: CanonicalLoopState): string;
/** Human/Agent-readable materialized view. It is always reproducible from the
 * canonical state and is never consulted as transaction truth. */
/** v3.3: Forward-looking "roadmap" view derived from existing state — loop
 *  position, met/remaining criteria (with IDs), and sub-goal activity.
 *
 *  Deliberately label-free: milestone labels/ranges are collapsed content in
 *  L1 (the diff-collapse invariant) and are rendered in full by Phase
 *  History everywhere else — the roadmap only reports "N rounds since the
 *  last milestone boundary", never the boundary's identity. Next action is
 *  likewise excluded: every level renders its own Next Action section.
 *  Shared by the state-file and prompt renderers so they cannot silently
 *  drift apart (module contract above). Returns [] — renders nothing —
 *  when the state carries none of these. Presentation only; never feeds
 *  enforcement. */
export declare function buildRoadmap(state: CanonicalLoopState): string[];
/** v3.3/v3.4: Render the ACTIVE Round Contract as the Current Task section
 *  body — the single formatting source shared by prompts and the state
 *  file (module contract above). The original objective is NOT here: it
 *  lives in the Objective section. Empty arrays render no line. */
export declare function formatRoundContract(contract: RoundContract): string;
/** The trust bar line ("██████░░░░ 60%"). The L2 Agent Trust section and the
 *  detailed L1 renderer used to carry private copies of this formula — shared
 *  here so a formatting change is made once (module contract: renderers must
 *  not silently drift apart). */
export declare function trustBarLine(score: number): string;
/** Milestone heading line ("**🏁 Round 7** (Rounds 3–7, 60%)"). Shared by the
 *  L2 Phase History and the detailed L1 renderer; the L1 copy previously
 *  rendered the range as "R3–R7", a format only this heading used. */
export declare function milestoneHeading(milestone: MilestoneSummary): string;
export declare function renderCanonicalStateMarkdown(state: CanonicalLoopState): string;
export declare function createCanonicalLoopState(request: LoopCompileRequest, response: LoopCompileResponse, stateFilePath: string, 
/** v3.3: Display-only derived data (round stats, machine git-motion).
 *  Optional 4th param — callers that predate v3.3 stay on 3-arg calls. */
derived?: {
    roundStats?: RoundStat[];
    machineStatus?: MachineStatus;
    /** v3.4: ACTIVE Round Contract for this round (compile-derived from the
     *  committed evals of earlier rounds — see loop-compiler). Drives the
     *  Current Task. Never the submission's own round_contract field, which
     *  is a proposal for the NEXT round. */
    roundContract?: RoundContract | null;
}): CanonicalLoopState;
//# sourceMappingURL=canonical-state.d.ts.map