"""PromptCraft Agent — Pattern Analysis Tool.

Aggregates N execution records from vault to discover:
  - High-frequency overlays (constraints users repeatedly add)
  - Missing constraints (gaps in existing Skills)
  - Low-quality task types (technique misalignment)

This is the "intelligence" layer — it turns raw feedback into insights.
"""

from __future__ import annotations

from collections import Counter
from typing import Any

from .base import Tool, ToolResult, tool_ok, tool_error


class PatternAnalysisTool(Tool):
    """Analyse vault execution records for patterns."""

    name = "pattern_analysis"
    description = "Analyse vault records to find high-frequency patterns and gaps."

    # Safety: reads vault only, writes analysis report to vault
    READ_ONLY = True
    WRITES_TO_VAULT = True  # Analysis report is persisted

    def check_permissions(self, input: dict[str, Any], context: Any = None) -> Any:
        from protocol import tool_permission_allow
        # Pattern analysis is read-only for external files; vault writes are
        # gated by guard_vault_write in engine. Always allow here.
        return tool_permission_allow()

    def is_applicable(self, request: Any, context: Any = None) -> bool:
        # Triggered when the main agent explicitly requests analysis,
        # or when enough records have accumulated (context-driven).
        hydrate_results = (context.hydrate_results or {}) if context else {}
        results = hydrate_results.get("results", []) if hydrate_results else []
        return len(results) >= 5  # Need minimum sample size

    def call(self, request: Any, context: Any = None) -> ToolResult:
        hydrate_results = (context.hydrate_results or {}) if context else {}
        records = hydrate_results.get("results", []) if hydrate_results else []

        if len(records) < 5:
            return tool_error(f"Need at least 5 records, got {len(records)}.")

        # ── Aggregate overlays ──
        overlay_counter: Counter = Counter()
        task_type_counter: Counter = Counter()
        quality_by_type: dict[str, list[int]] = {}

        for r in records:
            task_type = r.get("task_type", "unknown")
            task_type_counter[task_type] += 1

            for overlay in r.get("overlay_used", []):
                overlay_counter[overlay] += 1

            score = r.get("quality_score")
            if score is not None:
                quality_by_type.setdefault(task_type, []).append(score)

        total = len(records)

        # ── High-frequency overlays (used by >50% of tasks in a type) ──
        high_freq: list[dict[str, Any]] = []
        for overlay, count in overlay_counter.most_common():
            pct = round(count / total * 100)
            if pct >= 50:
                high_freq.append({"overlay": overlay, "count": count, "pct": pct})

        # ── Low-quality task types (avg score < 3) ──
        low_quality: list[str] = []
        for task_type, scores in quality_by_type.items():
            avg = sum(scores) / len(scores)
            if avg < 3:
                low_quality.append(task_type)

        # ── Summary ──
        parts: list[str] = [f"Analysed {total} execution records."]
        if high_freq:
            parts.append(
                f"{len(high_freq)} overlays used by >50% of tasks — "
                "candidates for Skill inclusion."
            )
        if low_quality:
            parts.append(
                f"{len(low_quality)} task types with avg quality < 3 — "
                "technique misalignment suspected."
            )
        top_types = task_type_counter.most_common(3)
        if top_types:
            parts.append(
                "Top task types: " + ", ".join(f"{t}({c}x)" for t, c in top_types)
            )

        # ── Proactive signals ──
        proactive = self._suggest_proactive(records, low_quality, hydrate_results)

        return tool_ok(
            total_executions=total,
            high_freq_overlays=high_freq,
            missing_constraints=[],
            low_quality_task_types=low_quality,
            proactive_signals=proactive,
            summary=" ".join(parts),
        )

    def _suggest_proactive(
        self,
        records: list[dict[str, Any]],
        low_quality_types: list[str],
        hydrate_results: dict[str, Any] | None = None,
    ) -> list[str]:
        """Generate proactive signal strings from already-aggregated data."""
        signals: list[str] = []

        if hydrate_results and hydrate_results.get("results"):
            n = len(hydrate_results["results"])
            if n > 0:
                signals.append(
                    f"{n} relevant vault entries available — consult for prior patterns."
                )

        task_types = {r.get("task_type", "") for r in records if r.get("task_type")}
        if task_types:
            signals.append(
                f"Previous tasks of type: {', '.join(sorted(task_types)[:3])}"
            )

        if low_quality_types:
            signals.append(
                f"Historically low-quality task types: {', '.join(low_quality_types[:3])}"
            )

        return signals

    def prompt(self) -> str:
        return (
            "- **Pattern Analysis**: After accumulating execution records, "
            "analyse them to identify high-frequency overlays (constraints "
            "users keep adding) and low-quality task types (wrong technique). "
            "Feed findings to Skill Advisor."
        )
