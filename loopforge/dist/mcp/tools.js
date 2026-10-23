/** LoopForge MCP — Tool definitions and handlers.
 *
 * 9 tools: start, next, status, stop, pause, resume, replay,
 *          gate_check, gate_resolve.
 * status is the unified inspection tool (view=session|loop|all|audit).
 * Each handler receives SessionManager + parsed input, returns the output object.
 */
import { StartCriteriaError } from "./round-lifecycle.js";
import { ProjectionCoverageError } from "../prompt-coverage.js";
import { validateCoreSelfEvaluation } from "../self-eval.js";
import { isRecord } from "../token-utils.js";
import { getPolicy, validateLoopId } from "../policy.js";
import { deriveEvidenceCapability } from "../evidence-provider.js";
import { fieldGuideDescription } from "../submission-guidance.js";
import { SessionLeaseConflictError } from "../storage.js";
// ═══════════════════════════════════════════════════════════════════════════
// Tool schemas (MCP JSON Schema format)
// ═══════════════════════════════════════════════════════════════════════════
const TOOL_BASE_SCHEMAS = [
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
                    type: "integer",
                    minimum: 1,
                    description: "Maximum rounds before auto-stop. Default: 200 from policy.",
                },
                domain: {
                    type: "string",
                    description: "Domain hint (e.g. 'solidity', 'react', 'rust') for state context.",
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
                criteria: {
                    type: "array",
                    items: { type: "string" },
                    description: "Initial success criteria — the operator's acceptance surface. Phrase " +
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
        description: "Submit the output from the current round and advance to the next. Returns the next-round prompt, or null with a stopReason when the loop ends. A structured evaluation is required; output is optional supporting context.",
        inputSchema: {
            type: "object",
            properties: {
                sessionId: {
                    type: "string",
                    description: "Session ID returned by loopforge_start.",
                },
                roundId: {
                    type: "string",
                    description: "The roundId from the most recent loopforge_start / loopforge_next / loopforge_resume / loopforge_status response. Anchors this submission to the exact round it reports on: a submission whose roundId no longer matches the current round (the round already committed) is not processed — the current held prompt is returned instead, so lost responses can be recovered without skipping or double-committing a round.",
                },
                transactionId: {
                    type: "string",
                    description: "v3.9.7: The transactionId returned with the SAME held prompt (start / next / resume / status / checkpoint). A redo or retry can reuse a numeric roundId with a different transaction; this anchor prevents an old response from being evaluated against the current attempt. On a lost response, call loopforge_status or loopforge_resume to retrieve it.",
                },
                output: {
                    type: "string",
                    description: "Optional. The agent's full output from executing the current round's prompt. The structured evaluation is the authoritative report.",
                },
                recovery: {
                    type: "object",
                    description: "v3.9.7: Agent-initiated recovery. Abandon the current branch and " +
                        "restore a visible workspace checkpoint (the held before-image, a " +
                        "mid-round savepoint, or a committed round's before-image). " +
                        "Mutually exclusive with evaluation. LoopForge records the directive, " +
                        "executes the restore, verifies the full Git boundary, then issues " +
                        "the redo prompt. It never chooses a target or judges the reason.",
                    properties: {
                        target_checkpoint_id: {
                            type: "string",
                            pattern: "^ck-[a-f0-9]{24}$",
                            description: "Checkpoint id (ck-<24 hex>) from the held prompt, a loopforge_checkpoint result, or a committed round's before-image.",
                        },
                        reason: {
                            type: "string",
                            minLength: 1,
                            maxLength: 500,
                            description: "The Agent's reason for abandoning the branch. Recorded verbatim; never judged.",
                        },
                    },
                    required: ["target_checkpoint_id", "reason"],
                    additionalProperties: false,
                },
                evaluation: {
                    type: "object",
                    description: "Structured self-evaluation for this round. Required when recovery is absent. Free-text or embedded evaluation blocks are not accepted.",
                    required: ["success", "output_summary", "should_continue", "constraint_violations"],
                    properties: {
                        success: {
                            type: "boolean",
                            description: fieldGuideDescription("success"),
                        },
                        output_summary: {
                            type: "string",
                            description: fieldGuideDescription("output_summary"),
                        },
                        should_continue: {
                            type: "boolean",
                            description: fieldGuideDescription("should_continue"),
                        },
                        constraint_violations: {
                            type: "array",
                            items: { type: "string" },
                            description: fieldGuideDescription("constraint_violations"),
                        },
                        discovered_constraints: {
                            type: "array",
                            items: { type: "string" },
                            description: fieldGuideDescription("discovered_constraints"),
                        },
                        objective_refinement: {
                            type: "string",
                            description: fieldGuideDescription("objective_refinement"),
                        },
                        emerged_subtasks: {
                            type: "array",
                            items: { type: "string" },
                            description: fieldGuideDescription("emerged_subtasks"),
                        },
                        execution_report: {
                            type: "object",
                            description: "Optional. Structured record of what actually happened this round.",
                            properties: {
                                files_changed: {
                                    type: "array",
                                    items: { type: "string" },
                                    description: fieldGuideDescription("execution_report.files_changed"),
                                },
                                tests_reported: {
                                    type: "object",
                                    description: fieldGuideDescription("execution_report.tests_reported"),
                                    properties: {
                                        passed: { type: "integer", minimum: 0, description: "Number of passing tests." },
                                        failed: { type: "integer", minimum: 0, description: "Number of failing tests." },
                                        skipped: { type: "integer", minimum: 0, description: "Number of skipped tests." },
                                    },
                                },
                                criterion_claims: {
                                    type: "array",
                                    description: fieldGuideDescription("execution_report.criterion_claims"),
                                    items: {
                                        type: "object",
                                        properties: {
                                            criterion_id: { type: "string", description: "cr-XXXXXXXX criterion id (free text allowed)." },
                                            outcome: { type: "string", enum: ["met", "remaining"] },
                                        },
                                        required: ["criterion_id", "outcome"],
                                        additionalProperties: false,
                                    },
                                },
                                contract_item_claims: {
                                    type: "array",
                                    description: fieldGuideDescription("execution_report.contract_item_claims"),
                                    items: {
                                        type: "object",
                                        properties: {
                                            item_id: { type: "string", description: "rci-XXXXXXXX id of an item of the ACTIVE contract." },
                                            outcome: { type: "string", enum: ["met", "remaining"], description: "Your claim for that item this round." },
                                        },
                                        required: ["item_id", "outcome"],
                                        additionalProperties: false,
                                    },
                                },
                            },
                        },
                        retracted_constraints: {
                            type: "array",
                            items: { type: "string" },
                            description: fieldGuideDescription("retracted_constraints"),
                        },
                        wrong_assumptions: {
                            type: "array",
                            items: { type: "string" },
                            description: fieldGuideDescription("wrong_assumptions"),
                        },
                        worker_results: {
                            type: "array",
                            description: fieldGuideDescription("worker_results"),
                            items: {
                                type: "object",
                                properties: {
                                    agentId: { type: "string" },
                                    subAgentType: { type: "string" },
                                    subTask: { type: "string" },
                                    resultSummary: { type: "string" },
                                    outcome: {
                                        type: "string",
                                        enum: ["success", "partial", "failed"],
                                    },
                                    discoveredConstraints: {
                                        type: "array",
                                        items: { type: "string" },
                                    },
                                },
                                required: ["agentId", "subTask", "resultSummary", "outcome"],
                            },
                        },
                        compression_checkpoint: {
                            type: "boolean",
                            description: fieldGuideDescription("compression_checkpoint"),
                        },
                        checkpoint_label: {
                            type: "string",
                            description: fieldGuideDescription("checkpoint_label"),
                        },
                        subgoal_updates: {
                            type: "array",
                            maxItems: 20,
                            description: fieldGuideDescription("subgoal_updates"),
                            items: {
                                type: "object",
                                properties: {
                                    id: {
                                        type: "string",
                                        description: "Active sub-goal ID (sg-XXXXXXXX).",
                                    },
                                    status: {
                                        type: "string",
                                        enum: ["in_progress", "done", "blocked", "canceled"],
                                    },
                                    note: {
                                        type: "string",
                                        description: "Optional free-text note (≤ 300 chars).",
                                    },
                                },
                                required: ["id", "status"],
                            },
                        },
                        stop_reason: {
                            type: "string",
                            enum: ["gave_up", "blocked", "needs_human_input"],
                            description: fieldGuideDescription("stop_reason"),
                        },
                        no_change_reason: {
                            type: "string",
                            description: fieldGuideDescription("no_change_reason"),
                        },
                        outcome: {
                            type: "string",
                            enum: ["success", "partial", "failed", "blocked"],
                            description: fieldGuideDescription("outcome"),
                        },
                        blocker: {
                            type: "string",
                            description: fieldGuideDescription("blocker"),
                        },
                        gate_ids: {
                            type: "array",
                            maxItems: 20,
                            description: fieldGuideDescription("gate_ids"),
                            items: { type: "string" },
                        },
                        retroactiveClaims: {
                            type: "array",
                            items: {
                                type: "object",
                                properties: {
                                    round: { type: "integer", minimum: 1 },
                                    claim: { type: "string" },
                                },
                                required: ["round", "claim"],
                                additionalProperties: false,
                            },
                            description: fieldGuideDescription("retroactiveClaims"),
                        },
                        prompt_requests: {
                            type: "object",
                            description: fieldGuideDescription("prompt_requests"),
                            properties: {
                                emphasize: {
                                    type: "array",
                                    items: { type: "string" },
                                    description: "Current governance objects to emphasize in the next prompt. Match by real stable id (c-/cr-/rc-/rci-/sg-/f-XXXXXXXX), the reserved id 'recovery', or normalized-exact text — a paraphrase matches nothing. Closed/historical objects never resurrect. Matched objects move into Critical Context; cap is L1 3 / L2 5. Pure reordering — no duplicated content.",
                                },
                                confusion_points: {
                                    type: "array",
                                    items: { type: "string" },
                                    description: "Things you're confused about. Echoed at the TOP of the next prompt as your own notes, not as LoopForge findings; they are never matched against state. Max 3 entries, each ≤ 200 chars recommended.",
                                },
                            },
                        },
                        round_contract: {
                            type: "object",
                            description: fieldGuideDescription("round_contract"),
                            properties: {
                                work_item: {
                                    type: "string",
                                    minLength: 1,
                                    maxLength: 200,
                                    description: "Required. The bounded deliverable this contract slice " +
                                        "produces — an outcome, not an activity. Rendered as the " +
                                        "Current Task heading. 1–200 chars.",
                                },
                                items: {
                                    type: "array",
                                    minItems: 1,
                                    maxItems: 20,
                                    description: "Required, at least one (max 20). Each item is an " +
                                        "acceptance condition for the deliverable, bound to its own " +
                                        "evidence commands. The runtime derives a stable " +
                                        "rci-XXXXXXXX id per item and renders it in the prompt — " +
                                        "cite that id in execution_report.contract_item_claims.",
                                    items: {
                                        type: "object",
                                        properties: {
                                            description: {
                                                type: "string",
                                                minLength: 1,
                                                maxLength: 200,
                                                description: "What must be true for this acceptance condition. " +
                                                    "1–200 chars.",
                                            },
                                            criterion_refs: {
                                                type: "array",
                                                maxItems: 20,
                                                items: { type: "string" },
                                                description: "Optional. Real cr-XXXXXXXX ids of ACTIVE criteria rendered in this prompt. Free text and unknown ids are rejected. Max 20.",
                                            },
                                            subgoal_refs: {
                                                type: "array",
                                                maxItems: 20,
                                                items: { type: "string" },
                                                description: "Optional. sg-XXXXXXXX ids of ACTIVE sub-goals displayed in this prompt. A sub-goal created by this same submission's emerged_subtasks becomes referenceable next round. Max 20 ids. A machine-verified item produces the derived verified-subgoal fact for exactly the ids it names here.",
                                            },
                                            verify_with: {
                                                type: "array",
                                                minItems: 1,
                                                maxItems: 20,
                                                items: { type: "string" },
                                                description: "Required, at least one. Names of configured, " +
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
                                    type: "array",
                                    maxItems: 50,
                                    items: { type: "string" },
                                    description: "Optional, report-only. The files/directories you intend " +
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
                            type: "object",
                            description: fieldGuideDescription("contract_transition"),
                            properties: {
                                kind: {
                                    type: "string",
                                    const: "supersede",
                                    description: "Only \"supersede\" is supported.",
                                },
                                contract_id: {
                                    type: "string",
                                    pattern: "^rc-[a-f0-9]{8}$",
                                    description: "The rc-XXXXXXXX id of the ACTIVE contract rendered in " +
                                        "this prompt. A stale/other id is rejected.",
                                },
                                reason: {
                                    type: "string",
                                    maxLength: 500,
                                    description: "Optional Agent report, recorded verbatim for audit only.",
                                },
                            },
                            required: ["kind", "contract_id"],
                            additionalProperties: false,
                        },
                    },
                },
            },
            required: ["sessionId", "roundId", "transactionId"],
        },
    },
    {
        name: "loopforge_checkpoint",
        description: "v3.9.7: Create an explicit mid-round workspace checkpoint (savepoint). " +
            "The call itself is the Agent's decision that this state is worth " +
            "restoring to. It creates no round, no commit and no progress; the " +
            "checkpoint becomes a visible recovery target only through the held " +
            "transaction's ref list. Requires the same sessionId/roundId/" +
            "transactionId anchors as loopforge_next.",
        inputSchema: {
            type: "object",
            properties: {
                sessionId: {
                    type: "string",
                    description: "Session ID returned by loopforge_start.",
                },
                roundId: {
                    type: "string",
                    description: "The held roundId.",
                },
                transactionId: {
                    type: "string",
                    description: "The held transactionId.",
                },
            },
            required: ["sessionId", "roundId", "transactionId"],
            additionalProperties: false,
        },
    },
    {
        name: "loopforge_status",
        description: "Inspect loop state. view=session (default): session status, round identity, success trajectory and typed projection. view=loop: loop health (goal alignment, constraints, drift). view=all: summary of every persisted loop. view=audit: read-only end-of-loop verification audit (claims, gates, verdict, sequence integrity).",
        inputSchema: {
            type: "object",
            properties: {
                sessionId: {
                    type: "string",
                    description: "Session ID returned by loopforge_start (views session/audit).",
                },
                loopId: {
                    type: "string",
                    description: "Loop ID (views loop/audit).",
                },
                view: {
                    type: "string",
                    enum: ["session", "loop", "all", "audit", "explain"],
                    description: "Which view to return. Defaults to session. explain (v3.8) is the read-only per-round \"why\" view over committed facts.",
                },
                round: {
                    type: "number",
                    description: "view=explain only: return that single round's \"why\" view. Omit for the whole timeline.",
                },
            },
            required: [],
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
        name: "loopforge_pause",
        description: "Pause a running loop session. The loop suspends at the next round boundary and its state is persisted to vault. Paused loops can be resumed with loopforge_resume. Use this to interrupt a long-running loop without losing progress.",
        inputSchema: {
            type: "object",
            properties: {
                sessionId: {
                    type: "string",
                    description: "Session ID to pause.",
                },
            },
            required: ["sessionId"],
        },
    },
    {
        name: "loopforge_replay",
        description: "Replay a completed or running loop as an auditable round timeline. " +
            "Pass sessionId for a live session, or loopId to replay straight from " +
            "the vault (works after a process restart, when no session is in " +
            "memory) — the timeline is derived from committed round documents.",
        inputSchema: {
            type: "object",
            properties: {
                sessionId: {
                    type: "string",
                    description: "Session ID to replay (live sessions).",
                },
                loopId: {
                    type: "string",
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
        description: "Resume a loop from vault state. Works for both: (a) running sessions that were interrupted by a process restart, and (b) paused sessions (via loopforge_pause). Returns the compiled prompt for the next round, or null with a stopReason if the loop is already complete.",
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
        name: "loopforge_gate_check",
        description: "v3.7.1: Structured preflight for a high-risk action. Classifies a " +
            "GateActionDescriptor as user_required (needs human authorization — " +
            "persists a gate_opened record you must cite via evaluation.gate_ids " +
            "once approved) or agent_allowed (no record, no human needed). " +
            "Never executes the action, never approves it, never advances a round. " +
            "Hidden when policy.gate.enabled=false (direct calls return gate_disabled).",
        inputSchema: {
            type: "object",
            properties: {
                sessionId: { type: "string", description: "Session ID." },
                roundId: { type: "string", description: "RoundId from the latest response." },
                action: {
                    type: "object",
                    description: "The action the agent plans to perform.",
                    properties: {
                        description: {
                            type: "string",
                            description: "What the action does, e.g. 'Deploy to production'.",
                        },
                        scope: {
                            type: "array",
                            items: { type: "string" },
                            description: "Files / systems / services the action touches.",
                        },
                        effects: {
                            type: "array",
                            items: {
                                type: "string",
                                enum: [
                                    "workspace_write", "production", "credentials", "data_migration",
                                    "public_api", "publish", "payment", "external_communication",
                                    "network",
                                ],
                            },
                        },
                        reversibility: {
                            type: "string",
                            enum: ["reversible", "recoverable", "irreversible", "unknown"],
                        },
                        authorization: {
                            type: "string",
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
        description: "v3.7.1: Record a human decision for a previously opened user gate. " +
            "The caller is still the Agent — LoopForge cannot machine-verify that a " +
            "human is present; the decision is recorded and audited, and the gate's " +
            "approval binds to the canonical action (any change expires it). " +
            "Agent gates are resolved by submitting evidence, never here. " +
            "Hidden when policy.gate.enabled=false (direct calls return gate_disabled).",
        inputSchema: {
            type: "object",
            properties: {
                sessionId: {
                    type: "string",
                    description: "Session ID whose loop owns the gate.",
                },
                gateId: {
                    type: "string",
                    description: "Gate id returned by loopforge_gate_check.",
                },
                approved: {
                    type: "boolean",
                    description: "Whether the human authorizes the action.",
                },
                note: {
                    type: "string",
                    description: "Optional human note recorded with the decision.",
                },
            },
            required: ["sessionId", "gateId", "approved"],
        },
    },
];
const ADVANCE_OUTPUT_SCHEMA = {
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
        transactionId: { type: ["string", "null"], description: "v3.9.7: the held transaction identity to echo on the next submission." },
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
            description: "v3.9.7: committed rollback directive facts and the verified restore that produced the redo prompt.",
        },
        verificationStatus: { enum: ["trusted", "insufficient", "contradicted"] },
        submission_guidance: {
            type: ["object", "null"],
            additionalProperties: true,
            description: "v3.9.1: current-fact submission guidance (real contract item ids, " +
                "active sub-goal ids, usable commands, applicable fields). Derived, " +
                "never persisted; terminal results with no prompt omit it.",
        },
        submission_receipt: {
            type: ["object", "null"],
            additionalProperties: true,
            description: "v3.9.1: what this submission did — saved/not-applied reports, " +
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
const CHECKPOINT_OUTPUT_SCHEMA = {
    type: "object",
    properties: {
        ok: { type: "boolean" },
        error: { type: "object", additionalProperties: true },
        sessionId: { type: "string" },
        checkpointId: { type: "string" },
        transactionId: { type: "string" },
        roundId: { type: "string" },
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
export const TOOL_OUTPUT_SCHEMAS = {
    loopforge_start: ADVANCE_OUTPUT_SCHEMA,
    loopforge_next: ADVANCE_OUTPUT_SCHEMA,
    loopforge_resume: ADVANCE_OUTPUT_SCHEMA,
    loopforge_checkpoint: CHECKPOINT_OUTPUT_SCHEMA,
    loopforge_status: {
        type: "object",
        properties: {
            ok: { type: "boolean", description: "v3.8: uniform result envelope — false means the error object describes a rejected call." },
            error: { type: "object", additionalProperties: true, description: "v3.8 ToolError: { code, message, retryable, sessionId?, roundId?, details? }" },
            sessionId: { type: "string" },
            loopId: { type: "string" },
            round: { type: "number" },
            roundId: { type: ["string", "null"] },
            transactionId: { type: ["string", "null"] },
            checkpoints: { type: ["array", "null"], items: { type: "object", additionalProperties: true } },
            beforeCheckpointError: { type: ["object", "null"], additionalProperties: true },
            maxRounds: { type: "number" },
            status: { enum: ["running", "stopped", "stalled", "paused"] },
            successTrajectory: { type: "array", items: { type: "boolean" } },
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
            legacyRounds: {
                type: "array",
                items: { type: "object", additionalProperties: true },
                description: "v3.9.1: rounds whose persisted envelope version is unsupported. " +
                    "They are NOT history; the list makes the loss visible.",
            },
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
function closeObjectSchemas(schema) {
    const result = { ...schema };
    if (result.type === "object") {
        result.additionalProperties = false;
        if (isRecord(result.properties)) {
            result.properties = Object.fromEntries(Object.entries(result.properties).map(([key, value]) => [
                key,
                isRecord(value) ? closeObjectSchemas(value) : value,
            ]));
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
function prepareInputSchema(name, schema) {
    const result = closeObjectSchemas(schema);
    if (name !== "loopforge_next" || !isRecord(result.properties))
        return result;
    const evaluation = result.properties.evaluation;
    if (!isRecord(evaluation) || !isRecord(evaluation.properties))
        return result;
    evaluation.properties = Object.fromEntries(Object.entries(evaluation.properties).map(([field, value]) => {
        if (CORE_EVALUATION_FIELDS.has(field) || !isRecord(value))
            return [field, value];
        return [field, typeof value.description === "string"
                ? { description: value.description }
                : {}];
    }));
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
    constructor(message) {
        super(message);
        this.name = "ToolInputValidationError";
    }
}
function typeMatches(value, type) {
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
function validateSchema(value, schema, path) {
    // v2.14: an explicitly-undefined optional field is the same as absent —
    // output objects carry `key: undefined` after spreads of optional fields.
    if (value === undefined)
        return;
    const types = Array.isArray(schema.type) ? schema.type : [schema.type];
    if (!types.some((type) => typeMatches(value, type))) {
        throw new ToolInputValidationError(`${path} must be ${types.join(" or ")}`);
    }
    if (types.some((type) => type === "object") && isRecord(value)) {
        const properties = isRecord(schema.properties) ? schema.properties : {};
        const required = Array.isArray(schema.required)
            ? schema.required.filter((item) => typeof item === "string")
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
            value.forEach((item, index) => validateSchema(item, schema.items, `${path}[${index}]`));
        }
        return;
    }
    if (types.some((type) => type === "string") && typeof value === "string") {
        // Enforce declared enums — the schemas advertise them, so validation
        // must too (v2.12: view/gateText enums were previously unchecked).
        if (Array.isArray(schema.enum) && !schema.enum.includes(value)) {
            throw new ToolInputValidationError(`${path} must be one of: ${schema.enum.join(", ")}`);
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
export function validateToolInput(name, input) {
    const contract = TOOL_SCHEMAS.find((schema) => schema.name === name);
    if (!contract)
        throw new ToolInputValidationError(`Unknown tool: ${name}`);
    validateSchema(input, contract.inputSchema, "arguments");
}
/** Validate a server dispatch without turning a malformed evaluation into a
 * JSON-RPC transport error. The advertised schema stays strict so clients can
 * construct valid calls; the runtime envelope validates every outer argument,
 * then lets loopforge_next return its retryable evaluation_invalid payload for
 * core evaluation mistakes. Once the core is valid, the full schema still
 * rejects unknown fields and other contract violations. */
export function validateToolDispatchInput(name, input) {
    if (name !== "loopforge_next") {
        validateToolInput(name, input);
        return;
    }
    const contract = TOOL_SCHEMAS.find((schema) => schema.name === name);
    if (!contract)
        throw new ToolInputValidationError(`Unknown tool: ${name}`);
    const properties = isRecord(contract.inputSchema.properties)
        ? contract.inputSchema.properties
        : {};
    validateSchema(input, {
        ...contract.inputSchema,
        required: ["sessionId", "roundId"],
        properties: { ...properties, evaluation: {} },
    }, "arguments");
    if (!isRecord(input.evaluation))
        return;
    const validation = validateCoreSelfEvaluation(input.evaluation);
    if (validation.missing.length > 0 || validation.invalid.length > 0)
        return;
    validateSchema(input, contract.inputSchema, "arguments");
}
/** Validate a handler's output against the tool's declared output schema.
 *  v2.14: the schemas were advertised in tools/list but never enforced —
 *  a mismatched output silently violated the declared contract. Throws
 *  ToolInputValidationError on mismatch. */
export function validateToolOutput(name, output) {
    const schema = TOOL_OUTPUT_SCHEMAS[name];
    if (!schema)
        return;
    validateSchema(output, schema, `output.${name}`);
}
/** v3.8: capability warnings for the current policy, merged with the compile's
 *  own warnings. Derived through the SAME function `RoundDriver.prepare()`
 *  uses, so the start/resume banner and the prepared round cannot tell two
 *  different stories about what the runtime can observe. Never persisted. */
function capabilityWarningList(existing) {
    return [...new Set([
            ...(existing ?? []),
            ...deriveEvidenceCapability(getPolicy()).warnings,
        ])];
}
/** v3.9.4: the stable envelope for a prompt-projection code defect. */
function projectionErrorResult(error) {
    if (error instanceof ProjectionCoverageError) {
        return {
            error: "projection_incomplete",
            errorMessage: error.message,
            details: { coverage: error.coverage },
        };
    }
    return null;
}
export const TOOL_HANDLERS = {
    async loopforge_start(mgr, input) {
        const startInput = {
            task: String(input.task ?? ""),
            loopId: input.loopId,
            maxRounds: typeof input.maxRounds === "number" ? input.maxRounds : undefined,
            domain: input.domain,
            planSource: input.planSource,
            constraints: Array.isArray(input.constraints)
                ? input.constraints
                : undefined,
            criteria: Array.isArray(input.criteria)
                ? input.criteria
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
            }
            catch (error) {
                return {
                    error: "invalid_argument",
                    errorMessage: `invalid loopId: ${error.message}`,
                };
            }
        }
        // A malformed loop_policy.json is a configuration defect, not a bad
        // argument — it must not escape as an opaque JSON-RPC internal error.
        let result;
        try {
            result = await mgr.create(startInput);
        }
        catch (error) {
            if (error instanceof StartCriteriaError) {
                return {
                    error: "invalid_argument",
                    errorMessage: error.message,
                };
            }
            const projectionFailure = projectionErrorResult(error);
            if (projectionFailure)
                return projectionFailure;
            if (error instanceof SessionLeaseConflictError) {
                return {
                    error: "lease_conflict",
                    errorMessage: `loop "${error.loopId}" is owned by another running LoopForge process`,
                };
            }
            return {
                error: "policy_invalid",
                errorMessage: `the runtime policy could not be loaded: ${error.message}`,
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
    async loopforge_next(mgr, input) {
        const sessionId = String(input.sessionId ?? "");
        const output = String(input.output ?? "");
        const rawEval = input.evaluation;
        const rawRecovery = input.recovery;
        const roundId = input.roundId === undefined ? undefined : String(input.roundId);
        const transactionId = input.transactionId === undefined
            ? undefined
            : String(input.transactionId);
        if (!sessionId) {
            return { error: "invalid_argument", errorMessage: "sessionId is required" };
        }
        if (!transactionId || !transactionId.trim()) {
            return {
                error: "invalid_argument",
                errorMessage: "transactionId is required — pass the transactionId returned " +
                    "with the held prompt (loopforge_status or loopforge_resume returns it)",
                sessionId,
                roundId,
            };
        }
        if (rawRecovery !== undefined && rawEval !== undefined) {
            return {
                error: "recovery_invalid",
                errorMessage: "evaluation and recovery are mutually exclusive",
                sessionId,
                roundId,
            };
        }
        if (rawRecovery !== undefined) {
            if (!roundId || !roundId.trim()) {
                return {
                    error: "round_id_required",
                    errorMessage: "roundId is required — pass the roundId from the most recent " +
                        "loopforge_start / loopforge_next / loopforge_resume / loopforge_status response",
                    sessionId,
                };
            }
            const result = await mgr.recover(sessionId, rawRecovery, roundId, transactionId);
            if (result.submissionError) {
                return {
                    error: result.submissionError.code,
                    errorMessage: result.stopDetail ?? "the recovery request was rejected",
                    details: result.submissionError.details,
                    sessionId,
                    roundId,
                };
            }
            return { ...result };
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
        let result;
        try {
            result = await mgr.advance(sessionId, output, rawEval, roundId, transactionId);
        }
        catch (error) {
            const projectionFailure = projectionErrorResult(error);
            if (projectionFailure)
                return projectionFailure;
            throw error;
        }
        if (result.submissionError) {
            return {
                error: result.submissionError.code,
                errorMessage: result.stopDetail ?? "the submission was rejected",
                details: result.submissionError.details,
                sessionId,
                roundId,
            };
        }
        return { ...result };
    },
    async loopforge_checkpoint(mgr, input) {
        const sessionId = String(input.sessionId ?? "");
        const roundId = input.roundId === undefined ? "" : String(input.roundId);
        const transactionId = input.transactionId === undefined
            ? ""
            : String(input.transactionId);
        if (!sessionId) {
            return { error: "invalid_argument", errorMessage: "sessionId is required" };
        }
        if (!roundId.trim() || !transactionId.trim()) {
            return {
                error: "checkpoint_invalid",
                errorMessage: "roundId and transactionId are required — use the anchors from the held prompt",
                sessionId,
            };
        }
        const result = await mgr.checkpoint(sessionId, roundId, transactionId);
        if (result.error) {
            return {
                error: String(result.error),
                errorMessage: String(result.errorMessage ?? "the checkpoint was rejected"),
                details: result.details,
                sessionId,
                roundId,
            };
        }
        return { ok: true, ...result };
    },
    async loopforge_status(mgr, input) {
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
            transactionId: session.roundSnapshot?.transactionId ?? null,
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
            successTrajectory: mgr.getSuccessTrajectory(session.loopId),
            lease: mgr.getLeaseStatus(session.loopId),
            // v3.5: derived ACTIVE Round Contract (display-only — the compile and
            // verification gates derive the same value from the same committed
            // evals via the shared round-contract walker).
            activeContract: mgr.getActiveContract(sessionId),
            // v3.9.1: current-fact submission guidance for the held round. Same
            // derivation as start/next/resume; read-only and never persisted.
            submission_guidance: mgr.getSubmissionGuidance(sessionId),
            last_submission: mgr.getLastSubmissionReceipt(sessionId),
            last_rollback: mgr.replayRollbacks(session.loopId).at(-1) ?? null,
            // v3.8: the ONE capability fact — the static half the compile hashes
            // (what verification is possible) plus the live half rendered from the
            // last baseline. `available` is provider-registry state: reported here
            // and by `doctor`, never hashed.
            capability: deriveEvidenceCapability(getPolicy(), session.roundSnapshot?.beforeEvidence ?? []),
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
    async loopforge_stop(mgr, input) {
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
        const successTrajectory = mgr.getSuccessTrajectory(session.loopId);
        mgr.delete(sessionId);
        return { success: true, roundsCompleted, successTrajectory };
    },
    async loopforge_pause(mgr, input) {
        const sessionId = String(input.sessionId ?? "");
        if (!sessionId) {
            return { error: "invalid_argument", errorMessage: "sessionId is required" };
        }
        const result = mgr.pause(sessionId);
        return { ...result };
    },
    async loopforge_replay(mgr, input) {
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
                return {
                    sessionId,
                    loopId: session.loopId,
                    timeline,
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
        const timeline = mgr.replayByLoop(loopId);
        if (!timeline) {
            return {
                error: "state_unavailable",
                errorMessage: `no committed rounds found for loop "${loopId}"`,
            };
        }
        // sessionId omitted on the vault path (its output schema is string-only).
        return {
            ...(sessionId ? { sessionId } : {}),
            loopId,
            timeline,
            rollbacks: mgr.replayRollbacks(loopId),
            legacyRounds: mgr.replayLegacyRounds(loopId),
        };
    },
    async loopforge_resume(mgr, input) {
        const loopId = String(input.loopId ?? "");
        if (!loopId) {
            return { error: "invalid_argument", errorMessage: "loopId is required" };
        }
        try {
            validateLoopId(loopId);
        }
        catch (error) {
            return {
                error: "invalid_argument",
                errorMessage: `invalid loopId: ${error.message}`,
            };
        }
        // Paused recovery must run first so the persisted status is atomically
        // changed back to running before a prompt is returned.
        let result;
        try {
            result = await mgr.unpause(loopId);
            if (!result) {
                result = await mgr.resume(loopId);
            }
        }
        catch (error) {
            const projectionFailure = projectionErrorResult(error);
            if (projectionFailure)
                return projectionFailure;
            throw error;
        }
        if (!result) {
            return {
                error: "state_unavailable",
                errorMessage: `no saved session found for loop "${loopId}"`,
            };
        }
        return { ...result };
    },
    async loopforge_gate_check(mgr, input) {
        // v3.7.1: hidden when disabled — direct calls get a stable error.
        if (!getPolicy().gate.enabled)
            return { error: "gate_disabled" };
        const sessionId = String(input.sessionId ?? "");
        const roundId = String(input.roundId ?? "");
        const action = input.action;
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
        const descriptor = {
            description: String(action.description ?? ""),
            scope: Array.isArray(action.scope)
                ? action.scope.filter((v) => typeof v === "string")
                : [],
            effects: Array.isArray(action.effects)
                ? action.effects.filter((v) => typeof v === "string")
                    .filter((_v) => true)
                : [],
            reversibility: (["reversible", "recoverable", "irreversible", "unknown"]
                .includes(String(action.reversibility))
                ? String(action.reversibility)
                : "unknown"),
            authorization: (["agent_allowed", "user_required", "unknown"]
                .includes(String(action.authorization))
                ? String(action.authorization)
                : "unknown"),
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
    async loopforge_gate_resolve(mgr, input) {
        // v3.7.1: hidden when disabled — direct calls get a stable error.
        if (!getPolicy().gate.enabled)
            return { error: "gate_disabled" };
        return mgr.resolveGate(String(input.sessionId ?? ""), String(input.gateId ?? ""), input.approved === true, input.note === undefined ? undefined : String(input.note));
    },
};
//# sourceMappingURL=tools.js.map