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

import type { CommittedRoundView } from "./committed-round.js";
import type { CommittedHistory } from "./history.js";
import { historyWindow } from "./history.js";
import type { PromptLevel } from "./prompt-policy.js";
import type {
  PromptWorkingMemoryProjection,
  RoundOutcome,
  WorkingMemorySourceCounts,
} from "./protocol.js";
import { normalizeText } from "./token-utils.js";
import { deriveOpenQuestionId } from "./open-question.js";

// ═══════════════════════════════════════════════════════════════════════════
// Data shape
// ═══════════════════════════════════════════════════════════════════════════

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

// ═══════════════════════════════════════════════════════════════════════════
// Deterministic windows and caps (code constants, never policy)
// ═══════════════════════════════════════════════════════════════════════════

/** Committed rounds that feed reports / assumptions / questions / redirects. */
export const WORKING_MEMORY_WINDOW_ROUNDS = 5;
export const WORKING_MEMORY_REPORT_LIMIT = 5;
export const WORKING_MEMORY_ASSUMPTION_LIMIT = 8;
export const WORKING_MEMORY_QUESTION_LIMIT = 6;
export const WORKING_MEMORY_RECOVERY_LIMIT = 3;
export const WORKING_MEMORY_REDIRECT_LIMIT = 3;
/** Per-recovery display cap for the abandoned-path detail lists. */
export const WORKING_MEMORY_RECOVERY_ITEM_LIMIT = 3;
/** Failed-round ids rendered for one recovery; replay/explain keep the full
 *  committed list. */
export const WORKING_MEMORY_FAILED_ROUNDS_DISPLAY = 10;

/** Per-text projection caps. Committed originals are never truncated. */
export const WORKING_MEMORY_TEXT_LIMITS = {
  latestReport: 1200,
  olderReport: 400,
  assumption: 500,
  openQuestion: 300,
  recoveryReason: 500,
  recoveryApproach: 200,
  recoveryAssumption: 500,
  redirectReason: 500,
} as const;

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
export const PROMPT_WORKING_MEMORY_DENSITY: Record<PromptLevel, WorkingMemoryDensity> = {
  l0: {
    reports: 1,
    assumptions: 2,
    openQuestions: 2,
    recoveries: 1,
    redirects: 1,
    totalChars: 1600,
  },
  l1: {
    reports: WORKING_MEMORY_REPORT_LIMIT,
    assumptions: WORKING_MEMORY_ASSUMPTION_LIMIT,
    openQuestions: WORKING_MEMORY_QUESTION_LIMIT,
    recoveries: WORKING_MEMORY_RECOVERY_LIMIT,
    redirects: WORKING_MEMORY_REDIRECT_LIMIT,
    totalChars: Number.POSITIVE_INFINITY,
  },
  l2: {
    reports: WORKING_MEMORY_REPORT_LIMIT,
    assumptions: WORKING_MEMORY_ASSUMPTION_LIMIT,
    openQuestions: WORKING_MEMORY_QUESTION_LIMIT,
    recoveries: WORKING_MEMORY_RECOVERY_LIMIT,
    redirects: WORKING_MEMORY_REDIRECT_LIMIT,
    totalChars: Number.POSITIVE_INFINITY,
  },
};

/** The state file keeps the full fixed window; it has no prompt budget. */
export const STATE_WORKING_MEMORY_DENSITY: WorkingMemoryDensity = {
  reports: WORKING_MEMORY_REPORT_LIMIT,
  assumptions: WORKING_MEMORY_ASSUMPTION_LIMIT,
  openQuestions: WORKING_MEMORY_QUESTION_LIMIT,
  recoveries: WORKING_MEMORY_RECOVERY_LIMIT,
  redirects: WORKING_MEMORY_REDIRECT_LIMIT,
  totalChars: Number.POSITIVE_INFINITY,
};

/** v4.0.3: the ONE deterministic truncation notice for the prompt. It counts
 *  toward the body budget, so it can never push the section over its ceiling. */
export const WORKING_MEMORY_ABBREVIATED_NOTICE =
  "> Working Memory is abbreviated; omitted committed memory is " +
  "available through replay/explain (and the state file when enabled).";

// ═══════════════════════════════════════════════════════════════════════════
// Text normalization
// ═══════════════════════════════════════════════════════════════════════════

/** Canonical text for a Working Memory item:
 *  - CRLF / CR → LF;
 *  - tab → two spaces;
 *  - C0 control characters removed;
 *  - 3+ consecutive blank lines collapsed;
 *  - surrounding whitespace trimmed.
 */
export function normalizeWorkingMemoryText(value: string): string {
  return value
    .replace(/\r\n?/g, "\n")
    .replace(/\t/g, "  ")
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** Truncate at a line boundary and leave an explicit marker. */
export function truncateWorkingMemoryText(
  text: string,
  maxChars: number,
): { text: string; truncated: boolean } {
  if (text.length <= maxChars) return { text, truncated: false };
  const marker = "\n… [truncated]";
  const room = Math.max(0, maxChars - marker.length);
  let clipped = text.slice(0, room);
  const lastBreak = clipped.lastIndexOf("\n");
  if (lastBreak > 0) clipped = clipped.slice(0, lastBreak);
  return { text: `${clipped.trimEnd()}${marker}`, truncated: true };
}

/** Every line of Agent text becomes a blockquote line so `##`, headings or
 *  list markers inside the report cannot masquerade as state-file sections. */
function quote(text: string, indent = ""): string[] {
  if (!text) return [];
  return text.split("\n").map((line) =>
    line === "" ? `${indent}>` : `${indent}> ${line}`);
}

// ═══════════════════════════════════════════════════════════════════════════
// Derivation
// ═══════════════════════════════════════════════════════════════════════════

function reportMemory(view: CommittedRoundView): CommittedReportMemory {
  const raw = view.evaluation?.output_summary ?? "";
  const noChangeReason = view.evaluation?.no_change_reason?.trim();
  const blocker = view.evaluation?.blocker?.trim();
  return {
    roundId: view.roundId,
    round: view.round,
    attempt: view.attempt,
    agentSuccessClaim: view.agentSuccessClaim,
    agentOutcome: view.agentOutcome,
    outputSummary: normalizeWorkingMemoryText(raw),
    sourceChars: raw.length,
    ...(noChangeReason
      ? { noChangeReason: normalizeWorkingMemoryText(noChangeReason) }
      : {}),
    ...(blocker ? { blocker: normalizeWorkingMemoryText(blocker) } : {}),
  };
}

function dedupeAssumptions(entries: AssumptionMemory[]): AssumptionMemory[] {
  const seen = new Set<string>();
  const out: AssumptionMemory[] = [];
  for (const entry of entries) {
    if (!entry.text) continue;
    const key = normalizeText(entry.text);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(entry);
    if (out.length >= WORKING_MEMORY_ASSUMPTION_LIMIT) break;
  }
  return out;
}

function dedupeQuestions(entries: OpenQuestionMemory[]): OpenQuestionMemory[] {
  const seen = new Set<string>();
  const out: OpenQuestionMemory[] = [];
  for (const entry of entries) {
    if (!entry.text) continue;
    const key = entry.id;
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(entry);
    if (out.length >= WORKING_MEMORY_QUESTION_LIMIT) break;
  }
  return out;
}

function boundedRecoveryItems(values: ReadonlyArray<string>): string[] {
  return values
    .map((value) => normalizeWorkingMemoryText(value))
    .filter(Boolean)
    .slice(0, WORKING_MEMORY_RECOVERY_ITEM_LIMIT);
}

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
export function deriveWorkingMemory(
  history: CommittedHistory,
  currentRound: number = Number.POSITIVE_INFINITY,
): WorkingMemory {
  const window = historyWindow(history, currentRound);
  // The window is ascending; the bounded derivation keeps the most recent
  // rounds, then exposes them newest-first.
  const recent = window.slice(-WORKING_MEMORY_WINDOW_ROUNDS);

  const reportSource = [...recent]
    .reverse()
    .map(reportMemory)
    .slice(0, WORKING_MEMORY_REPORT_LIMIT);
  const reports = reportSource;

  const assumptionSource: AssumptionMemory[] = [];
  for (const view of [...recent].reverse()) {
    for (const value of view.evaluation?.wrong_assumptions ?? []) {
      const text = normalizeWorkingMemoryText(value);
      if (text) {
        assumptionSource.push({ round: view.round, kind: "wrong_assumption", text });
      }
    }
    for (const value of view.retractedConstraints ?? []) {
      const text = normalizeWorkingMemoryText(value);
      if (text) {
        assumptionSource.push({ round: view.round, kind: "retracted_constraint", text });
      }
    }
  }
  const assumptions = dedupeAssumptions(assumptionSource);

  const activeQuestions = new Map<string, OpenQuestionMemory>();
  // An unresolved question remains active until its stable id is closed;
  // unlike reports, it must not expire merely because its declaration left
  // the recent-report window.
  for (const view of window) {
    for (const value of view.openQuestions ?? []) {
      const text = normalizeWorkingMemoryText(value);
      if (text) {
        const id = deriveOpenQuestionId(text);
        activeQuestions.set(id, { id, round: view.round, text });
      }
    }
    for (const id of view.resolvedOpenQuestionIds ?? []) {
      activeQuestions.delete(id);
    }
  }
  const questionSource = [...activeQuestions.values()]
    .sort((left, right) => right.round - left.round || left.id.localeCompare(right.id));
  const openQuestions = dedupeQuestions(questionSource);

  const pendingId = history.pendingDirective?.transactionId ||
    history.pendingDirective?.roundId ||
    null;
  const recoverySource = [...history.directives]
    .filter((view) => view.recovery !== null && view.recovery !== undefined)
    .filter((view) => view.recovery!.target.redo_round < currentRound)
    .filter((view) =>
      (view.transactionId ?? view.roundId) !== pendingId);
  const recoveries = recoverySource
    .slice(-WORKING_MEMORY_RECOVERY_LIMIT)
    .reverse()
    .map((view): RecoveryMemory => {
      const recovery = view.recovery!;
      return {
        round: view.round,
        redoRound: recovery.target.redo_round,
        origin: recovery.origin,
        reason: normalizeWorkingMemoryText(recovery.reason),
        abandonedRounds: [...(recovery.abandoned_rounds ?? [])],
        failedRounds: [...recovery.failed_rounds],
        observedSkippedFiles: boundedRecoveryItems(
          recovery.observed_skipped_files ?? recovery.skipped_files ?? []),
        reportedSkippedFiles: boundedRecoveryItems(
          recovery.reported_skipped_files ?? []),
        approaches: boundedRecoveryItems(recovery.approaches),
        wrongAssumptions: boundedRecoveryItems(recovery.wrong_assumptions),
        preservedDiscoveries: boundedRecoveryItems(recovery.skipped_discoveries),
      };
    });

  const redirectSource = [...recent]
    .filter((view) =>
      view.contractTransition !== null && view.contractTransition !== undefined);
  const redirects = redirectSource
    .slice(-WORKING_MEMORY_REDIRECT_LIMIT)
    .reverse()
    .map((view): ContractRedirectMemory => ({
      round: view.round,
      contractId: view.contractTransition!.contract_id,
      reason: normalizeWorkingMemoryText(view.contractTransition!.reason ?? ""),
    }));

  return {
    reports,
    assumptions,
    openQuestions,
    recoveries,
    redirects,
    sourceCounts: {
      windowRounds: recent.length,
      reports: reportSource.length,
      assumptions: assumptionSource.length,
      openQuestions: activeQuestions.size,
      recoveries: recoverySource.length,
      redirects: redirectSource.length,
    },
  };
}

export function hasWorkingMemoryContent(memory: WorkingMemory | undefined): boolean {
  if (!memory) return false;
  return memory.reports.length > 0 ||
    memory.assumptions.length > 0 ||
    memory.openQuestions.length > 0 ||
    memory.recoveries.length > 0 ||
    memory.redirects.length > 0;
}

function emptySourceCounts(): WorkingMemorySourceCounts {
  return {
    windowRounds: 0,
    reports: 0,
    assumptions: 0,
    openQuestions: 0,
    recoveries: 0,
    redirects: 0,
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// Shared formatter
// ═══════════════════════════════════════════════════════════════════════════

interface TextBlock {
  report: CommittedReportMemory;
  text: string;
  truncated: boolean;
}

interface AssumptionBlockItem {
  round: number;
  kind: AssumptionMemory["kind"];
  text: string;
  truncated: boolean;
}

interface QuestionBlockItem {
  id: string;
  round: number;
  text: string;
  truncated: boolean;
}

interface DecisionBlockItem {
  kind: "recovery" | "redirect";
  round: number;
  lines: string[];
}

interface WorkingMemoryCounts {
  reports: number;
  assumptions: number;
  openQuestions: number;
  recoveries: number;
  redirects: number;
}

interface FormattedWorkingMemory {
  text: string;
  reportRounds: number[];
  renderedCounts: WorkingMemoryCounts;
  questionIds: string[];
  previousReport: PromptWorkingMemoryProjection["previousReport"];
  truncated: boolean;
}

function reportBlockText(
  report: CommittedReportMemory,
  maxChars: number,
): { text: string; truncated: boolean } {
  if (!report.outputSummary) return { text: "", truncated: false };
  return truncateWorkingMemoryText(report.outputSummary, maxChars);
}

function reportHeader(
  report: CommittedReportMemory,
  newest: boolean,
): string {
  const outcome = report.agentOutcome ? `, agent_outcome=${report.agentOutcome}` : "";
  if (newest) {
    return `**Previous Round Report (Agent report) — R${report.round}** ` +
      `(source=agent_report; ref=${report.roundId}; ` +
      `agent_success_claim=${report.agentSuccessClaim}${outcome}, attempt ${report.attempt})`;
  }
  return report.outputSummary
    ? `- R${report.round} (agent_success_claim=${report.agentSuccessClaim}${outcome}; ` +
      `source=agent_report; ref=${report.roundId}):`
    : `- R${report.round} (agent_success_claim=${report.agentSuccessClaim}${outcome}; ` +
      `source=agent_report; ref=${report.roundId}): ` +
      "(no output_summary recorded)";
}

function renderReportBlock(
  report: CommittedReportMemory,
  newest: boolean,
): string[] {
  const header = reportHeader(report, newest);
  const details: string[] = [];
  if (report.noChangeReason) {
    details.push(...quote(`no_change_reason (Agent report): ${report.noChangeReason}`));
  }
  if (report.blocker) {
    details.push(...quote(`blocker (Agent report): ${report.blocker}`));
  }
  if (newest) {
    if (!report.outputSummary) return [header, ...details, "(no output_summary recorded)"];
    return [header, ...quote(report.outputSummary), ...details];
  }
  if (!report.outputSummary) return [header, ...details];
  return [header, ...quote(report.outputSummary, "  "), ...details];
}

function renderQuestionItem(item: QuestionBlockItem): string[] {
  return [`- [${item.id}] R${item.round}:`, ...quote(item.text, "  ")];
}

function renderAssumptionItem(item: AssumptionBlockItem): string[] {
  const label = item.kind === "wrong_assumption"
    ? "assumption"
    : "retracted constraint";
  return [`- R${item.round} ${label}:`, ...quote(item.text, "  ")];
}

function renderDecisionItem(item: DecisionBlockItem): string[] {
  return item.lines;
}

function renderRecoveryDecision(recovery: RecoveryMemory): DecisionBlockItem {
  const rounds = recovery.origin === "agent"
    ? recovery.abandonedRounds
    : recovery.failedRounds;
  const shownRounds = rounds.slice(0, WORKING_MEMORY_FAILED_ROUNDS_DISPLAY);
  const moreRounds = rounds.length - shownRounds.length;
  const roundsLabel = recovery.origin === "agent" ? "abandoned" : "failed";
  const roundsText = shownRounds.length > 0
    ? `; ${roundsLabel} R${shownRounds.join(", R")}` +
      (moreRounds > 0 ? ` and ${moreRounds} more` : "")
    : "";
  const lines = [
    `- R${recovery.round} recovery → redo R${recovery.redoRound} ` +
    `(${recovery.origin}${roundsText})`,
  ];
  if (recovery.reason) lines.push(...quote(`reason: ${recovery.reason}`, "  "));
  if (recovery.observedSkippedFiles.length > 0) {
    lines.push(...quote(
      `observed changed files (machine): ${recovery.observedSkippedFiles.join(", ")}`,
      "  ",
    ));
  }
  if (recovery.reportedSkippedFiles.length > 0) {
    lines.push(...quote(
      `Agent-reported changed files: ${recovery.reportedSkippedFiles.join(", ")}`,
      "  ",
    ));
  }
  for (const approach of recovery.approaches) {
    lines.push(...quote(`abandoned approach (Agent report): ${approach}`, "  "));
  }
  for (const assumption of recovery.wrongAssumptions) {
    lines.push(...quote(`assumption (Agent report): ${assumption}`, "  "));
  }
  for (const discovery of recovery.preservedDiscoveries) {
    lines.push(...quote(`preserved discovery (Agent report): ${discovery}`, "  "));
  }
  return { kind: "recovery", round: recovery.round, lines };
}

function renderRedirectDecision(redirect: ContractRedirectMemory): DecisionBlockItem {
  const lines = [
    `- R${redirect.round} contract redirect (${redirect.contractId})`,
  ];
  if (redirect.reason) lines.push(...quote(`reason (Agent report): ${redirect.reason}`, "  "));
  return { kind: "redirect", round: redirect.round, lines };
}

function buildText(
  previous: TextBlock | null,
  earlier: TextBlock[],
  questions: QuestionBlockItem[],
  decisions: DecisionBlockItem[],
  assumptions: AssumptionBlockItem[],
): string {
  const blocks: string[][] = [];
  if (previous) blocks.push(renderReportBlock(previous.report, true));
  if (questions.length > 0) {
    blocks.push([
      "**Open Questions (Agent reports)**",
      ...questions.flatMap(renderQuestionItem),
    ]);
  }
  if (decisions.length > 0) {
    blocks.push([
      "**Recent Decisions (committed events)**",
      ...decisions.flatMap(renderDecisionItem),
    ]);
  }
  if (assumptions.length > 0) {
    blocks.push([
      "**Falsified Assumptions and Retractions (Agent reports)**",
      ...assumptions.flatMap(renderAssumptionItem),
    ]);
  }
  if (earlier.length > 0) {
    blocks.push([
      "**Earlier Committed Reports (Agent reports)**",
      ...earlier.flatMap((block) => renderReportBlock(block.report, false)),
    ]);
  }
  return blocks.map((block) => block.join("\n")).join("\n\n");
}

function applyReportCap(
  report: CommittedReportMemory,
  cap: number,
): TextBlock {
  const clipped = reportBlockText(report, cap);
  return {
    report: {
      ...report,
      outputSummary: clipped.text,
    },
    text: clipped.text,
    truncated: clipped.truncated,
  };
}

function zeroCounts(): WorkingMemoryCounts {
  return {
    reports: 0,
    assumptions: 0,
    openQuestions: 0,
    recoveries: 0,
    redirects: 0,
  };
}

/** Format Working Memory with a profile. Deterministic: the same memory and
 *  profile always produce the same string and metadata.
 *
 *  `surface` selects the truncation notice: the prompt uses the fixed notice
 *  (which counts toward `totalChars`), the state file appends a structured
 *  `> Abbreviated: ...` line (it has no character budget). */
function formatWorkingMemory(
  memory: WorkingMemory,
  profile: WorkingMemoryDensity,
  surface: "prompt" | "state",
): FormattedWorkingMemory | null {
  if (!hasWorkingMemoryContent(memory)) return null;
  let anyTruncated = false;
  const source = memory.sourceCounts ?? emptySourceCounts();
  // The derivation applies fixed source caps before this renderer sees the
  // arrays. Preserve that omission in the prompt projection even when the
  // current profile can render the complete bounded arrays.
  anyTruncated =
    source.reports > memory.reports.length ||
    source.assumptions > memory.assumptions.length ||
    source.openQuestions > memory.openQuestions.length ||
    source.recoveries > memory.recoveries.length ||
    source.redirects > memory.redirects.length;

  const reportLimit = Math.max(0, profile.reports);
  const latest = memory.reports[0] ?? null;
  let previous: TextBlock | null = null;
  if (latest && reportLimit > 0) {
    previous = applyReportCap(latest, WORKING_MEMORY_TEXT_LIMITS.latestReport);
    anyTruncated ||= previous.truncated;
  }
  const earlier = memory.reports
    .slice(1, reportLimit)
    .map((report) => applyReportCap(report, WORKING_MEMORY_TEXT_LIMITS.olderReport));
  anyTruncated ||= earlier.some((block) => block.truncated);
  // Density omission is a projection truncation, not a committed loss.
  if (latest && memory.reports.length > reportLimit) anyTruncated = true;

  const questionLimit = Math.max(0, profile.openQuestions);
  if (memory.openQuestions.length > questionLimit) anyTruncated = true;
  const questions: QuestionBlockItem[] = memory.openQuestions
    .slice(0, questionLimit)
    .map((entry) => {
      const clipped = truncateWorkingMemoryText(
        entry.text, WORKING_MEMORY_TEXT_LIMITS.openQuestion);
      anyTruncated ||= clipped.truncated;
      return {
        id: entry.id,
        round: entry.round,
        text: clipped.text,
        truncated: clipped.truncated,
      };
    });

  const assumptionLimit = Math.max(0, profile.assumptions);
  if (memory.assumptions.length > assumptionLimit) anyTruncated = true;
  const assumptions: AssumptionBlockItem[] = memory.assumptions
    .slice(0, assumptionLimit)
    .map((entry) => {
      const clipped = truncateWorkingMemoryText(
        entry.text, WORKING_MEMORY_TEXT_LIMITS.assumption);
      anyTruncated ||= clipped.truncated;
      return {
        round: entry.round,
        kind: entry.kind,
        text: clipped.text,
        truncated: clipped.truncated,
      };
    });

  const recoveryLimit = Math.max(0, profile.recoveries);
  const redirectLimit = Math.max(0, profile.redirects);
  if (memory.recoveries.length > recoveryLimit ||
      memory.redirects.length > redirectLimit) {
    anyTruncated = true;
  }
  const decisions: DecisionBlockItem[] = [];
  for (const recovery of memory.recoveries.slice(0, recoveryLimit)) {
    const reason = truncateWorkingMemoryText(
      recovery.reason, WORKING_MEMORY_TEXT_LIMITS.recoveryReason);
    const approaches = recovery.approaches.map((value) =>
      truncateWorkingMemoryText(value, WORKING_MEMORY_TEXT_LIMITS.recoveryApproach));
    const wrongAssumptions = recovery.wrongAssumptions.map((value) =>
      truncateWorkingMemoryText(value, WORKING_MEMORY_TEXT_LIMITS.recoveryAssumption));
    anyTruncated ||= reason.truncated ||
      approaches.some((item) => item.truncated) ||
      wrongAssumptions.some((item) => item.truncated);
    decisions.push(renderRecoveryDecision({
      ...recovery,
      reason: reason.text,
      approaches: approaches.map((item) => item.text),
      wrongAssumptions: wrongAssumptions.map((item) => item.text),
    }));
  }
  for (const redirect of memory.redirects.slice(0, redirectLimit)) {
    const reason = truncateWorkingMemoryText(
      redirect.reason, WORKING_MEMORY_TEXT_LIMITS.redirectReason);
    anyTruncated ||= reason.truncated;
    decisions.push(renderRedirectDecision({ ...redirect, reason: reason.text }));
  }

  let text = buildText(previous, earlier, questions, decisions, assumptions);
  const totalChars = profile.totalChars;
  const noticeSuffix = surface === "prompt" && anyTruncated
    ? `\n\n${WORKING_MEMORY_ABBREVIATED_NOTICE}`
    : "";
  const size = () => text.length + (anyTruncated ? noticeSuffix.length : 0);
  if (Number.isFinite(totalChars)) {
    // Drop lower-priority details first. The previous report is the anchor and
    // is truncated only after every other block is gone. The truncation notice
    // counts toward the ceiling.
    while (size() > totalChars) {
      if (earlier.length > 0) {
        earlier.pop();
      } else if (assumptions.length > 0) {
        assumptions.pop();
      } else if (decisions.some((item) => item.kind === "redirect")) {
        const index = decisions.map((item) => item.kind).lastIndexOf("redirect");
        decisions.splice(index, 1);
      } else if (decisions.length > 0) {
        decisions.pop();
      } else if (questions.length > 0) {
        questions.pop();
      } else {
        break;
      }
      anyTruncated = true;
      text = buildText(previous, earlier, questions, decisions, assumptions);
    }
    if (size() > totalChars && previous) {
      const withoutReport = buildText(
        { ...previous, report: { ...previous.report, outputSummary: "" }, text: "" },
        earlier,
        questions,
        decisions,
        assumptions,
      );
      const overhead = (withoutReport.length > 0 ? withoutReport.length + 1 : 0) +
        (anyTruncated ? noticeSuffix.length : 0);
      const room = Math.max(0, totalChars - overhead);
      const clipped = truncateWorkingMemoryText(previous.report.outputSummary, room);
      const wasTruncated = previous.truncated;
      previous = {
        ...previous,
        report: { ...previous.report, outputSummary: clipped.text },
        text: clipped.text,
        truncated: wasTruncated || clipped.truncated,
      };
      anyTruncated ||= clipped.truncated;
      text = buildText(previous, earlier, questions, decisions, assumptions);
    }
  }

  const reportRounds = [
    ...(previous ? [previous.report.round] : []),
    ...earlier.map((block) => block.report.round),
  ];
  const renderedCounts: WorkingMemoryCounts = {
    reports: reportRounds.length,
    assumptions: assumptions.length,
    openQuestions: questions.length,
    recoveries: decisions.filter((item) => item.kind === "recovery").length,
    redirects: decisions.filter((item) => item.kind === "redirect").length,
  };
  if (surface === "prompt" && anyTruncated) {
    text = text ? `${text}\n\n${WORKING_MEMORY_ABBREVIATED_NOTICE}` : WORKING_MEMORY_ABBREVIATED_NOTICE;
  }
  if (surface === "state" && anyTruncated) {
    const parts: string[] = [];
    const labels: Array<[keyof WorkingMemoryCounts, string]> = [
      ["reports", "reports"],
      ["openQuestions", "questions"],
      ["assumptions", "assumptions"],
      ["recoveries", "recoveries"],
      ["redirects", "redirects"],
    ];
    for (const [key, label] of labels) {
      if (source[key] > renderedCounts[key] || !source[key]) {
        if (source[key] > renderedCounts[key]) {
          parts.push(`${label} ${renderedCounts[key]}/${source[key]}`);
        }
      }
    }
    text = `${text}\n\n> Abbreviated${parts.length > 0 ? `: ${parts.join(", ")}` : " (text truncated)"}`;
  }
  return {
    text,
    reportRounds,
    renderedCounts,
    questionIds: questions.map((item) => item.id),
    previousReport: previous
      ? {
          round: previous.report.round,
          sourceChars: memory.reports[0]?.sourceChars ?? 0,
          renderedChars: previous.report.outputSummary.length,
          truncated: previous.truncated,
        }
      : null,
    truncated: anyTruncated,
  };
}

export interface PromptWorkingMemoryRender {
  /** Body text (no `### Working Memory` heading, no trailing newline). */
  body: string;
  projection: PromptWorkingMemoryProjection;
}

function projectionFrom(
  memory: WorkingMemory,
  formatted: FormattedWorkingMemory,
  rendered: boolean,
): PromptWorkingMemoryProjection {
  const source = memory.sourceCounts ?? emptySourceCounts();
  const counts = rendered ? formatted.renderedCounts : zeroCounts();
  return {
    rendered,
    reportRounds: rendered ? formatted.reportRounds : [],
    counts,
    sourceCounts: { ...source },
    omittedCounts: {
      reports: Math.max(0, source.reports - counts.reports),
      assumptions: Math.max(0, source.assumptions - counts.assumptions),
      openQuestions: Math.max(0, source.openQuestions - counts.openQuestions),
      recoveries: Math.max(0, source.recoveries - counts.recoveries),
      redirects: Math.max(0, source.redirects - counts.redirects),
    },
    questionIds: rendered ? formatted.questionIds : [],
    previousReport: rendered ? formatted.previousReport : null,
    renderedChars: rendered ? formatted.text.length : 0,
    truncated: rendered ? formatted.truncated : true,
  };
}

/** Prompt projection for one level. Returns null when there is nothing to
 *  render, so the prompt renders no empty section. */
export function formatWorkingMemoryPrompt(
  memory: WorkingMemory | undefined,
  level: PromptLevel,
): PromptWorkingMemoryRender | null {
  if (!memory) return null;
  const formatted = formatWorkingMemory(
    memory, PROMPT_WORKING_MEMORY_DENSITY[level], "prompt");
  if (!formatted) return null;
  return {
    body: formatted.text,
    projection: projectionFrom(memory, formatted, true),
  };
}

/** v4.0.3: the projection of a Working Memory section that the prompt budget
 *  dropped WHOLE (`allowPartial: false`). `sourceCounts` is preserved so the
 *  omission is auditable; every rendered count is zero. */
export function unrenderedWorkingMemoryProjection(
  memory: WorkingMemory | undefined,
  level: PromptLevel,
): PromptWorkingMemoryProjection | null {
  if (!memory || !hasWorkingMemoryContent(memory)) return null;
  const formatted = formatWorkingMemory(
    memory, PROMPT_WORKING_MEMORY_DENSITY[level], "prompt");
  if (!formatted) return null;
  return projectionFrom(memory, formatted, false);
}

export interface WorkingMemoryStateRender {
  lines: string[];
  truncated: boolean;
  sourceCounts: WorkingMemorySourceCounts;
  renderedCounts: WorkingMemoryCounts;
  omittedCounts: WorkingMemoryCounts;
  questionIds: string[];
}

/** State-file projection: the full fixed window, no prompt budget. */
export function formatWorkingMemoryState(
  memory: WorkingMemory | undefined,
): WorkingMemoryStateRender {
  if (!memory) {
    return {
      lines: [],
      truncated: false,
      sourceCounts: emptySourceCounts(),
      renderedCounts: zeroCounts(),
      omittedCounts: zeroCounts(),
      questionIds: [],
    };
  }
  const formatted = formatWorkingMemory(
    memory, STATE_WORKING_MEMORY_DENSITY, "state");
  if (!formatted) {
    return {
      lines: [],
      truncated: false,
      sourceCounts: { ...(memory.sourceCounts ?? emptySourceCounts()) },
      renderedCounts: zeroCounts(),
      omittedCounts: zeroCounts(),
      questionIds: [],
    };
  }
  const source = memory.sourceCounts ?? emptySourceCounts();
  const counts = formatted.renderedCounts;
  return {
    lines: formatted.text.split("\n"),
    truncated: formatted.truncated,
    sourceCounts: { ...source },
    renderedCounts: counts,
    omittedCounts: {
      reports: Math.max(0, source.reports - counts.reports),
      assumptions: Math.max(0, source.assumptions - counts.assumptions),
      openQuestions: Math.max(0, source.openQuestions - counts.openQuestions),
      recoveries: Math.max(0, source.recoveries - counts.recoveries),
      redirects: Math.max(0, source.redirects - counts.redirects),
    },
    questionIds: formatted.questionIds,
  };
}
