/** LoopForge MCP — Tool definitions and handlers.
 *
 * 6 tools: start, next, status, stop, list, replay.
 * Each handler receives SessionManager + parsed input, returns the output object.
 */

import type { SessionManager, StartInput } from "./session.js";

// ═══════════════════════════════════════════════════════════════════════════
// Tool schemas (MCP JSON Schema format)
// ═══════════════════════════════════════════════════════════════════════════

export const TOOL_SCHEMAS = [
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
          description: "Domain hint (e.g. 'solidity', 'react', 'rust'). Helps technique routing.",
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
      "Submit the output from the current round and advance to the next. Returns the next-round prompt, or null with a stopReason when the loop ends.",
    inputSchema: {
      type: "object" as const,
      properties: {
        sessionId: {
          type: "string" as const,
          description: "Session ID returned by loopforge_start.",
        },
        output: {
          type: "string" as const,
          description: "The agent's full output from executing the current round's prompt.",
        },
      },
      required: ["sessionId", "output"],
    },
  },
  {
    name: "loopforge_status",
    description:
      "Get the current status of a loop session: round number, quality trajectory, technique in use.",
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
      "Replay a completed or running loop session — returns the timeline of all rounds with technique, quality, and task data.",
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
];

// ═══════════════════════════════════════════════════════════════════════════
// Handler registry
// ═══════════════════════════════════════════════════════════════════════════

export type ToolHandler = (mgr: SessionManager, input: Record<string, unknown>) => Record<string, unknown>;

export const TOOL_HANDLERS: Record<string, ToolHandler> = {
  loopforge_start(mgr, input): Record<string, unknown> {
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

    const result = mgr.create(startInput);
    return { ...result };
  },

  loopforge_next(mgr, input): Record<string, unknown> {
    const sessionId = String(input.sessionId ?? "");
    const output = String(input.output ?? "");

    if (!sessionId) return { error: "sessionId is required" };
    if (!output.trim()) return { error: "output is required and must be non-empty" };

    const result = mgr.advance(sessionId, output);

    // Clean up finished sessions
    if (result.prompt === null) {
      mgr.delete(sessionId);
    }

    return { ...result };
  },

  loopforge_status(mgr, input): Record<string, unknown> {
    const sessionId = String(input.sessionId ?? "");
    if (!sessionId) return { error: "sessionId is required" };

    const session = mgr.get(sessionId);
    if (!session) return { error: `session not found: ${sessionId}` };

    return {
      sessionId: session.sessionId,
      loopId: session.loopId,
      round: session.currentRound,
      maxRounds: session.maxRounds,
      status: session.status,
      qualityTrajectory: session.qualityTrajectory,
      technique: session.engine.state?.last_technique ?? null,
    };
  },

  loopforge_stop(mgr, input): Record<string, unknown> {
    const sessionId = String(input.sessionId ?? "");
    if (!sessionId) return { error: "sessionId is required" };

    const session = mgr.get(sessionId);
    if (!session) return { error: `session not found: ${sessionId}` };

    const roundsCompleted = session.currentRound;
    const qualityTrajectory = [...session.qualityTrajectory];
    mgr.delete(sessionId);

    return { success: true, roundsCompleted, qualityTrajectory };
  },

  loopforge_list(mgr, _input): Record<string, unknown> {
    const sessions = mgr.list();
    return { sessions };
  },

  loopforge_replay(mgr, input): Record<string, unknown> {
    const sessionId = String(input.sessionId ?? "");
    if (!sessionId) return { error: "sessionId is required" };

    const session = mgr.get(sessionId);
    if (!session) return { error: `session not found: ${sessionId}` };

    const timeline = mgr.replayTimeline(sessionId) ?? [];
    return { sessionId, loopId: session.loopId, timeline };
  },
};
