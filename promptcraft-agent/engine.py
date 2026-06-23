"""PromptCraft Agent — PromptCraft Engine (outer loop manager).

The Engine manages the lifecycle of prompt iterations within a session.
It is the "QueryEngine" equivalent for PromptCraft — it decides whether to
continue refining, stop with success, or escalate via circuit breaker.

v3: Engine orchestrates Tools (Personalization / PromptBuild / PatternAnalysis
/ SkillAdvisor) via the ToolRegistry. Feedback collection is inline.

Cf. Claude Code's QueryEngine vs query() separation.

=== HOTSPOT OWNERSHIP ===

Belongs here:
  - Lifecycle orchestration: the 5 public invoke_* methods (one per mode)
  - Mode routing: mapping user intent → tool selection
  - Feedback pipeline: quality scoring → buffer → vault persistence → analysis trigger
  - Vault I/O: _persist_feedback_to_vault, _flush_feedback_buffer, _run_aggregate_query
  - Circuit breaker coordination: _guard_tool_execution, _should_break
  - Batch processing: invoke_batch, _batch_response_to_loop
  - EngineContext + EngineMetrics (merged from context.py)

Does NOT belong here (add to these files instead):
  - Tool implementations → promptcraft-agent/tools/*.py
  - Protocol / schema definitions → promptcraft-agent/protocol.py
  - Execution boundary guards → promptcraft-agent/boundary.py
  - HealthReport logic → promptcraft-agent/health_report.py

Tests: tests/test_engine_modes.py (19 tests for 5 invoke_* + maybe_silent_analyze)
"""

from __future__ import annotations

import json
import subprocess
import sys
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from protocol import (
    AgentLoopResult, AgentStatus, Analysis, ConflictDetail,
    ContinueReason, FeedbackResponse, Mode, PromptCraftRequest,
    PromptCraftResponse, SessionState, StalledResponse,
)
from builder import score_quality
from health_report import HealthReport
from boundary import CircuitBreaker, BreakerState
from tools import ToolRegistry, ToolResult
from tools.personalization import PersonalizationTool
from tools.prompt_build import PromptBuildTool
from tools.pattern_analysis import PatternAnalysisTool
from tools.skill_advisor import SkillAdvisorTool


# ── Engine Metrics ────────────────────────────────────────────────────────────

@dataclass
class EngineMetrics:
    """Observability counters for silent/non-blocking operations.

    Silent failures (subprocess timeouts, vault write errors, cache misses)
    are tracked here so the HealthReport can surface degradation without
    breaking the fail-closed contract.

    All counters are monotonic within a session.
    """
    vault_write_errors: int = 0
    vault_write_timeouts: int = 0
    vault_write_bytes: int = 0
    silent_analysis_errors: int = 0
    subprocess_timeouts: int = 0
    hydrate_cache_misses: int = 0
    feedback_buffer_flushes: int = 0
    feedback_buffer_max_size: int = 0
    session_start: float = 0.0

    FEEDBACK_FLUSH_INTERVAL = 5


# ── Engine Context ────────────────────────────────────────────────────────────

@dataclass
class EngineContext:
    """Per-session context shared across all Tools in one Engine session.

    Three layers:
      Layer 1 — Hydration: vault data, loaded per-session with cache control
      Layer 2 — Intermediate products: Tool outputs passed to downstream Tools
      Layer 3 — Accumulation: grows across invocations within the session
    """
    hydrate_results: dict[str, Any] | None = None
    hydrate_mode: str = ""
    _hydrate_cache_key: str = ""
    _hydrate_dirty: bool = False

    overlay_config: "OverlayConfig | None" = None
    pattern_report: "PatternReport | None" = None
    skill_advice: "SkillAdvice | None" = None
    proactive_signals: list[str] = field(default_factory=list)

    feedback_signals: list[dict[str, Any]] = field(default_factory=list)
    analysis_count: int = 0

    skills_dir: str = "skills"

    def invalidate_hydrate(self) -> None:
        self._hydrate_dirty = True
        self._hydrate_cache_key = ""

    def is_hydrate_fresh(self, cache_key: str = "") -> bool:
        if self._hydrate_dirty:
            return False
        if self.hydrate_results is None:
            return False
        if cache_key and self._hydrate_cache_key != cache_key:
            return False
        return True

    def cache_hydrate(self, results: dict[str, Any], cache_key: str) -> None:
        self.hydrate_results = results
        self._hydrate_cache_key = cache_key
        self._hydrate_dirty = False


# ── Engine ─────────────────────────────────────────────────────────────────────

@dataclass
class PromptCraftEngine:
    """Manages the outer Agent Loop — iteration lifecycle, quality tracking,
    and circuit breaker decisions.

    One Engine instance per session. Each `invoke()` call represents one
    wake-up of the PromptCraft Agent by the main agent.

    v3: Tools are registered in priority order — Personalization checks first
    (Skill overlay), then Feedback/Review, and PromptBuild is the fallback.
    """

    skills_dir: str = "skills"
    state: SessionState | None = None    # None until first invocation

    # De-duplication cache (prevents recording the same constraint twice)
    _seen_constraints: set[str] = field(default_factory=set)

    # Circuit breaker — Layer 5 of the Execution Boundary
    _breaker: CircuitBreaker | None = field(default=None, repr=False)

    # Tool registry — built lazily on first invoke
    _registry: ToolRegistry | None = field(default=None, repr=False)

    # Paths for vault persistence (resolved relative to the project root)
    _checkpoint_script: Path | None = field(default=None, repr=False)

    # Session context — shared data container with lifecycle rules
    _ctx: EngineContext | None = field(default=None, repr=False)

    # Session metrics — observability counters for silent failures
    _metrics: EngineMetrics | None = field(default=None, repr=False)

    # Last task processed — used for lightweight vault probing in maybe_silent_analyze
    _last_task: str | None = field(default=None, repr=False)

    # Vault hints cache — avoids re-probing on every call
    _vault_hints: list[str] | None = field(default=None, repr=False)
    _vault_hints_task: str | None = field(default=None, repr=False)

    def _get_registry(self) -> ToolRegistry:
        """Lazy-init the tool registry with all four tools in priority order."""
        if self._registry is None:
            self._registry = ToolRegistry()
            # Priority order: Personalization > Pattern > Advisor > Build (fallback)
            self._registry.register(PersonalizationTool())
            self._registry.register(PatternAnalysisTool())
            self._registry.register(SkillAdvisorTool())
            self._registry.register(PromptBuildTool())  # Last = fallback
        return self._registry

    def _ensure_init(self, request: PromptCraftRequest) -> None:
        """Lazy-init session state, context, and circuit breaker on first invocation."""
        if self.state is None:
            from protocol import make_task_id
            self.state = SessionState(
                task_id=request.task_id or make_task_id(request.task),
            )
        if self._ctx is None:
            self._ctx = EngineContext(skills_dir=self.skills_dir)
        if self._breaker is None:
            self._breaker = CircuitBreaker()
        if self._metrics is None:
            import time as _time
            self._metrics = EngineMetrics(session_start=_time.monotonic())

    def _guard_tool_execution(self, tool, request: Any) -> AgentLoopResult | None:
        """Layer 2 + Layer 5: check circuit breaker and tool permissions.

        Returns None if execution may proceed. Returns an AgentLoopResult
        (denied/error) if the breaker is OPEN or the tool denies the request.
        The caller should return this result immediately.
        """
        # Layer 5: Circuit breaker
        if not self._breaker.before_tool_call():
            return AgentLoopResult(
                status=AgentStatus.STALLED,
                stalled=StalledResponse(
                    blocker="circuit_breaker_open",
                    question_for_main_agent=(
                        "PromptCraft's circuit breaker is OPEN — too many "
                        "consecutive denials. Wait for cooldown or investigate "
                        "the root cause of repeated denials."
                    ),
                ),
            )

        # Layer 2: Tool-level permission check
        if hasattr(tool, 'check_permissions'):
            perm = tool.check_permissions(
                {"task": getattr(request, "task", ""),
                 "skill_name": getattr(request, "skill_name", None),
                 "feedback": getattr(request, "feedback", None)},
                self._ctx,
            )
            if perm.action == "deny":
                self._breaker.after_denial()
                return AgentLoopResult(
                    status=AgentStatus.ERROR,
                    response=PromptCraftResponse(
                        status=AgentStatus.ERROR,
                        error=f"Tool denied: {perm.reason}",
                    ),
                )

        return None  # Proceed

    def invoke(
        self,
        request: PromptCraftRequest,
        hydrate_results: dict[str, Any] | None = None,
    ) -> AgentLoopResult:
        """Entry point. The main agent calls this whenever it wakes PromptCraft.

        Routes by mode to the dedicated invoke_* methods. Backward-compatible
        wrapper — subagent_adapter.py prefers the dedicated methods directly.
        REVIEW is the only legacy mode with a dedicated handler (no tool).
        """
        # ── BATCH: handle before _ensure_init (BatchRequest has no .task field) ──
        if request.mode == Mode.BATCH:
            from protocol import BatchRequest
            if isinstance(request, BatchRequest):
                return self._batch_response_to_loop(
                    self.invoke_batch(request, hydrate_results)
                )
            return AgentLoopResult(
                status=AgentStatus.ERROR,
                response=PromptCraftResponse(
                    status=AgentStatus.ERROR,
                    error="BATCH mode requires a BatchRequest with items list.",
                ),
            )

        # ── Lazy initialisation ──
        self._ensure_init(request)
        self._last_task = request.task

        # ── Hydrate caching (progressive cost model, cf. Claude Code memoization) ──
        if hydrate_results is not None:
            cache_key = f"{request.mode.value}:{request.task[:60]}"
            if not self._ctx.is_hydrate_fresh(cache_key):
                self._ctx.cache_hydrate(hydrate_results, cache_key)

        # ── REVIEW: dedicated handler ──
        if request.mode == Mode.REVIEW:
            return self._handle_review(request, hydrate_results)

        # ── OVERLAY: force PersonalizationTool (skill_name must be set) ──
        if request.mode == Mode.OVERLAY:
            return self.invoke_overlay(request, hydrate_results)

        # ── ANALYZE: force pattern analysis (explicit trigger) ──
        if request.mode == Mode.ANALYZE:
            return self.invoke_analyze(request, hydrate_results)

        # ── ADVISE: force skill advisor (explicit trigger) ──
        if request.mode == Mode.ADVISE:
            return self.invoke_advise(request, hydrate_results)

        # ── FULL / QUICK: delegate to invoke_build ──
        if request.mode in (Mode.FULL, Mode.QUICK):
            return self.invoke_build(request, hydrate_results)

        # ── FEEDBACK: delegate to invoke_feedback ──
        if request.mode == Mode.FEEDBACK:
            return self.invoke_feedback(request, hydrate_results)

        # ── Fallback: Tool Registry (unknown mode) ──
        registry = self._get_registry()
        tool = registry.match(request, self._ctx)

        if tool is None:
            return AgentLoopResult(
                status=AgentStatus.ERROR,
                response=PromptCraftResponse(
                    status=AgentStatus.ERROR,
                    error="No applicable tool found for this request.",
                ),
            )

        result = tool.call(request, self._ctx)

        # ── Post-processing per tool ──
        if tool.name == "personalization":
            self._store_overlay_config(result)

        elif tool.name == "prompt_build":
            self._track_quality_from_tool_result(result)

        return self._tool_result_to_loop(result, tool.name)

    def _store_overlay_config(self, result: ToolResult) -> None:
        """Populate ctx.overlay_config from PersonalizationTool output."""
        if self._ctx is None or not result.ok or not result.data:
            return
        from protocol import OverlayConfig
        self._ctx.overlay_config = OverlayConfig(
            skill_name=result.data.get("skill_name", ""),
            constraints=result.data.get("constraints", []),
            preferences=result.data.get("preferences", {}),
        )

    def _track_quality_from_tool_result(self, result: ToolResult) -> None:
        """Extract technique and constraints from PromptBuild ToolResult for tracking."""
        if not result.ok or not result.data:
            return
        data = result.data
        self.state.last_technique = data.get("technique", "")
        for c in data.get("global_constraints", []):
            self._seen_constraints.add(c)
        self.state.call_count += 1
        self.state.continue_reason = (
            ContinueReason.FIRST_CALL if self.state.call_count == 1
            else ContinueReason.NEXT_TURN
        )
        if self.state.call_count == 1:
            self._reset_circuit_breaker()

    def _tool_result_to_loop(self, result: ToolResult, tool_name: str) -> AgentLoopResult:
        """Convert a ToolResult into the legacy AgentLoopResult format.

        This ensures backward compatibility — main agents that expect
        AgentLoopResult continue to work unchanged.
        """
        if not result.ok:
            return AgentLoopResult(
                status=AgentStatus.ERROR,
                response=PromptCraftResponse(
                    status=AgentStatus.ERROR,
                    error=result.error,
                ),
            )

        data = result.data or {}

        if tool_name == "personalization":
            return AgentLoopResult(
                status=AgentStatus.OK,
                response=PromptCraftResponse(
                    status=AgentStatus.OK,
                    prompt=(
                        f"## Personalization Overlay for `{data.get('skill_name', 'unknown')}`\n\n"
                        + "\n".join(f"- {c}" for c in data.get("constraints", []))
                        + ("\n\n" + "\n".join(f"- {k}: {v}" for k, v in data.get("preferences", {}).items())
                           if data.get("preferences") else "")
                    ),
                    metadata=None,
                ),
            )

        if tool_name == "pattern_analysis":
            return AgentLoopResult(
                status=AgentStatus.OK,
                response=PromptCraftResponse(
                    status=AgentStatus.OK,
                    prompt=(
                        f"## Pattern Analysis Report\n\n"
                        f"Analysed {data.get('total_executions', 0)} execution records.\n\n"
                        + data.get("summary", "")
                        + ("\n\n### High-Frequency Overlays\n\n"
                           + "\n".join(f"- {o.get('overlay', '?')}: {o.get('pct', 0)}% of tasks"
                                       for o in data.get("high_freq_overlays", []))
                           if data.get("high_freq_overlays") else "")
                    ),
                    metadata=None,
                ),
            )

        if tool_name == "skill_advisor":
            advice_list = data.get("advice", [])
            parts = ["## Skill Advisor — Suggestions\n"]
            for i, a in enumerate(advice_list, 1):
                parts.append(
                    f"### {i}. [{a.get('advice_type', '?').upper()}] {a.get('suggestion', '')}\n"
                    f"**Evidence**: {a.get('data_support', '')}\n"
                )
                if a.get("draft_content"):
                    parts.append(
                        "**Draft for /create-skill**:\n"
                        f"```markdown\n{a['draft_content']}\n```\n"
                    )
            parts.append(
                "\n⚠️ These are suggestions only. Pass to the main agent's "
                "built-in Skill creation mechanism. Do NOT auto-apply."
            )
            return AgentLoopResult(
                status=AgentStatus.OK,
                response=PromptCraftResponse(
                    status=AgentStatus.OK,
                    prompt="\n".join(parts),
                    metadata=None,
                ),
            )

        if tool_name == "prompt_build":
            # Technique selected — LLM sub-agent generates the prompt
            technique = data.get("technique", "zero-shot")
            ref_file = data.get("reference_file", "")
            task = data.get("task", "")
            global_constraints = data.get("global_constraints", [])
            past_feedback = data.get("past_feedback", {})
            tech_stack = data.get("tech_stack", "")

            # Build an instruction for the LLM sub-agent
            lines = [
                "## PromptCraft Build — Technique Selected",
                "",
                f"**Technique**: `{technique}`",
                f"**Rationale**: {data.get('rationale', '')}",
                f"**Reference file**: `{ref_file}`",
                f"**Task**: {task}",
            ]
            if tech_stack:
                lines.append(f"**Tech stack**: {tech_stack}")
            if global_constraints:
                lines.append(f"\n### GLOBAL Constraints (must be injected into section 7)")
                for c in global_constraints:
                    lines.append(f"- {c}")
            if past_feedback:
                lines.append(f"\n### Past Feedback on Similar Tasks")
                for tid, fb in past_feedback.items():
                    lines.append(f"- `{tid}`: score={fb.get('score')}, technique={fb.get('technique')}")
            lines.append("")
            lines.append("### Next Step (LLM sub-agent)")
            lines.append(f"1. Read the technique reference: `{ref_file}`")
            lines.append("2. Study the technique's rules for 8-section structure")
            lines.append("3. Generate the complete 8-section prompt applying the technique")
            lines.append("4. Inject GLOBAL constraints into section 7 (硬约束)")
            lines.append("5. Run checkpoint.py to persist the prompt to vault")
            lines.append("6. Return the complete prompt to the main agent")

            return AgentLoopResult(
                status=AgentStatus.OK,
                response=PromptCraftResponse(
                    status=AgentStatus.OK,
                    prompt="\n".join(lines),
                    analysis=Analysis(
                        technique=technique,
                        rationale=data.get("rationale", ""),
                        independence=data.get("independence", ""),
                        cognitive_load=data.get("cognitive_load", ""),
                    ),
                ),
            )

        # Fallback: pass through as a response
        prompt_text = data.get("prompt", "")
        return AgentLoopResult(
            status=AgentStatus.OK,
            response=PromptCraftResponse(
                status=AgentStatus.OK,
                prompt=prompt_text or str(data),
            ),
        )

    # ── Feedback handler ───────────────────────────────────────────────────

    def _handle_feedback_post_tool(
        self,
        request: PromptCraftRequest,
        tool_result: ToolResult,
    ) -> AgentLoopResult:
        """Post-process after FeedbackCollectTool has collected signals.

        The tool handles signal extraction. Engine handles:
        quality scoring → buffer accumulation → vault persistence →
        pattern analysis trigger → circuit breaker → response.
        """
        # Normalise feedback: JSON deserialises to dict, but internal callers
        # may pass ExecutionFeedback dataclass. Convert to dict once at boundary.
        raw_fb = request.feedback
        fb: dict | None = None
        if raw_fb is not None:
            if hasattr(raw_fb, "success"):
                fb = {
                    "success": raw_fb.success,
                    "constraint_violations": getattr(raw_fb, "constraint_violations", []),
                    "manual_fixes_needed": getattr(raw_fb, "manual_fixes_needed", ""),
                }
            elif isinstance(raw_fb, dict):
                fb = raw_fb

        quality = score_quality(fb) if fb else (
            tool_result.data.get("quality_score", 0) if tool_result.data else 0
        )

        self.state.quality_trend.append(quality)
        self.state.call_count += 1

        # ── Circuit breaker: track vault write ──
        self._breaker.after_vault_write()

        # ── Circuit breaker: low-quality tracking ──
        if quality <= 3:
            should_break = self._breaker.after_low_quality()
            if should_break:
                return self._build_stalled_response(request)
        else:
            self._breaker.reset_quality_stall()

        # ── Accumulate feedback signal in buffer ──
        signal = {
            "task_type": request.task[:80] if request.task else "",
            "skill_used": getattr(request, "skill_name", None),
            "quality_score": quality,
            "overlay_used": getattr(request, "overlay_used", []),
        }
        if fb:
            signal["success"] = fb.get("success")
            signal["violations"] = fb.get("constraint_violations", [])
            signal["manual_fixes"] = fb.get("manual_fixes_needed", "")
        self.state.feedback_buffer.append(signal)
        if self._ctx is not None:
            self._ctx.feedback_signals.append(signal)
            self._ctx.invalidate_hydrate()

        # ── Persist feedback to vault for cross-session aggregation ──
        signal_with_id = signal | {"task_id": (
            request.task_id or
            getattr(request, "task_id", None) or
            request.task[:60]
        )}
        self._persist_feedback_to_vault(signal_with_id)

        # ── Check if we have enough data for pattern analysis ──
        if len(self.state.feedback_buffer) >= 10:
            analysis_result = self._maybe_trigger_analysis()
            if analysis_result is not None:
                return analysis_result

        # ── Check circuit breaker ──
        if self._should_break():
            return self._build_stalled_response(request)

        # ── If quality is good enough, stop ──
        if quality >= 4:
            return AgentLoopResult(
                status=AgentStatus.OK,
                feedback=FeedbackResponse(
                    status=AgentStatus.OK,
                    quality_score=quality,
                    improvement_notes="Quality sufficient — no further refinement needed.",
                ),
            )

        # ── Otherwise, flag that refinement is warranted ──
        return AgentLoopResult(
            status=AgentStatus.OK,
            feedback=FeedbackResponse(
                status=AgentStatus.OK,
                quality_score=quality,
                improvement_notes=(
                    f"Quality {quality}/5. Consider re-invoking PromptCraft "
                    "with the improvement notes to refine the prompt."
                ),
            ),
        )

    # ── Vault feedback persistence ────────────────────────────────────────

    def _persist_feedback_to_vault(self, signal: dict[str, Any]) -> None:
        """Write a feedback record to vault via checkpoint.py subprocess.

        Buffers writes when the feedback pipeline is active — flushes every
        EngineMetrics.FEEDBACK_FLUSH_INTERVAL records or on session end.
        Tracks errors in EngineMetrics for HealthReport visibility.

        Failure is non-blocking: if the subprocess fails, we track the error
        in metrics and continue. The in-memory buffer still works for
        same-session analysis.
        """
        if self._metrics is None:
            import time as _time
            self._metrics = EngineMetrics(session_start=_time.monotonic())

        # ── Buffer the signal for batched write ──
        if not hasattr(self, '_feedback_write_buffer'):
            self._feedback_write_buffer: list[dict[str, Any]] = []
        self._feedback_write_buffer.append(signal)

        buf_len = len(self._feedback_write_buffer)
        if buf_len > self._metrics.feedback_buffer_max_size:
            self._metrics.feedback_buffer_max_size = buf_len

        # Flush when buffer reaches threshold
        if buf_len >= self._metrics.FEEDBACK_FLUSH_INTERVAL:
            self._flush_feedback_buffer()
        # Note: remaining buffer entries are flushed by maybe_silent_analyze()
        # at session end, ensuring no data loss.

    def _flush_feedback_buffer(self) -> int:
        """Flush buffered feedback records to vault in a single subprocess call.

        Builds proper checkpoint payloads from buffer signals and writes them
        via NDJSON batch mode. Returns the number of records successfully persisted.
        """
        if not hasattr(self, '_feedback_write_buffer') or not self._feedback_write_buffer:
            return 0

        records = self._feedback_write_buffer[:]
        self._feedback_write_buffer.clear()
        if self._metrics:
            self._metrics.feedback_buffer_flushes += 1

        # Resolve checkpoint script path (cached)
        if self._checkpoint_script is None:
            candidate = Path("skills/prompt-memory/scripts/checkpoint.py")
            if candidate.exists():
                self._checkpoint_script = candidate.resolve()
            else:
                engine_dir = Path(__file__).resolve().parent.parent
                candidate = engine_dir / "skills/prompt-memory/scripts/checkpoint.py"
                if candidate.exists():
                    self._checkpoint_script = candidate
                else:
                    if self._metrics:
                        self._metrics.vault_write_errors += len(records)
                    return 0

        # Build payload for each signal record
        payloads: list[str] = []
        for signal in records:
            payload = {
                "task_id": signal.get("task_id", "feedback"),
                "user_intent": signal.get("task_type", "unknown"),
                "task_type": signal.get("task_type", ""),
                "quality_score": signal.get("quality_score", 0),
                "overlay_used": signal.get("overlay_used", []),
                "skill_used": signal.get("skill_used", ""),
                "execution_feedback": json.dumps({
                    "status": "success" if signal.get("quality_score", 0) >= 3 else "partial",
                    "quality_score": signal.get("quality_score", 0),
                    "constraint_compliance": {
                        "all_hard_constraints_met": not signal.get("violations"),
                        "violations": signal.get("violations", []),
                    },
                    "output_summary": signal.get("task_type", ""),
                    "improvement_notes": signal.get("manual_fixes", ""),
                }),
                "tags": [signal.get("skill_used", "")] if signal.get("skill_used") else [],
            }
            payloads.append(json.dumps(payload))

        ndjson_input = "\n".join(payloads)

        try:
            proc = subprocess.run(
                [
                    sys.executable, str(self._checkpoint_script),
                    "--batch",
                ],
                input=ndjson_input,
                capture_output=True,
                text=True,
                timeout=10 + len(records) * 2,  # 10s base + 2s per record
            )
            if proc.returncode != 0:
                if self._metrics:
                    self._metrics.vault_write_errors += len(records)
            else:
                total_bytes = len(ndjson_input.encode("utf-8"))
                if self._metrics:
                    self._metrics.vault_write_bytes += total_bytes
        except subprocess.TimeoutExpired:
            if self._metrics:
                self._metrics.vault_write_timeouts += len(records)
                self._metrics.subprocess_timeouts += 1
        except (OSError, ValueError):
            if self._metrics:
                self._metrics.vault_write_errors += len(records)

        return len(records)

    def _run_aggregate_query(self, min_records: int = 10) -> dict[str, Any] | None:
        """Run hydrate.py --aggregate to get cross-session Pattern Analysis data.

        This is the cross-session complement to the in-memory feedback_buffer.
        Returns parsed JSON output, or None if the subprocess fails.
        """
        hydrate_script = Path("skills/prompt-memory/scripts/hydrate.py")
        if not hydrate_script.exists():
            engine_dir = Path(__file__).resolve().parent.parent
            hydrate_script = engine_dir / "skills/prompt-memory/scripts/hydrate.py"
            if not hydrate_script.exists():
                return None

        try:
            proc = subprocess.run(
                [
                    sys.executable, str(hydrate_script),
                    "--aggregate", "--min-records", str(min_records),
                ],
                capture_output=True, text=True, timeout=15,
            )
            if proc.returncode == 0:
                return json.loads(proc.stdout)
        except (subprocess.TimeoutExpired, OSError, json.JSONDecodeError):
            pass
        return None

    # ── Pattern analysis trigger ──────────────────────────────────────────

    def _select_analysis_data(self) -> list[dict[str, Any]] | None:
        """Select data source for pattern analysis (progressive cost model).

        1. In-memory buffer (same-session, cheapest) — requires ≥10 records.
        2. Cross-session vault aggregate (disk read, more expensive).

        Returns list of record dicts, or None if neither source has enough data.
        """
        buffer = self.state.feedback_buffer
        if len(buffer) >= 10:
            return list(buffer)

        aggregate = self._run_aggregate_query(min_records=10)
        if aggregate and aggregate.get("results"):
            records: list[dict[str, Any]] = []
            for group in aggregate["results"]:
                records.append({
                    "task_type": group.get("group_key", ""),
                    "quality_score": int(group.get("avg_quality", 0)),
                    "overlay_used": [
                        ov.get("overlay", "")
                        for ov in group.get("high_freq_overlays", [])
                    ],
                    "total_records": group.get("total_records", 0),
                })
            return records
        return None

    def _run_pattern_analysis(
        self, records: list[dict[str, Any]]
    ) -> AgentLoopResult | None:
        """Run PatternAnalysisTool against the given records.

        Populates ctx.pattern_report and ctx.proactive_signals on success.
        Returns AgentLoopResult or None.
        """
        if self._ctx is None:
            self._ctx = EngineContext(skills_dir=self.skills_dir)
        if self._ctx.hydrate_results is None:
            self._ctx.hydrate_results = {}
        self._ctx.hydrate_results["results"] = records

        registry = self._get_registry()
        pattern_tool = registry.get("pattern_analysis")
        if pattern_tool is None:
            return None

        pattern_result = pattern_tool.call(None, self._ctx)
        if not (pattern_result.ok and pattern_result.data):
            return None

        self.state.analysis_count += 1
        self.state.continue_reason = ContinueReason.PATTERN_READY

        from protocol import PatternReport
        self._ctx.pattern_report = PatternReport(
            total_executions=pattern_result.data.get("total_executions", 0),
            high_freq_overlays=pattern_result.data.get("high_freq_overlays", []),
            missing_constraints=pattern_result.data.get("missing_constraints", []),
            low_quality_task_types=pattern_result.data.get("low_quality_task_types", []),
            summary=pattern_result.data.get("summary", ""),
        )
        self._ctx.proactive_signals = pattern_result.data.get("proactive_signals", [])

        # Try SkillAdvisor as a follow-up
        advisor_tool = registry.get("skill_advisor")
        if advisor_tool:
            advisor_result = advisor_tool.call(None, self._ctx)
            if advisor_result.ok and advisor_result.data:
                advice_list = advisor_result.data.get("advice", [])
                if advice_list:
                    self.state.continue_reason = ContinueReason.EVOLUTION_SUGGESTED
                    return self._tool_result_to_loop(advisor_result, "skill_advisor")

        return self._tool_result_to_loop(pattern_result, "pattern_analysis")

    def _maybe_trigger_analysis(self) -> AgentLoopResult | None:
        """Check if enough feedback signals exist for pattern analysis.

        Three-tier gating:
          - ≥10 records → Pattern Analysis (internal observation)
          - ≥20 records + ≥65% consistency → Skill Evolution Suggestion
          - ≥30 records + stable pattern → Skill Creation Suggestion

        Returns None if thresholds not met, or AgentLoopResult if triggered.
        """
        records = self._select_analysis_data()
        if records is None:
            return None
        return self._run_pattern_analysis(records)

    # ── Silent analysis ─────────────────────────────────────────────────────

    def _probe_vault_hints(self, task: str) -> list[str]:
        """Run a cheap vault query to find similar past tasks.

        Unlike the full aggregate query (which requires >=10 records), this
        lightweight probe works with any amount of vault data. Cache results
        per task to avoid repeated subprocess overhead.

        Returns list of short hint strings like "similar->solidity-audit q=4.2".
        """
        # Cache hit: same task as last probe
        if self._vault_hints is not None and self._vault_hints_task == task[:60]:
            return self._vault_hints

        self._vault_hints_task = task[:60]
        hints: list[str] = []

        hydrate_script = Path("skills/prompt-memory/scripts/hydrate.py")
        if not hydrate_script.exists():
            engine_dir = Path(__file__).resolve().parent.parent
            hydrate_script = engine_dir / "skills/prompt-memory/scripts/hydrate.py"
            if not hydrate_script.exists():
                self._vault_hints = hints
                return hints

        try:
            proc = subprocess.run(
                [
                    sys.executable, str(hydrate_script),
                    "--query", task[:120],
                    "--top-k", "3",
                ],
                capture_output=True, text=True, timeout=8,
            )
            if proc.returncode == 0:
                data = json.loads(proc.stdout)
                results = data.get("results", [])
                for r in results:
                    score = r.get("score", 0)
                    if score >= 0.25:  # Lower threshold than the 0.3 trigger gate
                        task_type = r.get("task_type", "") or r.get("user_intent", "")
                        if not task_type:
                            entry = r.get("entry", {})
                            task_type = entry.get("task_type", "") or entry.get("user_intent", "")
                        quality = r.get("avg_quality", 0) or r.get("quality_score", 0)
                        if task_type and score >= 0.25:
                            q_str = f" q={quality:.1f}" if quality else ""
                            hints.append(f"similar->{task_type[:30]}{q_str}")
        except (subprocess.TimeoutExpired, OSError, json.JSONDecodeError):
            pass

        self._vault_hints = hints
        return hints

    def maybe_silent_analyze(self) -> HealthReport:
        """Run pattern analysis silently, return HealthReport.

        Called after every mode invocation. If >=10 records are in the buffer,
        runs pattern analysis and stores the report in context (vault side
        effects only — nothing returned to main agent except the HealthReport).

        Even when below the 10-record threshold, runs a lightweight vault probe
        (cheap hydrate query) to surface similar past tasks as proactive hints.
        The main agent sees these hints in the health line and can decide to
        invoke overlay/build if they look useful.

        Returns:
            HealthReport with analysis_ran_this_time set to True if analysis
            was triggered. The main agent reads recommended_action to decide
            whether to run analyze/advise.
        """
        # Guard: no state yet (engine never invoked)
        if self.state is None:
            return HealthReport()

        buffer = self.state.feedback_buffer
        analysis_ran = False

        # ── Flush any remaining buffered feedback before analysis ──
        if hasattr(self, '_feedback_write_buffer') and self._feedback_write_buffer:
            self._flush_feedback_buffer()

        # ── Lightweight vault probe (always runs, even below threshold) ──
        vault_hints: list[str] = []
        if self._last_task:
            vault_hints = self._probe_vault_hints(self._last_task)

        # Run analysis if threshold met
        if len(buffer) >= 10:
            try:
                self._maybe_trigger_analysis()  # Side effects only
                analysis_ran = True
            except Exception:
                if self._metrics:
                    self._metrics.silent_analysis_errors += 1

        # Compute health from feedback buffer (uses the richer HealthReport.compute)
        proactive = self._ctx.proactive_signals if self._ctx else []
        metrics = self._metrics
        return HealthReport.compute(
            buffer,
            analysis_ran=analysis_ran,
            proactive_signals=proactive,
            metrics=metrics,
            vault_hints=vault_hints,
        )

    # ── Overlay (public) ────────────────────────────────────────────────────

    def invoke_overlay(
        self,
        request: PromptCraftRequest,
        hydrate_results: dict[str, Any] | None = None,
    ) -> AgentLoopResult:
        """Overlay mode: force PersonalizationTool for Skill enhancement.

        Requires request.skill_name to be set. Returns domain-filtered
        constraints as an overlay to prepend to the Skill's instructions.
        """
        self._ensure_init(request)
        self._last_task = request.task
        if not request.skill_name:
            return AgentLoopResult(
                status=AgentStatus.ERROR,
                response=PromptCraftResponse(
                    status=AgentStatus.ERROR,
                    error="OVERLAY mode requires skill_name to be set.",
                ),
            )

        registry = self._get_registry()
        tool = registry.get("personalization")
        if tool is None:
            return AgentLoopResult(
                status=AgentStatus.ERROR,
                response=PromptCraftResponse(
                    status=AgentStatus.ERROR,
                    error="PersonalizationTool not registered.",
                ),
            )

        result = tool.call(request, self._ctx)
        if result.ok:
            self._breaker.after_success()
        else:
            self._breaker.after_denial()
        self._store_overlay_config(result)
        return self._tool_result_to_loop(result, "personalization")

    # ── Analyze (public) ────────────────────────────────────────────────────

    def invoke_analyze(
        self,
        request: PromptCraftRequest,
        hydrate_results: dict[str, Any] | None = None,
    ) -> AgentLoopResult:
        """Analyze mode: force pattern analysis on accumulated feedback.

        Tries same-session buffer first, then cross-session aggregate.
        Returns PatternReport or an error if insufficient data.
        """
        self._ensure_init(request)
        self._last_task = request.task
        # Try to trigger analysis — _maybe_trigger_analysis handles both
        # same-session and cross-session data sources.
        result = self._maybe_trigger_analysis()
        if result is not None:
            return result

        # If no result, try forcing PatternAnalysisTool directly with
        # cross-session aggregate data.
        aggregate = self._run_aggregate_query(min_records=5)
        if aggregate is None or not aggregate.get("results"):
            return AgentLoopResult(
                status=AgentStatus.OK,
                response=PromptCraftResponse(
                    status=AgentStatus.OK,
                    prompt=(
                        "## Pattern Analysis\n\n"
                        f"Insufficient data. Buffer has {len(self.state.feedback_buffer)} "
                        "records. Need ≥5 records for pattern analysis.\n\n"
                        "Continue collecting feedback and try again."
                    ),
                ),
            )

        # Inject aggregate data into context and run PatternAnalysisTool
        if self._ctx is None:
            self._ctx = EngineContext(skills_dir=self.skills_dir)
        if self._ctx.hydrate_results is None:
            self._ctx.hydrate_results = {}
        self._ctx.hydrate_results["results"] = aggregate["results"]

        registry = self._get_registry()
        tool = registry.get("pattern_analysis")
        if tool is None:
            return AgentLoopResult(
                status=AgentStatus.ERROR,
                response=PromptCraftResponse(
                    status=AgentStatus.ERROR,
                    error="PatternAnalysisTool not registered.",
                ),
            )

        # Layer 2 + 5: guard
        denied = self._guard_tool_execution(tool, request)
        if denied is not None:
            return denied

        result = tool.call(request, self._ctx)
        if result.ok:
            self._breaker.after_success()
        else:
            self._breaker.after_denial()
        if result.ok and result.data:
            self.state.analysis_count += 1
            self.state.continue_reason = ContinueReason.PATTERN_READY
            # Store in context for downstream SkillAdvisor
            from protocol import PatternReport
            self._ctx.pattern_report = PatternReport(
                total_executions=result.data.get("total_executions", 0),
                high_freq_overlays=result.data.get("high_freq_overlays", []),
                missing_constraints=result.data.get("missing_constraints", []),
                low_quality_task_types=result.data.get("low_quality_task_types", []),
                summary=result.data.get("summary", ""),
            )

        return self._tool_result_to_loop(result, "pattern_analysis")

    # ── Advise (public) ─────────────────────────────────────────────────────

    def invoke_advise(
        self,
        request: PromptCraftRequest,
        hydrate_results: dict[str, Any] | None = None,
    ) -> AgentLoopResult:
        """Advise mode: force SkillAdvisorTool to generate suggestions.

        If no pattern_report exists in context, runs pattern analysis first
        (same data pipeline as _handle_analyze), then advisor.
        """
        self._ensure_init(request)
        self._last_task = request.task
        # If no pattern report yet, run analysis first
        if self._ctx is None or self._ctx.pattern_report is None:
            analysis_result = self._maybe_trigger_analysis()
            if analysis_result is not None:
                # _maybe_trigger_analysis may have already run advisor.
                # If it returned an advisor result, return it directly.
                if self._ctx and self._ctx.pattern_report:
                    # Context has pattern_report now — proceed to advisor below
                    pass
                else:
                    return analysis_result
            else:
                # Try cross-session aggregate
                aggregate = self._run_aggregate_query(min_records=5)
                if aggregate and aggregate.get("results"):
                    if self._ctx is None:
                        self._ctx = EngineContext(skills_dir=self.skills_dir)
                    if self._ctx.hydrate_results is None:
                        self._ctx.hydrate_results = {}
                    self._ctx.hydrate_results["results"] = aggregate["results"]

                    registry = self._get_registry()
                    pattern_tool = registry.get("pattern_analysis")
                    if pattern_tool:
                        pat_result = pattern_tool.call(request, self._ctx)
                        if pat_result.ok and pat_result.data:
                            from protocol import PatternReport
                            self._ctx.pattern_report = PatternReport(
                                total_executions=pat_result.data.get("total_executions", 0),
                                high_freq_overlays=pat_result.data.get("high_freq_overlays", []),
                                missing_constraints=pat_result.data.get("missing_constraints", []),
                                low_quality_task_types=pat_result.data.get("low_quality_task_types", []),
                                summary=pat_result.data.get("summary", ""),
                            )
                            self.state.analysis_count += 1
                    else:
                        return AgentLoopResult(
                            status=AgentStatus.ERROR,
                            response=PromptCraftResponse(
                                status=AgentStatus.ERROR,
                                error="PatternAnalysisTool not registered — cannot generate advice.",
                            ),
                        )

        # If still no pattern report, we can't advise
        if self._ctx is None or self._ctx.pattern_report is None:
            return AgentLoopResult(
                status=AgentStatus.OK,
                response=PromptCraftResponse(
                    status=AgentStatus.OK,
                    prompt=(
                        "## Skill Advisor\n\n"
                        "Insufficient data to generate advice. "
                        "Run analyze mode first to accumulate pattern data.\n\n"
                        f"Records needed: ≥{10 - len(self.state.feedback_buffer)} more."
                        if len(self.state.feedback_buffer) < 10
                        else "Run analyze mode to process accumulated data."
                    ),
                ),
            )

        registry = self._get_registry()
        tool = registry.get("skill_advisor")
        if tool is None:
            return AgentLoopResult(
                status=AgentStatus.ERROR,
                response=PromptCraftResponse(
                    status=AgentStatus.ERROR,
                    error="SkillAdvisorTool not registered.",
                ),
            )

        # Layer 2 + 5: guard
        denied = self._guard_tool_execution(tool, request)
        if denied is not None:
            return denied

        result = tool.call(request, self._ctx)
        if result.ok:
            self._breaker.after_success()
        else:
            self._breaker.after_denial()
        if result.ok and result.data and result.data.get("advice"):
            self.state.continue_reason = ContinueReason.EVOLUTION_SUGGESTED

        return self._tool_result_to_loop(result, "skill_advisor")

    # ── Batch (public) ──────────────────────────────────────────────────────

    def invoke_batch(
        self,
        request: "BatchRequest",
        hydrate_results: dict[str, Any] | None = None,
    ) -> "BatchResponse":
        """Batch mode: process multiple tasks in a single invocation.

        Hydrate once for all items. Group by Skill match (has skill_name vs
        not), process each item, and aggregate results into a single response.

        Uses ThreadPoolExecutor for parallel processing of independent items.
        """
        from protocol import BatchRequest, BatchItem, BatchResponse, BatchSummary

        items = request.items
        if not items:
            return BatchResponse(
                status=AgentStatus.ERROR,
                error="Batch request requires at least one item.",
            )

        # ── Hydrate once (shared vault snapshot for all items) ──
        # Initialize engine state manually (BatchRequest has no .task field)
        if self.state is None:
            from protocol import make_task_id
            self.state = SessionState(
                task_id=request.task_id or f"batch:{make_task_id(items[0].task if items else 'empty')}",
            )
        if self._ctx is None:
            self._ctx = EngineContext(skills_dir=self.skills_dir)
        if self._breaker is None:
            self._breaker = CircuitBreaker()
        if self._metrics is None:
            import time as _time
            self._metrics = EngineMetrics(session_start=_time.monotonic())
        cache_key = f"batch:{request.task_id or 'batch'}"
        if hydrate_results is not None:
            if not self._ctx.is_hydrate_fresh(cache_key):
                self._ctx.cache_hydrate(hydrate_results, cache_key)

        # ── Process each item ──
        def _process_item(item: BatchItem) -> dict[str, Any]:
            from protocol import Context as PCContext
            internal_ctx = item.context or PCContext()
            internal_req = PromptCraftRequest(
                task=item.task,
                mode=Mode.OVERLAY if item.skill_name else Mode.FULL,
                skill_name=item.skill_name,
                context=internal_ctx,
                feedback=item.feedback,
            )

            if item.skill_name:
                result = self.invoke_overlay(internal_req, self._ctx.hydrate_results)
            else:
                result = self.invoke_build(internal_req, self._ctx.hydrate_results)

            return {
                "task": item.task[:80],
                "skill_name": item.skill_name,
                "status": result.status.value,
                "prompt": result.response.prompt if result.response else None,
                "error": (
                    result.response.error if result.response
                    else (result.stalled.question_for_main_agent if result.stalled else None)
                ),
            }

        # ── Parallel execution (max 4 workers) ──
        item_results: list[dict[str, Any]] = []
        succeeded = 0
        failed = 0

        from concurrent.futures import ThreadPoolExecutor, as_completed
        with ThreadPoolExecutor(max_workers=min(len(items), 4)) as executor:
            future_map = {executor.submit(_process_item, item): item for item in items}
            for future in as_completed(future_map):
                try:
                    result = future.result()
                    item_results.append(result)
                    if result.get("status") == "ok":
                        succeeded += 1
                    else:
                        failed += 1
                except Exception as exc:
                    item = future_map[future]
                    item_results.append({
                        "task": item.task[:80] if item.task else "?",
                        "skill_name": item.skill_name,
                        "status": "error",
                        "error": str(exc),
                    })
                    failed += 1

        return BatchResponse(
            status=AgentStatus.OK if failed == 0 else AgentStatus.ERROR,
            item_results=item_results,
            batch_summary=BatchSummary(
                total=len(items),
                succeeded=succeeded,
                failed=failed,
                skipped=0,
            ),
        )

    def _batch_response_to_loop(self, batch_response: "BatchResponse") -> AgentLoopResult:
        """Convert BatchResponse to AgentLoopResult for protocol compatibility."""
        if batch_response.status == AgentStatus.ERROR and batch_response.error:
            return AgentLoopResult(
                status=AgentStatus.ERROR,
                response=PromptCraftResponse(
                    status=AgentStatus.ERROR,
                    error=batch_response.error,
                ),
            )

        summary = batch_response.batch_summary
        parts = [
            f"## Batch Results\n\n"
            f"Processed {summary.total} items: "
            f"{summary.succeeded} succeeded, {summary.failed} failed, "
            f"{summary.skipped} skipped.\n"
        ]
        for i, item in enumerate(batch_response.item_results, 1):
            status_icon = "OK" if item.get("status") == "ok" else "FAIL"
            skill_hint = f" ({item.get('skill_name', 'no-skill')})" if item.get("skill_name") else ""
            parts.append(f"{i}. [{status_icon}] {item.get('task', '?')}{skill_hint}")

        return AgentLoopResult(
            status=AgentStatus.OK,
            response=PromptCraftResponse(
                status=AgentStatus.OK,
                prompt="\n".join(parts),
            ),
        )

    # ── Build (public) ──────────────────────────────────────────────────────

    def invoke_build(
        self,
        request: PromptCraftRequest,
        hydrate_results: dict[str, Any] | None = None,
    ) -> AgentLoopResult:
        """Build mode: full 8-section prompt generation (FULL / QUICK).

        This is the fallback when no matching Skill exists. Routes through
        PromptBuildTool in the ToolRegistry.
        """
        self._ensure_init(request)
        self._last_task = request.task
        registry = self._get_registry()
        tool = registry.get("prompt_build")
        if tool is None:
            return AgentLoopResult(
                status=AgentStatus.ERROR,
                response=PromptCraftResponse(
                    status=AgentStatus.ERROR,
                    error="PromptBuildTool not registered.",
                ),
            )
        # Layer 2 + 5: guard
        denied = self._guard_tool_execution(tool, request)
        if denied is not None:
            return denied

        result = tool.call(request, self._ctx)
        if result.ok:
            self._breaker.after_success()
        else:
            self._breaker.after_denial()
        self._track_quality_from_tool_result(result)
        return self._tool_result_to_loop(result, "prompt_build")

    # ── Feedback (public) ───────────────────────────────────────────────────

    def invoke_feedback(
        self,
        request: PromptCraftRequest,
        hydrate_results: dict[str, Any] | None = None,
    ) -> AgentLoopResult:
        """Feedback mode: collect execution feedback and persist to vault.

        Extracts explicit feedback signals from the request and implicit
        signals from context, then runs the feedback pipeline: quality
        scoring → buffer → vault persistence → circuit breaker check.
        """
        self._ensure_init(request)
        self._last_task = request.task

        # ── Layer 5: Circuit breaker check ──
        if not self._breaker.before_tool_call():
            return AgentLoopResult(
                status=AgentStatus.STALLED,
                stalled=StalledResponse(
                    blocker="circuit_breaker_open",
                    question_for_main_agent=(
                        "PromptCraft's circuit breaker is OPEN — too many "
                        "consecutive denials. Wait for cooldown or investigate."
                    ),
                ),
            )

        # ── Validate: feedback payload is required ──
        fb = request.feedback
        if fb is None and not (self._ctx and self._ctx.feedback_signals):
            self._breaker.after_denial()
            return AgentLoopResult(
                status=AgentStatus.ERROR,
                response=PromptCraftResponse(
                    status=AgentStatus.ERROR,
                    error="Feedback mode requires a feedback payload.",
                ),
            )

        # ── Extract explicit feedback signal ──
        signals: list[dict[str, Any]] = []
        if fb is not None:
            success = fb.success if hasattr(fb, "success") else (
                fb.get("success") if isinstance(fb, dict) else None
            )
            violations = (
                fb.constraint_violations if hasattr(fb, "constraint_violations")
                else (fb.get("constraint_violations", []) if isinstance(fb, dict) else [])
            )
            fixes = (
                fb.manual_fixes_needed if hasattr(fb, "manual_fixes_needed")
                else (fb.get("manual_fixes_needed", "") if isinstance(fb, dict) else "")
            )
            signals.append({
                "signal_type": "explicit",
                "description": (
                    f"success={success}, violations={violations}, fixes={fixes}"
                ),
                "task_type": request.task[:80] if request.task else "",
                "skill_used": getattr(request, "skill_name", None),
                "overlay_used": getattr(request, "overlay_used", []),
            })

        # ── Collect implicit signals from context ──
        if self._ctx:
            for sig in self._ctx.feedback_signals:
                if isinstance(sig, dict):
                    signals.append(sig)

        if not signals:
            self._breaker.after_denial()
            return AgentLoopResult(
                status=AgentStatus.ERROR,
                response=PromptCraftResponse(
                    status=AgentStatus.ERROR,
                    error="No feedback signals to collect.",
                ),
            )

        self._breaker.after_success()

        # Build ToolResult-compatible object for _handle_feedback_post_tool
        tool_result = ToolResult(data={
            "signals": signals,
            "count": len(signals),
            "vault_payload": {
                "task_type": request.task[:80] if request.task else "",
                "skill_used": getattr(request, "skill_name", None),
                "signals": signals,
            },
        })
        return self._handle_feedback_post_tool(request, tool_result)

    # ── Review handler ─────────────────────────────────────────────────────

    def _handle_review(
        self,
        request: PromptCraftRequest,
        hydrate_results: dict[str, Any] | None,
    ) -> AgentLoopResult:
        """Review mode: audit an existing prompt for quality issues."""
        # Review mode loads the prompt from vault (via hydrate) and checks
        # structure, constraint compliance, and technique appropriateness.
        issues: list[str] = []
        if hydrate_results is None:
            return AgentLoopResult(
                status=AgentStatus.ERROR,
                response=PromptCraftResponse(
                    status=AgentStatus.ERROR,
                    error="Review mode requires hydrate_results (prompt to review).",
                ),
            )

        results = hydrate_results.get("results", [])
        if not results:
            return AgentLoopResult(
                status=AgentStatus.ERROR,
                response=PromptCraftResponse(
                    status=AgentStatus.ERROR,
                    error="No matching prompt found in vault to review.",
                ),
            )

        prompt_data = results[0]
        full_text = prompt_data.get("full_prompt", "")

        # Structural checks
        required_sections = ["角色", "任务", "输入", "输出格式", "硬约束", "生成要求"]
        for section in required_sections:
            if section not in full_text:
                issues.append(f"Missing section: {section}")

        # Constraint check
        global_entries = hydrate_results.get("global_entries", [])
        for entry in global_entries:
            for c in entry.get("hard_constraints_added", []):
                if c not in full_text:
                    issues.append(f"GLOBAL constraint not reflected: {c}")

        review_report = "\n".join(f"- {i}" for i in issues) if issues else "All checks passed."
        return AgentLoopResult(
            status=AgentStatus.OK,
            response=PromptCraftResponse(
                status=AgentStatus.OK,
                prompt=f"## Review Report\n\n{review_report}\n\n---\n\n{full_text}",
                analysis=None,
                metadata=None,
            ),
        )

    # ── Circuit breaker ─────────────────────────────────────────────────────

    MAX_CIRCUIT_BREAKER = 3  # Cf. Claude Code's MAX_CONSECUTIVE_AUTOCOMPACT_FAILURES

    def _should_break(self) -> bool:
        """Check if the circuit breaker should trip.

        Trip condition: last 3 iterations show no quality improvement.
        """
        if len(self.state.quality_trend) < self.MAX_CIRCUIT_BREAKER:
            return False

        recent = self.state.quality_trend[-self.MAX_CIRCUIT_BREAKER:]
        # No improvement if trend is flat or declining
        is_stalled = all(
            recent[i] >= recent[i + 1] for i in range(len(recent) - 1)
        ) and recent[-1] <= recent[0]

        if is_stalled:
            self.state.circuit_breaker_count += 1
        else:
            self.state.circuit_breaker_count = 0

        return self.state.circuit_breaker_count >= 1

    def _reset_circuit_breaker(self) -> None:
        self.state.circuit_breaker_count = 0
        self.state.quality_trend.clear()

    def _build_stalled_response(self, request: PromptCraftRequest) -> AgentLoopResult:
        """Build the structured escalation response.

        This does NOT dump raw prompt text to the user. It constructs a specific,
        answerable question for the main agent to relay in natural language.
        """
        # Determine blocker type — include circuit breaker state
        breaker_summary = self._breaker.summary() if self._breaker else {}
        if breaker_summary.get("state") == "OPEN":
            blocker = "circuit_breaker_open"
        elif breaker_summary.get("consecutive_low_quality", 0) >= 5:
            blocker = "low_quality_spiral"
        else:
            blocker = "quality_stagnation"
        trend = self.state.quality_trend[-3:] if len(self.state.quality_trend) >= 3 else self.state.quality_trend

        conflict = ConflictDetail(
            conflicting_items=[
                f"Prompt version {self.state.current_version}",
                f"Technique: {self.state.last_technique}",
            ],
            why_conflict=(
                f"Quality scores across {len(trend)} iterations: {trend}. "
                "No improvement detected — the selected technique or constraints "
                "may be fundamentally misaligned with the task."
            ),
            options=[
                "A) Try a different technique (engine will re-route with revised analysis)",
                "B) Relax one or more hard constraints (specify which)",
                "C) Clarify the task requirements with the user (task may be underspecified)",
            ],
        )

        return AgentLoopResult(
            status=AgentStatus.STALLED,
            stalled=StalledResponse(
                tries=self.state.call_count,
                quality_trend=trend,
                blocker=blocker,
                conflict_detail=conflict,
                question_for_main_agent=(
                    f"PromptCraft has tried {len(trend)} iterations (quality: {trend}) "
                    f"for task '{request.task[:80]}...' using {self.state.last_technique}. "
                    "Quality is not improving. Should we: "
                    + " | ".join(conflict.options)
                ),
            ),
        )

# ── Module-level convenience ──────────────────────────────────────────────────

def create_engine(skills_dir: str = "skills") -> PromptCraftEngine:
    """Factory for a fresh Engine instance."""
    return PromptCraftEngine(skills_dir=skills_dir)
