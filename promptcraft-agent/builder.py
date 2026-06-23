"""PromptCraft Agent — Technique router + quality scoring.

The two pure-function responsibilities that stay in Python:
  1. Technique selection — keyword heuristic, fast + zero-cost
  2. Quality scoring — deterministic 1-5 from feedback signals

Prompt generation is the LLM sub-agent's job — it reads the selected
technique reference file from skills/prompt-techniques/references/
and applies the technique to generate the 8-section prompt.
"""

from __future__ import annotations

from typing import Any

from protocol import Analysis, Technique


# ── Technique Router ────────────────────────────────────────────────────────────

# Routing table: (independence, cognitive_load) → technique
_ROUTING_TABLE: dict[tuple[str, str], Technique] = {
    ("continuous",  "low"):    Technique.ZERO_SHOT,
    ("independent", "low"):    Technique.ZERO_SHOT,
    ("continuous",  "medium"): Technique.FEW_SHOT,
    ("independent", "medium"): Technique.ZERO_SHOT_COT,
    ("continuous",  "high"):   Technique.FEW_SHOT_COT,
    ("independent", "high"):   Technique.TREE_OF_THOUGHT,
}

_RATIONALE: dict[Technique, str] = {
    Technique.ZERO_SHOT:      "Low load — direct instruction suffices.",
    Technique.FEW_SHOT:       "Fixed I/O pattern expected — examples anchor output format.",
    Technique.ZERO_SHOT_COT:  "Multi-step reasoning needed, no examples provided.",
    Technique.FEW_SHOT_COT:   "Complex reasoning with provided examples — relay pattern.",
    Technique.STEP_BACK:      "Vague or legacy — abstract to principles first.",
    Technique.LEAST_TO_MOST:  "Decomposable into ordered subproblems.",
    Technique.TREE_OF_THOUGHT: "High risk, multi-path — explore + evaluate + prune.",
}

# Technique name → reference file path
TECHNIQUE_REFERENCE: dict[str, str] = {
    "zero-shot":       "skills/prompt-techniques/references/zero-shot.md",
    "few-shot":        "skills/prompt-techniques/references/few-shot.md",
    "zero-shot-cot":   "skills/prompt-techniques/references/chain-of-thought.md",
    "few-shot-cot":    "skills/prompt-techniques/references/chain-of-thought.md",
    "step-back":       "skills/prompt-techniques/references/step-back.md",
    "least-to-most":   "skills/prompt-techniques/references/least-to-most.md",
    "tree-of-thought": "skills/prompt-techniques/references/tree-of-thought.md",
}

# Keyword sets for heuristic classification
_HIGH_LOAD_WORDS = {
    "security", "audit", "crypto", "encrypt", "concurrent",
    "thread", "transaction", "rollback", "compile", "protocol",
}
_LOW_LOAD_WORDS = {
    "rename", "format", "comment", "config", "readme", "simple", "basic",
}
_CONTINUOUS_WORDS = {
    "fix", "modify", "update", "change", "refactor", "extend",
    "add to", "improve", "debug",
}


def route_technique(task: str, context=None) -> Analysis:
    """Select the best prompt-engineering technique via keyword heuristic.

    Determines independence (continuous vs independent) and cognitive load
    (low/medium/high) from task keywords, then looks up the technique in
    the routing table.
    """
    task_lower = task.lower()

    # ── Independence ──
    continuous = any(w in task_lower for w in _CONTINUOUS_WORDS)
    if not continuous and context and getattr(context, 'session_context', None):
        continuous = any(
            w in str(context.session_context).lower()
            for w in ("continuing", "next step")
        )
    independence = "continuous" if continuous else "independent"

    # ── Cognitive load ──
    if any(w in task_lower for w in _HIGH_LOAD_WORDS):
        load = "high"
    elif any(w in task_lower for w in _LOW_LOAD_WORDS):
        load = "low"
    else:
        load = "medium" if len(task.split()) > 8 else "low"

    technique = _ROUTING_TABLE.get((independence, load), Technique.ZERO_SHOT)
    return Analysis(
        technique=technique.value,
        rationale=_RATIONALE.get(technique, "Default route."),
        independence=independence,
        cognitive_load=load,
    )


# ── Quality Scoring ─────────────────────────────────────────────────────────────

def score_quality(feedback) -> int:
    """Score execution feedback 1-5. Single source of truth — used by both
    builder and engine to avoid duplicate logic.

    Handles both ExecutionFeedback dataclass and plain dict (from JSON).
    """
    if feedback is None:
        return 0

    # Normalise to dict for uniform access
    if hasattr(feedback, "success"):
        fb = {"success": feedback.success,
              "constraint_violations": getattr(feedback, "constraint_violations", []),
              "manual_fixes_needed": getattr(feedback, "manual_fixes_needed", "")}
    elif isinstance(feedback, dict):
        fb = feedback
    else:
        return 0

    if fb.get("success") and not fb.get("constraint_violations") and not fb.get("manual_fixes_needed"):
        return 5
    if fb.get("success") and not fb.get("constraint_violations"):
        return 4
    if fb.get("success"):
        return 3
    if fb.get("constraint_violations"):
        return 2
    return 1


# ── Vault context helpers ───────────────────────────────────────────────────────

def extract_global_constraints(hydrate_results: dict[str, Any] | None) -> list[str]:
    """Extract GLOBAL hard constraints from hydrate results.

    GLOBAL entries are always returned by hydrate.py regardless of query match.
    These constraints must be injected into every generated prompt.
    """
    constraints: list[str] = []
    if not hydrate_results:
        return constraints
    for entry in hydrate_results.get("global_entries", []):
        for c in entry.get("hard_constraints_added", []):
            if c not in constraints:
                constraints.append(c)
    return constraints
