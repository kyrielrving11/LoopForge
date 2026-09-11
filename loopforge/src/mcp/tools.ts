/** LoopForge MCP — Tool definitions and handlers.
 *
 * 9 tools: start, next, status, stop, pause, resume, replay,
 *          gate_check, gate_resolve.
 * status is the unified inspection tool (view=session|loop|all|audit).
 * Each handler receives SessionManager + parsed input, returns the output object.
 */

import type { SessionManager, StartInput } from "./session.js";
import { validateCoreSelfEvaluation } from "../self-eval.js";
import { isRecord } from "../token-utils.js";
import { getPolicy, validateLoopId } from "../policy.js";
import { deriveEvidenceCapability } from "../evidence-provider.js";

// ═══════════════════════════════════════════════════════════════════════════
// Tool schemas (MCP JSON Schema format)
// ═══════════════════════════════════════════════════════════════════════════

const TOOL_BASE_SCHEMAS = [
  {
    name: "loopforge_start",
    description:
      "Start a new LoopForge loop session. Compiles the first-round prompt from the task description and returns it. Use this at the beginning of an autonomous multi-round coding loop.",
    inputSchema: {
      type: "object" as const,
      properties: {
        task: {
          type: "string" as const,
          description: "The task to accomplish across the loop. Be specific and actionable.",
        },
        loopId: {
          type: "string" as const,
          description: "Optional loop ID. Generated automatically if not provided.",
        },
        maxRounds: {
          type: "integer" as const,
          minimum: 1,
          description: "Maximum rounds before auto-stop. Default: 200 from policy.",
        },
        domain: {
          type: "string" as const,
          description: "Domain hint (e.g. 'solidity', 'react', 'rust') for state context.",
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
      },
      required: ["task"],
    },
  },
  {
    name: "loopforge_next",
    description:
      "Submit the output from the current round and advance to the next. Returns the next-round prompt, or null with a stopReason when the loop ends. A structured evaluation is required; output is optional supporting context.",
    inputSchema: {
      type: "object" as const,
      properties: {
        sessionId: {
          type: "string" as const,
          description: "Session ID returned by loopforge_start.",
        },
        roundId: {
          type: "string" as const,
          description: "The roundId from the most recent loopforge_start / loopforge_next / loopforge_resume / loopforge_status response. Anchors this submission to the exact round it reports on: a submission whose roundId no longer matches the current round (the round already committed) is not processed — the current held prompt is returned instead, so lost responses can be recovered without skipping or double-committing a round.",
        },
        output: {
          type: "string" as const,
          description: "Optional. The agent's full output from executing the current round's prompt. The structured evaluation is the authoritative report.",
        },
        evaluation: {
          type: "object" as const,
          description: "Required structured self-evaluation for this round. Free-text or embedded evaluation blocks are not accepted.",
          required: ["success", "output_summary", "should_continue", "constraint_violations"],
          properties: {
            success: {
              type: "boolean" as const,
              description: "true ONLY if all hard constraints met AND the task goal achieved.",
            },
            output_summary: {
              type: "string" as const,
              description: "Specific, actionable summary of what was DONE this round — not what was attempted.",
            },
            should_continue: {
              type: "boolean" as const,
              description: "false ONLY when the ENTIRE task is complete. Partial progress = true.",
            },
            constraint_violations: {
              type: "array" as const,
              items: { type: "string" as const },
              description: "Constraints the agent actually violated this round. Be honest.",
            },
            discovered_constraints: {
              type: "array" as const,
              items: { type: "string" as const },
              description: "Optional. New constraints discovered this round.",
            },
            objective_refinement: {
              type: "string" as const,
              description: "Optional. If this round deepened understanding of the task objective.",
            },
            emerged_subtasks: {
              type: "array" as const,
              items: { type: "string" as const },
              description:
                "Optional. Sub-problems that surfaced during execution. The only " +
                "sub-goal creation channel — sg-XXXXXXXX ID literals are rejected here.",
            },
            execution_report: {
              type: "object" as const,
              description: "Optional. Structured record of what actually happened this round.",
              properties: {
                files_changed: {
                  type: "array" as const,
                  items: { type: "string" as const },
                  description: "Files modified this round.",
                },
                tests_reported: {
                  type: "object" as const,
                  description: "Test results from this round.",
                  properties: {
                    passed: { type: "integer" as const, minimum: 0, description: "Number of passing tests." },
                    failed: { type: "integer" as const, minimum: 0, description: "Number of failing tests." },
                    skipped: { type: "integer" as const, minimum: 0, description: "Number of skipped tests." },
                  },
                },
                criterion_claims: {
                  type: "array" as const,
                  description: "v3.8: advisory claims about objective criteria. LENIENT — unknown or malformed ids are dropped with a warning, never a rejection.",
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
                  description: "Claims about items of the ACTIVE contract, cited by the rci-XXXXXXXX id the prompt rendered. LENIENT at declaration: an unknown/malformed id is reported as contract_invalid so you can correct the payload and resubmit the same roundId. A claim never verifies anything by itself — the runtime only marks an item verified when its bound commands are observed passing.",
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
                progress_estimate: {
                  type: "number" as const,
                  minimum: 0,
                  maximum: 1,
                  description: "Estimated progress toward task completion (0.0–1.0).",
                },
              },
            },
            retracted_constraints: {
              type: "array" as const,
              items: { type: "string" as const },
              description: "Optional. Constraints the agent now believes are wrong.",
            },
            revised_success_criteria: {
              type: "array" as const,
              description: "Optional. Success criteria that need reformulation.",
              items: {
                type: "object" as const,
                properties: {
                  old: { type: "string" as const, description: "Original criterion." },
                  new: { type: "string" as const, description: "Revised criterion." },
                },
              },
            },
            wrong_assumptions: {
              type: "array" as const,
              items: { type: "string" as const },
              description: "Optional. Assumptions from earlier rounds that were incorrect.",
            },
            worker_results: {
              type: "array" as const,
              description:
                "Optional. Results of sub-agent / Worker delegations this round. " +
                "Each entry must declare an outcome — the single reported fact. " +
                "Entries without a valid outcome are dropped by the runtime. " +
                "Omit or empty when nothing was delegated.",
              items: {
                type: "object" as const,
                properties: {
                  agentId: { type: "string" as const },
                  subAgentType: { type: "string" as const },
                  subTask: { type: "string" as const },
                  resultSummary: { type: "string" as const },
                  outcome: {
                    type: "string" as const,
                    enum: ["success", "partial", "failed"],
                  },
                  discoveredConstraints: {
                    type: "array" as const,
                    items: { type: "string" as const },
                  },
                },
                required: ["agentId", "subTask", "resultSummary", "outcome"],
              },
            },
            compression_checkpoint: {
              type: "boolean" as const,
              description: "Optional. Set true at subtask boundaries to trigger a full-state checkpoint (L2 prompt) that survives rolling-window eviction. The checkpoint label is carried into future prompts.",
            },
            checkpoint_label: {
              type: "string" as const,
              description: "Optional. Human-readable label for this checkpoint (e.g. 'core-functions-complete'). Only meaningful when compression_checkpoint is true.",
            },
            subgoal_updates: {
              type: "array" as const,
              maxItems: 20,
              description:
                "Optional. Explicit status transitions for EXISTING sub-goals. " +
                "Each entry references an ACTIVE sub-goal ID (sg-XXXXXXXX) from " +
                "the dashboard with a target status. Unknown IDs, done/canceled " +
                "(terminal) references, and illegal migrations are rejected " +
                "before the round advances. done/canceled items must never be " +
                "referenced again — re-open via a NEW emerged_subtasks item.",
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
            stop_reason: {
              type: "string" as const,
              enum: ["gave_up", "blocked", "needs_human_input"],
              description: "Optional. Why the agent is stopping. Only meaningful when should_continue=false and success=false. 'blocked' means work cannot proceed under current constraints.",
            },
            no_change_reason: {
              type: "string" as const,
              description: "Optional. Declared reason for claiming success with no machine-verifiable evidence (e.g. documentation-only round). Downgrades the success_without_verified_evidence check from error to info. Max 200 chars.",
            },
            outcome: {
              type: "string" as const,
              enum: ["success", "partial", "failed", "blocked"],
              description: "Optional. Tri-state outcome. When absent, derived from success (true→success, false→failed). 'partial' and 'blocked' must be declared explicitly. A declared non-success outcome suppresses the success-class checks even when success=true.",
            },
            blocker: {
              type: "string" as const,
              description: "Optional. Flat blocker description, required only when outcome=blocked. Also feeds the user/agent gate classification. Max 500 chars.",
            },
            gate_ids: {
              type: "array" as const,
              maxItems: 20,
              description:
                "Optional. gate_opened ids this round's work depended on (from " +
                "loopforge_gate_check). Enforced only when policy.gate.enabled: " +
                "an unapproved cited gate rejects the round.",
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
              description: "Optional. Claims that a PRIOR round satisfied a criterion. The runtime verifies them against the prior round's git evidence. Max 20 entries.",
            },
            prompt_requests: {
              type: "object" as const,
              description: "Optional. Information needs for the next round's prompt. Use when you know what context you'll need to succeed in the next round.",
              properties: {
                emphasize: {
                  type: "array" as const,
                  items: { type: "string" as const },
                  description: "Constraints, discoveries, or decisions that need emphasis in the next prompt. Matched by meaning — not exact text. Matched items appear in a 'Critical Context' section. Max 5 entries. Pure reordering — no token overhead.",
                },
                confusion_points: {
                  type: "array" as const,
                  items: { type: "string" as const },
                  description: "Things you're confused about. Rendered at the TOP of the next prompt before the objective. Max 3 entries, each ≤ 200 chars recommended. Be specific — 'I don't understand why milestone 3 is marked complete when phase 2 appears unfinished.'",
                },
              },
            },
            round_contract: {
              type: "object" as const,
              description: "Optional. Proposal for the NEXT round's contract (v3.8 item model). Declared here, it becomes the ACTIVE contract (rendered as the Current Task) only after this round commits. It closes when EVERY item is machine-verified (its bound commands observed passing, untampered, with the declared config), or when a round reports outcome=blocked. While it is open, restate it unchanged here — a different proposal is ignored. DECLARATION IS STRICT: an item with no bound command, one naming an unknown/disabled/non-after-capable command, a scope entry leaving the workspace, a malformed reference, or a count over the declared limits returns contract_invalid and the round may be retried with the same roundId.",
              properties: {
                work_item: {
                  type: "string" as const,
                  description: "Optional. Round focus, one line. Rendered as the active contract's Current Task first line. Max 200 chars.",
                },
                items: {
                  type: "array" as const,
                  description: "Required, at least one (max 20). Each item is a verification unit bound to evidence commands. The runtime derives a stable rci-XXXXXXXX id per item and renders it in the prompt — cite that id in execution_report.contract_item_claims.",
                  items: {
                    type: "object" as const,
                    properties: {
                      description: {
                        type: "string" as const,
                        description: "What must be true for this item. Max 200 chars.",
                      },
                      criterion_refs: {
                        type: "array" as const,
                        items: { type: "string" as const },
                        description: "Optional. cr-XXXXXXXX criterion ids this item is evidence for (free text allowed). Max 20.",
                      },
                      subgoal_refs: {
                        type: "array" as const,
                        items: { type: "string" as const },
                        description: "Optional. sg-XXXXXXXX sub-goals THIS ITEM is evidence for. Must name sub-goals that exist (or that this same submission creates via emerged_subtasks). Max 20 ids. A machine-verified item produces the derived verified-subgoal fact for exactly the ids it names here.",
                      },
                      verify_with: {
                        type: "array" as const,
                        items: { type: "string" as const },
                        description: "Required, at least one. Names of configured, enabled, after-capable evidence.commands (loop_policy.json) that verify this item. Unknown or disabled names are rejected.",
                      },
                    },
                    required: ["description", "verify_with"],
                    additionalProperties: false,
                  },
                },
                scope: {
                  type: "array" as const,
                  items: { type: "string" as const },
                  description: "Files/directories this round may touch (workspace-relative; './' and trailing slashes accepted; must stay inside the workspace). Out-of-scope git changes trigger round_scope_drift, which is a machine fact and is not waivable by explanation. Max 50 items.",
                },
              },
              required: ["items", "scope"],
            },
          },
        },
      },
      required: ["sessionId", "roundId", "evaluation"],
    },
  },
  {
    name: "loopforge_status",
    description:
      "Inspect loop state. view=session (default): session status, round identity, success trajectory and typed projection. view=loop: loop health (goal alignment, constraints, drift). view=all: summary of every persisted loop. view=audit: read-only end-of-loop verification audit (claims, gates, verdict, sequence integrity).",
    inputSchema: {
      type: "object" as const,
      properties: {
        sessionId: {
          type: "string" as const,
          description: "Session ID returned by loopforge_start (views session/audit).",
        },
        loopId: {
          type: "string" as const,
          description: "Loop ID (views loop/audit).",
        },
        view: {
          type: "string" as const,
          enum: ["session", "loop", "all", "audit", "explain"],
          description: "Which view to return. Defaults to session. explain (v3.8) is the read-only per-round \"why\" view over committed facts.",
        },
      },
      required: [],
    },
  },
  {
    name: "loopforge_stop",
    description:
      "Manually stop a loop session and return its final trajectory.",
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
      "Pause a running loop session. The loop suspends at the next round boundary and its state is persisted to vault. Paused loops can be resumed with loopforge_resume. Use this to interrupt a long-running loop without losing progress.",
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
      "Replay a completed or running loop as an auditable round timeline. " +
      "Pass sessionId for a live session, or loopId to replay straight from " +
      "the vault (works after a process restart, when no session is in " +
      "memory) — the timeline is derived from committed round documents.",
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
      },
      // v3.3.1: either identifier resolves the timeline; sessionId wins when
      // both are given (it also disambiguates re-used loopIds).
      required: [],
    },
  },
  {
    name: "loopforge_resume",
    description:
      "Resume a loop from vault state. Works for both: (a) running sessions that were interrupted by a process restart, and (b) paused sessions (via loopforge_pause). Returns the compiled prompt for the next round, or null with a stopReason if the loop is already complete.",
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
        sessionId: { type: "string" as const, description: "Session ID." },
        roundId: { type: "string" as const, description: "RoundId from the latest response." },
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
      required: ["sessionId", "roundId", "action"],
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
    error: { type: "object", additionalProperties: true, description: "v3.8 ToolError: { code, message, retryable, sessionId?, roundId?, details? }" },
    details: { type: "object", additionalProperties: true },
    sessionId: { type: "string" },
    round: { type: "number" },
    roundId: { type: ["string", "null"] },
    prompt: { type: ["string", "null"] },
    stopReason: { type: ["string", "null"] },
    stopDetail: { type: ["string", "null"], description: "Human-readable context for why the loop stopped. Provides facts without prescribing a specific agent action." },
    level: { type: ["string", "null"] },
    roundSuccess: { type: ["boolean", "null"] },
    enforcementAction: { enum: ["accept", "reject", "terminate", "backtrack"] },
    enforcementReason: { type: ["string", "null"] },
    warnings: { type: "array", items: { type: "string" } },
    projection: {
      type: "object",
      additionalProperties: true,
      description: "v2.12: Typed cognitive state projection (focus/todo/phase/delegation/handoff).",
    },
  },
  additionalProperties: true,
};

/** Declared structured-output contracts for every tool. The MCP server
 *  validates each handler's output against these before returning it —
 *  a mismatch is a contract bug, surfaced as a JSON-RPC error instead of
 *  silently shipping an output that violates the declared schema. */
export const TOOL_OUTPUT_SCHEMAS: Record<string, JsonSchema> = {
  loopforge_start: ADVANCE_OUTPUT_SCHEMA,
  loopforge_next: ADVANCE_OUTPUT_SCHEMA,
  loopforge_resume: ADVANCE_OUTPUT_SCHEMA,
  loopforge_status: {
    type: "object",
    properties: {
      ok: { type: "boolean", description: "v3.8: uniform result envelope — false means the error object describes a rejected call." },
      error: { type: "object", additionalProperties: true, description: "v3.8 ToolError: { code, message, retryable, sessionId?, roundId?, details? }" },
      sessionId: { type: "string" },
      loopId: { type: "string" },
      round: { type: "number" },
      roundId: { type: ["string", "null"] },
      maxRounds: { type: "number" },
      status: { enum: ["running", "stopped", "stalled", "paused"] },
      successTrajectory: { type: "array", items: { type: "boolean" } },
      lease: { type: ["object", "null"], additionalProperties: true },
      metrics: { type: "object", additionalProperties: true },
      // v3.5: the ACTIVE Round Contract governing the next round (derived
      // from committed rounds — null when the whole task is the Current
      // Task).
      activeContract: { type: ["object", "null"] },
    },
    additionalProperties: true,
  },
  loopforge_stop: {
    type: "object",
    properties: {
      ok: { type: "boolean", description: "v3.8: uniform result envelope — false means the error object describes a rejected call." },
      error: { type: "object", additionalProperties: true, description: "v3.8 ToolError: { code, message, retryable, sessionId?, roundId?, details? }" },
      success: { type: "boolean" },
      roundsCompleted: { type: "number" },
      successTrajectory: { type: "array", items: { type: "boolean" } },
    },
    additionalProperties: true,
  },
  loopforge_pause: {
    type: "object",
    properties: {
      ok: { type: "boolean", description: "v3.8: uniform result envelope — false means the error object describes a rejected call." },
      error: { type: "object", additionalProperties: true, description: "v3.8 ToolError: { code, message, retryable, sessionId?, roundId?, details? }" },
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
      error: { type: "object", additionalProperties: true, description: "v3.8 ToolError: { code, message, retryable, sessionId?, roundId?, details? }" },
      sessionId: { type: "string" },
      loopId: { type: "string" },
      timeline: { type: "array", items: { type: "object", additionalProperties: true } },
    },
    additionalProperties: true,
  },
  loopforge_gate_check: {
    type: "object",
    properties: {
      ok: { type: "boolean", description: "v3.8: uniform result envelope — false means the error object describes a rejected call." },
      error: { type: "object", additionalProperties: true, description: "v3.8 ToolError: { code, message, retryable, sessionId?, roundId?, details? }" },
      sessionId: { type: "string" },
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
      error: { type: "object", additionalProperties: true, description: "v3.8 ToolError: { code, message, retryable, sessionId?, roundId?, details? }" },
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

const CORE_EVALUATION_FIELDS = new Set([
  "success",
  "output_summary",
  "constraint_violations",
  "should_continue",
]);

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
      if (CORE_EVALUATION_FIELDS.has(field) || !isRecord(value)) return [field, value];
      return [field, typeof value.description === "string"
        ? { description: value.description }
        : {}];
    }),
  );
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
    required: ["sessionId", "roundId"],
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

export const TOOL_HANDLERS: Record<string, ToolHandler> = {
  async loopforge_start(mgr, input): Promise<Record<string, unknown>> {
    const startInput: StartInput = {
      task: String(input.task ?? ""),
      loopId: input.loopId as string | undefined,
      maxRounds: typeof input.maxRounds === "number" ? input.maxRounds : undefined,
      domain: input.domain as string | undefined,
      planSource: input.planSource as string | undefined,
      constraints: Array.isArray(input.constraints)
        ? (input.constraints as string[])
        : undefined,
    };

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
      return {
        error: "policy_invalid",
        errorMessage: `the runtime policy could not be loaded: ${(error as Error).message}`,
      };
    }
    // v2.14: a same-process duplicate loopId surfaces as a clean argument
    // error instead of a prompt-less "success" the client cannot act on.
    if (typeof result.stopReason === "string" &&
        result.stopReason.startsWith("loop_already_running:")) {
      return {
        error: "loop_already_running",
        errorMessage: result.stopDetail ?? "loop already running",
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
    const sessionId = String(input.sessionId ?? "");
    const output = String(input.output ?? "");
    const rawEval = input.evaluation as Record<string, unknown> | undefined;
    const roundId = input.roundId === undefined ? undefined : String(input.roundId);

    if (!sessionId) {
      return { error: "invalid_argument", errorMessage: "sessionId is required" };
    }
    // v3.0.1: every submission is anchored to the round it reports on. A
    // missing roundId would silently re-process a stale submission against a
    // later round — reject it here so the contract is enforced even when the
    // handler is invoked directly (bypassing schema validation).
    if (!roundId || !roundId.trim()) {
      return {
        error: "round_id_required",
        errorMessage: "roundId is required — pass the roundId from the most recent " +
          "loopforge_start / loopforge_next / loopforge_resume / loopforge_status response",
      };
    }

    // v3.8.1: the submission boundary belongs to the RUNTIME, not to this
    // transport. `mgr.advance` applies all of it — object shape, core fields,
    // subgoal_updates structure and references, and the strict Round Contract
    // declaration/claims boundary — before touching any state, and reports a
    // refusal through `submissionError`. This handler only maps that onto the
    // tool envelope, so a non-MCP caller gets exactly the same strictness.
    const result = await mgr.advance(sessionId, output, rawEval, roundId);

    if (result.submissionError) {
      return {
        error: result.submissionError.code,
        errorMessage: result.stopDetail ?? "the submission was rejected",
        details: result.submissionError.details,
        sessionId,
        roundId,
      };
    }

    // v2.12: Typed projection — runtime facts for the main agent, attached
    // on every accepted/continued round (not on errors).
    let projection: Record<string, unknown> | null = null;
    if (result.enforcementAction !== "reject" && result.enforcementAction !== "terminate" &&
        result.stopReason !== "session_not_found" && result.stopReason !== "stalled") {
      projection = mgr.getProjection(sessionId);
    }

    return projection ? { ...result, projection } : { ...result };
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

    if (!sessionId) {
      return {
        error: "invalid_argument",
        errorMessage: "sessionId is required for view=session",
      };
    }

    const session = mgr.get(sessionId);
    if (!session) {
      return {
        error: "session_not_found",
        errorMessage: `session not found: ${sessionId} (process restarted?) — pass loopId for view=audit/loop, or loopforge_resume`,
        sessionId,
      };
    }

    const metrics = session.engine.getMetrics();
    return {
      sessionId: session.sessionId,
      loopId: session.loopId,
      round: session.currentRound,
      roundId: session.roundSnapshot?.roundId ?? null,
      maxRounds: session.maxRounds,
      status: session.status,
      successTrajectory: session.successTrajectory,
      lease: mgr.getLeaseStatus(session.loopId),
      // v3.5: derived ACTIVE Round Contract (display-only — the compile and
      // verification gates derive the same value from the same committed
      // evals via the shared round-contract walker).
      activeContract: mgr.getActiveContract(sessionId),
      // v3.8: the ONE capability fact — the static half the compile hashes
      // (what verification is possible) plus the live half rendered from the
      // last baseline. `available` is provider-registry state: reported here
      // and by `doctor`, never hashed.
      capability: deriveEvidenceCapability(getPolicy(), session.evidenceBaseline ?? []),
      projection: mgr.getProjection(sessionId),
      metrics: {
        vaultWriteErrors: metrics.vaultWriteErrors,
        // v3.3.1: engine sessionStart was written but never read — surface it
        // so a status view shows how long this engine session has been alive
        // (observability design: the runtime is the loop's watchdog).
        startedAt: metrics.sessionStart,
        sessionAgeSeconds: Math.max(0, Math.floor((Date.now() - metrics.sessionStart) / 1000)),
        policy: mgr.getPolicyMetrics(session.loopId),
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

    const roundsCompleted = session.currentRound;
    const successTrajectory = [...session.successTrajectory];
    mgr.delete(sessionId);

    return { success: true, roundsCompleted, successTrajectory };
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

    // Live session first: it disambiguates re-used loopIds and the session
    // registry is the cheapest lookup.
    if (sessionId) {
      const session = mgr.get(sessionId);
      if (session) {
        const timeline = mgr.replayTimeline(sessionId) ?? [];
        return { sessionId, loopId: session.loopId, timeline };
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
    const timeline = mgr.replayByLoop(loopId);
    if (!timeline) {
      return {
        error: "state_unavailable",
        errorMessage: `no committed rounds found for loop "${loopId}"`,
      };
    }
    // sessionId omitted on the vault path (its output schema is string-only).
    return { ...(sessionId ? { sessionId } : {}), loopId, timeline };
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
    let result = await mgr.unpause(loopId);
    if (!result) {
      result = await mgr.resume(loopId);
    }
    if (!result) {
      return {
        error: "state_unavailable",
        errorMessage: `no saved session found for loop "${loopId}"`,
      };
    }

    return { ...result };
  },

  async loopforge_gate_check(mgr, input): Promise<Record<string, unknown>> {
    // v3.7.1: hidden when disabled — direct calls get a stable error.
    if (!getPolicy().gate.enabled) return { error: "gate_disabled" };
    const sessionId = String(input.sessionId ?? "");
    const roundId = String(input.roundId ?? "");
    const action = input.action as Record<string, unknown> | undefined;
    if (!sessionId) {
      return { error: "invalid_argument", errorMessage: "sessionId is required" };
    }
    if (!roundId) {
      return {
        error: "round_id_required",
        errorMessage: "roundId is required — pass the roundId from the latest response",
        sessionId,
      };
    }
    if (!action || !isRecord(action)) {
      return { error: "invalid_argument", errorMessage: "action is required", sessionId, roundId };
    }
    const descriptor: import("../protocol.js").GateActionDescriptor = {
      description: String(action.description ?? ""),
      scope: Array.isArray(action.scope)
        ? action.scope.filter((v): v is string => typeof v === "string")
        : [],
      effects: Array.isArray(action.effects)
        ? action.effects.filter((v): v is string => typeof v === "string")
            .filter((v): v is "workspace_write" | "production" | "credentials" |
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
        sessionId,
        roundId,
      };
    }
    return mgr.checkGate(sessionId, roundId, descriptor);
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
