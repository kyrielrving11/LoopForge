/** LoopForge MCP — Tool definitions and handlers.
 *
 * 10 tools: start, next, status, stop, pause, resume, replay,
 *           checkpoint, gate_check, gate_resolve.
 * status is the unified inspection tool (view=session|loop|all|audit|explain).
 * Each handler receives SessionManager + parsed input, returns the output object.
 */

import type { SessionManager, StartInput } from "./session.js";
import {
  MANUAL_STOP_REASON,
  StartCriteriaError,
  type AdvanceResult,
} from "./round-lifecycle.js";
import { ProjectionCoverageError } from "../prompt-coverage.js";
import {
  LegacyHistoryError,
  LoopExistsError,
  OperatorAcceptanceConflictError,
  StartFailureError,
} from "../errors.js";
import { validateCoreSelfEvaluation } from "../self-eval.js";
import { isRecord } from "../token-utils.js";
import { getPolicy, validateLoopId } from "../policy.js";
import { deriveEvidenceCapability } from "../evidence-provider.js";
import {
  CORE_SELF_EVALUATION_FIELDS,
  fieldGuideDescription,
} from "../submission-guidance.js";
import { LOST_HANDLE_ROUTING } from "../recovery-guidance.js";
import { SessionLeaseConflictError } from "../storage.js";
import { ReplayWindowError } from "../replay.js";
import type { ReplayPage } from "../replay.js";

// ═══════════════════════════════════════════════════════════════════════════
// Tool schemas (MCP JSON Schema format)
// ═══════════════════════════════════════════════════════════════════════════

/** v4.0.0: the ONE held-round anchor. The object is closed so a client cannot
 *  smuggle separate anchor fields alongside it. */
const SUBMISSION_HANDLE_SCHEMA = {
  type: "object" as const,
  description:
    "The submissionHandle object returned with the held prompt. Copy it " +
    "verbatim; never edit, reconstruct, or derive it. A stale handle never " +
    "submits work. " + LOST_HANDLE_ROUTING,
  properties: {
    sessionId: {
      type: "string" as const,
      description: "The owning session identity.",
    },
    roundId: {
      type: "string" as const,
      description: "The stable logical round identity.",
    },
    transactionId: {
      type: "string" as const,
      description: "The exact held transaction attempt.",
    },
  },
  required: ["sessionId", "roundId", "transactionId"],
  additionalProperties: false,
};

/** Output form: absent/null on terminal or non-held results, exact shape when
 *  present. */
const SUBMISSION_HANDLE_OUTPUT_SCHEMA = {
  ...SUBMISSION_HANDLE_SCHEMA,
  type: ["object", "null"] as const,
};

/** The closed argument set for `loopforge_start`.
 *
 *  The handler's unknown-argument guard reads this list; `schema-sync.test`
 *  asserts that the advertised tool schema exposes exactly the same keys. A
 *  field removed from the protocol (for example `domain` in 4.0.1) must not
 *  survive in only one of them: the schema says what clients may send, and
 *  the guard makes a stale caller fail loudly instead of silently dropping
 *  the field. */
export const START_INPUT_KEYS = [
  "task",
  "loopId",
  "maxRounds",
  "planSource",
  "constraints",
  "criteria",
] as const;

const TOOL_BASE_SCHEMAS = [
  {
    name: "loopforge_start",
    description:
      "Start a new LoopForge loop for a NEW objective. Compiles the first-round prompt from the task description and returns it. Use loopforge_status/loopforge_resume instead for an objective that already has a loopId.",
    inputSchema: {
      type: "object" as const,
      properties: {
        task: {
          type: "string" as const,
          description: "The task to accomplish across the loop. Be specific and actionable.",
        },
        loopId: {
          type: "string" as const,
          description:
            "Optional durable loop ID. Generated when omitted and returned " +
            "with the first prompt. Keep it: loopforge_resume and every " +
            "loopforge_status view use loopId after a restart, and a live " +
            "session can re-anchor a lost handle with loopId.",
        },
        maxRounds: {
          type: "integer" as const,
          minimum: 1,
          description: "Maximum rounds before auto-stop. Default: 200 from policy.",
        },
        planSource: {
          type: "string" as const,
          description: "Plan reference for constraint extraction (e.g. 'docs/plan.md').",
        },
        constraints: {
          type: "array" as const,
          items: { type: "string" as const },
          description: "Hard constraints to enforce across all rounds.",
        },
        criteria: {
          type: "array" as const,
          items: { type: "string" as const },
          description:
            "Initial success criteria — the operator's acceptance surface. Phrase " +
            "each as an observable outcome; implementation detail belongs in " +
            "sub-goals or task text. Each becomes a stable cr-XXXXXXXX anchor " +
            "rendered in every prompt and usable by contract items. Omit to keep " +
            "the default criterion.",
        },
      },
      required: ["task"],
    },
  },
  {
    name: "loopforge_next",
    description:
      "Submit one evaluation for the held attempt. Returns the next prompt (with its derived contextMode/contextReason and a strategy label), or null with stopReason/stopDetail when the loop ends. The submission may be accepted, rejected (same logical round, attempt+1, new handle), replayed, or answered with a rollback directive. A structured evaluation is required; output is optional supporting context.",
    inputSchema: {
      type: "object" as const,
      properties: {
        submissionHandle: SUBMISSION_HANDLE_SCHEMA,
        output: {
          type: "string" as const,
          description: "Optional. The agent's full output from executing the current round's prompt. The structured evaluation is the authoritative report.",
        },
        recovery: {
          type: "object" as const,
          description:
            "v3.9.7: Agent-initiated recovery. Abandon the current branch and " +
            "restore a visible workspace checkpoint (the held before-image, a " +
            "mid-round savepoint, or a committed round's before-image). " +
            "Mutually exclusive with evaluation. LoopForge records the directive, " +
            "executes the restore, verifies the full Git boundary, then issues " +
            "the redo prompt. It never chooses a target or judges the reason.",
          properties: {
            target_checkpoint_id: {
              type: "string" as const,
              pattern: "^ck-[a-f0-9]{24}$",
              description: "Checkpoint id (ck-<24 hex>) from the held prompt, a loopforge_checkpoint result, or a committed round's before-image.",
            },
            reason: {
              type: "string" as const,
              minLength: 1,
              maxLength: 500,
              description: "The Agent's reason for abandoning the branch. Recorded verbatim; never judged.",
            },
          },
          required: ["target_checkpoint_id", "reason"],
          additionalProperties: false,
        },
        evaluation: {
          type: "object" as const,
          description: "Structured self-evaluation for this round. Required when recovery is absent. Free-text or embedded evaluation blocks are not accepted.",
          required: ["success", "output_summary", "should_continue", "constraint_violations"],
          properties: {
            success: {
              type: "boolean" as const,
              description: fieldGuideDescription("success"),
            },
            output_summary: {
              type: "string" as const,
              description: fieldGuideDescription("output_summary"),
            },
            should_continue: {
              type: "boolean" as const,
              description: fieldGuideDescription("should_continue"),
            },
            constraint_violations: {
              type: "array" as const,
              items: { type: "string" as const },
              description: fieldGuideDescription("constraint_violations"),
            },
            discovered_constraints: {
              type: "array" as const,
              items: { type: "string" as const },
              description: fieldGuideDescription("discovered_constraints"),
            },
            emerged_subtasks: {
              type: "array" as const,
              items: { type: "string" as const },
              description: fieldGuideDescription("emerged_subtasks"),
            },
            execution_report: {
              type: "object" as const,
              description: "Optional. Structured record of what actually happened this round.",
              properties: {
                files_changed: {
                  type: "array" as const,
                  items: { type: "string" as const },
                  description: fieldGuideDescription("execution_report.files_changed"),
                },
                tests_reported: {
                  type: "object" as const,
                  description: fieldGuideDescription("execution_report.tests_reported"),
                  properties: {
                    passed: { type: "integer" as const, minimum: 0, description: "Number of passing tests." },
                    failed: { type: "integer" as const, minimum: 0, description: "Number of failing tests." },
                    skipped: { type: "integer" as const, minimum: 0, description: "Number of skipped tests." },
                  },
                },
                criterion_claims: {
                  type: "array" as const,
                  description: fieldGuideDescription("execution_report.criterion_claims"),
                  items: {
                    type: "object" as const,
                    properties: {
                      criterion_id: { type: "string" as const, description: "cr-XXXXXXXX criterion id (free text allowed)." },
                      outcome: { type: "string" as const, enum: ["met", "remaining"] },
                    },
                    required: ["criterion_id", "outcome"],
                    additionalProperties: false,
                  },
                },
                contract_item_claims: {
                  type: "array" as const,
                  description: fieldGuideDescription("execution_report.contract_item_claims"),
                  items: {
                    type: "object" as const,
                    properties: {
                      item_id: { type: "string" as const, description: "rci-XXXXXXXX id of an item of the ACTIVE contract." },
                      outcome: { type: "string" as const, enum: ["met", "remaining"], description: "Your claim for that item this round." },
                    },
                    required: ["item_id", "outcome"],
                    additionalProperties: false,
                  },
                },
              },
            },
            retracted_constraints: {
              type: "array" as const,
              items: { type: "string" as const },
              description: fieldGuideDescription("retracted_constraints"),
            },
            wrong_assumptions: {
              type: "array" as const,
              items: { type: "string" as const },
              description: fieldGuideDescription("wrong_assumptions"),
            },
            open_questions: {
              type: "array" as const,
              maxItems: 3,
              items: { type: "string" as const, maxLength: 300 },
              description: fieldGuideDescription("open_questions"),
            },
            resolved_open_question_ids: {
              type: "array" as const,
              maxItems: 20,
              items: {
                type: "string" as const,
                pattern: "^oq-[a-f0-9]{12}$",
              },
              description: fieldGuideDescription("resolved_open_question_ids"),
            },
            worker_results: {
              type: "array" as const,
              description: fieldGuideDescription("worker_results"),
              items: {
                type: "object" as const,
                properties: {
                  agentId: { type: "string" as const },
                  subTask: { type: "string" as const },
                  resultSummary: { type: "string" as const },
                  outcome: {
                    type: "string" as const,
                    enum: ["success", "partial", "failed"],
                  },
                },
                required: ["agentId", "subTask", "resultSummary", "outcome"],
              },
            },
            subtask_boundary: {
              type: "boolean" as const,
              description: fieldGuideDescription("subtask_boundary"),
            },
            subtask_boundary_label: {
              type: "string" as const,
              description: fieldGuideDescription("subtask_boundary_label"),
            },
            subgoal_updates: {
              type: "array" as const,
              maxItems: 20,
              description: fieldGuideDescription("subgoal_updates"),
              items: {
                type: "object" as const,
                properties: {
                  id: {
                    type: "string" as const,
                    description: "Active sub-goal ID (sg-XXXXXXXX).",
                  },
                  status: {
                    type: "string" as const,
                    enum: ["in_progress", "done", "blocked", "canceled"],
                  },
                  note: {
                    type: "string" as const,
                    description: "Optional free-text note (≤ 300 chars).",
                  },
                },
                required: ["id", "status"],
              },
            },
            agent_stop_reason: {
              type: "string" as const,
              enum: ["gave_up", "blocked", "needs_human_input"],
              description: fieldGuideDescription("agent_stop_reason"),
            },
            no_change_reason: {
              type: "string" as const,
              description: fieldGuideDescription("no_change_reason"),
            },
            outcome: {
              type: "string" as const,
              enum: ["success", "partial", "failed", "blocked"],
              description: fieldGuideDescription("outcome"),
            },
            blocker: {
              type: "string" as const,
              description: fieldGuideDescription("blocker"),
            },
            gate_ids: {
              type: "array" as const,
              maxItems: 20,
              description: fieldGuideDescription("gate_ids"),
              items: { type: "string" as const },
            },
            retroactiveClaims: {
              type: "array" as const,
              items: {
                type: "object" as const,
                properties: {
                  round: { type: "integer" as const, minimum: 1 },
                  claim: { type: "string" as const },
                },
                required: ["round", "claim"],
                additionalProperties: false,
              },
              description: fieldGuideDescription("retroactiveClaims"),
            },
            round_contract: {
              type: "object" as const,
              description: fieldGuideDescription("round_contract"),
              properties: {
                work_item: {
                  type: "string" as const,
                  minLength: 1,
                  maxLength: 200,
                  description:
                    "Required. The bounded deliverable this contract slice " +
                    "produces — an outcome, not an activity. Rendered as the " +
                    "Current Task heading. 1–200 chars.",
                },
                items: {
                  type: "array" as const,
                  minItems: 1,
                  maxItems: 20,
                  description:
                    "Required, at least one (max 20). Each item is an " +
                    "acceptance condition for the deliverable, bound to its own " +
                    "evidence commands. The runtime derives a stable " +
                    "rci-XXXXXXXX id per item and renders it in the prompt — " +
                    "cite that id in execution_report.contract_item_claims.",
                  items: {
                    type: "object" as const,
                    properties: {
                      description: {
                        type: "string" as const,
                        minLength: 1,
                        maxLength: 200,
                        description:
                          "What must be true for this acceptance condition. " +
                          "1–200 chars.",
                      },
                      criterion_refs: {
                        type: "array" as const,
                        maxItems: 20,
                        items: { type: "string" as const },
                        description: "Optional. Real cr-XXXXXXXX ids of ACTIVE criteria rendered in this prompt. Free text and unknown ids are rejected. Max 20.",
                      },
                      verify_with: {
                        type: "array" as const,
                        minItems: 1,
                        maxItems: 20,
                        items: { type: "string" as const },
                        description:
                          "Required, at least one. Names of configured, " +
                          "enabled, after-capable evidence.commands " +
                          "(loop_policy.json) that check this acceptance " +
                          "condition. Unknown or disabled names are rejected. A " +
                          "command may be shared by multiple conditions.",
                      },
                    },
                    required: ["description", "verify_with"],
                    additionalProperties: false,
                  },
                },
                scope: {
                  type: "array" as const,
                  maxItems: 50,
                  items: { type: "string" as const },
                  description:
                    "Optional, report-only. The files/directories you intend " +
                    "this slice to touch. Omission and [] both mean no declared " +
                    "intent. It is NOT enforced: out-of-scope changes are " +
                    "reported as an info fact and never reject the round. Max " +
                    "50 items.",
                },
              },
              required: ["work_item", "items"],
              additionalProperties: false,
            },
            contract_transition: {
              type: "object" as const,
              description: fieldGuideDescription("contract_transition"),
              properties: {
                kind: {
                  type: "string" as const,
                  const: "supersede",
                  description: "Only \"supersede\" is supported.",
                },
                contract_id: {
                  type: "string" as const,
                  pattern: "^rc-[a-f0-9]{8}$",
                  description:
                    "The rc-XXXXXXXX id of the ACTIVE contract rendered in " +
                    "this prompt. A stale/other id is rejected.",
                },
                reason: {
                  type: "string" as const,
                  maxLength: 500,
                  description:
                    "Optional Agent report, recorded verbatim for audit only.",
                },
              },
              required: ["kind", "contract_id"],
              additionalProperties: false,
            },
          },
        },
      },
      required: ["submissionHandle"],
    },
  },
  {
    name: "loopforge_checkpoint",
    description:
      "v3.9.7: Create an explicit mid-round workspace checkpoint (savepoint). " +
      "The call itself is the Agent's decision that this state is worth " +
      "restoring to. It creates no round, no commit and no progress; the " +
      "checkpoint becomes a visible recovery target only through the held " +
      "transaction's ref list. Requires the same submissionHandle as " +
      "loopforge_next; the handle is unchanged after a successful checkpoint.",
    inputSchema: {
      type: "object" as const,
      properties: {
        submissionHandle: SUBMISSION_HANDLE_SCHEMA,
      },
      required: ["submissionHandle"],
      additionalProperties: false,
    },
  },
  {
    name: "loopforge_status",
    description:
      "Read-only inspection. view=session (default): live session status, " +
      "round identity, the current held submissionHandle when one exists, " +
      "success trajectory, active contract, current guidance and the latest " +
      "committed receipt. It never returns the held prompt; a paused or " +
      "stalled session must resume before submitting. view=loop: committed " +
      "round counts, unverified-item rounds and policy metrics. view=all: " +
      "summary of every persisted loop. view=audit: end-of-loop verification " +
      "audit. view=explain: per-round \"why\" view over committed facts.",
    inputSchema: {
      type: "object" as const,
      properties: {
        sessionId: {
          type: "string" as const,
          description:
            "Live session ID returned by loopforge_start or loopforge_resume. " +
            "Resolvable only in the current process; after a restart use loopId. " +
            "view=session returns the current held submissionHandle.",
        },
        loopId: {
          type: "string" as const,
          description:
            "Durable loop ID. Required for views loop/audit/explain; also " +
            "accepted for view=session, which resolves it to the live session " +
            "and returns its current held submissionHandle.",
        },
        view: {
          type: "string" as const,
          enum: ["session", "loop", "all", "audit", "explain"],
          description: "Which view to return. Defaults to session. explain (v3.8) is the read-only per-round \"why\" view over committed facts.",
        },
        round: {
          type: "number" as const,
          description: "view=explain only: return that single round's \"why\" view. Omit for the whole timeline.",
        },
      },
      required: [],
    },
  },
  {
    name: "loopforge_stop",
    description:
      "Manually stop a loop session and return its final trajectory. The " +
      "returned `success` is tool-call success, not a task-success verdict.",
    inputSchema: {
      type: "object" as const,
      properties: {
        sessionId: {
          type: "string" as const,
          description: "Session ID to stop.",
        },
      },
      required: ["sessionId"],
    },
  },
  {
    name: "loopforge_pause",
    description:
      "Pause a running loop session: it immediately stops accepting submissions (an in-flight advance may still finish) and its state is persisted to vault. Paused loops can be resumed with loopforge_resume. Use this to interrupt a long-running loop without losing progress.",
    inputSchema: {
      type: "object" as const,
      properties: {
        sessionId: {
          type: "string" as const,
          description: "Session ID to pause.",
        },
      },
      required: ["sessionId"],
    },
  },
  {
    name: "loopforge_replay",
    description:
      "Replay committed rounds as an auditable timeline. Pass sessionId for a " +
      "live session, or loopId to replay straight from the vault (works after " +
      "a process restart). Returns the last 10 committed rounds by default; " +
      "pass start/end for an explicit window (at most 50 rounds). Each round " +
      "carries its context boundary, committed report, assumptions, open " +
      "questions, blocker and contract redirect. Read-only projection.",
    inputSchema: {
      type: "object" as const,
      properties: {
        sessionId: {
          type: "string" as const,
          description: "Session ID to replay (live sessions).",
        },
        loopId: {
          type: "string" as const,
          description: "Loop ID to replay from the vault — works without a " +
            "live session, e.g. after a restart.",
        },
        start: {
          type: "integer" as const,
          minimum: 1,
          description: "First round of the explicit window (inclusive).",
        },
        end: {
          type: "integer" as const,
          minimum: 1,
          description: "Last round of the explicit window (inclusive).",
        },
      },
      // v3.3.1: either identifier resolves the timeline; sessionId wins when
      // both are given (it also disambiguates re-used loopIds).
      required: [],
    },
  },
  {
    name: "loopforge_resume",
    description:
      "Resume a loop from vault state. Requires the durable loopId returned by " +
      "loopforge_start (not sessionId). Use this when the held prompt was lost, " +
      "no live session exists, or the session is paused/stalled; if only the " +
      "submissionHandle was lost while the prompt is still in context, prefer " +
      "loopforge_status. Returns the held prompt and its current " +
      "submissionHandle, or a newly compiled prompt when none is held. A " +
      "terminal loop returns no prompt, the committed stopReason when one was " +
      "committed, and/or sessionStatus (paused/stopped/stalled); a stopped " +
      "loop without a committed stop round reports sessionStatus only.",
    inputSchema: {
      type: "object" as const,
      properties: {
        loopId: {
          type: "string" as const,
          description: "Loop ID to resume. Must have a saved session_state entry from a previous start/run.",
        },
      },
      required: ["loopId"],
    },
  },
  {
    name: "loopforge_gate_check",
    description:
      "v3.7.1: Structured preflight for a high-risk action. Classifies a " +
      "GateActionDescriptor as user_required (needs human authorization — " +
      "persists a gate_opened record you must cite via evaluation.gate_ids " +
      "once approved) or agent_allowed (no record, no human needed). " +
      "Never executes the action, never approves it, never advances a round. " +
      "Hidden when policy.gate.enabled=false (direct calls return gate_disabled).",
    inputSchema: {
      type: "object" as const,
      properties: {
        submissionHandle: SUBMISSION_HANDLE_SCHEMA,
        action: {
          type: "object" as const,
          description: "The action the agent plans to perform.",
          properties: {
            description: {
              type: "string" as const,
              description: "What the action does, e.g. 'Deploy to production'.",
            },
            scope: {
              type: "array" as const,
              items: { type: "string" as const },
              description: "Files / systems / services the action touches.",
            },
            effects: {
              type: "array" as const,
              items: {
                type: "string" as const,
                enum: [
                  "workspace_write", "production", "credentials", "data_migration",
                  "public_api", "publish", "payment", "external_communication",
                  "network",
                ],
              },
            },
            reversibility: {
              type: "string" as const,
              enum: ["reversible", "recoverable", "irreversible", "unknown"],
            },
            authorization: {
              type: "string" as const,
              enum: ["agent_allowed", "user_required", "unknown"],
            },
          },
          required: ["description", "scope", "effects", "reversibility", "authorization"],
        },
      },
      required: ["submissionHandle", "action"],
    },
  },
  {
    name: "loopforge_gate_resolve",
    description:
      "v3.7.1: Record a human decision for a previously opened user gate. " +
      "The caller is still the Agent — LoopForge cannot machine-verify that a " +
      "human is present; the decision is recorded and audited, and the gate's " +
      "approval binds to the canonical action (any change expires it). " +
      "Agent gates are resolved by submitting evidence, never here. " +
      "Hidden when policy.gate.enabled=false (direct calls return gate_disabled).",
    inputSchema: {
      type: "object" as const,
      properties: {
        sessionId: {
          type: "string" as const,
          description: "Session ID whose loop owns the gate.",
        },
        gateId: {
          type: "string" as const,
          description: "Gate id returned by loopforge_gate_check.",
        },
        approved: {
          type: "boolean" as const,
          description: "Whether the human authorizes the action.",
        },
        note: {
          type: "string" as const,
          description: "Optional human note recorded with the decision.",
        },
      },
      required: ["sessionId", "gateId", "approved"],
    },
  },
];

type JsonSchema = Record<string, unknown>;

const ADVANCE_OUTPUT_SCHEMA: JsonSchema = {
  type: "object",
  properties: {
    ok: { type: "boolean", description: "v3.8: uniform result envelope — false means the error object describes a rejected call." },
    error: { type: "object", additionalProperties: true, description: "v3.8 ToolError: { code, message, retryable, sessionId?, submissionHandle?, details? }" },
    details: { type: "object", additionalProperties: true },
    sessionId: { type: "string" },
    loopId: {
      type: "string",
      description:
        "Durable loop identity. Returned with every held prompt so a restarted " +
        "agent can call loopforge_resume without reconstructing IDs.",
    },
    round: { type: "number" },
    submissionHandle: SUBMISSION_HANDLE_OUTPUT_SCHEMA,
    prompt: { type: ["string", "null"] },
    stopReason: {
      type: ["string", "null"],
      enum: [
        "completed", "failed", "blocked", "cancelled", "max_rounds",
        "stalled", "enforcement_terminated", "paused", "incomplete", null,
      ],
      description:
        "v4.0.4: LoopForge's terminal reason. Never a session status, a tool " +
        "error or the Agent's declared agent_stop_reason.",
    },
    sessionStatus: {
      enum: ["running", "stopped", "paused", "stalled"],
      description:
        "v4.0.4: the live session status when the result is not a committed " +
        "loop terminal reason.",
    },
    stopDetail: { type: ["string", "null"], description: "Human-readable context for why the loop stopped. Three fact blocks: Agent report, LoopForge decision, Machine evidence. Provides facts without prescribing a specific agent action." },
    level: { type: ["string", "null"] },
    contextMode: {
      enum: ["fresh_invocation", "same_round_retry"],
      description:
        "The context boundary the returned prompt was compiled under. " +
        "Prompt density does not determine it: same_round_retry continues the " +
        "invocation below the repeated same-check rejection threshold; " +
        "fresh_invocation starts clean context at rejection escalation. " +
        "Projected from the PromptArtifact.",
    },
    contextReason: {
      enum: ["first_round", "next_round", "recovery_redo", "enforcement_retry", "rejection_escalation"],
      description: "v4.0.2: why the context boundary was selected.",
    },
    agentSuccessClaim: { type: ["boolean", "null"] },
    agentOutcome: {
      type: ["string", "null"],
      enum: ["success", "partial", "failed", "blocked", null],
      description: "v4.0.3: the effective Agent-declared outcome.",
    },
    agentStopReason: {
      type: ["string", "null"],
      enum: ["gave_up", "blocked", "needs_human_input", null],
      description:
        "v4.0.4: the Agent's declared stop reason of the round this result " +
        "is about. An Agent report, never a loop terminal reason.",
    },
    agentShouldContinue: {
      type: ["boolean", "null"],
      description: "v4.0.4: the Agent's declared should_continue for that same round.",
    },
    checkpoints: {
      type: ["array", "null"],
      items: { type: "object", additionalProperties: true },
      description: "v3.9.7: the held transaction's checkpoint refs (before-image + explicit mid savepoints).",
    },
    beforeCheckpointError: {
      type: ["object", "null"],
      additionalProperties: true,
      description: "v3.9.7: explicit machine fact when the automatic before-image could not be captured.",
    },
    enforcementAction: { enum: ["accept", "reject", "terminate", "backtrack", "recovery"] },
    enforcementReason: { type: ["string", "null"] },
    recovery: {
      type: ["object", "null"],
      additionalProperties: true,
      description:
        "v3.9.7: committed rollback directive facts and the verified restore that produced the redo prompt.",
    },
    evidencePosture: {
      type: ["object", "null"],
      additionalProperties: true,
      description:
        "v4.0.3: the ONE evidence posture of the round this result is about " +
        "(status, machineBackedSuccess, verificationConfigured, workspace, " +
        "files reconciliation, providers, commands, contract snapshot, " +
        "findings and omitted counts). Accepted rounds carry the persisted " +
        "posture; a rejection carries its transient copy.",
    },
    submission_guidance: {
      type: ["object", "null"],
      additionalProperties: true,
      description:
        "v3.9.1: current-fact submission guidance (real contract item ids, " +
        "active sub-goal ids, usable commands, applicable fields). Derived, " +
        "never persisted; terminal results with no prompt omit it.",
    },
    submission_receipt: {
      type: ["object", "null"],
      additionalProperties: true,
      description:
        "v3.9.1: what this submission did — saved/not-applied reports, " +
        "derived-state effects, and machine verification, kept separate. " +
        "Returned by loopforge_next only.",
    },
    warnings: { type: "array", items: { type: "string" } },
  },
  additionalProperties: true,
};

/** Declared structured-output contracts for every tool. The MCP server
 *  validates each handler's output against these before returning it —
 *  a mismatch is a contract bug, surfaced as a JSON-RPC error instead of
 *  silently shipping an output that violates the declared schema. */
const CHECKPOINT_OUTPUT_SCHEMA: JsonSchema = {
  type: "object",
  properties: {
    ok: { type: "boolean" },
    error: { type: "object", additionalProperties: true, description: "v3.8 ToolError: { code, message, retryable, sessionId?, submissionHandle?, details? }" },
    sessionId: { type: "string" },
    submissionHandle: SUBMISSION_HANDLE_SCHEMA,
    checkpointId: { type: "string" },
    round: { type: "number" },
    role: { const: "mid" },
    redoRound: { type: "number" },
    createdAt: { type: "number" },
    head: { type: ["string", "null"] },
    fileCount: { type: "number" },
    contentCount: { type: "number" },
    contentHash: { type: "string" },
  },
  additionalProperties: true,
};

export const TOOL_OUTPUT_SCHEMAS: Record<string, JsonSchema> = {
  loopforge_start: ADVANCE_OUTPUT_SCHEMA,
  loopforge_next: ADVANCE_OUTPUT_SCHEMA,
  loopforge_resume: ADVANCE_OUTPUT_SCHEMA,
  loopforge_checkpoint: CHECKPOINT_OUTPUT_SCHEMA,
  loopforge_status: {
    type: "object",
    properties: {
      ok: { type: "boolean", description: "v3.8: uniform result envelope — false means the error object describes a rejected call." },
      error: { type: "object", additionalProperties: true, description: "v3.8 ToolError: { code, message, retryable, sessionId?, submissionHandle?, details? }" },
      sessionId: { type: "string" },
      loopId: { type: "string" },
      round: { type: "number" },
      submissionHandle: SUBMISSION_HANDLE_OUTPUT_SCHEMA,
      checkpoints: { type: ["array", "null"], items: { type: "object", additionalProperties: true } },
      beforeCheckpointError: { type: ["object", "null"], additionalProperties: true },
      maxRounds: { type: "number" },
      status: { enum: ["running", "stopped", "stalled", "paused"] },
      // v4.0.4: a stopped loop's committed terminal facts are readable from
      // view=session without calling resume.
      loopStopReason: {
        type: ["string", "null"],
        enum: [
          "completed", "failed", "blocked", "cancelled", "max_rounds",
          "stalled", "enforcement_terminated", "paused", "incomplete", null,
        ],
      },
      agentStopReason: {
        type: ["string", "null"],
        enum: ["gave_up", "blocked", "needs_human_input", null],
      },
      agentShouldContinue: { type: ["boolean", "null"] },
      stopDetail: { type: ["string", "null"] },
      machineBackedSuccessTrajectory: { type: "array", items: { type: "boolean" } },
      evidencePosture: { type: ["object", "null"], additionalProperties: true },
      machineBackedSuccess: { type: ["boolean", "null"] },
      agentSuccessClaim: { type: ["boolean", "null"] },
      agentOutcome: { type: ["string", "null"] },
      lease: { type: ["object", "null"], additionalProperties: true },
      metrics: { type: "object", additionalProperties: true },
      // v3.5: the ACTIVE Round Contract governing the next round (derived
      // from committed rounds — null when the whole task is the Current
      // Task).
      activeContract: { type: ["object", "null"] },
      // v3.9.1: same current-fact guidance start/next/resume return, plus the
      // latest committed submission's receipt.
      submission_guidance: { type: ["object", "null"], additionalProperties: true },
      last_submission: { type: ["object", "null"], additionalProperties: true },
    },
    additionalProperties: true,
  },
  loopforge_stop: {
    type: "object",
    properties: {
      ok: { type: "boolean", description: "v3.8: uniform result envelope — false means the error object describes a rejected call." },
      error: { type: "object", additionalProperties: true, description: "v3.8 ToolError: { code, message, retryable, sessionId?, submissionHandle?, details? }" },
      success: { type: "boolean", description: "Tool-call success, not a task-success verdict." },
      sessionId: { type: "string" },
      loopId: { type: "string" },
      roundsCompleted: { type: "number", description: "Deprecated alias of roundCursor (the session round cursor, not a committed count)." },
      roundCursor: { type: "number", description: "The session's current round cursor." },
      sessionStatus: { const: "stopped" },
      loopStopReason: { const: MANUAL_STOP_REASON, description: "The manual-cancel terminal reason sent to the terminal sink; not a committed round fact." },
      machineBackedSuccessRounds: { type: "number", description: "Machine-backed successful rounds (same committed-view source as the trajectory)." },
      machineBackedSuccessTrajectory: { type: "array", items: { type: "boolean" } },
    },
    additionalProperties: true,
  },
  loopforge_pause: {
    type: "object",
    properties: {
      ok: { type: "boolean", description: "v3.8: uniform result envelope — false means the error object describes a rejected call." },
      error: { type: "object", additionalProperties: true, description: "v3.8 ToolError: { code, message, retryable, sessionId?, submissionHandle?, details? }" },
      sessionId: { type: "string" },
      round: { type: "number" },
      status: { type: "string" },
    },
    additionalProperties: true,
  },
  loopforge_replay: {
    type: "object",
    properties: {
      ok: { type: "boolean", description: "v3.8: uniform result envelope — false means the error object describes a rejected call." },
      error: { type: "object", additionalProperties: true, description: "v3.8 ToolError: { code, message, retryable, sessionId?, submissionHandle?, details? }" },
      sessionId: { type: "string" },
      loopId: { type: "string" },
      timeline: { type: "array", items: { type: "object", additionalProperties: true } },
      window: {
        type: "object",
        additionalProperties: true,
        description:
          "v4.0.2: the returned round window: { start, end, totalRounds, " +
          "hasBefore, hasAfter }.",
      },
      legacyRounds: {
        type: "array",
        items: { type: "object", additionalProperties: true },
        description:
          "v3.9.1: rounds whose persisted envelope version is unsupported. " +
          "They are NOT history; the list makes the loss visible.",
      },
    },
    additionalProperties: true,
  },
  loopforge_gate_check: {
    type: "object",
    properties: {
      ok: { type: "boolean", description: "v3.8: uniform result envelope — false means the error object describes a rejected call." },
      error: { type: "object", additionalProperties: true, description: "v3.8 ToolError: { code, message, retryable, sessionId?, submissionHandle?, details? }" },
      submissionHandle: SUBMISSION_HANDLE_SCHEMA,
      gateId: { type: "string" },
      risk: { type: "string", enum: ["low", "high", "unknown"] },
      decision: { type: "string", enum: ["agent_allowed", "user_required"] },
      reasonCodes: { type: "array", items: { type: "string" } },
      blockedScope: { type: "array", items: { type: "string" } },
      allowedBeforeApproval: { type: "array", items: { type: "string" } },
      requiredEvidence: { type: "array", items: { type: "string" } },
      approvalQuestion: { type: "string" },
    },
    additionalProperties: true,
  },
  loopforge_gate_resolve: {
    type: "object",
    properties: {
      ok: { type: "boolean", description: "v3.8: uniform result envelope — false means the error object describes a rejected call." },
      error: { type: "object", additionalProperties: true, description: "v3.8 ToolError: { code, message, retryable, sessionId?, submissionHandle?, details? }" },
      sessionId: { type: "string" },
      loopId: { type: "string" },
      gateId: { type: "string" },
      approved: { type: "boolean" },
    },
    additionalProperties: true,
  },
};

function closeObjectSchemas(schema: JsonSchema): JsonSchema {
  const result: JsonSchema = { ...schema };
  if (result.type === "object") {
    result.additionalProperties = false;
    if (isRecord(result.properties)) {
      result.properties = Object.fromEntries(
        Object.entries(result.properties).map(([key, value]) => [
          key,
          isRecord(value) ? closeObjectSchemas(value) : value,
        ]),
      );
    }
  }
  if (result.type === "array" && isRecord(result.items)) {
    result.items = closeObjectSchemas(result.items);
  }
  return result;
}


/** Keep the four authoritative fields schema-strict while leaving optional
 * reporting fields available for buildSelfEvaluation's lossy normalization.
 * Their descriptions remain in tools/list, but malformed optional values do
 * not become JSON-RPC argument failures before the runtime can ignore them. */
function prepareInputSchema(name: string, schema: JsonSchema): JsonSchema {
  const result = closeObjectSchemas(schema);
  if (name !== "loopforge_next" || !isRecord(result.properties)) return result;
  const evaluation = result.properties.evaluation;
  if (!isRecord(evaluation) || !isRecord(evaluation.properties)) return result;
  evaluation.properties = Object.fromEntries(
    Object.entries(evaluation.properties).map(([field, value]) => {
      if (CORE_SELF_EVALUATION_FIELDS.has(field) || !isRecord(value)) return [field, value];
      return [field, typeof value.description === "string"
        ? { description: value.description }
        : {}];
    }),
  );
  // v3.9.1: unknown evaluation keys must reach the runtime normalizer so it
  // can diagnose and drop them (e.g. a retired progress_estimate) instead of
  // failing as a JSON-RPC argument error. The runtime boundary remains the
  // authority; the four core fields above stay strict.
  evaluation.additionalProperties = true;
  return result;
}

/** MCP tool contracts include strict input and structured output schemas. */
export const TOOL_SCHEMAS = TOOL_BASE_SCHEMAS.map((schema) => ({
  ...schema,
  inputSchema: prepareInputSchema(schema.name, schema.inputSchema),
  outputSchema: TOOL_OUTPUT_SCHEMAS[schema.name] ?? {
    type: "object",
    additionalProperties: true,
  },
}));

export class ToolInputValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ToolInputValidationError";
  }
}

function typeMatches(value: unknown, type: string | undefined): boolean {
  switch (type) {
    case "object": return isRecord(value);
    case "array": return Array.isArray(value);
    case "string": return typeof value === "string";
    case "boolean": return typeof value === "boolean";
    case "number": return typeof value === "number" && Number.isFinite(value);
    case "integer": return typeof value === "number" && Number.isInteger(value);
    case "null": return value === null;
    default: return true; // undeclared type — no constraint
  }
}

function validateSchema(value: unknown, schema: JsonSchema, path: string): void {
  // v2.14: an explicitly-undefined optional field is the same as absent —
  // output objects carry `key: undefined` after spreads of optional fields.
  if (value === undefined) return;
  const types = Array.isArray(schema.type) ? schema.type : [schema.type];
  if (!types.some((type) => typeMatches(value, type))) {
    throw new ToolInputValidationError(
      `${path} must be ${types.join(" or ")}`,
    );
  }
  if (types.some((type) => type === "object") && isRecord(value)) {
    const properties = isRecord(schema.properties) ? schema.properties : {};
    const required = Array.isArray(schema.required)
      ? schema.required.filter((item): item is string => typeof item === "string")
      : [];
    for (const key of required) {
      if (!(key in value)) {
        throw new ToolInputValidationError(`${path}.${key} is required`);
      }
    }
    if (schema.additionalProperties === false) {
      for (const key of Object.keys(value)) {
        if (!(key in properties)) {
          throw new ToolInputValidationError(`${path}.${key} is not allowed`);
        }
      }
    }
    for (const [key, child] of Object.entries(properties)) {
      if (key in value && isRecord(child)) {
        validateSchema(value[key], child, `${path}.${key}`);
      }
    }
    return;
  }
  if (types.some((type) => type === "array") && Array.isArray(value)) {
    if (isRecord(schema.items)) {
      value.forEach((item, index) =>
        validateSchema(item, schema.items as JsonSchema, `${path}[${index}]`));
    }
    return;
  }
  if (types.some((type) => type === "string") && typeof value === "string") {
    // Enforce declared enums — the schemas advertise them, so validation
    // must too (v2.12: view/gateText enums were previously unchecked).
    if (Array.isArray(schema.enum) && !schema.enum.includes(value)) {
      throw new ToolInputValidationError(
        `${path} must be one of: ${schema.enum.join(", ")}`,
      );
    }
    return;
  }
  if ((types.some((type) => type === "number") ||
       types.some((type) => type === "integer")) &&
      typeof value === "number") {
    if (typeof schema.minimum === "number" && value < schema.minimum) {
      throw new ToolInputValidationError(`${path} must be >= ${schema.minimum}`);
    }
    if (typeof schema.maximum === "number" && value > schema.maximum) {
      throw new ToolInputValidationError(`${path} must be <= ${schema.maximum}`);
    }
  }
}

export function validateToolInput(
  name: string,
  input: Record<string, unknown>,
): void {
  const contract = TOOL_SCHEMAS.find((schema) => schema.name === name);
  if (!contract) throw new ToolInputValidationError(`Unknown tool: ${name}`);
  validateSchema(input, contract.inputSchema, "arguments");
}

/** Validate a server dispatch without turning a malformed evaluation into a
 * JSON-RPC transport error. The advertised schema stays strict so clients can
 * construct valid calls; the runtime envelope validates every outer argument,
 * then lets loopforge_next return its retryable evaluation_invalid payload for
 * core evaluation mistakes. Once the core is valid, the full schema still
 * rejects unknown fields and other contract violations. */
export function validateToolDispatchInput(
  name: string,
  input: Record<string, unknown>,
): void {
  if (name !== "loopforge_next") {
    validateToolInput(name, input);
    return;
  }
  const contract = TOOL_SCHEMAS.find((schema) => schema.name === name);
  if (!contract) throw new ToolInputValidationError(`Unknown tool: ${name}`);
  const properties = isRecord(contract.inputSchema.properties)
    ? contract.inputSchema.properties
    : {};
  validateSchema(input, {
    ...contract.inputSchema,
    required: ["submissionHandle"],
    properties: { ...properties, evaluation: {} },
  }, "arguments");

  if (!isRecord(input.evaluation)) return;
  const validation = validateCoreSelfEvaluation(input.evaluation);
  if (validation.missing.length > 0 || validation.invalid.length > 0) return;
  validateSchema(input, contract.inputSchema, "arguments");
}

/** Validate a handler's output against the tool's declared output schema.
 *  v2.14: the schemas were advertised in tools/list but never enforced —
 *  a mismatched output silently violated the declared contract. Throws
 *  ToolInputValidationError on mismatch. */
export function validateToolOutput(
  name: string,
  output: Record<string, unknown>,
): void {
  const schema = TOOL_OUTPUT_SCHEMAS[name];
  if (!schema) return;
  validateSchema(output, schema, `output.${name}`);
}

// ═══════════════════════════════════════════════════════════════════════════
// Handler registry
// ═══════════════════════════════════════════════════════════════════════════

export type ToolHandler = (mgr: SessionManager, input: Record<string, unknown>) => Promise<Record<string, unknown>>;

/** v3.8: capability warnings for the current policy, merged with the compile's
 *  own warnings. Derived through the SAME function `RoundDriver.prepare()`
 *  uses, so the start/resume banner and the prepared round cannot tell two
 *  different stories about what the runtime can observe. Never persisted. */
function capabilityWarningList(existing?: string[]): string[] {
  return [...new Set([
    ...(existing ?? []),
    ...deriveEvidenceCapability(getPolicy()).warnings,
  ])];
}

/** v3.9.4: the stable envelope for a prompt-projection code defect. */
function projectionErrorResult(error: unknown): Record<string, unknown> | null {
  if (error instanceof ProjectionCoverageError) {
    return {
      error: "projection_incomplete",
      errorMessage: error.message,
      details: { coverage: error.coverage },
    };
  }
  return null;
}

/** Stable state-integrity errors. They are never retryable with the same
 *  payload: the loop data or the operator surface must be repaired first. */
function stateErrorResult(error: unknown): Record<string, unknown> | null {
  if (error instanceof LegacyHistoryError) {
    return {
      error: error.code,
      errorMessage: error.message,
      details: { loopId: error.loopId, rounds: error.rounds },
    };
  }
  if (error instanceof OperatorAcceptanceConflictError) {
    return {
      error: error.code,
      errorMessage: error.message,
      details: { loopId: error.loopId },
    };
  }
  return null;
}

export const TOOL_HANDLERS: Record<string, ToolHandler> = {
  async loopforge_start(mgr, input): Promise<Record<string, unknown>> {
    // A removed or misspelled start argument must not disappear silently: the
    // schema is permissive about extra top-level keys, and the handler used to
    // rebuild StartInput from a whitelist. Without this guard a stale manual
    // (for example one still naming `domain`) produces a successful start with
    // part of the caller's intent ignored.
    const unknownStartArgs = Object.keys(input).filter(
      (key) => !(START_INPUT_KEYS as readonly string[]).includes(key),
    );
    if (unknownStartArgs.length > 0) {
      const retired = unknownStartArgs.includes("domain")
        ? " `domain` was removed in 4.0.1."
        : "";
      return {
        error: "invalid_argument",
        errorMessage:
          `unknown loopforge_start argument(s): ${unknownStartArgs.join(", ")}.` +
          `${retired} Accepted: ${START_INPUT_KEYS.join(", ")}.`,
        details: {
          unknown: unknownStartArgs,
          accepted: [...START_INPUT_KEYS],
        },
      };
    }

    const startInput: StartInput = {
      task: String(input.task ?? ""),
      loopId: input.loopId as string | undefined,
      maxRounds: typeof input.maxRounds === "number" ? input.maxRounds : undefined,
      planSource: input.planSource as string | undefined,
      constraints: Array.isArray(input.constraints)
        ? (input.constraints as string[])
        : undefined,
      criteria: Array.isArray(input.criteria)
        ? (input.criteria as string[])
        : undefined,
    };

    if (input.criteria !== undefined && !Array.isArray(input.criteria)) {
      return {
        error: "invalid_argument",
        errorMessage: "criteria must be an array of non-empty strings",
      };
    }

    if (!startInput.task.trim()) {
      return {
        error: "invalid_argument",
        errorMessage: "task is required and must be non-empty",
      };
    }

    // v2.14: entry-point validation — a bad maxRounds previously passed
    // through and stopped the loop on the first round; an invalid loopId
    // exploded later as an internal storage error instead of a clean
    // argument error.
    if (startInput.maxRounds !== undefined &&
        (!Number.isInteger(startInput.maxRounds) || startInput.maxRounds < 1)) {
      return {
        error: "invalid_argument",
        errorMessage: "maxRounds must be a positive integer",
      };
    }
    if (startInput.loopId !== undefined) {
      try {
        validateLoopId(startInput.loopId);
      } catch (error) {
        return {
          error: "invalid_argument",
          errorMessage: `invalid loopId: ${(error as Error).message}`,
        };
      }
    }

    // A malformed loop_policy.json is a configuration defect, not a bad
    // argument — it must not escape as an opaque JSON-RPC internal error.
    let result: Awaited<ReturnType<SessionManager["create"]>>;
    try {
      result = await mgr.create(startInput);
    } catch (error) {
      if (error instanceof StartCriteriaError) {
        return {
          error: "invalid_argument",
          errorMessage: error.message,
        };
      }
      const projectionFailure = projectionErrorResult(error);
      if (projectionFailure) return projectionFailure;
      const stateFailure = stateErrorResult(error);
      if (stateFailure) return stateFailure;
      if (error instanceof LoopExistsError) {
        return {
          error: error.code,
          errorMessage: error.message,
          details: { loopId: error.loopId, reason: error.reason },
        };
      }
      if (error instanceof StartFailureError) {
        return {
          error: error.code,
          errorMessage: error.message,
          details: { retry: "call loopforge_start again" },
        };
      }
      if (error instanceof SessionLeaseConflictError) {
        return {
          error: "lease_conflict",
          errorMessage: `loop "${error.loopId}" is owned by another running LoopForge process`,
        };
      }
      return {
        error: "policy_invalid",
        errorMessage: `the runtime policy could not be loaded: ${(error as Error).message}`,
      };
    }
    // v3.8: the static capability warning — a loop with no provider or no
    // enabled command can still run; its success claims are recorded as
    // insufficient instead of verified, and the agent is told so up front.
    const capabilityWarnings = capabilityWarningList(result.warnings);
    return capabilityWarnings.length > 0
      ? { ...result, warnings: capabilityWarnings }
      : { ...result };
  },

  async loopforge_next(mgr, input): Promise<Record<string, unknown>> {
    const output = String(input.output ?? "");
    const rawEval = input.evaluation as Record<string, unknown> | undefined;
    const rawRecovery = input.recovery as Record<string, unknown> | undefined;
    const handle = input.submissionHandle;

    if (rawRecovery !== undefined && rawEval !== undefined) {
      return {
        error: "recovery_invalid",
        errorMessage: "evaluation and recovery are mutually exclusive",
      };
    }

    // v4.0.0: the handle is the only identity. The runtime validates its
    // shape, resolves the session, checks the exact held attempt, then runs
    // the payload boundary — all before its queue/lease heartbeat. This
    // handler only maps the refusal onto the tool envelope.
    let result: Awaited<ReturnType<SessionManager["advance"]>>;
    try {
      result = rawRecovery !== undefined
        ? await mgr.recover(handle, rawRecovery)
        : await mgr.advance(handle, output, rawEval);
    } catch (error) {
      const projectionFailure = projectionErrorResult(error);
      if (projectionFailure) return projectionFailure;
      const stateFailure = stateErrorResult(error);
      if (stateFailure) return stateFailure;
      throw error;
    }

    const loopId = result.sessionId
      ? mgr.get(result.sessionId)?.loopId
      : undefined;

    if (result.submissionError) {
      return {
        error: result.submissionError.code,
        errorMessage: result.stopDetail ??
          (rawRecovery !== undefined
            ? "the recovery request was rejected"
            : "the submission was rejected"),
        details: result.submissionError.details,
        ...(result.sessionId ? { sessionId: result.sessionId } : {}),
        ...(loopId ? { loopId } : {}),
        ...(result.submissionHandle ? { submissionHandle: result.submissionHandle } : {}),
      };
    }

    return { ...result, ...(loopId ? { loopId } : {}) };
  },

  async loopforge_checkpoint(mgr, input): Promise<Record<string, unknown>> {
    const result = await mgr.checkpoint(input.submissionHandle);
    if (result.error) {
      return {
        error: String(result.error),
        errorMessage: String(result.errorMessage ?? "the checkpoint was rejected"),
        details: result.details,
        ...(typeof result.sessionId === "string" ? { sessionId: result.sessionId } : {}),
        ...(isRecord(result.submissionHandle)
          ? { submissionHandle: result.submissionHandle }
          : {}),
      };
    }
    return { ok: true, ...result };
  },

  async loopforge_status(mgr, input): Promise<Record<string, unknown>> {
    const view = input.view === "loop" || input.view === "all" ||
        input.view === "audit" || input.view === "explain"
      ? input.view
      : "session";
    const sessionId = String(input.sessionId ?? "");
    const loopId = String(input.loopId ?? "");

    // v2.12: view=all — every persisted loop (formerly loopforge_list).
    if (view === "all") {
      return { sessions: mgr.list() };
    }

    // v2.12: view=audit — read-only verification audit.
    if (view === "audit") {
      if (!loopId) {
        return { error: "invalid_argument", errorMessage: "loopId is required for view=audit" };
      }
      const audit = mgr.getAudit(loopId);
      if (!audit) {
        return {
          error: "state_unavailable",
          errorMessage: `no audit data found for loop "${loopId}"`,
          sessionId,
        };
      }
      return audit;
    }

    // v3.8: view=explain — the read-only per-round "why" view.
    if (view === "explain") {
      if (!loopId) {
        return { error: "invalid_argument", errorMessage: "loopId is required for view=explain" };
      }
      const roundValue = input.round;
      const round = typeof roundValue === "number" && Number.isInteger(roundValue) && roundValue >= 1
        ? roundValue
        : undefined;
      return mgr.getExplain(loopId, round);
    }

    // v2.12: view=loop — loop health (formerly loopforge_health).
    if (view === "loop") {
      if (!loopId) {
        return { error: "invalid_argument", errorMessage: "loopId is required for view=loop" };
      }
      const health = mgr.getHealth(loopId);
      return health ?? {
        error: "state_unavailable",
        errorMessage: `no health data for loop "${loopId}"`,
      };
    }

    if (!sessionId && !loopId) {
      return {
        error: "invalid_argument",
        errorMessage: "sessionId or loopId is required for view=session",
      };
    }

    // sessionId is a live-process key; loopId is the durable identity. Prefer
    // a live sessionId, then fall back to loopId so a model that kept only the
    // durable key can still read session state in the same process. A stale
    // sessionId after a restart resolves through loopId when both are present.
    const session = (sessionId ? mgr.get(sessionId) : undefined) ??
      (loopId ? mgr.getByLoopId(loopId) : undefined);
    if (!session) {
      // v4.0.4: a persisted STOPPED loop has no live session, but its
      // committed terminal facts are still readable. This is a projection of
      // committed history — no lease, no session save, no resume side effect.
      // A running/paused/stalled loop with no live session still goes through
      // resume; "no live session" is never treated as "stopped".
      if (loopId) {
        let stopped: AdvanceResult | null = null;
        try {
          stopped = mgr.getStoppedLoopSummary(loopId);
        } catch (error) {
          const stateFailure = stateErrorResult(error);
          if (stateFailure) return stateFailure;
          throw error;
        }
        if (stopped) {
          return {
            ok: true,
            loopId,
            round: stopped.round,
            status: stopped.sessionStatus ?? "stopped",
            loopStopReason: stopped.stopReason ?? null,
            agentStopReason: stopped.agentStopReason ?? null,
            agentShouldContinue: stopped.agentShouldContinue ?? null,
            stopDetail: stopped.stopDetail ?? null,
            last_submission: stopped.submission_receipt ?? null,
          };
        }
      }
      return {
        error: "session_not_found",
        errorMessage: sessionId
          ? `session not found: ${sessionId} (process restarted?) — call ` +
            `loopforge_status with view="all" to find the loopId; if the ` +
            `held prompt is still in context, call loopforge_status with ` +
            `that loopId to fetch the current handle; otherwise call ` +
            `loopforge_resume with it`
          : `no live session for loop "${loopId}" — call loopforge_resume with this loopId`,
        ...(sessionId ? { sessionId } : {}),
        ...(loopId ? { loopId } : {}),
        details: {
          next: "loopforge_resume",
          ...(loopId ? { loopId } : {}),
        },
      };
    }

    // Every live-session-derived projection must use the resolved session's
    // identity. The caller's raw sessionId is empty on a loopId-only query and
    // may be stale when the loopId fallback resolved the session; using it here
    // silently nulled the handle/contract/guidance and forced a full resume.
    const liveSessionId = session.sessionId;
    const policyMetricsView = mgr.getPolicyMetrics(session.loopId);
    // v4.0.3: a live held prompt has no result yet; the last committed
    // receipt is the correct current machine posture then.
    const lastReceipt = mgr.getLastSubmissionReceiptByLoopId(session.loopId);
    const posture = session.roundSnapshot?.result?.evidencePosture ??
      lastReceipt?.verification.evidence_posture ??
      null;
    return {
      sessionId: liveSessionId,
      loopId: session.loopId,
      round: session.currentRound,
      submissionHandle: mgr.getSubmissionHandle(liveSessionId),
      checkpoints: session.roundSnapshot
        ? [
            ...(session.roundSnapshot.beforeCheckpoint
              ? [session.roundSnapshot.beforeCheckpoint]
              : []),
            ...(session.roundSnapshot.checkpoints ?? []),
          ]
        : [],
      beforeCheckpointError: session.roundSnapshot?.beforeCheckpointError ?? null,
      maxRounds: session.maxRounds,
      status: session.status,
      evidencePosture: posture,
      // v4.0.4: no committed/held posture is null (unknown), not false.
      machineBackedSuccess: posture?.machineBackedSuccess ?? null,
      agentSuccessClaim: session.roundSnapshot?.result?.agentSuccessClaim ??
        lastReceipt?.agent_success_claim ?? null,
      agentOutcome: session.roundSnapshot?.result?.agentOutcome ??
        lastReceipt?.agent_outcome ?? null,
      machineBackedSuccessTrajectory: mgr.getMachineBackedSuccessTrajectory(session.loopId),
      lease: mgr.getLeaseStatus(session.loopId),
      // v3.5: derived ACTIVE Round Contract (display-only — the compile and
      // verification gates derive the same value from the same committed
      // evals via the shared round-contract walker).
      activeContract: mgr.getActiveContract(liveSessionId),
      // v3.9.1: current-fact submission guidance for the held round. Same
      // derivation as start/next/resume; read-only and never persisted.
      submission_guidance: mgr.getSubmissionGuidance(liveSessionId),
      last_submission: lastReceipt,
      last_rollback: mgr.replayRollbacks(session.loopId).at(-1) ?? null,
      // v3.8: the ONE capability fact — the static half the compile hashes
      // (what verification is possible) plus the live half rendered from the
      // last baseline. `available` is provider-registry state: reported here
      // and by `doctor`, never hashed.
      capability: deriveEvidenceCapability(
        getPolicy(),
        session.roundSnapshot?.beforeEvidence ?? [],
      ),
      metrics: {
        // The vault write counters live in the shared policy metrics now;
        // the engine no longer owns a second copy.
        vaultWriteErrors: policyMetricsView.vaultWriteErrors,
        startedAt: session.createdAt,
        sessionAgeSeconds: Math.max(0, Math.floor((Date.now() - session.createdAt) / 1000)),
        policy: policyMetricsView,
      },
    };
  },

  async loopforge_stop(mgr, input): Promise<Record<string, unknown>> {
    const sessionId = String(input.sessionId ?? "");
    if (!sessionId) {
      return { error: "invalid_argument", errorMessage: "sessionId is required" };
    }

    const session = mgr.get(sessionId);
    if (!session) {
      return {
        error: "session_not_found",
        errorMessage: `session not found: ${sessionId}`,
        sessionId,
      };
    }

    const loopId = session.loopId;
    const roundCursor = session.currentRound;
    const roundsCompleted = roundCursor;
    const machineBackedSuccessTrajectory = mgr.getMachineBackedSuccessTrajectory(loopId);
    mgr.delete(sessionId);

    // v4.0.4: make the stop response self-describing. `cancelled` is the
    // terminal reason the terminal sink just received; it is NOT persisted as
    // a committed round fact, so resume/status still report "no committed
    // terminal reason" after a restart. `success` remains tool-call success.
    return {
      ok: true,
      success: true,
      sessionId,
      loopId,
      roundsCompleted,
      roundCursor,
      sessionStatus: "stopped",
      loopStopReason: MANUAL_STOP_REASON,
      machineBackedSuccessRounds: machineBackedSuccessTrajectory.length,
      machineBackedSuccessTrajectory,
    };
  },

  async loopforge_pause(mgr, input): Promise<Record<string, unknown>> {
    const sessionId = String(input.sessionId ?? "");
    if (!sessionId) {
      return { error: "invalid_argument", errorMessage: "sessionId is required" };
    }
    const result = mgr.pause(sessionId);
    return { ...result };
  },

  async loopforge_replay(mgr, input): Promise<Record<string, unknown>> {
    const sessionId = String(input.sessionId ?? "");
    const loopId = String(input.loopId ?? "");
    if (!sessionId && !loopId) {
      return {
        error: "invalid_argument",
        errorMessage: "sessionId or loopId is required — pass loopId to replay a loop " +
          "after a restart (no live session)",
      };
    }

    // v4.0.2: an explicit window is validated at the tool boundary. The
    // backend owns the rule; the boundary only converts the type.
    const windowOptions: { start?: number; end?: number } = {};
    for (const name of ["start", "end"] as const) {
      const value = input[name];
      if (value === undefined) continue;
      if (typeof value !== "number" || !Number.isInteger(value) || value < 1) {
        return {
          error: "invalid_argument",
          errorMessage: `${name} must be a positive integer`,
        };
      }
      windowOptions[name] = value;
    }

    const pageFor = (
      resolvePage: () => ReplayPage,
    ): ReplayPage | { error: string; errorMessage: string } => {
      try {
        return resolvePage();
      } catch (error) {
        if (error instanceof ReplayWindowError) {
          return { error: "invalid_argument", errorMessage: error.message };
        }
        throw error;
      }
    };

    // Live session first: it disambiguates re-used loopIds and the session
    // registry is the cheapest lookup.
    if (sessionId) {
      const session = mgr.get(sessionId);
      if (session) {
        const page = pageFor(() => mgr.replayPage(sessionId, windowOptions)!);
        if ("error" in page) return page;
        return {
          sessionId,
          loopId: session.loopId,
          timeline: page.timeline,
          window: page.window,
          rollbacks: mgr.replayRollbacks(session.loopId),
          legacyRounds: mgr.replayLegacyRounds(session.loopId),
        };
      }
      // v3.3.1: session not in memory (restart). Fall through to the vault
      // path when a loopId was also provided; otherwise say so plainly.
      if (!loopId) {
        return {
          error: "session_not_found",
          errorMessage: `session not found: ${sessionId} (process restarted?) — ` +
            "pass loopId to replay from the vault",
          sessionId,
        };
      }
    }

    // Vault-direct replay — the timeline lives in the committed round
    // documents, not in the session registry.
    const page = pageFor(() => mgr.replayPageByLoop(loopId, windowOptions));
    if ("error" in page) return page;
    if (page.window.totalRounds === 0 && page.timeline.length === 0) {
      return {
        error: "state_unavailable",
        errorMessage: `no committed rounds found for loop "${loopId}"`,
      };
    }
    // sessionId omitted on the vault path (its output schema is string-only).
    return {
      ...(sessionId ? { sessionId } : {}),
      loopId,
      timeline: page.timeline,
      window: page.window,
      rollbacks: mgr.replayRollbacks(loopId),
      legacyRounds: mgr.replayLegacyRounds(loopId),
    };
  },

  async loopforge_resume(mgr, input): Promise<Record<string, unknown>> {
    const loopId = String(input.loopId ?? "");
    if (!loopId) {
      return { error: "invalid_argument", errorMessage: "loopId is required" };
    }
    try {
      validateLoopId(loopId);
    } catch (error) {
      return {
        error: "invalid_argument",
        errorMessage: `invalid loopId: ${(error as Error).message}`,
      };
    }

    // Paused recovery must run first so the persisted status is atomically
    // changed back to running before a prompt is returned.
    let result: Awaited<ReturnType<SessionManager["unpause"]>>;
    try {
      result = await mgr.unpause(loopId);
      if (!result) {
        result = await mgr.resume(loopId);
      }
    } catch (error) {
      const projectionFailure = projectionErrorResult(error);
      if (projectionFailure) return projectionFailure;
      const stateFailure = stateErrorResult(error);
      if (stateFailure) return stateFailure;
      throw error;
    }
    if (!result) {
      return {
        error: "state_unavailable",
        errorMessage: `no saved session found for loop "${loopId}"`,
        loopId,
      };
    }

    return { ...result, loopId };
  },

  async loopforge_gate_check(mgr, input): Promise<Record<string, unknown>> {
    // v3.7.1: hidden when disabled — direct calls get a stable error.
    if (!getPolicy().gate.enabled) return { error: "gate_disabled" };
    const action = input.action as Record<string, unknown> | undefined;
    if (!action || !isRecord(action)) {
      return { error: "invalid_argument", errorMessage: "action is required" };
    }
    const descriptor: import("../protocol.js").GateActionDescriptor = {
      description: String(action.description ?? ""),
      scope: Array.isArray(action.scope)
        ? action.scope.filter((v): v is string => typeof v === "string")
        : [],
      effects: Array.isArray(action.effects)
        ? action.effects.filter((v): v is string => typeof v === "string")
            .filter((_v): _v is "workspace_write" | "production" | "credentials" |
              "data_migration" | "public_api" | "publish" | "payment" |
              "external_communication" | "network" => true)
        : [],
      reversibility: (["reversible", "recoverable", "irreversible", "unknown"]
        .includes(String(action.reversibility))
        ? String(action.reversibility)
        : "unknown") as import("../protocol.js").GateActionDescriptor["reversibility"],
      authorization: (["agent_allowed", "user_required", "unknown"]
        .includes(String(action.authorization))
        ? String(action.authorization)
        : "unknown") as import("../protocol.js").GateActionDescriptor["authorization"],
    };
    if (!descriptor.description.trim()) {
      return {
        error: "invalid_argument",
        errorMessage: "action.description is required",
      };
    }
    return mgr.checkGate(input.submissionHandle, descriptor);
  },

  async loopforge_gate_resolve(mgr, input): Promise<Record<string, unknown>> {
    // v3.7.1: hidden when disabled — direct calls get a stable error.
    if (!getPolicy().gate.enabled) return { error: "gate_disabled" };
    return mgr.resolveGate(
      String(input.sessionId ?? ""),
      String(input.gateId ?? ""),
      input.approved === true,
      input.note === undefined ? undefined : String(input.note),
    );
  },
};
