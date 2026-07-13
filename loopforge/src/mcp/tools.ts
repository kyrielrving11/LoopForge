/** LoopForge MCP — Tool definitions and handlers.
 *
 * 9 tools: start, next, status, stop, pause, list, replay, resume, health.
 * Each handler receives SessionManager + parsed input, returns the output object.
 */

import type { SessionManager, StartInput } from "./session.js";
import { buildSelfEvaluation } from "../engine.js";
import { getPolicyMetrics } from "../policy-metrics.js";

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
          type: "number" as const,
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
        output: {
          type: "string" as const,
          description: "Optional. The agent's full output from executing the current round's prompt. May be omitted if evaluation parameter is provided.",
        },
        evaluation: {
          type: "object" as const,
          description: "Structured self-evaluation for this round. Required for the loop to continue. Preferred over embedding ---loopforge-eval blocks in output text.",
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
                  discoveredConstraints: {
                    type: "array" as const,
                    items: { type: "string" as const },
                  },
                },
                required: ["agentId", "subAgentType", "subTask", "resultSummary", "success"],
              },
            },
          },
        },
      },
      required: ["sessionId", "evaluation"],
    },
  },
  {
    name: "loopforge_status",
    description:
      "Get the current status of a loop session, including round identity and success trajectory.",
    inputSchema: {
      type: "object" as const,
      properties: {
        sessionId: {
          type: "string" as const,
          description: "Session ID returned by loopforge_start.",
        },
      },
      required: ["sessionId"],
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
    name: "loopforge_list",
    description:
      "List all active loop sessions managed by this MCP server.",
    inputSchema: {
      type: "object" as const,
      properties: {},
      required: [],
    },
  },
  {
    name: "loopforge_replay",
    description:
      "Replay a completed or running loop session as an auditable round timeline.",
    inputSchema: {
      type: "object" as const,
      properties: {
        sessionId: {
          type: "string" as const,
          description: "Session ID to replay.",
        },
      },
      required: ["sessionId"],
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
    name: "loopforge_health",
    description:
      "Check the health of a loop: goal alignment, constraint integrity, drift detection, strategy stability, and task continuity. Works for both active in-memory sessions and vault-persisted loops.",
    inputSchema: {
      type: "object" as const,
      properties: {
        loopId: {
          type: "string" as const,
          description: "Loop ID to check health for.",
        },
      },
      required: ["loopId"],
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
    stopReason: { type: "string" },
    level: { type: "string" },
    roundSuccess: { type: "boolean" },
    enforcementAction: { enum: ["accept", "reject", "terminate"] },
    enforcementReason: { type: "string" },
    warnings: { type: "array", items: { type: "string" } },
  },
  additionalProperties: true,
};

const TOOL_OUTPUT_SCHEMAS: Record<string, JsonSchema> = {
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
  loopforge_list: {
    type: "object",
    properties: {
      sessions: { type: "array", items: { type: "object", additionalProperties: true } },
    },
    required: ["sessions"],
    additionalProperties: false,
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
  loopforge_health: {
    type: "object",
    properties: {
      error: { type: "string" },
      loopId: { type: "string" },
      goal_alignment: { type: "object", additionalProperties: true },
      constraint_integrity: { type: "object", additionalProperties: true },
      drift_detected: { type: "boolean" },
      strategy_stability: { type: "object", additionalProperties: true },
      task_continuity: { type: "object", additionalProperties: true },
      policy_metrics: { type: "object", additionalProperties: true },
    },
    additionalProperties: true,
  },
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

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

function validateSchema(value: unknown, schema: JsonSchema, path: string): void {
  const type = schema.type;
  if (type === "object") {
    if (!isRecord(value)) {
      throw new ToolInputValidationError(`${path} must be an object`);
    }
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
  if (type === "array") {
    if (!Array.isArray(value)) {
      throw new ToolInputValidationError(`${path} must be an array`);
    }
    if (isRecord(schema.items)) {
      value.forEach((item, index) =>
        validateSchema(item, schema.items as JsonSchema, `${path}[${index}]`));
    }
    return;
  }
  if (type === "string" && typeof value !== "string") {
    throw new ToolInputValidationError(`${path} must be a string`);
  }
  if (type === "boolean" && typeof value !== "boolean") {
    throw new ToolInputValidationError(`${path} must be a boolean`);
  }
  if (type === "number" || type === "integer") {
    if (
      typeof value !== "number" ||
      !Number.isFinite(value) ||
      (type === "integer" && !Number.isInteger(value))
    ) {
      throw new ToolInputValidationError(
        `${path} must be ${type === "integer" ? "an integer" : "a number"}`,
      );
    }
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

    const result = await mgr.create(startInput);
    return { ...result };
  },

  async loopforge_next(mgr, input): Promise<Record<string, unknown>> {
    const sessionId = String(input.sessionId ?? "");
    const output = String(input.output ?? "");
    const rawEval = input.evaluation as Record<string, unknown> | undefined;

    if (!sessionId) return { error: "sessionId is required" };

    // Build SelfEvaluation from structured evaluation parameter
    const preExtractedEval = rawEval ? buildSelfEvaluation(rawEval) : undefined;

    // Require at least one of: evaluation parameter or output with embedded eval block
    if (!preExtractedEval && !output.trim()) {
      return { error: "Either evaluation parameter or output with ---loopforge-eval block is required" };
    }

    const result = await mgr.advance(sessionId, output, preExtractedEval);
    return { ...result };
  },

  async loopforge_status(mgr, input): Promise<Record<string, unknown>> {
    const sessionId = String(input.sessionId ?? "");
    if (!sessionId) return { error: "sessionId is required" };

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
      metrics: {
        vaultWriteErrors: metrics.vaultWriteErrors,
        vaultWriteBytes: metrics.vaultWriteBytes,
        feedbackBufferFlushes: metrics.feedbackBufferFlushes,
        feedbackBufferMaxSize: metrics.feedbackBufferMaxSize,
        hydrateCacheMisses: metrics.hydrateCacheMisses,
        silentAnalysisErrors: metrics.silentAnalysisErrors,
        policy: getPolicyMetrics(session.loopId),
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

  async loopforge_list(mgr, _input): Promise<Record<string, unknown>> {
    const sessions = mgr.list();
    return { sessions };
  },

  async loopforge_replay(mgr, input): Promise<Record<string, unknown>> {
    const sessionId = String(input.sessionId ?? "");
    if (!sessionId) return { error: "sessionId is required" };

    const session = mgr.get(sessionId);
    if (!session) return { error: `session not found: ${sessionId}` };

    const timeline = mgr.replayTimeline(sessionId) ?? [];
    return { sessionId, loopId: session.loopId, timeline };
  },

  async loopforge_resume(mgr, input): Promise<Record<string, unknown>> {
    const loopId = String(input.loopId ?? "");
    if (!loopId) return { error: "loopId is required" };

    // Paused recovery must run first so the persisted status is atomically
    // changed back to running before a prompt is returned.
    let result = await mgr.unpause(loopId);
    if (!result) {
      result = mgr.resume(loopId);
    }
    if (!result) return { error: `no saved session found for loop "${loopId}"` };

    return { ...result };
  },

  async loopforge_health(mgr, input): Promise<Record<string, unknown>> {
    const loopId = String(input.loopId ?? "");
    if (!loopId) return { error: "loopId is required" };

    const health = mgr.getHealth(loopId);
    if (!health) return { error: `no data found for loop "${loopId}"` };

    return health;
  },
};
