/** The evaluation field guide and the submission-guidance projection.
 *
 * This module is the ONE source for what an evaluation field means, when it
 * applies, what a legal example looks like, and where a submitted value goes.
 * The MCP tool schema, the round prompt's evaluation block, and
 * `submission_guidance` all read it; none of them owns a second copy.
 *
 * It is an interface description, not state: it performs no I/O, persists
 * nothing, and makes no business decision. The runtime's submission boundary
 * remains the only validator.
 */

import type {
  ActiveContractView,
} from "./round-contract.js";
import type { ContractItemStatusView } from "./contract-items.js";
import type {
  CommittedRoundView,
} from "./committed-round.js";
import {
  deriveConfiguredCapability,
  getPolicy,
} from "./policy.js";
import type { CommandEvidencePolicy } from "./policy.js";
import { deriveRoundFacts, NO_IN_FLIGHT_ROUND } from "./round-facts.js";
import { deriveSubGoals } from "./subgoal-state.js";
import { verificationActionFor } from "./verification-actions.js";
import type {
  ContractItemStatus,
  CriterionStatus,
  LoopForgeResponse,
  PromptArtifact,
  SubGoal,
  SubmissionGuidance,
  VerificationFlag,
} from "./protocol.js";

// ═══════════════════════════════════════════════════════════════════════════
// Field guide
// ═══════════════════════════════════════════════════════════════════════════

export type FieldNature = "report" | "claim" | "proposal" | "transition" | "control";

export interface FieldGuide {
  /** Dotted path, e.g. `execution_report.files_changed`. */
  path: string;
  /** One-line meaning. */
  purpose: string;
  /** The event that makes this field applicable. */
  when: string;
  nature: FieldNature;
  /** Where a submitted value goes after it is committed. */
  downstream: string;
  /** The `loopforge_next.evaluation` schema description. */
  toolDescription: string;
  /** True when the value is saved as a report but never auto-expands into
   *  derived state (e.g. worker-reported discoveries). */
  reportOnly?: boolean;
  /** One of the four strict core fields. */
  core?: boolean;
  /** v3.9.2: a compact trigger sentence used only by the prompt checklist. */
  decision?: string;
  /** 3.9.3: the ONLY marker of compact-checklist membership. The set is
   *  level-independent: L0/L1/L2 differ in state density, never in which
   *  evaluation fields they offer. Fields with dedicated contract/sub-goal
   *  renderers leave this unset. */
  compact?: true;
  /** Deterministic order inside the compact checklist. */
  promptRank?: number;
}

/** Field order used by the prompt, guidance and receipts. Core fields first,
 *  then the execution report, then contract/sub-goal state, then the
 *  cognitive/report fields, then terminal fields. Deterministic by design. */
export const FIELD_ORDER = [
  "success",
  "output_summary",
  "constraint_violations",
  "should_continue",
  "execution_report.files_changed",
  "execution_report.tests_reported",
  "execution_report.contract_item_claims",
  "execution_report.criterion_claims",
  "subgoal_updates",
  "emerged_subtasks",
  "discovered_constraints",
  "wrong_assumptions",
  "objective_refinement",
  "retracted_constraints",
  "revised_success_criteria",
  "round_contract",
  "worker_results",
  "prompt_requests",
  "compression_checkpoint",
  "checkpoint_label",
  "retroactiveClaims",
  "gate_ids",
  "outcome",
  "blocker",
  "stop_reason",
  "no_change_reason",
] as const;

export type FieldPath = (typeof FIELD_ORDER)[number];

const GUIDES: FieldGuide[] = [
  {
    path: "success",
    purpose: "Whether the whole objective and every hard constraint are satisfied.",
    when: "Every round. Use true only when the full goal is achieved and verified.",
    nature: "claim",
    downstream: "Stop decision, success trajectory, verification posture.",
    toolDescription:
      "true ONLY if all hard constraints were met AND the task goal was achieved. " +
      "This is a claim; a machine observation is what backs it.",
    core: true,
  },
  {
    path: "output_summary",
    purpose: "What was actually done this round, not what was attempted.",
    when: "Every round.",
    nature: "report",
    downstream: "Rolling summary, focus/handoff projection, backtrack failed-approach list.",
    toolDescription:
      "Specific, actionable summary of what was DONE this round — not what was " +
      "attempted. Do not restate the plan.",
    core: true,
  },
  {
    path: "constraint_violations",
    purpose: "Hard constraints actually violated this round.",
    when: "Every round; empty when none were violated.",
    nature: "report",
    downstream: "Recurring-violation detection and constraint retirement.",
    toolDescription:
      "Constraints the agent actually violated this round, preferably by the " +
      "c-XXXXXXXX id the prompt rendered. Empty when none. Be honest.",
    core: true,
  },
  {
    path: "should_continue",
    purpose: "Whether the loop should advance to another round.",
    when: "Every round. false only when the ENTIRE task is complete or the agent must stop.",
    nature: "control",
    downstream: "Stop decision. Partial progress is still true.",
    toolDescription:
      "false ONLY when the ENTIRE task is complete or a stop is required. " +
      "Partial progress = true.",
    core: true,
  },
  {
    path: "execution_report.files_changed",
    purpose:
      "The boundary net change: paths whose content or file type differs between " +
      "round preparation and this submission, including deleted paths.",
    when: "Every round that changed the workspace. A commit alone adds no entry when content is unchanged.",
    nature: "report",
    downstream:
      "Compared with the machine boundary delta; never trusted as the observation.",
    toolDescription:
      "Paths whose content or file type differs between round start and this " +
      "submission, including deletions. A commit alone does not add a path when " +
      "content is unchanged. Gitignored paths are outside the machine boundary — " +
      "do not report them merely to look complete.",
    reportOnly: false,
  },
  {
    path: "execution_report.tests_reported",
    purpose: "The agent's own test counts.",
    when: "When tests were run (or a test run is relevant to the claim).",
    nature: "report",
    downstream:
      "Compared with parsed command output when available; never converted into a verification verdict.",
    toolDescription:
      "Self-reported test counts. Informational: the runtime never translates " +
      "an exit code into a test count, and the receipt shows self-report and " +
      "command observation separately.",
  },
  {
    path: "execution_report.contract_item_claims",
    purpose: "Claims about items of the ACTIVE Round Contract.",
    when: "Only when an active contract is open; cite the rci-XXXXXXXX ids rendered in the prompt.",
    nature: "claim",
    decision: "Claim completed items of the active contract with their real rci- ids",
    downstream:
      "Starts machine evaluation of the item; the item becomes verified only when its bound commands pass.",
    toolDescription:
      "Claims about items of the ACTIVE contract, cited by the rci-XXXXXXXX id " +
      "the prompt rendered. A claim never verifies anything by itself — the " +
      "runtime marks an item verified only when its bound commands are observed " +
      "passing. Unknown ids or illegal outcomes are contract_invalid.",
  },
  {
    path: "execution_report.criterion_claims",
    purpose: "Advisory claims about objective criteria.",
    when: "When you want to state which criteria are met or still remaining.",
    nature: "claim",
    decision: "You can state which criteria are met or still outstanding",
    compact: true,
    promptRank: 10,
    downstream:
      "Advisory only: unbacked claims warn; they never upgrade a criterion to verified.",
    toolDescription:
      "Advisory claims about objective criteria. LENIENT: unknown or malformed " +
      "ids are dropped with a diagnostic, never a rejection. A criterion claim " +
      "never becomes machine-verified by itself.",
  },
  {
    path: "subgoal_updates",
    purpose: "Explicit status transitions for existing sub-goals.",
    when: "When an active sg-XXXXXXXX sub-goal starts, is blocked, completes, or is canceled.",
    nature: "transition",
    decision: "An active sub-goal moved status; cite its real sg- id",
    downstream: "Sub-goal state derived from committed rounds; done/canceled are terminal.",
    toolDescription:
      "Explicit status transitions for EXISTING sub-goals. Each entry references " +
      "an ACTIVE sg-XXXXXXXX id from the prompt. Unknown ids, done/canceled " +
      "(terminal) references, and illegal migrations are evaluation_invalid. " +
      "Re-open work through a NEW emerged_subtasks declaration, never by " +
      "referencing a terminal id.",
  },
  {
    path: "emerged_subtasks",
    purpose: "New sub-problems that surfaced during execution.",
    when: "When a new work item appears or an existing one must be split.",
    nature: "transition",
    decision: "A new sub-problem surfaced (plain text, never sg- ids)",
    compact: true,
    promptRank: 40,
    downstream: "The only sub-goal creation channel; the runtime derives stable sg- ids.",
    toolDescription:
      "Sub-problems that surfaced during execution. The ONLY sub-goal creation " +
      "channel. Plain descriptions, never sg-XXXXXXXX ids.",
  },
  {
    path: "discovered_constraints",
    purpose: "New constraints that later rounds must respect.",
    when: "When this round discovered a limit that was not known before.",
    nature: "report",
    decision: "You discovered a limit later rounds must respect",
    compact: true,
    promptRank: 20,
    downstream:
      "Merged into the active constraint set by the compiler (bounded per round).",
    toolDescription:
      "New constraints that must apply to later rounds. This is the ONLY " +
      "promotion channel for a worker-discovered constraint: a worker result " +
      "stays a report until the main agent states the constraint here.",
  },
  {
    path: "wrong_assumptions",
    purpose: "Assumptions from earlier rounds that this round falsified.",
    when: "When evidence proved an earlier assumption wrong; omit when none.",
    nature: "report",
    decision: "Evidence falsified an earlier assumption",
    compact: true,
    promptRank: 30,
    downstream:
      "State-file 'Corrected assumption', recovery brief, and backtrack wrong-assumption facts.",
    toolDescription:
      "Assumptions from earlier rounds that turned out to be wrong. Record one " +
      "only when this round actually falsified it; otherwise omit. This is not " +
      "a reflection quota.",
  },
  {
    path: "objective_refinement",
    purpose: "A deeper or more accurate understanding of the objective.",
    when: "When this round changed your understanding of what the task needs.",
    nature: "report",
    downstream:
      "Appended to the objective with a version bump; never replaces the original objective.",
    toolDescription:
      "Optional. A refinement or deepening of the task objective based on this " +
      "round's discoveries. Appended, never substituted for the original goal.",
  },
  {
    path: "retracted_constraints",
    purpose: "Existing constraints that are no longer correct or relevant.",
    when: "When a prior constraint is proven wrong or obsolete.",
    nature: "report",
    downstream:
      "Retired from the active set (with the configured retirement window for plan/hard constraints).",
    toolDescription:
      "Optional. Constraints the agent now believes are wrong or irrelevant, by " +
      "c-XXXXXXXX id or exact text. Omit when none.",
  },
  {
    path: "revised_success_criteria",
    purpose: "Success criteria that need reformulation.",
    when: "When the original criterion was incorrect or unmeasurable.",
    nature: "report",
    downstream: "Applied to the Loop Objective with a version bump.",
    toolDescription:
      "Optional. Success criteria that need reformulation: each entry has the " +
      "old and new wording.",
  },
  {
    path: "round_contract",
    purpose: "A proposal for the NEXT round's evidence-bound contract.",
    when:
      "When no contract is active and a contract command is available; while a " +
      "contract is open, omit it (or restate it unchanged) unless this round " +
      "closes it and declares a successor.",
    nature: "proposal",
    decision: "No active contract: if the next slice is machine-checkable, declare it",
    downstream:
      "Becomes active only after this round commits; item ids rci-XXXXXXXX are " +
      "derived by the runtime.",
    toolDescription:
      "Proposal for the NEXT round's contract (items + verify_with + scope). " +
      "Declared here, it becomes the ACTIVE contract only after this round " +
      "commits. While it is open, omitting it continues the contract; a " +
      "different proposal is ignored (contract_premature). DECLARATION IS " +
      "STRICT: an item with no bound command, an unknown/disabled command, a " +
      "scope entry outside the workspace, a malformed reference, or a count " +
      "over the limits returns contract_invalid.",
  },
  {
    path: "worker_results",
    purpose: "Results of sub-agent / worker delegations.",
    when: "Only when work was actually delegated.",
    nature: "report",
    decision: "You delegated work",
    compact: true,
    promptRank: 50,
    downstream:
      "Saved with its source and written to the delegation journal; worker " +
      "discoveredConstraints is NOT auto-promoted.",
    toolDescription:
      "Optional. Results of sub-agent / Worker delegations this round. Each " +
      "entry must declare an outcome. Entries without a valid outcome are " +
      "dropped with a diagnostic. A worker's discoveredConstraints stays in " +
      "this report; to make it a global constraint, submit it in top-level " +
      "discovered_constraints.",
    reportOnly: true,
  },
  {
    path: "prompt_requests",
    purpose: "Information needs for the next round's prompt.",
    when: "When you know what context the next round will need.",
    nature: "control",
    decision: "You know what the next prompt needs",
    compact: true,
    promptRank: 70,
    downstream:
      "Matched exactly against state items; applied to the NEXT round's prompt. " +
      "If that prompt is L0 it is ignored. Unmatched entries have no effect.",
    toolDescription:
      "Optional. Information needs for the NEXT prompt. emphasize entries are " +
      "matched by stable id or normalized-exact text; a paraphrase matches " +
      "nothing. confusion_points are echoed at the top. They are applied to the " +
      "next round's prompt; if that prompt is L0 they are ignored. This never " +
      "becomes long-term knowledge.",
  },
  {
    path: "compression_checkpoint",
    purpose: "Mark a meaningful work boundary.",
    when: "At a phase/subtask boundary worth a full-state milestone.",
    nature: "report",
    decision: "This round reached a real phase boundary; pair with checkpoint_label",
    compact: true,
    promptRank: 60,
    downstream:
      "Creates an agent-declared milestone and forces an L2 rehydration boundary.",
    toolDescription:
      "Optional. true at a subtask boundary to create a recoverable milestone " +
      "and force a full-state checkpoint. Pair with checkpoint_label.",
  },
  {
    path: "checkpoint_label",
    purpose: "A human-readable label for the checkpoint.",
    when: "Only together with compression_checkpoint=true.",
    nature: "report",
    downstream: "Milestone heading in later prompts and the state file.",
    toolDescription:
      "Optional. Short label for the checkpoint (for example " +
      "'core-model-complete'). Meaningful only when compression_checkpoint=true.",
  },
  {
    path: "retroactiveClaims",
    purpose: "A claim that an earlier round satisfied a criterion.",
    when: "When you can point at an earlier round's evidence.",
    nature: "claim",
    downstream:
      "Advisory check against the named round's committed delta; never upgrades a criterion.",
    toolDescription:
      "Optional. Claims that a PRIOR round satisfied a criterion. The runtime " +
      "checks them against that round's committed evidence and warns when the " +
      "claim is unbacked. Advisory: it never upgrades a criterion by itself.",
  },
  {
    path: "gate_ids",
    purpose: "Approved gate ids this round's work depended on.",
    when: "Only when policy.gate.enabled is true and an approval was actually obtained.",
    nature: "control",
    downstream:
      "Checked only when the gate layer is enabled; otherwise saved as an unused report.",
    toolDescription:
      "Optional. Approved loopforge_gate_check ids this round depended on. " +
      "Enforced only when policy.gate.enabled: a cited, unapproved gate rejects " +
      "the round. Without the gate layer this is saved but has no effect.",
  },
  {
    path: "outcome",
    purpose: "The declared round outcome.",
    when: "When the round is partial, failed, or blocked (success is derivable).",
    nature: "claim",
    downstream:
      "Wins over `success` for the stop decision and success-class checks.",
    toolDescription:
      "Optional. success | partial | failed | blocked. When absent, derived " +
      "from success. A declared non-success outcome suppresses the " +
      "success-class checks even when success=true.",
  },
  {
    path: "blocker",
    purpose: "A concrete description of what blocks the work.",
    when: "Required when outcome=blocked; useful with stop_reason=blocked.",
    nature: "report",
    downstream:
      "Stop decision, handoff open risks, and gate classification when enabled.",
    toolDescription:
      "Optional. A flat blocker description, required when outcome=blocked. " +
      "State what cannot proceed and why; do not use it as a substitute for " +
      "`success=false`.",
  },
  {
    path: "stop_reason",
    purpose: "Why the agent is stopping.",
    when: "Only when should_continue=false and success=false.",
    nature: "control",
    downstream:
      "blocked/needs_human_input stop without claiming success; gave_up is the default stop behavior.",
    toolDescription:
      "Optional. Why the agent is stopping: gave_up | blocked | needs_human_input. " +
      "Only meaningful when should_continue=false and success=false.",
  },
  {
    path: "no_change_reason",
    purpose: "Why a success claim needs no workspace change.",
    when:
      "Only when no enabled verification command is configured and the round " +
      "genuinely required no change.",
    nature: "report",
    downstream:
      "Downgrades the unbacked-success check from warn to info; never creates evidence.",
    toolDescription:
      "Optional. Reason for claiming success with no machine-verifiable change " +
      "(for example a documentation-only round). Honored only when no enabled " +
      "verification command is configured. Never excuses an open contract.",
  },
];

const GUIDE_BY_PATH = new Map(GUIDES.map((guide) => [guide.path, guide]));

/** Fields that existed in earlier releases and are now unknown. A diagnostic
 *  for one of these names explains the removal instead of silently dropping. */
const RETIRED_FIELDS: Readonly<Record<string, string>> = {
  progress_estimate:
    "removed in 3.9.0 — progress is machine-derived; remove this field",
  progress_at_boundary:
    "removed in 3.9.0 — milestones render a round range, not a percentage",
  success_criteria_remaining:
    "removed in 3.8 — report criterion claims under execution_report.criterion_claims",
  next_action:
    "removed in 3.8 — the agent plans; LoopForge does not accept a next-action field",
};

export function fieldGuide(path: string): FieldGuide | undefined {
  return GUIDE_BY_PATH.get(path);
}

export function fieldGuideDescription(path: string): string {
  return GUIDE_BY_PATH.get(path)?.toolDescription ?? "";
}

export function retiredFieldDetail(path: string): string | undefined {
  return RETIRED_FIELDS[path];
}

/** The current SelfEvaluation + ExecutionReport paths, for a schema-sync test. */
export function allFieldGuidePaths(): string[] {
  return GUIDES.map((guide) => guide.path);
}

// ═══════════════════════════════════════════════════════════════════════════
// Examples
// ═══════════════════════════════════════════════════════════════════════════

export interface FieldExampleContext {
  activeContract: ActiveContractView | null;
  activeSubGoals: ReadonlyArray<SubGoal>;
  commands: ReadonlyArray<string>;
  contractVerificationAvailable: boolean;
  criteria?: ReadonlyArray<CriterionStatus>;
  /** The task / current work item, used as the natural first contract item. */
  currentRequirement?: string;
}

function firstActiveItem(contract: ActiveContractView | null) {
  return contract?.items?.[0] ?? null;
}

function firstActiveSubGoal(subGoals: ReadonlyArray<SubGoal>): SubGoal | null {
  return subGoals.find((item) => item.status !== "done" && item.status !== "canceled") ?? null;
}

/** The first criterion the next slice can still work on: `remaining` or
 *  `unknown`. `claimed` is the Agent's own completion claim (machine
 *  unverified), so it is not a natural NEXT work item. */
export function outstandingCriterion(
  criteria: ReadonlyArray<CriterionStatus> | undefined,
): CriterionStatus | null {
  return (criteria ?? []).find(
    (criterion) =>
      criterion.status === "remaining" || criterion.status === "unknown",
  ) ?? null;
}

function clipContractText(text: string | undefined): string {
  const collapsed = (text ?? "").trim().replace(/\s+/g, " ");
  return collapsed.length > 200 ? collapsed.slice(0, 200) : collapsed;
}

/** A legal minimal example for a field, or null when the current facts make the
 *  field unusable (no real id/command to cite). The renderer omits nulls; it
 *  never invents an sg-/rci- reference. */
export function fieldExample(
  path: string,
  ctx: FieldExampleContext,
): unknown | null {
  switch (path) {
    case "success": return false;
    case "output_summary": return "<what was done and how it was verified>";
    case "constraint_violations": return [];
    case "should_continue": return true;
    case "execution_report.files_changed":
      return ["<path whose content or type differs from round start>"];
    case "execution_report.tests_reported":
      return { passed: 0, failed: 0, skipped: 0 };
    case "execution_report.contract_item_claims": {
      const item = firstActiveItem(ctx.activeContract);
      return item ? [{ item_id: item.id, outcome: "met" }] : null;
    }
    case "execution_report.criterion_claims": {
      const criterion = ctx.criteria?.[0];
      return criterion
        ? [{ criterion_id: criterion.id, outcome: "met" }]
        : null;
    }
    case "subgoal_updates": {
      const subGoal = firstActiveSubGoal(ctx.activeSubGoals);
      return subGoal ? [{ id: subGoal.id, status: "done" }] : null;
    }
    case "emerged_subtasks":
      return ["<a new sub-problem that surfaced>"];
    case "discovered_constraints":
      return ["<a constraint later rounds must respect>"];
    case "wrong_assumptions":
      return ["<an assumption from an earlier round that was falsified>"];
    case "objective_refinement":
      return "<what you now understand better about the objective>";
    case "retracted_constraints":
      return ["<constraint text or c-XXXXXXXX id that is no longer valid>"];
    case "revised_success_criteria":
      return [{ old: "<old criterion>", new: "<new criterion>" }];
    case "round_contract": {
      if (!ctx.contractVerificationAvailable || ctx.commands.length === 0) return null;
      const criterion = outstandingCriterion(ctx.criteria);
      const workItem = clipContractText(ctx.currentRequirement) ||
        "<the current requirement, one line>";
      return {
        work_item: workItem,
        items: [{
          description: criterion
            ? clipContractText(criterion.text)
            : "<machine-checkable outcome for this requirement>",
          criterion_refs: criterion ? [criterion.id] : [],
          subgoal_refs: [],
          verify_with: [ctx.commands[0]],
        }],
        scope: ["<workspace-relative file or directory>"],
      };
    }
    case "worker_results":
      return [{
        agentId: "<worker id>",
        subAgentType: "general-purpose",
        subTask: "<self-contained subtask you delegated>",
        resultSummary: "<what the worker reported>",
        outcome: "success",
        discoveredConstraints: [],
      }];
    case "prompt_requests":
      return {
        emphasize: ["<exact constraint text or stable id>"],
        confusion_points: ["<what is unclear about the current state>"],
      };
    case "compression_checkpoint": return false;
    case "checkpoint_label": return "<short phase label>";
    case "retroactiveClaims":
      return [{ round: 1, claim: "<what that earlier round satisfied>" }];
    case "gate_ids":
      return ["<approved gateId from loopforge_gate_check>"];
    case "outcome": return "partial";
    case "blocker": return "<what cannot proceed and why>";
    case "stop_reason": return "blocked";
    case "no_change_reason": return "<why no workspace change was needed>";
    default: return null;
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// Applicability
// ═══════════════════════════════════════════════════════════════════════════

export interface GuidanceFacts {
  activeContract: ActiveContractView | null;
  itemStatuses?: ContractItemStatusView | null;
  subGoals: ReadonlyArray<SubGoal>;
  commands: ReadonlyArray<string>;
  contractVerificationAvailable: boolean;
  gateEnabled: boolean;
  criteria?: ReadonlyArray<CriterionStatus>;
}

/** Semantic applicability — the ONE rule, deliberately independent of prompt
 *  level. Core fields and the two baseline execution-report fields are always
 *  applicable; the rest depend on facts the runtime can actually observe.
 *  Future events (delegation, a checkpoint boundary, a falsified assumption)
 *  remain conditional opportunities, not render-time facts. */
export function isFieldApplicable(path: string, facts: GuidanceFacts): boolean {
  const guide = GUIDE_BY_PATH.get(path);
  if (!guide) return false;
  if (guide.core) return true;
  switch (path) {
    case "execution_report.files_changed":
    case "execution_report.tests_reported":
      return true;
    case "execution_report.contract_item_claims":
      return facts.activeContract !== null;
    case "execution_report.criterion_claims":
      return (facts.criteria ?? []).length > 0;
    case "subgoal_updates":
      return firstActiveSubGoal(facts.subGoals) !== null;
    case "round_contract":
      // A first declaration needs no active contract and a usable command.
      // While a contract is open, the dedicated active-contract block carries
      // the successor instruction instead of a competing proposal example.
      return facts.activeContract === null &&
        facts.contractVerificationAvailable &&
        facts.commands.length > 0;
    case "gate_ids":
      return facts.gateEnabled;
    case "no_change_reason":
      return facts.commands.length === 0;
    default:
      return true;
  }
}

/** Compact-checklist membership: the explicit `compact` marker plus semantic
 *  applicability. The level is deliberately absent — L0/L1/L2 offer the same
 *  evaluation fields; only state density changes. Dedicated renderer fields
 *  (`round_contract`, `subgoal_updates`, `contract_item_claims`) are never
 *  compact members, so they cannot duplicate their own blocks. */
export function isFieldPrompted(path: string, facts: GuidanceFacts): boolean {
  const guide = GUIDE_BY_PATH.get(path);
  if (!guide?.compact) return false;
  return isFieldApplicable(path, facts);
}

/** Deterministic compact-checklist order, shared by the renderer and tests. */
export function promptedFieldPaths(facts: GuidanceFacts): string[] {
  return FIELD_ORDER
    .filter((path) => isFieldPrompted(path, facts))
    .sort((left, right) =>
      (GUIDE_BY_PATH.get(left)?.promptRank ?? Number.MAX_SAFE_INTEGER) -
      (GUIDE_BY_PATH.get(right)?.promptRank ?? Number.MAX_SAFE_INTEGER));
}

// ═══════════════════════════════════════════════════════════════════════════
// Prompt block
// ═══════════════════════════════════════════════════════════════════════════

export interface SelfEvalPromptContext {
  round: number;
  level: "l0" | "l1" | "l2";
  activeContract: ActiveContractView | null;
  itemStatuses?: ContractItemStatusView | null;
  commands: ReadonlyArray<string>;
  contractVerificationAvailable: boolean;
  subGoals: ReadonlyArray<SubGoal>;
  verificationFlags: ReadonlyArray<VerificationFlag>;
  recovery: boolean;
  gateEnabled?: boolean;
  criteria?: ReadonlyArray<CriterionStatus>;
  /** The task / current work item; the natural first contract work_item. */
  currentRequirement?: string;
}

function statusOfItem(
  itemId: string,
  statuses: ContractItemStatusView | null | undefined,
): ContractItemStatus {
  return statuses?.items.find((item) => item.itemId === itemId)?.status ?? "pending";
}

function renderContractGuidance(ctx: SelfEvalPromptContext): string[] {
  const contract = ctx.activeContract;
  if (contract) {
    const lines = [
      "Active Round Contract — continue it; you do NOT need to restate it:",
      `- ${contract.work_item ? `${contract.work_item} ` : ""}(${contract.id})`,
    ];
    const shown = contract.items.slice(0, 5);
    for (const item of shown) {
      const status = statusOfItem(item.id, ctx.itemStatuses);
      const commands = item.verify_with.join(", ") || "<none>";
      lines.push(`  - [${item.id}] ${item.description} — ${status}; verify via: ${commands}`);
    }
    if (contract.items.length > shown.length) {
      lines.push(`  - … and ${contract.items.length - shown.length} more in the Current Task.`);
    }
    const claimDecision = GUIDE_BY_PATH.get("execution_report.contract_item_claims")?.decision
      ?? "Claim completed items of the active contract with their real rci- ids";
    lines.push(
      `${claimDecision} via \`execution_report.contract_item_claims\`.`,
      "A claim alone leaves an item insufficient; its bound command must be observed",
      "passing. Omit `round_contract` to continue this contract; a different proposal",
      "is ignored (contract_premature). If this round closes the contract and another",
      "slice follows, declare the successor proposal here.",
    );
    return lines;
  }
  if (!ctx.contractVerificationAvailable || ctx.commands.length === 0) {
    return [
      "No enabled after-capable evidence command is configured. Contract items cannot",
      "be machine-verified, so run without a contract and do not declare items.",
    ];
  }
  const commands = ctx.commands.slice(0, 3).join(", ");
  const proposalDecision = GUIDE_BY_PATH.get("round_contract")?.decision
    ?? "No active contract: if the next slice is machine-checkable, declare it";
  // The current requirement — not an invented slice — is the natural work
  // item. Real criterion ids/text and the real command are rendered; the
  // runtime still derives rci- ids and the Agent still decides whether this
  // is the right machine-checkable outcome.
  const example = fieldExample("round_contract", {
    activeContract: null,
    activeSubGoals: ctx.subGoals,
    commands: [...ctx.commands],
    contractVerificationAvailable: true,
    criteria: ctx.criteria,
    currentRequirement: ctx.currentRequirement,
  });
  return [
    "The current requirement is the natural work item — not an invented slice.",
    "Declare it as-is only if the command below is its acceptance check; otherwise",
    "describe the machine-checkable outcome and bind the command that actually",
    "verifies it. The proposal activates only after this round commits.",
    `${proposalDecision} → proposal below:`,
    "```json",
    JSON.stringify({ round_contract: example }, null, 1),
    "```",
    `Usable commands: ${commands}.`,
  ];
}

function renderSubGoalGuidance(ctx: SelfEvalPromptContext): string[] {
  const active = ctx.subGoals.filter(
    (item) => item.status !== "done" && item.status !== "canceled",
  );
  if (active.length === 0) return [];
  const shown = active.slice(0, 5);
  const updateDecision = GUIDE_BY_PATH.get("subgoal_updates")?.decision
    ?? "An active sub-goal moved status; cite its real sg- id";
  return [
    "Active sub-goals — update only with their real ids:",
    ...shown.map((item) => `- [${item.id}] ${item.description} — ${item.status}`),
    `${updateDecision} via \`subgoal_updates\`; done/canceled are terminal.`,
  ];
}

const CRITERIA_DISPLAY_LIMIT = 3;
const CRITERIA_TEXT_LIMIT = 80;

function clipCriterionText(text: string): string {
  const collapsed = text.trim().replace(/\s+/g, " ");
  return collapsed.length > CRITERIA_TEXT_LIMIT
    ? collapsed.slice(0, CRITERIA_TEXT_LIMIT - 3) + "..."
    : collapsed;
}

function criteriaDetailLines(
  criteria: ReadonlyArray<CriterionStatus>,
): string[] {
  if (criteria.length === 0) return [];
  const shown = criteria.slice(0, CRITERIA_DISPLAY_LIMIT);
  const more = criteria.length - shown.length;
  const detail = shown
    .map((criterion) =>
      `\`${criterion.id}\` "${clipCriterionText(criterion.text)}" (${criterion.status})`)
    .join("; ");
  return [
    `  Real criteria: ${detail}${more > 0 ? `; +${more} more in the objective.` : "."}`,
  ];
}

/** The compact decision checklist. Only fields whose trigger facts are known
 *  or whose event is a conditional opportunity are rendered; the full
 *  per-field shapes remain in `submission_guidance`. */
function renderCompactTriggers(ctx: SelfEvalPromptContext): string[] {
  const facts: GuidanceFacts = {
    activeContract: ctx.activeContract,
    itemStatuses: ctx.itemStatuses,
    subGoals: ctx.subGoals,
    commands: ctx.commands,
    contractVerificationAvailable: ctx.contractVerificationAvailable,
    gateEnabled: ctx.gateEnabled === true,
    criteria: ctx.criteria ?? [],
  };
  const paths = promptedFieldPaths(facts);
  if (paths.length === 0) return [];
  const lines = [
    "Optional fields — trigger → field → effect. Include a field ONLY when its",
    "trigger actually happened; omitting any of them is always correct. Legal",
    "shapes: see the `submission_guidance` field in the round response.",
  ];
  for (const path of paths) {
    const guide = GUIDE_BY_PATH.get(path);
    if (!guide?.decision) continue;
    lines.push(`- ${guide.decision} → \`${path}\` → ${guide.downstream}`);
    if (path === "execution_report.criterion_claims") {
      lines.push(...criteriaDetailLines(ctx.criteria ?? []));
    }
  }
  return lines;
}

/** Verification flags name the concrete evaluation field, which is often the
 *  dotted path the Agent must fill. Normalize the legacy short names before
 *  the guidance lookup so the prompt always names the real field. */
const FLAG_FIELD_PATHS: Readonly<Record<string, string>> = {
  files_changed: "execution_report.files_changed",
  tests_reported: "execution_report.tests_reported",
  criterion_claims: "execution_report.criterion_claims",
  contract_item_claims: "execution_report.contract_item_claims",
};

function flagFieldPath(field: string): string {
  return FLAG_FIELD_PATHS[field] ?? field;
}

function renderFlagGuidance(
  flags: ReadonlyArray<VerificationFlag>,
  criteria: ReadonlyArray<CriterionStatus> = [],
  level: "l0" | "l1" | "l2" = "l1",
): string[] {
  if (flags.length === 0) return [];
  const fields = [
    ...new Set(flags.map((flag) => flagFieldPath(flag.field)).filter(Boolean)),
  ];
  const lines = [
    "Previous machine findings name these fields:",
    ...fields.slice(0, 8).map((field) => {
      const guide = GUIDE_BY_PATH.get(field);
      return `- \`${field}\`${guide ? ` — ${guide.purpose}` : ""}`;
    }),
  ];
  // L0's Verification Gate deliberately stays compact and carries no action
  // continuation. The evaluation block is the Agent's composition surface,
  // so the concrete action belongs here. L1/L2 already render it once in the
  // gate; do not duplicate it.
  if (level === "l0") {
    const actions = new Map<string, { label: string; action: string }>();
    for (const flag of flags) {
      if (flag.severity === "info" || actions.has(flag.check)) continue;
      actions.set(flag.check, {
        label: flag.severity === "error" ? "Fix" : "Action",
        action: verificationActionFor(flag.check),
      });
      if (actions.size >= 3) break;
    }
    for (const [check, entry] of actions) {
      lines.push(`  → ${entry.label}: ${entry.action} [${check}]`);
    }
  }
  const criterionFinding = flags.some((flag) =>
    flag.field === "execution_report.criterion_claims" ||
    flag.field === "criterion_claims" ||
    flag.check === "criteria_claims_unverified" ||
    flag.check === "success_with_remaining_criteria");
  if (criterionFinding && criteria.length > 0) {
    lines.push(...criteriaDetailLines(criteria));
  }
  lines.push(
    "Correct the relevant field(s) in this round if the finding still applies.",
    "If this attempt falsified an earlier assumption, record it in",
    "`wrong_assumptions`; otherwise omit it.",
  );
  return lines;
}

/** Render the evaluation block appended to every prompt. */
export function renderSelfEvalBlock(ctx: SelfEvalPromptContext): string {
  const base = {
    success: false,
    output_summary: "<what was done and how it was verified>",
    constraint_violations: [],
    should_continue: true,
  };
  const reportCtx: FieldExampleContext = {
    activeContract: ctx.activeContract,
    activeSubGoals: ctx.subGoals,
    commands: ctx.commands,
    contractVerificationAvailable: ctx.contractVerificationAvailable,
    criteria: ctx.criteria ?? [],
    currentRequirement: ctx.currentRequirement,
  };
  const lines: string[] = [
    "### LoopForge Evaluation (Required)",
    "",
    `After completing Round ${ctx.round}, submit one evaluation to ` +
      "`loopforge_next.evaluation`.",
    "",
    "Base (always):",
    "```json",
    JSON.stringify(base, null, 2),
    "```",
    "Add the execution report when the round changed files or ran tests:",
    "```json",
    JSON.stringify({
      execution_report: {
        files_changed: fieldExample("execution_report.files_changed", reportCtx),
        tests_reported: fieldExample("execution_report.tests_reported", reportCtx),
      },
    }, null, 1),
    "```",
    "`files_changed` is the net boundary change from round start (content or",
    "file type), including deletions. A commit alone adds no entry when content",
    "is unchanged. Do not list gitignored paths merely to look complete.",
  ];
  lines.push(...renderCompactTriggers(ctx));
  lines.push(...renderContractGuidance(ctx));
  lines.push(...renderSubGoalGuidance(ctx));
  if (ctx.recovery || ctx.verificationFlags.length > 0) {
    lines.push(
      ...renderFlagGuidance(ctx.verificationFlags, ctx.criteria ?? [], ctx.level),
    );
  }
  lines.push(
    "Never invent an id. Use only ids rendered in this prompt or",
    "`submission_guidance`; when an id is absent, omit the field rather than",
    "writing a placeholder id.",
  );
  return lines.join("\n");
}

// ═══════════════════════════════════════════════════════════════════════════
// submission_guidance projection
// ═══════════════════════════════════════════════════════════════════════════

/** The session slice guidance needs. Structural so lifecycle and manager can
 *  both pass their own view without importing each other. */
export interface GuidanceSessionView {
  loopId: string;
  currentRound: number;
  /** The task / current work item, when the caller can observe it. */
  task?: string;
  roundSnapshot?: {
    roundId: string;
    promptArtifact?: PromptArtifact;
    beforeEvidence?: unknown;
  } | null;
  lastCompileResponse?: LoopForgeResponse | null;
  currentLevel?: string;
  backtrackTargetGitHead?: string;
  backtrackSkippedFiles?: string[];
}

export interface GuidanceOptions {
  /** The history window the caller already uses: `derivationRounds` for a live
   *  prepare, `readOnlyRounds` for a read-only view. Never derive a second one. */
  rounds: ReadonlyArray<CommittedRoundView>;
  verificationFlags?: ReadonlyArray<VerificationFlag>;
  recovery?: {
    required: boolean;
    restore_point?: number;
    target_head?: string;
  } | null;
}

function activeSubGoals(subGoals: ReadonlyArray<SubGoal>): SubGoal[] {
  return subGoals.filter(
    (item) => item.status !== "done" && item.status !== "canceled",
  );
}

/** Derive `submission_guidance` from current facts. Pure: no I/O, no writes,
 *  no persistence. The same inputs produce the same object. */
export function deriveSubmissionGuidance(
  session: GuidanceSessionView,
  options: GuidanceOptions,
): SubmissionGuidance {
  const policy = getPolicy();
  const commandsPolicy: ReadonlyArray<CommandEvidencePolicy> =
    policy.evidence?.commands ?? [];
  const capability = deriveConfiguredCapability(policy);
  const commandNames = capability.commands
    .filter((command) => command.enabled)
    .map((command) => command.commandId);
  const level: "l0" | "l1" | "l2" =
    session.currentLevel === "l0" || session.currentLevel === "l1" ||
      session.currentLevel === "l2"
      ? session.currentLevel
      : (session.roundSnapshot?.promptArtifact?.level ??
        session.lastCompileResponse?.prompt_artifact?.level ?? "l2");

  const subGoals: ReadonlyArray<SubGoal> =
    session.lastCompileResponse?.sub_goals ??
    deriveSubGoals({
      loopId: session.loopId,
      currentRound: session.currentRound,
      rounds: options.rounds,
    });
  const facts = deriveRoundFacts({
    rounds: options.rounds,
    currentRound: session.currentRound,
    inFlight: NO_IN_FLIGHT_ROUND,
    subGoals,
    commands: commandsPolicy,
  });
  const activeContract = facts.activeContract;
  const itemStatuses = facts.itemStatuses;
  const criteria = session.lastCompileResponse?.criterion_statuses ?? [];
  const guidanceFacts: GuidanceFacts = {
    activeContract,
    itemStatuses,
    subGoals,
    commands: commandNames,
    contractVerificationAvailable: capability.contractVerificationAvailable,
    gateEnabled: policy.gate?.enabled === true,
    criteria,
  };
  const exampleCtx: FieldExampleContext = {
    activeContract,
    activeSubGoals: activeSubGoals(subGoals),
    commands: commandNames,
    contractVerificationAvailable: capability.contractVerificationAvailable,
    criteria,
    currentRequirement:
      session.task?.trim() || activeContract?.work_item || "",
  };
  const artifact = session.roundSnapshot?.promptArtifact ??
    session.lastCompileResponse?.prompt_artifact;
  const roundId = session.roundSnapshot?.roundId ??
    `loop:${session.loopId}:round:${session.currentRound}`;

  return {
    round_id: roundId,
    active_contract: activeContract
      ? {
          id: activeContract.id,
          ...(activeContract.work_item ? { work_item: activeContract.work_item } : {}),
          declared_at_round: activeContract.declared_at_round,
          items: activeContract.items.map((item) => ({
            id: item.id,
            description: item.description,
            status: statusOfItem(item.id, itemStatuses),
            verify_with: [...item.verify_with],
          })),
        }
      : null,
    contract_commands: commandNames,
    contract_verification_available: capability.contractVerificationAvailable,
    subgoals: activeSubGoals(subGoals).map((item) => ({
      id: item.id,
      description: item.description,
      status: item.status,
    })),
    criteria: criteria.map((criterion) => ({
      id: criterion.id,
      text: criterion.text,
      status: criterion.status,
    })),
    recovery: options.recovery ?? (session.backtrackTargetGitHead
      ? {
          required: true,
          restore_point: Math.max(1, session.currentRound - 1),
          target_head: session.backtrackTargetGitHead,
        }
      : null),
    prompt: {
      level,
      dropped_sections: [...(artifact?.droppedSections ?? [])],
      protected_overflow: artifact?.protectedOverflow === true,
    },
    fields: FIELD_ORDER
      .filter((path) => isFieldApplicable(path, guidanceFacts))
      .map((path) => {
        const guide = GUIDE_BY_PATH.get(path)!;
        return {
          path,
          when: guide.when,
          example: fieldExample(path, exampleCtx),
          effect: guide.downstream,
        };
      }),
    findings: (options.verificationFlags ?? []).map((flag) => ({
      field: flag.field,
      check: flag.check,
      severity: flag.severity,
      detail: flag.detail,
      ...(flag.ref ? { ref: flag.ref } : {}),
    })),
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// Submitted-field manifest (used by diagnostics/receipts)
// ═══════════════════════════════════════════════════════════════════════════

const TOP_LEVEL_KNOWN = new Set(
  GUIDES.map((guide) => guide.path.split(".")[0]),
);
const EXECUTION_REPORT_KNOWN = new Set(
  GUIDES
    .filter((guide) => guide.path.startsWith("execution_report."))
    .map((guide) => guide.path.slice("execution_report.".length)),
);

/** The ATTEMPTED manifest: known paths present in the raw payload, in
 *  FIELD_ORDER. Presence means the key is an own property with a defined
 *  value; an explicit `null` is still an attempt (the normalizer diagnoses
 *  whether it survived). Unknown fields are NOT in the manifest; the
 *  diagnostic channel owns them. */
export function submittedFieldPaths(raw: Record<string, unknown>): string[] {
  const paths: string[] = [];
  const report = raw.execution_report;
  const reportRecord =
    report && typeof report === "object" && !Array.isArray(report)
      ? report as Record<string, unknown>
      : null;
  for (const path of FIELD_ORDER) {
    if (path.startsWith("execution_report.")) {
      const key = path.slice("execution_report.".length);
      if (reportRecord &&
          Object.hasOwn(reportRecord, key) &&
          reportRecord[key] !== undefined &&
          EXECUTION_REPORT_KNOWN.has(key)) {
        paths.push(path);
      }
      continue;
    }
    if (Object.hasOwn(raw, path) && raw[path] !== undefined && TOP_LEVEL_KNOWN.has(path)) {
      paths.push(path);
    }
  }
  return paths;
}

export function unknownExecutionReportEntryFields(
  report: Record<string, unknown>,
): string[] {
  return Object.keys(report)
    .filter((key) => !EXECUTION_REPORT_KNOWN.has(key))
    .sort();
}

export function unknownExecutionReportFields(raw: Record<string, unknown>): string[] {
  const report = raw.execution_report;
  if (!report || typeof report !== "object" || Array.isArray(report)) return [];
  return unknownExecutionReportEntryFields(report as Record<string, unknown>);
}

export function unknownTopLevelFields(raw: Record<string, unknown>): string[] {
  return Object.keys(raw)
    .filter((key) => !TOP_LEVEL_KNOWN.has(key))
    .sort();
}
