/** LoopForge MCP — Tool definitions and handlers.
 *
 * 6 tools: start, next, status, stop, list, replay.
 * Each handler receives SessionManager + parsed input, returns the output object.
 */
// ═══════════════════════════════════════════════════════════════════════════
// Tool schemas (MCP JSON Schema format)
// ═══════════════════════════════════════════════════════════════════════════
export const TOOL_SCHEMAS = [
    {
        name: "loopforge_start",
        description: "Start a new LoopForge loop session. Compiles the first-round prompt from the task description and returns it. Use this at the beginning of an autonomous multi-round coding loop.",
        inputSchema: {
            type: "object",
            properties: {
                task: {
                    type: "string",
                    description: "The task to accomplish across the loop. Be specific and actionable.",
                },
                loopId: {
                    type: "string",
                    description: "Optional loop ID. Generated automatically if not provided.",
                },
                maxRounds: {
                    type: "number",
                    description: "Maximum rounds before auto-stop. Default: 20 from policy.",
                },
                domain: {
                    type: "string",
                    description: "Domain hint (e.g. 'solidity', 'react', 'rust'). Helps technique routing.",
                },
                planSource: {
                    type: "string",
                    description: "Plan reference for constraint extraction (e.g. 'docs/plan.md').",
                },
                constraints: {
                    type: "array",
                    items: { type: "string" },
                    description: "Hard constraints to enforce across all rounds.",
                },
            },
            required: ["task"],
        },
    },
    {
        name: "loopforge_next",
        description: "Submit the output from the current round and advance to the next. Returns the next-round prompt, or null with a stopReason when the loop ends.",
        inputSchema: {
            type: "object",
            properties: {
                sessionId: {
                    type: "string",
                    description: "Session ID returned by loopforge_start.",
                },
                output: {
                    type: "string",
                    description: "The agent's full output from executing the current round's prompt.",
                },
            },
            required: ["sessionId", "output"],
        },
    },
    {
        name: "loopforge_status",
        description: "Get the current status of a loop session: round number, quality trajectory, technique in use.",
        inputSchema: {
            type: "object",
            properties: {
                sessionId: {
                    type: "string",
                    description: "Session ID returned by loopforge_start.",
                },
            },
            required: ["sessionId"],
        },
    },
    {
        name: "loopforge_stop",
        description: "Manually stop a loop session and return its final trajectory.",
        inputSchema: {
            type: "object",
            properties: {
                sessionId: {
                    type: "string",
                    description: "Session ID to stop.",
                },
            },
            required: ["sessionId"],
        },
    },
    {
        name: "loopforge_list",
        description: "List all active loop sessions managed by this MCP server.",
        inputSchema: {
            type: "object",
            properties: {},
            required: [],
        },
    },
    {
        name: "loopforge_replay",
        description: "Replay a completed or running loop session — returns the timeline of all rounds with technique, quality, and task data.",
        inputSchema: {
            type: "object",
            properties: {
                sessionId: {
                    type: "string",
                    description: "Session ID to replay.",
                },
            },
            required: ["sessionId"],
        },
    },
    {
        name: "loopforge_resume",
        description: "Resume a loop from vault state after process restart. Returns the compiled prompt for the next round, or null with a stopReason if the loop is already complete.",
        inputSchema: {
            type: "object",
            properties: {
                loopId: {
                    type: "string",
                    description: "Loop ID to resume. Must have a saved session_state entry from a previous start/run.",
                },
            },
            required: ["loopId"],
        },
    },
    {
        name: "loopforge_health",
        description: "Check the health of a loop: goal alignment, constraint integrity, drift detection, strategy stability, and task continuity. Works for both active in-memory sessions and vault-persisted loops.",
        inputSchema: {
            type: "object",
            properties: {
                loopId: {
                    type: "string",
                    description: "Loop ID to check health for.",
                },
            },
            required: ["loopId"],
        },
    },
];
export const TOOL_HANDLERS = {
    loopforge_start(mgr, input) {
        const startInput = {
            task: String(input.task ?? ""),
            loopId: input.loopId,
            maxRounds: typeof input.maxRounds === "number" ? input.maxRounds : undefined,
            domain: input.domain,
            planSource: input.planSource,
            constraints: Array.isArray(input.constraints)
                ? input.constraints
                : undefined,
        };
        if (!startInput.task.trim()) {
            return { error: "task is required and must be non-empty" };
        }
        const result = mgr.create(startInput);
        return { ...result };
    },
    loopforge_next(mgr, input) {
        const sessionId = String(input.sessionId ?? "");
        const output = String(input.output ?? "");
        if (!sessionId)
            return { error: "sessionId is required" };
        if (!output.trim())
            return { error: "output is required and must be non-empty" };
        const result = mgr.advance(sessionId, output);
        // Clean up finished sessions
        if (result.prompt === null) {
            mgr.delete(sessionId);
        }
        return { ...result };
    },
    loopforge_status(mgr, input) {
        const sessionId = String(input.sessionId ?? "");
        if (!sessionId)
            return { error: "sessionId is required" };
        const session = mgr.get(sessionId);
        if (!session)
            return { error: `session not found: ${sessionId}` };
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
    loopforge_stop(mgr, input) {
        const sessionId = String(input.sessionId ?? "");
        if (!sessionId)
            return { error: "sessionId is required" };
        const session = mgr.get(sessionId);
        if (!session)
            return { error: `session not found: ${sessionId}` };
        const roundsCompleted = session.currentRound;
        const qualityTrajectory = [...session.qualityTrajectory];
        mgr.delete(sessionId);
        return { success: true, roundsCompleted, qualityTrajectory };
    },
    loopforge_list(mgr, _input) {
        const sessions = mgr.list();
        return { sessions };
    },
    loopforge_replay(mgr, input) {
        const sessionId = String(input.sessionId ?? "");
        if (!sessionId)
            return { error: "sessionId is required" };
        const session = mgr.get(sessionId);
        if (!session)
            return { error: `session not found: ${sessionId}` };
        const timeline = mgr.replayTimeline(sessionId) ?? [];
        return { sessionId, loopId: session.loopId, timeline };
    },
    loopforge_resume(mgr, input) {
        const loopId = String(input.loopId ?? "");
        if (!loopId)
            return { error: "loopId is required" };
        const result = mgr.resume(loopId);
        if (!result)
            return { error: `no saved session found for loop "${loopId}"` };
        return { ...result };
    },
    loopforge_health(mgr, input) {
        const loopId = String(input.loopId ?? "");
        if (!loopId)
            return { error: "loopId is required" };
        const health = mgr.getHealth(loopId);
        if (!health)
            return { error: `no data found for loop "${loopId}"` };
        return health;
    },
};
//# sourceMappingURL=tools.js.map