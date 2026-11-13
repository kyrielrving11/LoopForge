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
import { deriveCriterionStatuses } from "./criterion-status.js";
import { deriveSubGoals } from "./subgoal-state.js";
import { deriveContractRequirement } from "./contract-requirement.js";
import type {
  ContractItemStatus,
  ContractSupersede,
  CriterionStatus,
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
  /** v4.0.3: the persisted value is an array. Field accounting reads this
   *  flag instead of keeping a second hardcoded path list. */
  array?: true;
  /** One of the four strict core fields. */
  core?: boolean;
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
/** v4.0.3: THE four structural evaluation fields. The MCP input schema, the
 *  prompt template and field accounting read this one set. */
export const CORE_SELF_EVALUATION_FIELDS: ReadonlySet<string> = new Set([
  "outcome",
  "output_summary",
  "constraint_violations",
  "should_continue",
]);

export const FIELD_ORDER = [
  "outcome",
  "output_summary",
  "constraint_violations",
  "should_continue",
  "execution_report.files_changed",
  "execution_report.claims",
  "objective_refinement",
  "subgoal_updates",
  "emerged_subtasks",
  "discovered_constraints",
  "wrong_assumptions",
  "open_questions",
  "resolved_open_question_ids",
  "retracted_constraints",
  "round_contract",
  "worker_results",
  "subtask_boundary",
  "subtask_boundary_label",
  "retroactiveClaims",
  "gate_ids",
  "blocker",
  "no_change_reason",
] as const;

export type FieldPath = (typeof FIELD_ORDER)[number];

const OUTCOME_COMBINATIONS =
  "success/blocked require should_continue=false; blocked also needs a " +
  "non-empty blocker. partial/failed may continue or stop.";

const FILES_CHANGED_BOUNDARY =
  "Net content/type change from round start, including deletions; a commit " +
  "alone adds nothing. Include only tracked and non-ignored untracked paths.";

const GUIDES: FieldGuide[] = [
  {
    path: "outcome",
    purpose: "The ONE round conclusion.",
    when: "Every round: success | partial | failed | blocked. " + OUTCOME_COMBINATIONS,
    nature: "claim",
    downstream: "Stop/success trajectory; a claim, not evidence.",
    toolDescription:
      "Required. success | partial | failed | blocked. " +
      OUTCOME_COMBINATIONS + " This is the ONE " +
      "round conclusion.",
    core: true,
  },
  {
    path: "output_summary",
    purpose: "What was actually done this round, not what was attempted.",
    when: "Every round.",
    nature: "report",
    downstream: "Committed record; never machine evidence.",
    toolDescription:
      "Specific, actionable summary of what was DONE this round — not what was " +
      "attempted. Do not restate the plan.",
    core: true,
  },
  {
    path: "constraint_violations",
    array: true,
    purpose: "Hard constraints actually violated this round.",
    when: "Every round; empty when none.",
    nature: "report",
    downstream: "Recurring detection/retirement.",
    toolDescription:
      "Constraints the agent actually violated this round, preferably by the " +
      "c-XXXXXXXX id the prompt rendered. Empty when none. Be honest.",
    core: true,
  },
  {
    path: "should_continue",
    purpose: "Whether the loop should advance to another round.",
    when: "Every round; false only when the whole task is complete or a stop is required.",
    nature: "control",
    downstream: "Controls the next round; partial progress is true.",
    toolDescription:
      "false ONLY when the ENTIRE task is complete or a stop is required. " +
      "Partial progress = true.",
    core: true,
  },
  {
    path: "execution_report.files_changed",
    array: true,
    purpose:
      "The boundary net change: paths whose content or file type differs between " +
      "round preparation and this submission, including deleted paths.",
    when: "When the workspace changed. " + FILES_CHANGED_BOUNDARY,
    nature: "report",
    downstream: "Compared with machine boundary; not observation.",
    toolDescription: FILES_CHANGED_BOUNDARY,
    reportOnly: false,
  },
  {
    path: "execution_report.claims",
    array: true,
    purpose:
      "Claims about objective criteria and ACTIVE contract items, in one channel.",
    when:
      "When declaring criteria or active items met/remaining; cite real " +
      "cr-/rci- ids from this prompt.",
    nature: "claim",
    compact: true,
    promptRank: 10,
    downstream:
      "`cr-` advisory; `rci-` strict; only machine commands verify.",
    toolDescription:
      "One claims channel. Each entry is { id, outcome } where id is a " +
      "cr-XXXXXXXX objective criterion id or an rci-XXXXXXXX item id of the " +
      "ACTIVE contract, and outcome is met | remaining. cr- claims are " +
      "advisory (unknown/malformed entries are dropped); rci- claims are strict " +
      "(unknown/duplicate ids are contract_invalid). A claim never verifies " +
      "anything by itself — the runtime marks an item verified only when its " +
      "bound commands are observed passing.",
  },
  {
    path: "objective_refinement",
    purpose:
      "The Agent's working version of the OVERALL starting objective — not the " +
      "current round, not the contract.",
    when:
      "Only when the overall objective genuinely evolved; omit when unchanged.",
    nature: "report",
    compact: true,
    promptRank: 15,
    downstream: "Working objective text only; never acceptance/criteria.",
    toolDescription:
      "Optional, at most 1000 chars. A refined statement of the OVERALL " +
      "starting objective when understanding genuinely changed. It never " +
      "rewrites the operator acceptance, criteria or hard constraints, and it " +
      "is not the round task or contract. Omit when the objective is unchanged.",
  },
  {
    path: "subgoal_updates",
    array: true,
    purpose: "Explicit status transitions for existing sub-goals.",
    when: "When an active sg- id starts, blocks, completes or is canceled.",
    nature: "transition",
    downstream: "Derived sub-goal state; done/canceled are terminal.",
    toolDescription:
      "Explicit status transitions for EXISTING sub-goals. Each entry references " +
      "an ACTIVE sg-XXXXXXXX id from the prompt. Unknown ids, done/canceled " +
      "(terminal) references, and illegal migrations are evaluation_invalid. " +
      "Re-open work through a NEW emerged_subtasks declaration, never by " +
      "referencing a terminal id.",
  },
  {
    path: "emerged_subtasks",
    array: true,
    purpose: "New execution-plan work that the active criteria/contract do not already cover.",
    when:
      "Only when new work appears or a work item must split; zero is valid.",
    nature: "transition",
    compact: true,
    promptRank: 40,
    downstream: "Only sub-goal creation channel; ids derived.",
    toolDescription:
      "New work that surfaced during execution and was not already covered by " +
      "the active criteria or current contract. The ONLY sub-goal creation " +
      "channel. Plain descriptions, never sg-XXXXXXXX ids. Do not restate the " +
      "criteria as sub-goals; zero entries is a valid result.",
  },
  {
    path: "discovered_constraints",
    array: true,
    purpose: "New constraints that later rounds must respect.",
    when: "When this round found a limit not known before.",
    nature: "report",
    compact: true,
    promptRank: 20,
    downstream: "Merged into active constraints; over-limit dropped.",
    toolDescription:
      "New constraints that must apply to later rounds. This is the ONLY " +
      "promotion channel for a worker-discovered constraint: a worker result " +
      "stays a report until the main agent states the constraint here.",
  },
  {
    path: "wrong_assumptions",
    array: true,
    purpose: "Assumptions from earlier rounds that this round falsified.",
    when: "When evidence falsified an earlier assumption; omit when none.",
    nature: "report",
    compact: true,
    promptRank: 30,
    downstream:
      "Working Memory/replay; only committed reports reach later prompts.",
    toolDescription:
      "Assumptions from earlier rounds that turned out to be wrong. Record one " +
      "only when this round actually falsified it; otherwise omit. This is not " +
      "a reflection quota.",
  },
  {
    path: "open_questions",
    array: true,
    purpose:
      "Unresolved questions that still affect later slices (a question list, " +
      "not a todo list).",
    when:
      "Only when a real question affects later work; omit when none.",
    nature: "report",
    reportOnly: true,
    compact: true,
    promptRank: 35,
    downstream:
      "Report-only; Working Memory/replay, never a gate.",
    toolDescription:
      "Optional. At most 3 unresolved questions, 300 chars each. Record only " +
      "questions that still affect later slices — not a todo list, not a " +
      "completion checklist, and not a substitute for a blocker or decision. " +
      "Report-only: LoopForge never acts on these entries.",
  },
  {
    path: "resolved_open_question_ids",
    array: true,
    purpose: "Open-question ids that this round resolved.",
    when: "When a rendered open question is resolved.",
    nature: "report",
    reportOnly: true,
    compact: true,
    promptRank: 36,
    downstream: "Removes question from Working Memory.",
    toolDescription:
      "Optional. Use only stable oq-... ids rendered beside open questions in " +
      "Working Memory or the state file. Report-only; it never changes the " +
      "verification gate or acceptance criteria.",
  },
  {
    path: "retracted_constraints",
    array: true,
    purpose: "Existing constraints that are no longer correct or relevant.",
    when: "When a prior constraint is proven wrong or obsolete.",
    nature: "report",
    downstream:
      "Only active Agent-discovered constraints; operator/plan immutable.",
    toolDescription:
      "Optional. Active Agent-discovered constraints that are no longer valid, " +
      "by c-XXXXXXXX id or exact text. Operator criteria/hard constraints and " +
      "plan constraints cannot be retracted. Omit when none.",
  },
  {
    path: "round_contract",
    purpose:
      "THE contract channel: the NEXT round's bounded deliverable and its " +
      "acceptance conditions.",
    when:
      "When coverage requires a next-round contract, or you start/replace a " +
      "slice; omit to continue the current one.",
    nature: "proposal",
    downstream:
      "Active after this round commits; rci- ids are derived. `scope` is " +
      "report-only; `supersedes` closes the named active contract.",
    toolDescription:
      "THE contract channel for the NEXT round. work_item is the bounded " +
      "deliverable this slice produces (an outcome, not an activity) and is " +
      "required for a new proposal. items are acceptance conditions; each item " +
      "binds its own verify_with commands and may cite cr- ids in " +
      "criterion_refs. scope is an OPTIONAL, report-only declaration of " +
      "intended files — it is not enforced and is not part of the rc- id. " +
      "While a contract is open, omit this field to continue it unchanged. To " +
      "replace the active slice, add supersedes { contract_id, reason? } with " +
      "the active rc- id and different acceptance items. If the active " +
      "contract closes this round and a successor is available, a successor " +
      "is REQUIRED. The final configured round has no successor consumer. " +
      "DECLARATION IS STRICT: a missing work_item, an item with no bound " +
      "command, an unknown/disabled command, a malformed reference, an " +
      "unknown field, or a count over the limits returns contract_invalid.",
  },
  {
    path: "worker_results",
    array: true,
    purpose: "Results of sub-agent / worker delegations.",
    when: "Only when work was actually delegated.",
    nature: "report",
    compact: true,
    promptRank: 50,
    downstream: "Audit report; never auto-promoted.",
    toolDescription:
      "Optional. Results of sub-agent / Worker delegations this round. Each " +
      "entry must declare an outcome. Entries without a valid outcome are " +
      "dropped with a diagnostic. To make a worker finding a global " +
      "constraint, submit it in top-level discovered_constraints.",
    reportOnly: true,
  },
  {
    path: "subtask_boundary",
    purpose: "Mark a meaningful work boundary.",
    when: "At a subtask boundary that warrants an L2 rehydration.",
    nature: "report",
    compact: true,
    promptRank: 60,
    downstream: "Forces L2 rehydration.",
    toolDescription:
      "Optional. true at a subtask boundary to force an L2 rehydration boundary. " +
      "Pair with subtask_boundary_label.",
  },
  {
    path: "subtask_boundary_label",
    purpose: "A human-readable label for the subtask boundary.",
    when: "Only together with subtask_boundary=true.",
    nature: "report",
    downstream: "Stored on the report.",
    toolDescription:
      "Optional. Short label for the subtask boundary (for example " +
      "'core-model-complete'). Meaningful only when subtask_boundary=true.",
  },
  {
    path: "retroactiveClaims",
    array: true,
    purpose: "A claim that an earlier round satisfied a criterion.",
    when: "When you can point at an earlier round's evidence.",
    nature: "claim",
    downstream: "Advisory check; never upgrades a criterion.",
    toolDescription:
      "Optional. Claims that a PRIOR round satisfied a criterion. The runtime " +
      "checks them against that round's committed evidence and warns when the " +
      "claim is unbacked. Advisory: it never upgrades a criterion by itself.",
  },
  {
    path: "gate_ids",
    array: true,
    purpose: "Approved gate ids this round's work depended on.",
    when: "Only when the gate layer is enabled and an approval was obtained.",
    nature: "control",
    downstream: "Checked only when gate enabled.",
    toolDescription:
      "Optional. Approved loopforge_gate_check ids this round depended on. " +
      "Enforced only when policy.gate.enabled: a cited, unapproved gate rejects " +
      "the round. Without the gate layer this is saved but has no effect.",
  },
  {
    path: "blocker",
    purpose: "A concrete description of what blocks the work.",
    when: "Required when outcome=blocked; ignored (with a diagnostic) otherwise.",
    nature: "report",
    downstream: "Stop reason; blocked-contract closure.",
    toolDescription:
      "Required when outcome=blocked (trim non-empty, at most 500 chars). State " +
      "what cannot proceed and why. When another outcome is declared it is " +
      "dropped with a diagnostic and never rejects the round.",
  },
  {
    path: "no_change_reason",
    purpose: "Why a success claim needs no workspace change.",
    when:
      "Only when no verification command is configured and no change was needed.",
    nature: "report",
    downstream: "Warn to info; never evidence.",
    toolDescription:
      "Optional. Reason for claiming success with no machine-verifiable change " +
      "(for example a documentation-only round). Honored only when no enabled " +
      "verification command is configured. Never excuses an open contract.",
  },
];

const GUIDE_BY_PATH = new Map(GUIDES.map((guide) => [guide.path, guide]));

/** v4.0.3: array-valued evaluation paths, derived from the SAME field
 *  metadata the prompt, MCP schema and receipts read. Field accounting uses
 *  this set instead of a second hardcoded list. */
export const ARRAY_SELF_EVALUATION_FIELDS: ReadonlySet<string> = new Set(
  GUIDES.filter((guide) => guide.array === true).map((guide) => guide.path),
);

/** Fields that existed in earlier releases and are now unknown. A diagnostic
 *  for one of these names explains the removal instead of silently dropping. */
const RETIRED_FIELDS: Readonly<Record<string, string>> = {
  progress_estimate:
    "removed in 3.9.0 — progress is machine-derived; remove this field",
  progress_at_boundary:
    "removed in 3.9.0 — milestones render a round range, not a percentage",
  success_criteria_remaining:
    "removed in 3.8 — report criterion claims under execution_report.claims",
  next_action:
    "removed in 3.8 — the agent plans; LoopForge does not accept a next-action field",
  revised_success_criteria:
    "removed in 3.9.6 — operator acceptance is immutable; report a conflict in " +
    "wrong_assumptions or stop with outcome=blocked/needs_human_input",
  prompt_requests:
    "removed in 4.0.1 — the next prompt is compiled from committed facts; " +
    "there is no per-round prompt-steering channel",
  success:
    "removed in 4.0.6 — use `outcome` (success | partial | failed | blocked)",
  agent_stop_reason:
    "removed in 4.0.6 — use outcome=blocked with `blocker`; stop with " +
    "outcome=failed and should_continue=false",
  contract_transition:
    "removed in 4.0.6 — use round_contract.supersedes { contract_id, reason? }",
  tests_reported:
    "removed in 4.0.6 — command observations are the test fact; do not report counts",
  criterion_claims:
    "removed in 4.0.6 — use execution_report.claims with cr- ids",
  contract_item_claims:
    "removed in 4.0.6 — use execution_report.claims with rci- ids",
  "execution_report.tests_reported":
    "removed in 4.0.6 — command observations are the test fact; remove tests_reported",
  "execution_report.criterion_claims":
    "removed in 4.0.6 — move these claims into execution_report.claims with cr- ids",
  "execution_report.contract_item_claims":
    "removed in 4.0.6 — move these claims into execution_report.claims with rci- ids",
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
}

function firstActiveItem(contract: ActiveContractView | null) {
  return contract?.items?.[0] ?? null;
}

function firstActiveSubGoal(subGoals: ReadonlyArray<SubGoal>): SubGoal | null {
  return subGoals.find((item) => item.status !== "done" && item.status !== "canceled") ?? null;
}

function contractSupersedeExample(contract: ActiveContractView): ContractSupersede {
  return { contract_id: contract.id, reason: "<why the slice changed>" };
}

/** A legal minimal example for a field, or null when the current facts make the
 *  field unusable (no real id/command to cite). The renderer omits nulls; it
 *  never invents an sg-/rci- reference. */
export function fieldExample(
  path: string,
  ctx: FieldExampleContext,
): unknown | null {
  switch (path) {
    case "outcome": return "partial";
    case "output_summary": return "<what was done and verified>";
    case "constraint_violations": return [];
    case "should_continue": return true;
    case "execution_report.files_changed": return ["<path>"];
    case "execution_report.claims": {
      const item = firstActiveItem(ctx.activeContract);
      if (item) return [{ id: item.id, outcome: "met" }];
      const criterion = ctx.criteria?.[0];
      return criterion ? [{ id: criterion.id, outcome: "met" }] : null;
    }
    case "objective_refinement":
      return "<refined objective>";
    case "subgoal_updates": {
      const subGoal = firstActiveSubGoal(ctx.activeSubGoals);
      return subGoal ? [{ id: subGoal.id, status: "done" }] : null;
    }
    case "emerged_subtasks":
      return ["<new sub-problem>"];
    case "discovered_constraints":
      return ["<new constraint>"];
    case "wrong_assumptions":
      return ["<falsified assumption>"];
    case "open_questions":
      return ["<open question>"];
    case "resolved_open_question_ids":
      return ["oq-<rendered id>"];
    case "retracted_constraints":
      return ["<c- id or exact text>"];
    case "round_contract": {
      if (!ctx.contractVerificationAvailable || ctx.commands.length === 0) return null;
      return {
        work_item: "<bounded deliverable>",
        items: [{
          description: "<acceptance condition>",
          criterion_refs: [],
          verify_with: [ctx.commands[0]],
        }],
        ...(ctx.activeContract
          ? { supersedes: contractSupersedeExample(ctx.activeContract) }
          : {}),
      };
    }
    case "worker_results":
      return [{
        agentId: "<worker id>",
        subTask: "<delegated subtask>",
        resultSummary: "<worker report>",
        outcome: "success",
      }];
    case "subtask_boundary": return false;
    case "subtask_boundary_label": return "<short phase label>";
    case "retroactiveClaims":
      return [{ round: 1, claim: "<satisfied condition>" }];
    case "gate_ids":
      return ["<approved gateId>"];
    case "blocker": return "<what cannot proceed and why>";
    case "no_change_reason": return "<why no change was needed>";
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
 *  Future events (delegation, a subtask boundary, a falsified assumption)
 *  remain conditional opportunities, not render-time facts. */
export function isFieldApplicable(path: string, facts: GuidanceFacts): boolean {
  const guide = GUIDE_BY_PATH.get(path);
  if (!guide) return false;
  if (guide.core) return true;
  switch (path) {
    case "execution_report.files_changed":
      return true;
    case "execution_report.claims":
      return facts.activeContract !== null || (facts.criteria ?? []).length > 0;
    case "objective_refinement":
      return true;
    case "subgoal_updates":
      return firstActiveSubGoal(facts.subGoals) !== null;
    case "round_contract":
      // v4.0.6: the contract channel is usable whenever a contract can be
      // verified. The dedicated contract block decides REQUIRED vs continue vs
      // redirect for the current facts.
      return facts.contractVerificationAvailable && facts.commands.length > 0;
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
 *  (`round_contract`, `subgoal_updates`) are never compact members, so they
 *  cannot duplicate their own blocks. */
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
  maxRounds?: number;
  activeContract: ActiveContractView | null;
  itemStatuses?: ContractItemStatusView | null;
  commands: ReadonlyArray<string>;
  contractVerificationAvailable: boolean;
  subGoals: ReadonlyArray<SubGoal>;
  gateEnabled?: boolean;
  criteria?: ReadonlyArray<CriterionStatus>;
}

function statusOfItem(
  itemId: string,
  statuses: ContractItemStatusView | null | undefined,
): ContractItemStatus {
  return statuses?.items.find((item) => item.itemId === itemId)?.status ?? "pending";
}

function renderContractGuidance(ctx: SelfEvalPromptContext): string[] {
  const contract = ctx.activeContract;
  const hasCommand = ctx.contractVerificationAvailable && ctx.commands.length > 0;
  // v4.0.6: coverage guidance uses the SAME shared rule as the submission
  // boundary and the post-evidence gate. `proposalPresent:false` describes
  // this prompt (no next-round proposal has been committed yet). The current
  // contract's items already render in Current Task / Active Round Contract;
  // this block only states the decision rule.
  const requirement = deriveContractRequirement({
    shouldContinue: true,
    blocked: false,
    proposalPresent: false,
    activeContract: contract,
    closure: ctx.itemStatuses?.closure ?? "open",
    contractCapability: hasCommand,
    successorRoundAvailable:
      ctx.maxRounds === undefined || ctx.round < ctx.maxRounds,
  });
  if (contract) {
    const lines = [`Active contract \`${contract.id}\`.`];
    const continueOpenContract =
      "While open, omit `round_contract` to continue it unchanged.";
    if (requirement.reason === "no_contract_capability") {
      lines.push(
        continueOpenContract,
        "No enabled after-capable command is configured, so its items cannot " +
          "be machine-verified and no successor is required.",
      );
    } else if (requirement.reason === "no_successor_round") {
      lines.push(
        "This is the final configured round; do not submit a successor " +
          "`round_contract`.",
      );
    } else if (requirement.reason === "active_contract_closed") {
      lines.push(
        "This contract is already closed; if you continue, a successor " +
          "`round_contract` is REQUIRED for the next round.",
      );
    } else {
      lines.push(
        continueOpenContract + " To replace it, " +
          "submit different acceptance items with `round_contract.supersedes`: " +
          `\`${JSON.stringify(contractSupersedeExample(contract))}\` (reason optional).`,
        "If this round closes the contract and you continue, a successor " +
          "`round_contract` is REQUIRED for the next round.",
      );
    }
    return lines;
  }
  if (requirement.reason === "no_contract_capability") {
    return ["No after-capable evidence command — no contract is possible."];
  }
  if (requirement.reason === "no_successor_round") {
    return [
      "This is the final configured round; do not submit `round_contract`.",
    ];
  }
  const commands = ctx.commands.slice(0, 3).join(", ");
  const example = fieldExample("round_contract", {
    activeContract: null,
    activeSubGoals: ctx.subGoals,
    commands: [...ctx.commands],
    contractVerificationAvailable: true,
    criteria: ctx.criteria,
  });
  return [
    "No active Round Contract. If you continue, one is REQUIRED for the next " +
      "round. Legal shape:",
    "```json",
    JSON.stringify({ round_contract: example }, null, 1),
    "```",
    `Usable commands: ${commands}.`,
  ];
}

function renderSubGoalGuidance(ctx: SelfEvalPromptContext): string[] {
  if (!firstActiveSubGoal(ctx.subGoals)) return [];
  return [
    "Update sub-goal status only with a real `sg-` id via `subgoal_updates`; " +
      "done/canceled are terminal.",
  ];
}

/** Render each optional event's existing `when` once beside its path. Full
 *  examples and effects stay in guidance; no second trigger text is maintained. */
function renderOptionalTriggers(ctx: SelfEvalPromptContext): string[] {
  const facts: GuidanceFacts = {
    activeContract: ctx.activeContract,
    itemStatuses: ctx.itemStatuses,
    subGoals: ctx.subGoals,
    commands: ctx.commands,
    contractVerificationAvailable: ctx.contractVerificationAvailable,
    gateEnabled: ctx.gateEnabled === true,
    criteria: ctx.criteria ?? [],
  };
  const paths = promptedFieldPaths(facts)
    .filter((path) => path !== "execution_report.claims");
  if (paths.length === 0) return [];
  return [
    "Optional event fields — only when the event happened; examples/effects " +
      "are in `submission_guidance`:",
    ...paths.map((path) => `- ${GUIDE_BY_PATH.get(path)!.when} → \`${path}\``),
  ];
}

/** Render the minimal evaluation block appended to every prompt. The full
 *  field interface (when/example/effect) stays in `submission_guidance`; this
 *  block is self-sufficient for the core fields and the execution report. */
export function renderSelfEvalBlock(ctx: SelfEvalPromptContext): string {
  const base = {
    outcome: "partial",
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
  };
  const lines: string[] = [
    "### LoopForge Evaluation (Required)",
    "",
    "Base:",
    "```json",
    JSON.stringify(base),
    "```",
    `\`outcome\`: ${GUIDE_BY_PATH.get("outcome")!.when}`,
    "Execution report (when files changed or you claim items):",
    "```json",
    JSON.stringify({
      execution_report: {
        files_changed: fieldExample("execution_report.files_changed", reportCtx),
        claims: fieldExample("execution_report.claims", reportCtx) ?? [],
      },
    }),
    "```",
    `\`files_changed\`: ${fieldGuideDescription("execution_report.files_changed")}`,
  ];
  lines.push(...renderOptionalTriggers(ctx));
  lines.push(...renderContractGuidance(ctx));
  lines.push(...renderSubGoalGuidance(ctx));
  lines.push(
    "Never invent an id; use only ids rendered here or in `submission_guidance`.",
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
  maxRounds?: number;
  /** The task / current work item, when the caller can observe it. */
  task?: string;
  roundSnapshot?: {
    promptArtifact?: PromptArtifact;
    beforeEvidence?: unknown;
  } | null;
}

export interface GuidanceOptions {
  /** The history window the caller already uses: `derivationRounds` for a live
   *  prepare, `readOnlyRounds` for a read-only view. Never derive a second one. */
  rounds: ReadonlyArray<CommittedRoundView>;
  /** The operator objective's success criteria, resolved by the caller from
   *  the held acceptance or committed objective. Absent = unobservable; no
   *  criterion rows are rendered. */
  objective?: { success_criteria: ReadonlyArray<string> } | null;
  verificationFlags?: ReadonlyArray<VerificationFlag>;
  recovery?: {
    pending: boolean;
    redo_round: number;
    checkpoint_id: string;
    restore_verified: boolean;
    origin?: "agent" | "machine";
    reason?: string;
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
  // Never invent a prompt level. If no held artifact is observable, the
  // level is unknown; the prompt itself is derived from current facts.
  const level: "l0" | "l1" | "l2" | null =
    session.roundSnapshot?.promptArtifact?.level ?? null;

  const subGoals: ReadonlyArray<SubGoal> = deriveSubGoals({
    loopId: session.loopId,
    currentRound: session.currentRound,
    rounds: options.rounds,
  });
  const facts = deriveRoundFacts({
    rounds: options.rounds,
    currentRound: session.currentRound,
    inFlight: NO_IN_FLIGHT_ROUND,
    commands: commandsPolicy,
  });
  const activeContract = facts.activeContract;
  const itemStatuses = facts.itemStatuses;
  const criteria = options.objective
    ? deriveCriterionStatuses({
        rounds: options.rounds,
        currentRound: session.currentRound,
        objective: options.objective,
        criterionFacts: facts.criterionFacts,
      })
    : [];
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
  };
  const artifact = session.roundSnapshot?.promptArtifact;

  return {
    contract_requirement: (() => {
      const requirement = deriveContractRequirement({
        shouldContinue: true,
        blocked: false,
        proposalPresent: false,
        activeContract,
        closure: itemStatuses.closure,
        contractCapability: capability.contractVerificationAvailable,
        successorRoundAvailable:
          session.maxRounds === undefined || session.currentRound < session.maxRounds,
      });
      return {
        required_on_continue: requirement.required,
        successor_required_if_closed:
          activeContract !== null && capability.contractVerificationAvailable &&
          session.currentRound < (session.maxRounds ?? Number.POSITIVE_INFINITY),
        reason: requirement.reason === "active_contract_closed" ||
            requirement.reason === "active_contract_continues" ||
            requirement.reason === "no_contract_capability" ||
            requirement.reason === "no_successor_round"
          ? requirement.reason
          : "no_active_contract" as const,
        active_contract_id: activeContract?.id ?? null,
      };
    })(),
    active_contract: activeContract
      ? {
          id: activeContract.id,
          ...(activeContract.work_item ? { work_item: activeContract.work_item } : {}),
          scope: [...activeContract.scope],
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
    recovery: options.recovery ?? null,
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
