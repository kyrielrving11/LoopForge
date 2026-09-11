/** Structured self-evaluation parsing and normalization — pure functions.
 * The MCP boundary validates required fields before these helpers run.
 */
import { type CriterionRevision, type ExecutionReport, type PromptRequests, type RoundContractProposal, type RoundOutcome, type SelfEvaluation, type SubGoalUpdate } from "./protocol.js";
/** v3.8.1: the emerged-subtask intake bound — ONE constant, because the
 *  sub-goal ids are derived by ORDINAL over this list. The strict submission
 *  boundary builds the reference space the agent may transition from, and the
 *  lenient normalizer builds the committed list every prompt compiles from;
 *  bounding them differently let the boundary accept a transition to a
 *  sub-goal the prompt could never carry, and the migration was then dropped
 *  by the compile path without a word. */
export declare const EMERGED_LIMITS: {
    readonly items: 50;
    readonly chars: 500;
};
/** THE emerged-list normalization. Both the boundary and the committed
 *  evaluation call this, so the two sets cannot disagree. */
export declare function boundedEmergedSubtasks(value: unknown): string[];
/** Parse ExecutionReport from a raw JSON object. */
export declare function parseExecutionReport(raw: Record<string, unknown> | undefined | null): ExecutionReport | undefined;
/** v3.8: The criterion ids the agent claims met this round. */
export declare function claimedMetCriteria(report: {
    criterion_claims?: Array<{
        criterion_id: string;
        outcome: string;
    }>;
} | undefined | null): string[];
/** v3.8: The criterion ids the agent declares still outstanding. */
export declare function claimedRemainingCriteria(report: {
    criterion_claims?: Array<{
        criterion_id: string;
        outcome: string;
    }>;
} | undefined | null): string[];
/** Parse CriterionRevision[] from a raw JSON array. */
export declare function parseCriterionRevisions(raw: unknown): CriterionRevision[];
/** Parse SubGoalUpdate[] from a raw JSON array.
 *  v3.7.1: lenient per-entry filtering (id/status shape) with fixed caps
 *  (20 entries, id ≤ 64, note ≤ 300). Referential validity — unknown IDs
 *  and illegal migrations — is NOT checked here: that needs the committed
 *  sub-goal set and runs as a pre-advance validation (evaluation_invalid). */
export declare function parseSubGoalUpdates(raw: unknown): SubGoalUpdate[];
/** Parse WorkerResult[] from a raw JSON array.
 *  v3.7.1: `outcome` is the single fact. An entry without a valid outcome
 *  is dropped (not derived, not defaulted) — the array stays informational:
 *  absent/empty arrays are accepted unchanged, so a round without any
 *  delegation can never be rejected over worker fields. */
export declare function parseWorkerResults(raw: unknown): import("./protocol.js").WorkerResult[];
/** v2.12: The effective round outcome — declared outcome wins, otherwise
 *  derived from `success`. "partial" can only be declared explicitly (never
 *  silently derived from success=false, which would quietly change the
 *  success-class enforcement surface). */
export declare function effectiveOutcome(selfEval: SelfEvaluation): RoundOutcome;
/** v2.12: Whether the effective outcome is a success claim. Shared by the
 *  verification gate (success-class checks) and enforcement gate (R3). */
export declare function effectiveSuccess(selfEval: SelfEvaluation): boolean;
/** Required evaluation fields are the only format boundary. Optional fields
 * are deliberately normalized by buildSelfEvaluation instead of rejecting a
 * round for a non-authoritative reporting detail.
 *
 * v3.7.1: subgoal_updates is one documented exception — it is a strict
 * STRUCTURAL boundary (machine-processable state transitions). Its shape
 * and referential errors ride here as `subgoal_errors` and return
 * evaluation_invalid with the same guarantees: no state change, no gates,
 * no rejection counters, same-roundId retry. */
export interface EvaluationValidation {
    missing: string[];
    invalid: Array<{
        field: string;
        expected: string;
    }>;
    subgoal_errors?: Array<{
        field: string;
        reason: string;
        detail: string;
    }>;
}
export declare function validateCoreSelfEvaluation(raw: Record<string, unknown>): EvaluationValidation;
/** v3.7.1: Strict structural checks for the sub-goal protocol fields
 *  (subgoal_updates / emerged_subtasks). Runs in the same pre-advance
 *  evaluation_invalid boundary as the four core fields: an error here is a
 *  payload defect, never a work-quality rejection — no session state, no
 *  gates, no rejection counters, retry with the same roundId.
 *
 *  Shape-only (no vault): entry shape, id pattern, status enum, caps, and
 *  the sg-XXXXXXXX creation prohibition on emerged_subtasks. Referential
 *  validity (unknown IDs / terminal references / illegal migrations) needs
 *  the committed sub-goal set and is checked against the compiled
 *  sub_goals right before advance (validateSubGoalUpdates in
 *  loop-compiler.ts). */
export declare function validateSubGoalUpdatesShape(raw: Record<string, unknown>): Array<{
    field: string;
    reason: string;
    detail: string;
}>;
export interface ContractValidationError {
    field: string;
    reason: string;
    detail: string;
}
/** v3.8: Everything the strict contract boundary needs to judge a declaration
 *  against the SAME derived state the agent saw in its prompt. Injected rather
 *  than imported so the validator stays a pure, unit-testable function. */
export interface ContractValidationContext {
    /** rci- ids of the ACTIVE contract; null when it cannot be observed (fail
     *  open — shape checks stay strict either way). */
    activeItemIds: ReadonlySet<string> | null;
    /** sg- ids the agent may legitimately reference: the compiled set plus the
     *  submission's own same-round `emerged_subtasks`; null when it cannot be
     *  observed (fail open). */
    knownSubGoalIds: ReadonlySet<string> | null;
    /** Configured AND enabled AND after-capable evidence command. */
    isConfiguredCommand: (name: string) => boolean;
    /** Returns a detail string when a declared scope entry leaves the
     *  workspace, or null when it is contained. */
    checkScopeEntry: (entry: string) => string | null;
}
/** v3.8: Strict STRUCTURAL boundary for the Round Contract declaration and
 *  the contract item claims — the same pre-advance contract as
 *  subgoal_updates: an error here is a payload defect, never a work-quality
 *  rejection (no session state, no gates, no rejection counters, retry with
 *  the same roundId as `contract_invalid`).
 *
 *  Declaration strictness: items must exist and stay within CONTRACT_LIMITS;
 *  every item must bind at least one configured, enabled, after-capable
 *  command; scope entries must stay inside the workspace; criterion and
 *  sub-goal references must be well-formed, and sub-goal references must name
 *  a sub-goal that actually exists. The limits are enforced HERE rather than
 *  by silently truncating in the lenient parser — a declaration is a
 *  boundary, not a suggestion.
 *
 *  Claim strictness: item ids must be well formed, unique, and — when the
 *  active contract is known — reference an item of the ACTIVE contract. */
export declare function validateContractShape(raw: Record<string, unknown>, context: ContractValidationContext): ContractValidationError[];
/** Build a SelfEvaluation from a parsed JSON object.
 *  Lenient parsing: missing optional fields get sensible defaults. */
export declare function buildSelfEvaluation(raw: Record<string, unknown>): SelfEvaluation;
/** v3.8: The ONE set of contract-declaration limits. `validateContractShape`
 *  (the strict boundary) rejects a declaration over these; `parseRoundContract`
 *  (the lenient path, reached only after the strict boundary passed) truncates
 *  to the same numbers. One source, so the two can never drift. */
export declare const CONTRACT_LIMITS: {
    readonly items: 20;
    readonly scope: 50;
    readonly criterionRefs: 20;
    readonly subgoalRefs: 20;
    readonly verifyWith: 20;
};
/** Parse a Round Contract PROPOSAL from raw JSON input. Lenient on shapes
 *  the strict declaration boundary already rejected: strings are trimmed and
 *  capped, non-string array entries are dropped. Item ORDER and COUNT are
 *  preserved — the derived rci- ids depend on them. Returns undefined only
 *  when the raw value is absent or not an object. */
export declare function parseRoundContract(raw: unknown): RoundContractProposal | undefined;
/** Parse a PromptRequests object from raw JSON input.
 *  Lenient: missing or invalid fields get sensible defaults.
 *  Returns undefined if the raw value is absent or not an object,
 *  so makeSelfEvaluation can distinguish "not set" from "empty".
 *  Exported for the engine's last_round_result rebuild — the MCP
 *  lifecycle assembles prompt_requests into the request, but every
 *  compile path funnels through engine.invokeLoopCompile, whose
 *  field-by-field reconstruction must preserve them (v3.3.1). */
export declare function parsePromptRequests(raw: unknown): PromptRequests | undefined;
//# sourceMappingURL=self-eval.d.ts.map