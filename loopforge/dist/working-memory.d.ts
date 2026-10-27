/** v4.0.2: bounded Working Memory — the ONE cognitive extension of
 *  `CanonicalLoopState`.
 *
 *  It is a PURE derivation over the current branch's committed rounds and
 *  committed rollback directives. It performs no I/O, is never persisted as
 *  its own store, and is never an independent factual source. Prompt and
 *  state-file renderers share the formatters below and differ only by profile,
 *  so the two projections cannot drift apart.
 *
 *  Hard exclusions (guaranteed by the inputs this module accepts):
 *  rejected/terminated/invalid attempts, uncommitted held snapshots,
 *  abandoned rounds excluded by the branch walker, and the pending rollback
 *  directive (already covered by the current Recovery Brief).
 */
import type { CommittedHistory } from "./history.js";
import type { PromptLevel } from "./prompt-policy.js";
import type { PromptWorkingMemoryProjection, RoundOutcome } from "./protocol.js";
export interface CommittedReportMemory {
    round: number;
    attempt: number;
    success: boolean;
    outcome: RoundOutcome | null;
    /** Sanitized committed `output_summary` (may be empty). */
    outputSummary: string;
    /** Length of the committed text before sanitization/truncation. */
    sourceChars: number;
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
    failedRounds: number[];
    approaches: string[];
    wrongAssumptions: string[];
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
 *  past; the pending directive is also excluded. */
export declare function deriveWorkingMemory(history: CommittedHistory, currentRound?: number): WorkingMemory;
export declare function hasWorkingMemoryContent(memory: WorkingMemory | undefined): boolean;
export interface PromptWorkingMemoryRender {
    /** Body text (no `### Working Memory` heading, no trailing newline). */
    body: string;
    projection: PromptWorkingMemoryProjection;
}
/** Prompt projection for one level. Returns null when there is nothing to
 *  render, so the prompt renders no empty section. */
export declare function formatWorkingMemoryPrompt(memory: WorkingMemory | undefined, level: PromptLevel): PromptWorkingMemoryRender | null;
/** State-file projection: the full fixed window, no prompt budget. */
export declare function formatWorkingMemoryState(memory: WorkingMemory | undefined): string[];
//# sourceMappingURL=working-memory.d.ts.map