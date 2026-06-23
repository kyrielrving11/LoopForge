"""PromptCraft Agent — Prompt Build Tool (technique selector).

This tool selects the best prompt-engineering technique via keyword heuristic
and returns the technique name + reference file path + vault context.

The LLM sub-agent then reads the selected reference file and generates
the actual 8-section prompt — Python does NOT generate prompt text.
"""

from __future__ import annotations

import sys
from pathlib import Path
from typing import Any

from .base import Tool, ToolResult, tool_ok, tool_error

# Ensure promptcraft-agent/ is on sys.path so we can import builder unconditionally.
_AGENT_DIR = Path(__file__).resolve().parent.parent
if str(_AGENT_DIR) not in sys.path:
    sys.path.insert(0, str(_AGENT_DIR))

from builder import route_technique, extract_global_constraints, TECHNIQUE_REFERENCE  # noqa: E402


class PromptBuildTool(Tool):
    """Select technique and prepare context for LLM-driven prompt generation.

    Does NOT generate prompts — that's the LLM sub-agent's job.
    """

    name = "prompt_build"
    description = "Select prompt-engineering technique and prepare context for LLM generation."

    # Safety: reads skills (for technique refs), writes to vault (checkpoint)
    WRITES_TO_VAULT = True
    READS_SKILLS = True

    def check_permissions(self, input: dict[str, Any], context: Any = None) -> Any:
        from protocol import tool_permission_allow, tool_permission_deny
        task = input.get("task", "")
        if not task or len(str(task).strip()) < 3:
            return tool_permission_deny("Task too short for prompt build.")
        return tool_permission_allow()

    def is_applicable(self, request: Any, context: dict[str, Any] | None = None) -> bool:
        # Fallback — runs last when no other tool has claimed the request
        return True

    def call(self, request: Any, context: Any = None) -> ToolResult:
        hydrate_results = context.hydrate_results if context else None

        try:
            analysis = route_technique(request.task, request.context)
        except Exception as exc:
            return tool_error(f"Technique routing failed: {exc}")

        technique = analysis.technique
        ref_file = TECHNIQUE_REFERENCE.get(technique, "")

        global_constraints = extract_global_constraints(hydrate_results)
        # Also extract per-result constraints for self-awareness
        past_feedback: dict[str, Any] = {}
        if hydrate_results:
            for result in hydrate_results.get("results", []):
                score = result.get("feedback", {}).get("quality_score")
                if score is not None:
                    past_feedback[result.get("task_id", "")] = {
                        "score": score,
                        "technique": result.get("technique", ""),
                        "notes": result.get("feedback", {}).get("improvement_notes", ""),
                    }

        tech_stack = (
            getattr(request.context, "tech_stack", "")
            if request.context else ""
        )

        return tool_ok(
            technique=technique,
            rationale=analysis.rationale,
            independence=analysis.independence,
            cognitive_load=analysis.cognitive_load,
            reference_file=ref_file,
            task=request.task,
            tech_stack=tech_stack,
            global_constraints=global_constraints,
            past_feedback=past_feedback,
            mode="build",
        )

    def prompt(self) -> str:
        return (
            "- **Prompt Build**: When no existing Skill covers the user's task, "
            "use this tool to select the best prompt-engineering technique and "
            "prepare context. Then read the technique reference file and generate "
            "the complete 8-section prompt yourself (you are the LLM — you write "
            "the prompt, not Python)."
        )
