/** LoopForge MCP — Tool definitions and handlers.
 *
 * 6 tools: start, next, status, stop, list, replay.
 * Each handler receives SessionManager + parsed input, returns the output object.
 */
import type { SessionManager } from "./session.js";
export declare const TOOL_SCHEMAS: ({
    name: string;
    description: string;
    inputSchema: {
        type: "object";
        properties: {
            task: {
                type: "string";
                description: string;
            };
            loopId: {
                type: "string";
                description: string;
            };
            maxRounds: {
                type: "number";
                description: string;
            };
            domain: {
                type: "string";
                description: string;
            };
            planSource: {
                type: "string";
                description: string;
            };
            constraints: {
                type: "array";
                items: {
                    type: "string";
                };
                description: string;
            };
            sessionId?: undefined;
            output?: undefined;
            evaluation?: undefined;
        };
        required: string[];
    };
} | {
    name: string;
    description: string;
    inputSchema: {
        type: "object";
        properties: {
            sessionId: {
                type: "string";
                description: string;
            };
            output: {
                type: "string";
                description: string;
            };
            evaluation: {
                type: "object";
                description: string;
                required: string[];
                properties: {
                    success: {
                        type: "boolean";
                        description: string;
                    };
                    output_summary: {
                        type: "string";
                        description: string;
                    };
                    should_continue: {
                        type: "boolean";
                        description: string;
                    };
                    constraint_violations: {
                        type: "array";
                        items: {
                            type: "string";
                        };
                        description: string;
                    };
                    discovered_constraints: {
                        type: "array";
                        items: {
                            type: "string";
                        };
                        description: string;
                    };
                    objective_refinement: {
                        type: "string";
                        description: string;
                    };
                    emerged_subtasks: {
                        type: "array";
                        items: {
                            type: "string";
                        };
                        description: string;
                    };
                    execution_evidence: {
                        type: "object";
                        description: string;
                        properties: {
                            files_changed: {
                                type: "array";
                                items: {
                                    type: "string";
                                };
                                description: string;
                            };
                            test_results: {
                                type: "object";
                                description: string;
                                properties: {
                                    passed: {
                                        type: "integer";
                                        minimum: number;
                                        description: string;
                                    };
                                    failed: {
                                        type: "integer";
                                        minimum: number;
                                        description: string;
                                    };
                                    skipped: {
                                        type: "integer";
                                        minimum: number;
                                        description: string;
                                    };
                                };
                            };
                            success_criteria_met: {
                                type: "array";
                                items: {
                                    type: "string";
                                };
                                description: string;
                            };
                            success_criteria_remaining: {
                                type: "array";
                                items: {
                                    type: "string";
                                };
                                description: string;
                            };
                            progress_estimate: {
                                type: "number";
                                minimum: number;
                                maximum: number;
                                description: string;
                            };
                        };
                    };
                    retracted_constraints: {
                        type: "array";
                        items: {
                            type: "string";
                        };
                        description: string;
                    };
                    revised_success_criteria: {
                        type: "array";
                        description: string;
                        items: {
                            type: "object";
                            properties: {
                                old: {
                                    type: "string";
                                    description: string;
                                };
                                new: {
                                    type: "string";
                                    description: string;
                                };
                            };
                        };
                    };
                    wrong_assumptions: {
                        type: "array";
                        items: {
                            type: "string";
                        };
                        description: string;
                    };
                    worker_results: {
                        type: "array";
                        description: string;
                        items: {
                            type: "object";
                            properties: {
                                agentId: {
                                    type: "string";
                                };
                                subAgentType: {
                                    type: "string";
                                };
                                subTask: {
                                    type: "string";
                                };
                                resultSummary: {
                                    type: "string";
                                };
                                success: {
                                    type: "boolean";
                                };
                                discoveredConstraints: {
                                    type: "array";
                                    items: {
                                        type: "string";
                                    };
                                };
                            };
                            required: string[];
                        };
                    };
                };
            };
            task?: undefined;
            loopId?: undefined;
            maxRounds?: undefined;
            domain?: undefined;
            planSource?: undefined;
            constraints?: undefined;
        };
        required: string[];
    };
} | {
    name: string;
    description: string;
    inputSchema: {
        type: "object";
        properties: {
            sessionId: {
                type: "string";
                description: string;
            };
            task?: undefined;
            loopId?: undefined;
            maxRounds?: undefined;
            domain?: undefined;
            planSource?: undefined;
            constraints?: undefined;
            output?: undefined;
            evaluation?: undefined;
        };
        required: string[];
    };
} | {
    name: string;
    description: string;
    inputSchema: {
        type: "object";
        properties: {
            task?: undefined;
            loopId?: undefined;
            maxRounds?: undefined;
            domain?: undefined;
            planSource?: undefined;
            constraints?: undefined;
            sessionId?: undefined;
            output?: undefined;
            evaluation?: undefined;
        };
        required: never[];
    };
} | {
    name: string;
    description: string;
    inputSchema: {
        type: "object";
        properties: {
            loopId: {
                type: "string";
                description: string;
            };
            task?: undefined;
            maxRounds?: undefined;
            domain?: undefined;
            planSource?: undefined;
            constraints?: undefined;
            sessionId?: undefined;
            output?: undefined;
            evaluation?: undefined;
        };
        required: string[];
    };
})[];
export type ToolHandler = (mgr: SessionManager, input: Record<string, unknown>) => Promise<Record<string, unknown>>;
export declare const TOOL_HANDLERS: Record<string, ToolHandler>;
//# sourceMappingURL=tools.d.ts.map