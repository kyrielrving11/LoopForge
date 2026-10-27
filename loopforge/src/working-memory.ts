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

import type { CommittedRoundView } from "./committed-round.js";
import type { CommittedHistory } from "./history.js";
import { historyWindow } from "./history.js";
import type { PromptLevel } from "./prompt-policy.js";
import type {
  PromptWorkingMemoryProjection,
  RoundOutcome,
} from "./protocol.js";
import { normalizeText } from "./token-utils.js";
import { deriveOpenQuestionId } from "./open-question.js";

// ═══════════════════════════════════════════════════════════════════════════
// Data shape
// ═══════════════════════════════════════════════════════════════════════════

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
    reports: 3,
    assumptions: 4,
    openQuestions: 3,
    recoveries: 2,
    redirects: 2,
    totalChars: 3000,
  },
  l2: {
    reports: 5,
    assumptions: 6,
    openQuestions: 4,
    recoveries: 3,
    redirects: 3,
    totalChars: 4500,
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
  return {
    round: view.round,
    attempt: view.attempt,
    success: view.success,
    outcome: view.outcome,
    outputSummary: normalizeWorkingMemoryText(raw),
    sourceChars: raw.length,
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
 *  past; the pending directive is also excluded. */
export function deriveWorkingMemory(
  history: CommittedHistory,
  currentRound: number = Number.POSITIVE_INFINITY,
): WorkingMemory {
  const window = historyWindow(history, currentRound);
  // The window is ascending; the bounded derivation keeps the most recent
  // rounds, then exposes them newest-first.
  const recent = window.slice(-WORKING_MEMORY_WINDOW_ROUNDS);

  const reports = [...recent]
    .reverse()
    .map(reportMemory)
    .slice(0, WORKING_MEMORY_REPORT_LIMIT);

  const assumptions: AssumptionMemory[] = [];
  for (const view of [...recent].reverse()) {
    for (const value of view.evaluation?.wrong_assumptions ?? []) {
      const text = normalizeWorkingMemoryText(value);
      if (text) {
        assumptions.push({ round: view.round, kind: "wrong_assumption", text });
      }
    }
    for (const value of view.retractedConstraints ?? []) {
      const text = normalizeWorkingMemoryText(value);
      if (text) {
        assumptions.push({ round: view.round, kind: "retracted_constraint", text });
      }
    }
  }

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
  const openQuestions = [...activeQuestions.values()]
    .sort((left, right) => right.round - left.round || left.id.localeCompare(right.id));

  const pendingId = history.pendingDirective?.transactionId ||
    history.pendingDirective?.roundId ||
    null;
  const recoveries = [...history.directives]
    .filter((view) => view.recovery !== null && view.recovery !== undefined)
    .filter((view) => view.recovery!.target.redo_round < currentRound)
    .filter((view) =>
      (view.transactionId ?? view.roundId) !== pendingId)
    .slice(-WORKING_MEMORY_RECOVERY_LIMIT)
    .reverse()
    .map((view): RecoveryMemory => {
      const recovery = view.recovery!;
      return {
        round: view.round,
        redoRound: recovery.target.redo_round,
        origin: recovery.origin,
        reason: normalizeWorkingMemoryText(recovery.reason),
        failedRounds: [...recovery.failed_rounds],
        approaches: boundedRecoveryItems(recovery.approaches),
        wrongAssumptions: boundedRecoveryItems(recovery.wrong_assumptions),
      };
    });

  const redirects = [...recent]
    .filter((view) =>
      view.contractTransition !== null && view.contractTransition !== undefined)
    .slice(-WORKING_MEMORY_REDIRECT_LIMIT)
    .reverse()
    .map((view): ContractRedirectMemory => ({
      round: view.round,
      contractId: view.contractTransition!.contract_id,
      reason: normalizeWorkingMemoryText(view.contractTransition!.reason ?? ""),
    }));

  return {
    reports,
    assumptions: dedupeAssumptions(assumptions),
    openQuestions: dedupeQuestions(openQuestions),
    recoveries,
    redirects,
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

interface FormattedWorkingMemory {
  text: string;
  reportRounds: number[];
  counts: PromptWorkingMemoryProjection["counts"];
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
  const outcome = report.outcome ? `, outcome=${report.outcome}` : "";
  if (newest) {
    return `**Previous Round Report (Agent report) — R${report.round}** ` +
      `(success=${report.success}${outcome}, attempt ${report.attempt})`;
  }
  return report.outputSummary
    ? `- R${report.round} (success=${report.success}${outcome}):`
    : `- R${report.round} (success=${report.success}${outcome}): (no output_summary recorded)`;
}

function renderReportBlock(
  report: CommittedReportMemory,
  newest: boolean,
): string[] {
  const header = reportHeader(report, newest);
  if (newest) {
    if (!report.outputSummary) return [header, "(no output_summary recorded)"];
    return [header, ...quote(report.outputSummary)];
  }
  if (!report.outputSummary) return [header];
  return [header, ...quote(report.outputSummary, "  ")];
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
  const failedRounds = recovery.failedRounds.slice(0, WORKING_MEMORY_FAILED_ROUNDS_DISPLAY);
  const moreFailed = recovery.failedRounds.length - failedRounds.length;
  const failed = failedRounds.length > 0
    ? `; failed R${failedRounds.join(", R")}` +
      (moreFailed > 0 ? ` and ${moreFailed} more` : "")
    : "";
  const lines = [
    `- R${recovery.round} recovery → redo R${recovery.redoRound} ` +
    `(${recovery.origin}${failed})`,
  ];
  if (recovery.reason) lines.push(...quote(`reason: ${recovery.reason}`, "  "));
  for (const approach of recovery.approaches) {
    lines.push(...quote(`approach: ${approach}`, "  "));
  }
  for (const assumption of recovery.wrongAssumptions) {
    lines.push(...quote(`assumption: ${assumption}`, "  "));
  }
  return { kind: "recovery", round: recovery.round, lines };
}

function renderRedirectDecision(redirect: ContractRedirectMemory): DecisionBlockItem {
  const lines = [
    `- R${redirect.round} contract redirect (${redirect.contractId})`,
  ];
  if (redirect.reason) lines.push(...quote(`reason: ${redirect.reason}`, "  "));
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

/** Format Working Memory with a profile. Deterministic: the same memory and
 *  profile always produce the same string and metadata. */
function formatWorkingMemory(
  memory: WorkingMemory,
  profile: WorkingMemoryDensity,
): FormattedWorkingMemory | null {
  if (!hasWorkingMemoryContent(memory)) return null;
  let anyTruncated = false;

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
  let questions: QuestionBlockItem[] = memory.openQuestions
    .slice(0, questionLimit)
     .map((entry) => {
      const clipped = truncateWorkingMemoryText(
        entry.text, WORKING_MEMORY_TEXT_LIMITS.openQuestion);
      anyTruncated ||= clipped.truncated;
       return { id: entry.id, round: entry.round, text: clipped.text, truncated: clipped.truncated };
    });

  const assumptionLimit = Math.max(0, profile.assumptions);
  if (memory.assumptions.length > assumptionLimit) anyTruncated = true;
  let assumptions: AssumptionBlockItem[] = memory.assumptions
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
  if (Number.isFinite(totalChars)) {
    // Drop lower-priority details first. The previous report is the anchor and
    // is truncated only after every other block is gone.
    while (text.length > totalChars) {
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
    if (text.length > totalChars && previous) {
      const withoutReport = buildText(
        { ...previous, report: { ...previous.report, outputSummary: "" }, text: "" },
        earlier,
        questions,
        decisions,
        assumptions,
      );
      const overhead = withoutReport.length > 0 ? withoutReport.length + 1 : 0;
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
  return {
    text,
    reportRounds,
    counts: {
      reports: reportRounds.length,
      assumptions: assumptions.length,
      openQuestions: questions.length,
      recoveries: decisions.filter((item) => item.kind === "recovery").length,
      redirects: decisions.filter((item) => item.kind === "redirect").length,
    },
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

/** Prompt projection for one level. Returns null when there is nothing to
 *  render, so the prompt renders no empty section. */
export function formatWorkingMemoryPrompt(
  memory: WorkingMemory | undefined,
  level: PromptLevel,
): PromptWorkingMemoryRender | null {
  if (!memory) return null;
  const formatted = formatWorkingMemory(memory, PROMPT_WORKING_MEMORY_DENSITY[level]);
  if (!formatted) return null;
  return {
    body: formatted.text,
    projection: {
      reportRounds: formatted.reportRounds,
      counts: formatted.counts,
      previousReport: formatted.previousReport,
      renderedChars: formatted.text.length,
      truncated: formatted.truncated,
    },
  };
}

/** State-file projection: the full fixed window, no prompt budget. */
export function formatWorkingMemoryState(
  memory: WorkingMemory | undefined,
): string[] {
  if (!memory) return [];
  const formatted = formatWorkingMemory(memory, STATE_WORKING_MEMORY_DENSITY);
  return formatted ? formatted.text.split("\n") : [];
}
