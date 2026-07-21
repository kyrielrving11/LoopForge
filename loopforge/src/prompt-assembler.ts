/** Single-pass prompt renderer for canonical LoopForge state.
 *
 * L0/L1/L2 control state density only. Reasoning strategy belongs to the
 * external Agent. Mandatory task, hard-constraint, and verification sections
 * are never truncated; budgets are soft and overflow is recorded.
 */

import { createHash } from "node:crypto";
import type { CanonicalLoopState } from "./canonical-state.js";
import { hashCanonicalState } from "./canonical-state.js";
import type { PromptArtifact } from "./protocol.js";
import type {
  PromptLevel,
  PromptLevelReason,
} from "./prompt-policy.js";

export const PROMPT_ARTIFACT_SCHEMA_VERSION = 1 as const;
export const BASE_PROMPT_VERSION = "2.0.0";

export type InjectionMode = "adaptive" | "full" | "pointer";

export interface PromptBudgets {
  l0: number;
  l1: number;
  l2: number;
}

export const DEFAULT_PROMPT_BUDGETS: PromptBudgets = {
  l0: 3000,
  l1: 7000,
  l2: 18000,
};

export interface PromptAssemblyInput {
  state: CanonicalLoopState;
  level: PromptLevel;
  reasons: PromptLevelReason[];
  mode?: InjectionMode;
  budgets?: Partial<PromptBudgets>;
  attempt?: number;
  selfEvaluationBlock: string;
  fullStateMarkdown?: string;
}

interface Section {
  id: string;
  text: string;
  mandatory: boolean;
}

function section(title: string, body: string): string {
  return body.trim() ? `### ${title}\n${body.trim()}\n\n` : "";
}

function bullets(values: string[], prefix = "- "): string {
  return values.map((value) => `${prefix}${value}`).join("\n");
}

function verificationText(state: CanonicalLoopState): string {
  const lines = state.verificationFlags.map((flag) => {
    const icon = flag.severity === "error"
      ? "🚫"
      : flag.severity === "warn" ? "⚠️" : "ℹ️";
    return `- ${icon} [${flag.check}] ${flag.detail}`;
  });
  if (state.verificationFlags.some((flag) => flag.severity === "error")) {
    lines.push(
      "- Gate Verdict: CONTRADICTED — resolve every error before claiming success.",
    );
  }
  return lines.join("\n");
}

function activeNonHardConstraints(state: CanonicalLoopState): string[] {
  const hard = new Set(state.hardConstraints);
  return state.activeConstraints.filter((value) => !hard.has(value));
}

function commonMandatorySections(state: CanonicalLoopState): Section[] {
  const sections: Section[] = [
    {
      id: "objective",
      text: section("Objective", state.objective),
      mandatory: true,
    },
    {
      id: "current_task",
      text: section("Current Task", state.currentTask),
      mandatory: true,
    },
  ];

  if (state.hardConstraints.length > 0) {
    sections.push({
      id: "hard_constraints",
      text: section("Active Hard Constraints", bullets(state.hardConstraints)),
      mandatory: true,
    });
  }
  if (state.verificationFlags.length > 0) {
    sections.push({
      id: "verification",
      text: section("Verification Gate", verificationText(state)),
      mandatory: true,
    });
  }
  return sections;
}

function l0Sections(state: CanonicalLoopState): Section[] {
  const retryRequirements = [
    ...state.blockers,
    ...state.verificationFlags.map((flag) => flag.detail),
  ];
  const sections = commonMandatorySections(state);
  if (retryRequirements.length > 0) {
    sections.push({
      id: "retry_requirements",
      text: section("Retry Requirements", bullets(retryRequirements)),
      mandatory: true,
    });
  }
  if (state.changesSinceLastRound.length > 0) {
    sections.push({
      id: "changes",
      text: section("New Evidence / Changes", bullets(state.changesSinceLastRound)),
      mandatory: false,
    });
  }
  return sections;
}

function l1Sections(state: CanonicalLoopState): Section[] {
  const sections = commonMandatorySections(state);
  const active = activeNonHardConstraints(state);
  if (state.changesSinceLastRound.length > 0) {
    sections.push({
      id: "changes",
      text: section("Changes Since Last Round", bullets(state.changesSinceLastRound)),
      mandatory: false,
    });
  }
  if (active.length > 0) {
    sections.push({
      id: "active_constraints",
      text: section("Active Constraints / Success Criteria", bullets(active)),
      mandatory: false,
    });
  }
  if (state.remainingCriteria.length > 0) {
    sections.push({
      id: "remaining",
      text: section("Remaining", bullets(state.remainingCriteria)),
      mandatory: false,
    });
  }
  if (state.blockers.length > 0) {
    sections.push({
      id: "blockers",
      text: section("Blockers", bullets(state.blockers)),
      mandatory: false,
    });
  }
  if (state.discoveries.length > 0) {
    sections.push({
      id: "discoveries",
      text: section("New Discoveries", bullets(state.discoveries)),
      mandatory: false,
    });
  }
  if (state.nextAction) {
    sections.push({
      id: "next_action",
      text: section("Next Action", state.nextAction),
      mandatory: false,
    });
  }
  return sections;
}

function l2Sections(
  state: CanonicalLoopState,
  fullStateMarkdown?: string,
): Section[] {
  const sections = commonMandatorySections(state);
  const fullState = fullStateMarkdown?.trim();
  if (fullState) {
    sections.push({
      id: "full_state",
      text: section("Full Rehydrated State", fullState),
      mandatory: false,
    });
    return sections;
  }

  const groups: Array<[string, string, string[]]> = [
    ["success_criteria", "Success Criteria", state.successCriteria],
    ["active_constraints", "Active Constraints", activeNonHardConstraints(state)],
    ["changes", "Changes Since Last Round", state.changesSinceLastRound],
    ["remaining", "Remaining", state.remainingCriteria],
    ["blockers", "Blockers", state.blockers],
    ["discoveries", "Discoveries", state.discoveries],
    ["rolling_outcomes", "Cross-Round Outcomes", state.rollingOutcomes],
    ["recurring_issues", "Recurring Issues", state.recurringIssues],
    ["failed_patterns", "Failed Patterns", state.failedPatterns],
  ];
  for (const [id, title, values] of groups) {
    if (values.length > 0) {
      sections.push({ id, text: section(title, bullets(values)), mandatory: false });
    }
  }
  if (state.nextAction) {
    sections.push({
      id: "next_action",
      text: section("Next Action", state.nextAction),
      mandatory: false,
    });
  }
  if (state.externalContext) {
    sections.push({
      id: "external_context",
      text: section("External Context", state.externalContext),
      mandatory: false,
    });
  }
  return sections;
}

function selectSections(input: PromptAssemblyInput): Section[] {
  if (input.mode === "full") {
    return l2Sections(input.state, input.fullStateMarkdown);
  }
  if (input.level === "l0") return l0Sections(input.state);
  if (input.level === "l1") return l1Sections(input.state);
  return l2Sections(input.state, input.fullStateMarkdown);
}

function renderWithinBudget(
  sections: Section[],
  fixedText: string,
  budget: number,
): { rendered: string; included: string[] } {
  const mandatory = sections.filter((item) => item.mandatory);
  const optional = sections.filter((item) => !item.mandatory);
  let rendered = fixedText + mandatory.map((item) => item.text).join("");
  const included = mandatory.filter((item) => item.text).map((item) => item.id);

  for (const item of optional) {
    if (!item.text) continue;
    if (rendered.length + item.text.length <= budget) {
      rendered += item.text;
      included.push(item.id);
    }
  }
  return { rendered, included };
}

export function assemblePromptArtifact(input: PromptAssemblyInput): PromptArtifact {
  const mode = input.mode ?? "adaptive";
  const budgets = { ...DEFAULT_PROMPT_BUDGETS, ...input.budgets };
  const budget = budgets[input.level];
  const stateHash = hashCanonicalState(input.state);
  const attempt = Math.max(1, input.attempt ?? 1);
  const header = [
    `## LoopForge Round ${input.state.round}`,
    `State: ${stateHash.slice(0, 12)} | Level: ${input.level.toUpperCase()} | Attempt: ${attempt}`,
    "",
  ].join("\n");

  const sections = selectSections(input);
  const pointer = input.state.stateFilePath
    ? section("Full State", input.state.stateFilePath)
    : "";
  const evaluation = input.selfEvaluationBlock.trim()
    ? `${input.selfEvaluationBlock.trim()}\n`
    : "";
  const howToRespond = [
    "## How to Complete This Round",
    "",
    "1. Execute the task described above. Do NOT generate another prompt or plan — act.",
    "2. When finished, call the MCP tool **`loopforge_next`** with these parameters:",
    "   - `sessionId`: the session ID from `loopforge_start`.",
    "   - `evaluation`: a structured self-assessment object (see schema below).",
    "",
    "### Evaluation Rules",
    "",
    "- `success`: Set to **`true` ONLY** when ALL hard constraints are met AND",
    "  the task goal is fully achieved. If anything remains incomplete, set `false`.",
    "- `should_continue`: Set to **`false` ONLY** when the ENTIRE loop task is done.",
    "  Partial progress or completed subtasks → `true`.",
    "- `constraint_violations`: Be honest. List every constraint you actually violated.",
    "- `execution_evidence.files_changed`: List files you modified — used for verification.",
    "- `execution_evidence.test_results`: Report actual test runner output.",
    "- `progress_estimate`: A number 0.0–1.0 reflecting overall task completion.",
    "",
    "### If the Prompt Says \"REJECTED\"",
    "",
    "- Re-execute the **same round**. Do NOT advance the round counter.",
    "- Read the Required Fix section, address every issue, then submit again.",
    "- Use `loopforge_next` with a corrected evaluation.",
    "",
    evaluation,
  ].join("\n");

  const footer = [pointer, howToRespond].join("");

  const fixedText = header;
  const selected = mode === "pointer"
    ? renderWithinBudget(
        sections.filter((item) => item.mandatory),
        fixedText,
        budget,
      )
    : renderWithinBudget(sections, fixedText, budget - footer.length);
  const renderedPrompt = selected.rendered + footer;
  const includedSections = [
    ...selected.included,
    ...(pointer ? ["state_pointer"] : []),
    ...(evaluation ? ["self_evaluation"] : []),
  ];
  const promptHash = createHash("sha256").update(renderedPrompt).digest("hex");

  return {
    schemaVersion: PROMPT_ARTIFACT_SCHEMA_VERSION,
    roundId: `loop:${input.state.loopId}:round:${input.state.round}`,
    attempt,
    level: input.level,
    levelReasons: [...input.reasons],
    renderedPrompt,
    promptHash,
    stateHash,
    basePromptVersion: BASE_PROMPT_VERSION,
    includedSections,
    budgetChars: budget,
    charCount: renderedPrompt.length,
    budgetExceeded: renderedPrompt.length > budget,
    generatedAt: Date.now(),
  };
}
