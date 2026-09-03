/** LoopForge MCP — Tool definitions and handlers.
 *
 * 9 tools: start, next, status, stop, pause, resume, replay,
 *          gate_check, gate_resolve.
 * status is the unified inspection tool (view=session|loop|all|audit).
 * Each handler receives SessionManager + parsed input, returns the output object.
 */

import type { SessionManager, StartInput } from "./session.js";
import { buildSelfEvaluation } from "../engine.js";
import { collectSelfEvalGaps } from "../self-eval.js";
import { isRecord } from "../token-utils.js";
import { validateLoopId } from "../policy.js";

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
          description: "Maximum rounds before auto-stop. Default: 20 from policy.",
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
      "Submit the output from the current round and advance to the next. Returns the next-round prompt, or null with a stopReason when the loop ends. The evaluation parameter provides structured self-assessment — prefer this over embedding a ---loopforge-eval block in the output text.",
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
          description: "Optional. The agent's full output from executing the current round's prompt. May be omitted if evaluation parameter is provided.",
        },
        evaluation: {
          type: "object" as const,
          description: "Structured self-evaluation for this round. Either this or an output containing a ---loopforge-eval block is required for the loop to continue. Preferred over embedding ---loopforge-eval blocks in output text.",
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
              description: "Optional. Sub-problems that surfaced during execution.",
            },
            execution_evidence: {
              type: "object" as const,
              description: "Optional. Structured record of what actually happened this round.",
              properties: {
                files_changed: {
                  type: "array" as const,
                  items: { type: "string" as const },
                  description: "Files modified this round.",
                },
                test_results: {
                  type: "object" as const,
                  description: "Test results from this round.",
                  properties: {
                    passed: { type: "integer" as const, minimum: 0, description: "Number of passing tests." },
                    failed: { type: "integer" as const, minimum: 0, description: "Number of failing tests." },
                    skipped: { type: "integer" as const, minimum: 0, description: "Number of skipped tests." },
                  },
                },
                success_criteria_met: {
                  type: "array" as const,
                  items: { type: "string" as const },
                  description: "Success criteria satisfied this round.",
                },
                success_criteria_remaining: {
                  type: "array" as const,
                  items: { type: "string" as const },
                  description: "Success criteria still outstanding.",
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
              description: "Optional. Results of sub-agent / Worker delegations this round.",
              items: {
                type: "object" as const,
                properties: {
                  agentId: { type: "string" as const },
                  subAgentType: { type: "string" as const },
                  subTask: { type: "string" as const },
                  resultSummary: { type: "string" as const },
                  success: { type: "boolean" as const },
                  outcome: {
                    type: "string" as const,
                    enum: ["success", "partial", "failed"],
                    description: "Optional. Worker outcome; derived from success when absent.",
                  },
                  discoveredConstraints: {
                    type: "array" as const,
                    items: { type: "string" as const },
                  },
                },
                required: ["agentId", "subAgentType", "subTask", "resultSummary", "success"],
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
            next_action: {
              type: "string" as const,
              description: "Optional. What the agent plans to do in the next round. Helps LoopForge detect task drift early by comparing declared intent with actual work.",
            },
            completed_subtasks: {
              type: "array" as const,
              items: { type: "string" as const },
              description: "Optional. Sub-tasks completed this round. Matched to previously emerged sub-tasks by description similarity.",
            },
            blocked_subtasks: {
              type: "array" as const,
              items: { type: "string" as const },
              description: "Optional. Sub-tasks that are now blocked. Describe what is blocking and why.",
            },
            canceled_subtasks: {
              type: "array" as const,
              items: { type: "string" as const },
              description: "Optional. Sub-tasks no longer needed. Removes them from the active sub-goal list.",
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
            drift_clarification: {
              type: "string" as const,
              description: "Optional. Explain why this round's actions diverged from your previous round's next_action. Only required when the previous round was flagged for intent_drift or subgoal_drift. Mention concrete anchors: sub-goal IDs (sg-XXXXXXXX), constraint IDs (c-XXXXXXXX), criterion IDs (cr-XXXXXXXX), or file paths.",
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
                expand: {
                  type: "array" as const,
                  items: {
                    type: "string" as const,
                    enum: ["milestones", "sub_goals", "constraint_lifecycle", "agent_trust", "progress", "loop_synthesis"],
                  },
                  description: "Sections to expand to full detail in the next prompt. Useful when you need full context on a specific area (e.g. full sub-goal dashboard when replanning). L1 max 1 section. L2 already expanded — redundant. L0 ignored.",
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
              description: "Optional. Proposal for the NEXT round's contract (v3.4). Declared here, it becomes the ACTIVE contract (rendered as the Current Task) only after this round commits, and stays active until a later round lists every done_when item in success_criteria_met or reports outcome=blocked. While it is active, restate it unchanged here; on completion or block, declare the next contract instead (or omit the field — the Current Task reverts to the original task). Checks: round_underspecified / round_unverifiable target this proposal; round_scope_drift and premature_boundary target the ACTIVE contract.",
              properties: {
                work_item: {
                  type: "string" as const,
                  description: "Optional. Round focus, one line. Rendered as the active contract's Current Task first line. Max 200 chars.",
                },
                done_when: {
                  type: "array" as const,
                  items: { type: "string" as const },
                  description: "Completion conditions: cr-XXXXXXXX criterion IDs or free text. Satisfied = list in success_criteria_met; still open = list in success_criteria_remaining. Max 20 items.",
                },
                verification_plan: {
                  type: "array" as const,
                  items: { type: "string" as const },
                  description: "Names of configured, enabled evidence.commands (see loop_policy.json evidence.commands) that verify the done_when claims. Max 20 items.",
                },
                scope: {
                  type: "array" as const,
                  items: { type: "string" as const },
                  description: "Files/directories this round may touch (workspace-relative; './' and trailing slashes accepted). Out-of-scope git changes trigger round_scope_drift. Max 50 items.",
                },
              },
              required: ["done_when", "verification_plan", "scope"],
            },
          },
        },
      },
      // v3.2.1: evaluation is optional at the schema level — the handler
      // requires EITHER the evaluation parameter OR output containing a
      // ---loopforge-eval block. Requiring it here made the embedded-block
      // path dead code (input validation rejected it before the handler).
      required: ["sessionId", "roundId"],
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
          enum: ["session", "loop", "all", "audit"],
          description: "Which view to return. Defaults to session.",
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
      "v2.12: Classify a high-risk action or blocker text as a user gate (needs human authorization) or an agent gate (resolvable with evidence). Read-only — nothing is recorded. Use the returned gate id with loopforge_gate_resolve after a human decision.",
    inputSchema: {
      type: "object" as const,
      properties: {
        gateText: {
          type: "string" as const,
          description: "The action or blocker text to classify, e.g. 'Deploy to production'.",
        },
      },
      required: ["gateText"],
    },
  },
  {
    name: "loopforge_gate_resolve",
    description:
      "v2.12: Record a human decision for a previously opened user gate. The gate id embeds the action hash — if the action text changed, the approval expires automatically. Read-only for agent gates (they are resolved by submitting evidence).",
    inputSchema: {
      type: "object" as const,
      properties: {
        sessionId: {
          type: "string" as const,
          description: "Session ID whose loop owns the gate.",
        },
        gateId: {
          type: "string" as const,
          description: "Gate id returned by loopforge_gate_check or recorded from a blocked round.",
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
    error: { type: "string" },
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
    parseGaps: {
      type: "array",
      items: { type: "object", additionalProperties: true },
      description: "v2.12: Field-level format diagnostics for tolerated evaluation issues.",
    },
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
      error: { type: "string" },
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
      error: { type: "string" },
      success: { type: "boolean" },
      roundsCompleted: { type: "number" },
      successTrajectory: { type: "array", items: { type: "boolean" } },
    },
    additionalProperties: true,
  },
  loopforge_pause: {
    type: "object",
    properties: {
      error: { type: "string" },
      sessionId: { type: "string" },
      round: { type: "number" },
      status: { type: "string" },
    },
    additionalProperties: true,
  },
  loopforge_replay: {
    type: "object",
    properties: {
      error: { type: "string" },
      sessionId: { type: "string" },
      loopId: { type: "string" },
      timeline: { type: "array", items: { type: "object", additionalProperties: true } },
    },
    additionalProperties: true,
  },
  loopforge_gate_check: {
    type: "object",
    properties: {
      error: { type: "string" },
      id: { type: "string" },
      kind: { type: "string" },
      question: { type: "string" },
      blockedScope: { type: "array", items: { type: "string" } },
      allowedWork: { type: "array", items: { type: "string" } },
      problem: { type: "string" },
      requiredEvidence: { type: "array", items: { type: "string" } },
      suggestedResolution: { type: "string" },
    },
    additionalProperties: true,
  },
  loopforge_gate_resolve: {
    type: "object",
    properties: {
      error: { type: "string" },
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

/** MCP tool contracts include strict input and structured output schemas. */
export const TOOL_SCHEMAS = TOOL_BASE_SCHEMAS.map((schema) => ({
  ...schema,
  inputSchema: closeObjectSchemas(schema.inputSchema),
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
      return { error: "task is required and must be non-empty" };
    }

    // v2.14: entry-point validation — a bad maxRounds previously passed
    // through and stopped the loop on the first round; an invalid loopId
    // exploded later as an internal storage error instead of a clean
    // argument error.
    if (startInput.maxRounds !== undefined &&
        (!Number.isInteger(startInput.maxRounds) || startInput.maxRounds < 1)) {
      return { error: "maxRounds must be a positive integer" };
    }
    if (startInput.loopId !== undefined) {
      try {
        validateLoopId(startInput.loopId);
      } catch (error) {
        return { error: `invalid loopId: ${(error as Error).message}` };
      }
    }

    const result = await mgr.create(startInput);
    // v2.14: a same-process duplicate loopId surfaces as a clean argument
    // error instead of a prompt-less "success" the client cannot act on.
    if (typeof result.stopReason === "string" &&
        result.stopReason.startsWith("loop_already_running:")) {
      return { error: result.stopDetail ?? "loop already running" };
    }
    return { ...result };
  },

  async loopforge_next(mgr, input): Promise<Record<string, unknown>> {
    const sessionId = String(input.sessionId ?? "");
    const output = String(input.output ?? "");
    const rawEval = input.evaluation as Record<string, unknown> | undefined;
    const roundId = input.roundId === undefined ? undefined : String(input.roundId);

    if (!sessionId) return { error: "sessionId is required" };
    // v3.0.1: every submission is anchored to the round it reports on. A
    // missing roundId would silently re-process a stale submission against a
    // later round — reject it here so the contract is enforced even when the
    // handler is invoked directly (bypassing schema validation).
    if (!roundId || !roundId.trim()) {
      return { error: "roundId is required — pass the roundId from the most recent loopforge_start / loopforge_next / loopforge_resume / loopforge_status response" };
    }

    // Build SelfEvaluation from structured evaluation parameter
    const preExtractedEval = rawEval ? buildSelfEvaluation(rawEval) : undefined;

    // Require at least one of: evaluation parameter or output with embedded eval block
    if (!preExtractedEval && !output.trim()) {
      return { error: "Either evaluation parameter or output with ---loopforge-eval block is required" };
    }

    const result = await mgr.advance(sessionId, output, preExtractedEval, roundId);

    // v2.12: Typed projection — runtime facts for the main agent, attached
    // on every accepted/continued round (not on errors).
    let projection: Record<string, unknown> | null = null;
    if (result.enforcementAction !== "reject" && result.enforcementAction !== "terminate" &&
        result.stopReason !== "session_not_found" && result.stopReason !== "stalled") {
      projection = mgr.getProjection(sessionId);
    }

    // v2.12: Field-level diagnostics for tolerated format issues. The
    // lenient parser still accepts the evaluation — the gaps are surfaced
    // as structured warnings so the agent can correct its template.
    if (rawEval) {
      const gaps = collectSelfEvalGaps(rawEval);
      if (gaps.length > 0) {
        return {
          ...result,
          projection,
          warnings: [...(result.warnings ?? []), ...gaps.map((g) => `[${g.field}] ${g.issue}`)],
          parseGaps: gaps,
        };
      }
    }

    return projection ? { ...result, projection } : { ...result };
  },

  async loopforge_status(mgr, input): Promise<Record<string, unknown>> {
    const view = input.view === "loop" || input.view === "all" || input.view === "audit"
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
      if (!loopId) return { error: "loopId is required for view=audit" };
      const audit = mgr.getAudit(loopId);
      if (!audit) return { error: `no audit data found for loop "${loopId}"` };
      return audit;
    }

    // v2.12: view=loop — loop health (formerly loopforge_health).
    if (view === "loop") {
      if (!loopId) return { error: "loopId is required for view=loop" };
      const health = mgr.getHealth(loopId);
      return health ?? { error: `no health data for loop "${loopId}"` };
    }

    if (!sessionId) return { error: "sessionId is required for view=session" };

    const session = mgr.get(sessionId);
    if (!session) return { error: `session not found: ${sessionId}` };

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
    if (!sessionId) return { error: "sessionId is required" };

    const session = mgr.get(sessionId);
    if (!session) return { error: `session not found: ${sessionId}` };

    const roundsCompleted = session.currentRound;
    const successTrajectory = [...session.successTrajectory];
    mgr.delete(sessionId);

    return { success: true, roundsCompleted, successTrajectory };
  },

  async loopforge_pause(mgr, input): Promise<Record<string, unknown>> {
    const sessionId = String(input.sessionId ?? "");
    if (!sessionId) return { error: "sessionId is required" };
    const result = mgr.pause(sessionId);
    return { ...result };
  },

  async loopforge_replay(mgr, input): Promise<Record<string, unknown>> {
    const sessionId = String(input.sessionId ?? "");
    const loopId = String(input.loopId ?? "");
    if (!sessionId && !loopId) {
      return { error: "sessionId or loopId is required — pass loopId to replay a loop after a restart (no live session)" };
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
        return { error: `session not found: ${sessionId} (process restarted?) — pass loopId to replay from the vault` };
      }
    }

    // Vault-direct replay — the timeline lives in the committed round
    // documents, not in the session registry.
    const timeline = mgr.replayByLoop(loopId);
    if (!timeline) {
      return { error: `no committed rounds found for loop "${loopId}"` };
    }
    // sessionId omitted on the vault path (its output schema is string-only).
    return { ...(sessionId ? { sessionId } : {}), loopId, timeline };
  },

  async loopforge_resume(mgr, input): Promise<Record<string, unknown>> {
    const loopId = String(input.loopId ?? "");
    if (!loopId) return { error: "loopId is required" };
    try {
      validateLoopId(loopId);
    } catch (error) {
      return { error: `invalid loopId: ${(error as Error).message}` };
    }

    // Paused recovery must run first so the persisted status is atomically
    // changed back to running before a prompt is returned.
    let result = await mgr.unpause(loopId);
    if (!result) {
      result = mgr.resume(loopId);
    }
    if (!result) return { error: `no saved session found for loop "${loopId}"` };

    return { ...result };
  },

  async loopforge_gate_check(mgr, input): Promise<Record<string, unknown>> {
    const gateText = String(input.gateText ?? "");
    if (!gateText.trim()) return { error: "gateText is required" };
    return mgr.checkGate(gateText);
  },

  async loopforge_gate_resolve(mgr, input): Promise<Record<string, unknown>> {
    return mgr.resolveGate(
      String(input.sessionId ?? ""),
      String(input.gateId ?? ""),
      input.approved === true,
      input.note === undefined ? undefined : String(input.note),
    );
  },
};
