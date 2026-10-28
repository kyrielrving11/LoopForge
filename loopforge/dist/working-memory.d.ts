/** v4.0.2/v4.0.3: bounded Working Memory — the ONE cognitive extension of
 *  `CanonicalLoopState`.
 *
 *  It is a PURE derivation over the current branch's committed rounds and
 *  committed rollback directives. It performs no I/O, is never persisted as
 *  its own store, and is never an independent factual source. Prompt and
 *  state-file renderers share the formatters below and differ only by profile,
 *  so the two projections cannot drift apart.
 *
 *  v4.0.3 adds auditable truncation: `sourceCounts` is computed BEFORE any
 *  cap/dedupe, `renderedCounts`/`omittedCounts` describe what actually entered
 *  the body, and every omission produces a deterministic notice. Agent text is
 *  always blockquoted and labeled a report.
 *
 *  Hard exclusions (guaranteed by the inputs this module accepts):
 *  rejected/terminated/invalid attempts, uncommitted held snapshots,
 *  abandoned rounds excluded by the branch walker, and the pending rollback
 *  directive (already covered by the current Recovery Brief).
 */
import type { CommittedHistory } from "./history.js";
import type { PromptLevel } from "./prompt-policy.js";
import type { PromptWorkingMemoryProjection, RoundOutcome, WorkingMemorySourceCounts } from "./protocol.js";
export interface CommittedReportMemory {
    /** Stable identity of the committed report's source round. */
    roundId: string;
    round: number;
    attempt: number;
    /** The Agent's claim, never a machine verdict. */
    agentSuccessClaim: boolean;
    agentOutcome: RoundOutcome | null;
    /** Sanitized committed `output_summary` (may be empty). */
    outputSummary: string;
    /** Length of the committed text before sanitization/truncation. */
    sourceChars: number;
    /** v4.0.3: Agent-reported escape hatch, shown as a report only. */
    noChangeReason?: string;
    /** v4.0.3: Agent-reported blocker, shown as a report only. */
    blocker?: string;
}
export interface AssumptionMemory {
    round: number;
    kind: "wrong_assumption" | "retracted_constraint";
    text: string;
}
export interface OpenQuestionMemory {
    id: string;
    round: number;
    text: string;
}
export interface RecoveryMemory {
    round: number;
    redoRound: number;
    origin: "agent" | "machine";
    reason: string;
    abandonedRounds: number[];
    failedRounds: number[];
    observedSkippedFiles: string[];
    reportedSkippedFiles: string[];
    approaches: string[];
    wrongAssumptions: string[];
    preservedDiscoveries: string[];
}
export interface ContractRedirectMemory {
    round: number;
    contractId: string;
    reason: string;
}
export interface WorkingMemory {
    /** Newest first. */
    reports: CommittedReportMemory[];
    /** Newest first, wrong assumptions and retractions merged. */
    assumptions: AssumptionMemory[];
    /** Newest first. */
    openQuestions: OpenQuestionMemory[];
    /** Newest first. */
    recoveries: RecoveryMemory[];
    /** Newest first. */
    redirects: ContractRedirectMemory[];
    /** v4.0.3: committed counts BEFORE cap/dedupe. Enters stateHash. */
    sourceCounts: WorkingMemorySourceCounts;
}
/** Committed rounds that feed reports / assumptions / questions / redirects. */
export declare const WORKING_MEMORY_WINDOW_ROUNDS = 5;
export declare const WORKING_MEMORY_REPORT_LIMIT = 5;
export declare const WORKING_MEMORY_ASSUMPTION_LIMIT = 8;
export declare const WORKING_MEMORY_QUESTION_LIMIT = 6;
export declare const WORKING_MEMORY_RECOVERY_LIMIT = 3;
export declare const WORKING_MEMORY_REDIRECT_LIMIT = 3;
/** Per-recovery display cap for the abandoned-path detail lists. */
export declare const WORKING_MEMORY_RECOVERY_ITEM_LIMIT = 3;
/** Failed-round ids rendered for one recovery; replay/explain keep the full
 *  committed list. */
export declare const WORKING_MEMORY_FAILED_ROUNDS_DISPLAY = 10;
/** Per-text projection caps. Committed originals are never truncated. */
export declare const WORKING_MEMORY_TEXT_LIMITS: {
    readonly latestReport: 1200;
    readonly olderReport: 400;
    readonly assumption: 500;
    readonly openQuestion: 300;
    readonly recoveryReason: 500;
    readonly recoveryApproach: 200;
    readonly recoveryAssumption: 500;
    readonly redirectReason: 500;
};
export interface WorkingMemoryDensity {
    reports: number;
    assumptions: number;
    openQuestions: number;
    recoveries: number;
    redirects: number;
    /** Hard ceiling for the whole prompt Working Memory body. */
    totalChars: number;
}
/** Prompt density by level. Levels change only the size of this bounded
 *  projection; they never change governance facts or coverage. */
export declare const PROMPT_WORKING_MEMORY_DENSITY: Record<PromptLevel, WorkingMemoryDensity>;
/** The state file keeps the full fixed window; it has no prompt budget. */
export declare const STATE_WORKING_MEMORY_DENSITY: WorkingMemoryDensity;
/** v4.0.3: the ONE deterministic truncation notice for the prompt. It counts
 *  toward the body budget, so it can never push the section over its ceiling. */
export declare const WORKING_MEMORY_ABBREVIATED_NOTICE: string;
/** Canonical text for a Working Memory item:
 *  - CRLF / CR → LF;
 *  - tab → two spaces;
 *  - C0 control characters removed;
 *  - 3+ consecutive blank lines collapsed;
 *  - surrounding whitespace trimmed.
 */
export declare function normalizeWorkingMemoryText(value: string): string;
/** Truncate at a line boundary and leave an explicit marker. */
export declare function truncateWorkingMemoryText(text: string, maxChars: number): {
    text: string;
    truncated: boolean;
};
/** Derive the bounded Working Memory from committed history only.
 *
 *  `currentRound` selects the compile window: only rounds strictly below it
 *  (the SAME window the compiler uses) feed reports, assumptions and
 *  redirects. Open questions remain active until explicitly resolved. A
 *  recovery enters memory only after its redo round is in the
 *  past; the pending directive is also excluded.
 *
 *  v4.0.3: `sourceCounts` is measured before any cap/dedupe so every omission
 *  can be stated. */
export declare function deriveWorkingMemory(history: CommittedHistory, currentRound?: number): WorkingMemory;
export declare function hasWorkingMemoryContent(memory: WorkingMemory | undefined): boolean;
interface WorkingMemoryCounts {
    reports: number;
    assumptions: number;
    openQuestions: number;
    recoveries: number;
    redirects: number;
}
export interface PromptWorkingMemoryRender {
    /** Body text (no `### Working Memory` heading, no trailing newline). */
    body: string;
    projection: PromptWorkingMemoryProjection;
}
/** Prompt projection for one level. Returns null when there is nothing to
 *  render, so the prompt renders no empty section. */
export declare function formatWorkingMemoryPrompt(memory: WorkingMemory | undefined, level: PromptLevel): PromptWorkingMemoryRender | null;
/** v4.0.3: the projection of a Working Memory section that the prompt budget
 *  dropped WHOLE (`allowPartial: false`). `sourceCounts` is preserved so the
 *  omission is auditable; every rendered count is zero. */
export declare function unrenderedWorkingMemoryProjection(memory: WorkingMemory | undefined, level: PromptLevel): PromptWorkingMemoryProjection | null;
export interface WorkingMemoryStateRender {
    lines: string[];
    truncated: boolean;
    sourceCounts: WorkingMemorySourceCounts;
    renderedCounts: WorkingMemoryCounts;
    omittedCounts: WorkingMemoryCounts;
    questionIds: string[];
}
/** State-file projection: the full fixed window, no prompt budget. */
export declare function formatWorkingMemoryState(memory: WorkingMemory | undefined): WorkingMemoryStateRender;
export {};
//# sourceMappingURL=working-memory.d.ts.map