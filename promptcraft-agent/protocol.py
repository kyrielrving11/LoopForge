"""PromptCraft Agent — I/O protocol definitions.

All data exchanged between the Main Agent and PromptCraft Agent flows through
these structured schemas. This is the contract layer — no implementation logic
lives here, only validation and serialisation.

Design principle:
    Protocol over platform. These schemas work with any main agent (Claude Code,
    Codex, etc.) without requiring the main agent to modify its own system prompt.
"""

from __future__ import annotations

import uuid
from dataclasses import dataclass, field, asdict
from enum import Enum
from typing import Any


# ── Enums ────────────────────────────────────────────────────────────────────

class Mode(str, Enum):
    """Agent invocation mode."""
    FULL     = "full"      # Complete pipeline: hydrate → build → checkpoint
    QUICK    = "quick"     # Skip vault I/O, build only
    REVIEW   = "review"    # Audit an existing prompt, no new generation
    FEEDBACK = "feedback"  # Learn from execution results, write improvement notes
    OVERLAY  = "overlay"   # Skill personalisation: hydrate + filter overlay constraints
    ANALYZE  = "analyze"   # Pattern analysis: aggregate feedback → find patterns
    ADVISE   = "advise"    # Skill advisor: suggest evolution or creation
    BATCH    = "batch"     # Multi-task batch processing (hydrate once, parallel execution)


class Importance(str, Enum):
    """Blast radius tier for vault entries (Layer 4 of system prompt)."""
    GLOBAL           = "GLOBAL"            # All projects, all future sessions
    STAGE            = "STAGE"             # Current task only
    WORKING          = "WORKING"           # Still forming, expect revision
    REFERENCE        = "REFERENCE"         # Consultable, not auto-injected
    SKILL_SUGGESTION = "SKILL_SUGGESTION"  # Zero blast radius until user confirms


class Technique(str, Enum):
    """The 7 prompt-engineering techniques."""
    ZERO_SHOT      = "zero-shot"
    FEW_SHOT       = "few-shot"
    ZERO_SHOT_COT  = "zero-shot-cot"
    FEW_SHOT_COT   = "few-shot-cot"
    STEP_BACK      = "step-back"
    LEAST_TO_MOST  = "least-to-most"
    TREE_OF_THOUGHT = "tree-of-thought"


class AgentStatus(str, Enum):
    """Top-level response status."""
    OK      = "ok"
    ERROR   = "error"
    STALLED = "stalled"  # Circuit breaker triggered — needs main agent intervention


class ContinueReason(str, Enum):
    """Why the Engine decided to continue iterating (cf. Claude Code's 7 continue sites)."""
    NEXT_TURN            = "next_turn"            # Normal: feedback received, refining
    TECHNIQUE_SWITCH     = "technique_switch"     # Current technique unsuitable, trying another
    CONSTRAINT_CONFLICT  = "constraint_conflict"  # Two constraints conflict, needs resolution
    SCOPE_CHANGE         = "scope_change"         # User requirements shifted, realigning
    FIRST_CALL           = "first_call"           # Initial call for a new task
    OVERLAY_APPLIED      = "overlay_applied"      # Skill enhanced with overlay, awaiting execution feedback
    PATTERN_READY        = "pattern_ready"        # Enough records accumulated, pattern analysis warranted
    EVOLUTION_SUGGESTED  = "evolution_suggested"  # Skill advice generated, waiting for user confirmation


# ── Vault references ──────────────────────────────────────────────────────────

@dataclass
class VaultRef:
    """Reference to a saved prompt version in vault."""
    id: str
    version_tag: str          # "v1", "v2", ...
    md_path: str              # Relative path within vault, e.g. "prompts/task-id/v1.md"


# ── Structured summary ────────────────────────────────────────────────────────

@dataclass
class Summary:
    """10-field structured summary stored in vault (metadata tier)."""
    goal: str                              # One-sentence task objective
    technique: str                         # Selected technique name
    importance: str                        # GLOBAL | STAGE | WORKING | REFERENCE
    what_was_done: list[str] = field(default_factory=list)
    key_decisions: list[str] = field(default_factory=list)
    hard_constraints_added: list[str] = field(default_factory=list)
    rejected_directions: list[str] = field(default_factory=list)
    important_outputs: list[str] = field(default_factory=list)
    open_questions: list[str] = field(default_factory=list)
    summary_text: str = ""                 # 2-3 sentence natural-language summary


# ── Analysis — Router output ──────────────────────────────────────────────────

@dataclass
class Analysis:
    """Result of LLM Router evaluation."""
    technique: str
    rationale: str           # One sentence
    independence: str
    cognitive_load: str


# ── Request schemas ───────────────────────────────────────────────────────────

@dataclass
class DomainKnowledge:
    """Domain-specific data extracted from PRD / tech design docs."""
    sample_data: dict[str, Any] | None = None
    field_definitions: dict[str, Any] | None = None
    reference_ranges: dict[str, Any] | None = None
    input_output_pairs: list[dict[str, Any]] | None = None
    specifications: str | None = None
    reference_implementation: str | None = None


@dataclass
class Context:
    """Rich context from the main agent's current session."""
    prd: str | None = None                   # Full PRD text
    tech_design: str | None = None            # Full technical design doc
    domain_knowledge: DomainKnowledge | None = None
    current_file: str | None = None           # Path or content of current file
    tech_stack: str | None = None
    # Session environment (set by main agent before calling)
    session_context: str | None = None        # Brief: what the main agent is doing right now
    previous_agent_calls: int = 0             # How many times Agent has been called this session


@dataclass
class VaultConfig:
    """Vault paths configuration."""
    project_vault: str = ".promptcraft/prompt_vault.json"
    global_vault: str  = "~/.promptcraft/global_vault.json"
    skills_dir: str     = "skills"
    no_global: bool     = False


@dataclass
class PromptCraftRequest:
    """What the main agent sends to PromptCraft Agent.

    This is the single entry point — every Agent invocation receives one of these.
    """
    task: str                                    # Required: user's core coding task
    mode: Mode = Mode.FULL
    context: Context = field(default_factory=Context)
    vault_config: VaultConfig = field(default_factory=VaultConfig)
    # For feedback mode
    feedback: ExecutionFeedback | None = None
    # For overlay mode (Skill enhancement)
    skill_name: str | None = None                # Skill to personalise
    # For iteration tracking (Engine sets these)
    task_id: str | None = None                   # None = first call; set = iteration
    version_of: str | None = None                # Previous version tag to fork from


@dataclass
class ExecutionFeedback:
    """Execution results passed back for feedback mode."""
    output: str                                 # Actual output produced
    success: bool
    constraint_violations: list[str] = field(default_factory=list)
    manual_fixes_needed: str = ""


# ── Response schemas ──────────────────────────────────────────────────────────

@dataclass
class Metadata:
    """Key decisions and constraints — what the main agent needs to know."""
    task_id: str
    skill_used: str
    hard_constraints: list[str] = field(default_factory=list)
    key_decisions: list[str] = field(default_factory=list)
    summary: Summary | None = None


@dataclass
class PromptCraftResponse:
    """Standard response: a complete, structured prompt ready for execution."""
    status: AgentStatus = AgentStatus.OK
    prompt: str | None = None                    # The full 8-section enhanced prompt
    analysis: Analysis | None = None
    metadata: Metadata | None = None
    vault: VaultRef | None = None
    error: str | None = None                     # Only when status=error


@dataclass
class FeedbackResponse:
    """Response in feedback mode: quality assessment and improvement notes."""
    status: AgentStatus = AgentStatus.OK
    quality_score: int = 0                       # 1-5
    constraint_compliance: dict[str, Any] = field(default_factory=dict)
    output_summary: str = ""
    issues_found: list[str] = field(default_factory=list)
    what_worked_well: list[str] = field(default_factory=list)
    improvement_notes: str = ""
    vault_ref: VaultRef | None = None             # New version created


# ── Stalled response (circuit breaker) ────────────────────────────────────────

@dataclass
class ConflictDetail:
    """Describes a constraint conflict the Agent cannot resolve alone."""
    conflicting_items: list[str]  # The constraints/tasks in conflict
    why_conflict: str             # Why they can't both be satisfied
    options: list[str]            # Concrete choices for the main agent / user


@dataclass
class StalledResponse:
    """Returned when the circuit breaker trips.

    The Agent has tried and failed to improve. It escalates a structured question
    to the main agent — NOT a raw prompt dump. The main agent translates this into
    natural language for the user.
    """
    status: AgentStatus = AgentStatus.STALLED
    tries: int = 0
    quality_trend: list[int] = field(default_factory=list)  # Scores across iterations
    blocker: str = ""                          # Why the loop stalled
    conflict_detail: ConflictDetail | None = None
    question_for_main_agent: str = ""          # Human-readable, one specific question
    last_prompt: str | None = None             # The best prompt so far (for reference)
    vault_ref: VaultRef | None = None


# ── Enhanced loop response (union type substitute) ────────────────────────────

@dataclass
class AgentLoopResult:
    """Unified result from one Agent Loop invocation.

    The main agent checks .status to decide next action:
      - OK      → execute the prompt
      - STALLED → read question_for_main_agent, ask user, call back with answer
      - ERROR   → handle failure
    """
    status: AgentStatus
    response: PromptCraftResponse | None = None
    feedback: FeedbackResponse | None = None
    stalled: StalledResponse | None = None


# ── Session state (Engine internal) ───────────────────────────────────────────

@dataclass
class SessionState:
    """Mutable state carried across Agent invocations within one session.

    Equivalent to query.ts's State object — reassigned as a whole on each iteration.
    """
    task_id: str
    call_count: int = 0
    quality_trend: list[int] = field(default_factory=list)    # Scores per iteration
    current_version: str = "v1"
    last_technique: str | None = None
    circuit_breaker_count: int = 0                            # Consecutive no-improvement
    continue_reason: ContinueReason = ContinueReason.FIRST_CALL
    # v3: cross-session feedback accumulation
    feedback_buffer: list[dict[str, Any]] = field(default_factory=list)
    last_overlay_used: str | None = None
    analysis_count: int = 0


# ── Tool System schemas (v3) ────────────────────────────────────────────────────

@dataclass
class OverlayConfig:
    """Output of PersonalizationTool — constraints filtered for a specific Skill.

    Unlike full GLOBAL injection, overlay only carries constraints tagged
    as relevant to the current Skill's domain.
    """
    skill_name: str
    constraints: list[str] = field(default_factory=list)   # Filtered relevant constraints
    preferences: dict[str, str] = field(default_factory=dict)  # user/project/team prefs


@dataclass
class PatternReport:
    """Output of PatternAnalysisTool — aggregate insights from N executions."""
    total_executions: int = 0
    high_freq_overlays: list[dict[str, Any]] = field(default_factory=list)
    missing_constraints: list[str] = field(default_factory=list)
    low_quality_task_types: list[str] = field(default_factory=list)
    summary: str = ""   # One-paragraph natural-language summary


@dataclass
class SkillAdvice:
    """Output of SkillAdvisorTool — a suggestion, not an auto-applied change.

    PromptCraft never modifies Skills directly. It produces advice
    (PR description, patch, overlay suggestion) and leaves execution
    to the main agent's built-in /create-skill or similar.
    """
    advice_type: str            # "evolution" | "creation"
    suggestion: str             # Natural-language suggestion for the user
    data_support: str           # Evidence backing the suggestion
    draft_content: str | None = None  # Optional: raw text for /create-skill


# ── Sub-agent output (unified — what flows back to the main agent) ─────────────

@dataclass
class SubagentOutput:
    """Unified output from subagent_adapter — what flows back to the main agent.

    This is the ONLY structure the main agent sees. Internal PromptCraft
    process (vault search, routing, tool selection) is invisible.
    """
    mode: str
    prompt_or_overlay: str | None = None       # overlay: filtered constraints
                                                # build: full 8-section prompt
                                                # other modes: None
    analysis: dict[str, Any] | None = None      # PatternReport or SkillAdvice as dict
    health: dict[str, Any] | None = None        # HealthReport as dict
    technique_used: str | None = None           # Which technique was selected (build)
    confidence: float = 0.0                     # 0-1 confidence in the output
    proactive_signals: list[str] = field(default_factory=list)  # Relevant vault history/pitfalls


# ── Batch Processing types ──────────────────────────────────────────────────────

@dataclass
class BatchItem:
    """One task within a batch request."""
    task: str
    skill_name: str | None = None
    context: Context | None = None
    feedback: ExecutionFeedback | None = None


@dataclass
class BatchRequest:
    """Multiple tasks processed in a single PromptCraft call.

    Hydrate once for all items, group by Skill match, process in parallel,
    aggregate results into a single response.
    """
    items: list[BatchItem]
    mode: Mode = Mode.BATCH
    vault_config: VaultConfig = field(default_factory=VaultConfig)
    task_id: str | None = None


@dataclass
class BatchSummary:
    """Aggregate stats for a batch execution."""
    total: int = 0
    succeeded: int = 0
    failed: int = 0
    skipped: int = 0


@dataclass
class BatchResponse:
    """Result of a batch invocation — per-item results + summary."""
    status: AgentStatus = AgentStatus.OK
    item_results: list[dict[str, Any]] = field(default_factory=list)
    batch_summary: BatchSummary = field(default_factory=BatchSummary)
    error: str | None = None


# ── Execution Boundary types ────────────────────────────────────────────────────

@dataclass
class ToolPermission:
    """Returned by Tool.check_permissions() — whether the tool may execute.

    Cf. Claude Code's checkPermission returning {action, message}.
    """
    action: str           # "allow" | "deny" | "warn"
    reason: str = ""      # Why denied, or warning message for "warn"
    warnings: list[str] = field(default_factory=list)

    @property
    def ok(self) -> bool:
        return self.action != "deny"


def tool_permission_allow() -> ToolPermission:
    return ToolPermission(action="allow")


def tool_permission_deny(reason: str) -> ToolPermission:
    return ToolPermission(action="deny", reason=reason)


def tool_permission_warn(message: str) -> ToolPermission:
    return ToolPermission(action="warn", warnings=[message])


# ── Serialisation helpers ─────────────────────────────────────────────────────

def to_dict(obj: Any) -> dict[str, Any]:
    """Convert any protocol dataclass to a JSON-serialisable dict."""
    def _convert(value: Any) -> Any:
        if isinstance(value, Enum):
            return value.value
        if isinstance(value, uuid.UUID):
            return str(value)
        if hasattr(value, "__dataclass_fields__"):
            return {k: _convert(v) for k, v in asdict(value).items()}
        if isinstance(value, dict):
            return {k: _convert(v) for k, v in value.items()}
        if isinstance(value, list):
            return [_convert(v) for v in value]
        return value
    return _convert(asdict(obj))


# ── Factory helpers ───────────────────────────────────────────────────────────

def make_task_id(task_description: str) -> str:
    """Derive a kebab-case task_id from a task description."""
    import re
    slug = task_description.lower().strip()[:60]
    slug = re.sub(r"[^a-z0-9\s-]", "", slug)
    slug = re.sub(r"\s+", "-", slug)
    return slug or "unnamed-task"


def new_vault_ref(task_id: str, version: int = 1) -> VaultRef:
    return VaultRef(
        id=str(uuid.uuid4()),
        version_tag=f"v{version}",
        md_path=f"prompts/{task_id}/v{version}.md",
    )
