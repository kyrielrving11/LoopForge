"""PromptCraft Agent — HealthReport (compact status signal to main agent).

The HealthReport is the ONLY mechanism by which PromptCraft communicates
its internal state to the main agent. It is a one-line compact string
designed to be prepended to every sub-agent response.

Design principle (from subagent-orchestration-plan.md):
    "Health Report 是唯一信号机制 — 主 Agent 不需要理解 PromptCraft 内部"

Thresholds (from v3 three-tier gating):
    Pattern Analysis: >= 10 records
    Evolution:        >= 20 records + consistency >= 65%
    Creation:         >= 30 records + stable pattern
    Stalled:          3 consecutive quality scores with no improvement
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any


# ── Threshold constants ─────────────────────────────────────────────────────────

ANALYSIS_THRESHOLD = 10        # >= 10 records → pattern analysis recommended
EVOLUTION_THRESHOLD = 20       # >= 20 records + >= 65% consistency
CREATION_THRESHOLD = 30        # >= 30 records + stable pattern
CONSISTENCY_THRESHOLD = 0.65   # overlay appears in >= 65% of records
STALLED_THRESHOLD = 3          # 3 consecutive quality scores with no improvement


# ── Consistency helper ──────────────────────────────────────────────────────────

def _compute_consistency(feedback: list[dict[str, Any]]) -> float:
    """Compute overlay_used consistency across feedback records (Jaccard avg).

    High consistency → same constraints being added repeatedly →
    worth solidifying into a Skill.
    """
    if len(feedback) < 2:
        return 0.0
    overlays = [f.get("overlay_used", []) for f in feedback]
    jaccards = []
    for i in range(len(overlays)):
        for j in range(i + 1, len(overlays)):
            a, b = set(overlays[i]), set(overlays[j])
            if not a and not b:
                continue
            j = len(a & b) / len(a | b) if (a | b) else 0.0
            jaccards.append(j)
    return sum(jaccards) / len(jaccards) if jaccards else 0.0


# ── HealthReport ────────────────────────────────────────────────────────────────

@dataclass
class HealthReport:
    """Compact health signal returned with every PromptCraft response.

    The main agent reads ONLY recommended_action and compact_str().
    No internal vault details are exposed.
    """

    # ── Status indicators ──
    feedback_buffer_size: int = 0       # Current accumulated feedback records
    analysis_ran_this_time: bool = False  # Did silent analysis run this call?
    pattern_detected: bool = False      # High-frequency pattern found (>=10 records)
    evolution_ready: bool = False       # Skill evolution warranted (>=20 + >=65%)
    creation_ready: bool = False        # New Skill creation warranted (>=30)
    stalled: bool = False               # 3 consecutive no-improvement iterations

    # ── Action guidance ──
    recommended_action: str = "none"    # "none" | "run_analysis" | "review_evolution"
                                        # | "review_creation" | "stalled_needs_human"

    # ── Human-readable summary (main agent can display to user) ──
    summary: str = ""

    # ── Proactive awareness (vault context without changing passive model) ──
    proactive_signals: list[str] = field(default_factory=list)

    # ── Lightweight vault hints (available even below 10-record threshold) ──
    vault_hints: list[str] = field(default_factory=list)

    # ── Session metrics (observability) ──
    metrics: Any | None = None   # EngineMetrics from engine session

    def compact_str(self, breaker_state: str = "") -> str:
        """Single-line format — doesn't consume main agent context.

        Example:
            [PC: 15 records, normal]
            [PC: 25 records, signals=3, action=review_evolution]
            [PC: 8 records, STALLED, action=stalled_needs_human]
            [PC: 12 records, BREAKER=OPEN, action=stalled_needs_human]
            [PC: 10 records, errs=3, action=run_analysis]
            [PC: 5 records | hint: similar→solidity-audit q=4.2, normal]
        """
        # Metrics degradation suffix
        degradation = ""
        if self.metrics:
            errs = (self.metrics.vault_write_errors + self.metrics.vault_write_timeouts
                    + self.metrics.silent_analysis_errors + self.metrics.subprocess_timeouts)
            if errs > 0:
                degradation = f", errs={errs}"

        # Build signal count suffix if proactive signals present
        signal_part = ""
        if self.proactive_signals:
            signal_part = f", signals={len(self.proactive_signals)}"

        # Build hint suffix from vault_hints (available even below threshold)
        hint_part = ""
        if self.vault_hints:
            hint_part = " | hint: " + "; ".join(self.vault_hints[:2])

        if self.recommended_action == "none":
            line = f"[PC: {self.feedback_buffer_size} records{degradation}{signal_part}{hint_part}, normal]"
            if breaker_state and breaker_state != "CLOSED":
                line = f"[PC: {self.feedback_buffer_size} records{degradation}{signal_part}{hint_part}, breaker={breaker_state}, normal]"
            return line
        parts = [f"[PC: {self.feedback_buffer_size} records"]
        if breaker_state and breaker_state != "CLOSED":
            parts.append(f"breaker={breaker_state}")
        if self.stalled:
            parts.append("STALLED")
        if degradation:
            parts.append(degradation.strip(", "))
        if self.proactive_signals:
            parts.append(f"signals={len(self.proactive_signals)}")
        if self.vault_hints:
            parts.append("hint: " + "; ".join(self.vault_hints[:2]))
        parts.append(f"action={self.recommended_action}]")
        return ", ".join(parts)

    def compact_line(self) -> str:
        """Alias for compact_str() — backward compatibility."""
        return self.compact_str()

    @staticmethod
    def compute(
        feedback_buffer: list[dict[str, Any]],
        analysis_ran: bool = False,
        proactive_signals: list[str] | None = None,
        metrics: Any | None = None,
        vault_hints: list[str] | None = None,
    ) -> "HealthReport":
        """Compute HealthReport from vault state.

        Pure function — no side effects, no I/O. The caller provides
        the feedback buffer and whether analysis just ran.

        Args:
            feedback_buffer: List of feedback signal dicts from vault.
            analysis_ran: True if silent analysis was triggered this call.
            proactive_signals: Optional proactive signals from pattern analysis.
            metrics: Optional EngineMetrics for observability degradation signals.
            vault_hints: Optional lightweight vault hints — available even
                         below the 10-record threshold. Each hint is a short
                         actionable string like "similar→solidity-audit q=4.2".

        Returns:
            HealthReport with threshold checks applied.
        """
        n = len(feedback_buffer)

        p_signals = proactive_signals or []
        v_hints = vault_hints or []

        # Fast path: insufficient data
        if n < ANALYSIS_THRESHOLD:
            return HealthReport(
                feedback_buffer_size=n,
                analysis_ran_this_time=analysis_ran,
                recommended_action="none",
                summary=f"Normal operation. {n} feedback records accumulated.",
                proactive_signals=p_signals,
                vault_hints=v_hints,
                metrics=metrics,
            )

        # Pattern detected (>=10 records)
        report = HealthReport(
            feedback_buffer_size=n,
            analysis_ran_this_time=analysis_ran,
            pattern_detected=True,
            proactive_signals=p_signals,
            vault_hints=v_hints,
            metrics=metrics,
        )

        # ── Stall detection: last 3 scores flat or declining AND low quality ──
        recent = feedback_buffer[-STALLED_THRESHOLD:]
        if len(recent) >= STALLED_THRESHOLD:
            scores = [r.get("quality_score", 0) for r in recent]
            no_improvement = all(
                scores[i] >= scores[i + 1] for i in range(len(scores) - 1)
            )
            # Only stalled if quality is actually problematic (≤3)
            if no_improvement and min(scores) <= 3:
                report.stalled = True
                report.recommended_action = "stalled_needs_human"
                report.summary = (
                    "Circuit breaker: 3 consecutive executions without improvement."
                )
                report.proactive_signals = p_signals
                report.vault_hints = v_hints
                return report

        # ── Creation ready (>=30 records) ──
        if n >= CREATION_THRESHOLD:
            report.creation_ready = True
            report.recommended_action = "review_creation"
            report.summary = (
                f"Strong pattern detected ({n} records). "
                "Consider creating a new Skill."
            )
            report.proactive_signals = p_signals
            report.vault_hints = v_hints
            return report

        # ── Evolution ready (>=20 records + >=65% consistency) ──
        if n >= EVOLUTION_THRESHOLD:
            consistency = _compute_consistency(feedback_buffer)
            if consistency >= CONSISTENCY_THRESHOLD:
                report.evolution_ready = True
                report.recommended_action = "review_evolution"
                report.summary = (
                    f"High-consistency pattern ({consistency:.0%}). "
                    "Skill evolution suggested."
                )
                report.proactive_signals = p_signals
                report.vault_hints = v_hints
                return report

        # ── Pattern detected but not ready for evolution ──
        report.recommended_action = "run_analysis"
        report.summary = (
            f"Pattern detected ({n} records). "
            "Run analysis for detailed insights."
        )
        report.proactive_signals = p_signals
        report.vault_hints = v_hints
        return report


# ── Standalone health check (no engine needed) ──────────────────────────────────

def check_health(
    vault_aggregate: dict[str, Any] | None = None,
    buffer_size: int = 0,
) -> HealthReport:
    """Check health from vault state — no engine invocation needed.

    Can be called at session start or any time the main agent wants to
    check PromptCraft's health without invoking the full engine.

    Args:
        vault_aggregate: Optional result from hydrate.py --aggregate.
        buffer_size: Known in-memory buffer size (0 if unknown).

    Returns:
        HealthReport with current state and recommendations.
    """
    records: list[dict[str, Any]] = []

    # Convert aggregate data to record-like dicts for HealthReport.compute()
    if vault_aggregate and vault_aggregate.get("results"):
        for group in vault_aggregate["results"]:
            total = group.get("total_records", 0)
            avg_q = round(group.get("avg_quality", 0))
            overlays = [
                ov.get("overlay", "")
                for ov in group.get("high_freq_overlays", [])
            ]
            for _ in range(total):
                records.append({
                    "quality_score": avg_q,
                    "overlay_used": overlays,
                })

    # Pad with buffer entries if aggregate didn't cover them
    while len(records) < buffer_size:
        records.append({"quality_score": 0})

    return HealthReport.compute(records)


# ── Backward-compatible wrapper ─────────────────────────────────────────────────

def compute_health(
    buffer_size: int,
    quality_trend: list[int],
    aggregate_data: dict[str, Any] | None = None,
    analysis_count: int = 0,
) -> HealthReport:
    """Backward-compatible wrapper around HealthReport.compute().

    Used by engine.py which passes integer counts rather
    than raw feedback buffer dicts.

    Prefer HealthReport.compute() for new code.
    """
    # Build synthetic buffer entries from available data
    synthetic: list[dict[str, Any]] = []
    for i in range(buffer_size):
        entry: dict[str, Any] = {"quality_score": 0}
        if i < len(quality_trend):
            entry["quality_score"] = quality_trend[i]
        synthetic.append(entry)

    return HealthReport.compute(
        synthetic,
        analysis_ran=(analysis_count > 0),
    )
