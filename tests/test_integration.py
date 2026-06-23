"""Integration tests — full 5-mode closed-loop workflows.

Run:  python tests/test_integration.py
"""

import json
import sys
import tempfile
import unittest
from pathlib import Path

AGENT_DIR = Path(__file__).resolve().parent.parent / "promptcraft-agent"
sys.path.insert(0, str(AGENT_DIR))

from protocol import Mode, PromptCraftRequest, Context
from engine import create_engine
from health_report import HealthReport, _compute_consistency


class TestOverlayToFeedbackLoop(unittest.TestCase):
    """overlay → simulate execution → feedback → verify buffer."""

    def setUp(self):
        self.engine = create_engine()

    def test_full_overlay_feedback_cycle(self):
        # 1. Overlay: get personalised constraints
        overlay_req = PromptCraftRequest(
            task="audit ERC20 token",
            mode=Mode.OVERLAY,
            skill_name="solidity-audit",
        )
        overlay_result = self.engine.invoke_overlay(overlay_req)
        self.assertIn("Personalization Overlay", overlay_result.response.prompt)
        self.assertIn("solidity-audit", overlay_result.response.prompt)

        # 2. Simulate execution (not actually executing — just recording)
        # 3. Feedback: record execution outcome
        feedback_req = PromptCraftRequest(
            task="audit ERC20 token",
            mode=Mode.FEEDBACK,
            feedback={"output": "Audit complete: 3 issues found", "success": True},
            skill_name="solidity-audit",
        )
        fb_result = self.engine.invoke_feedback(feedback_req)
        self.assertIsNotNone(fb_result.feedback)
        self.assertGreaterEqual(fb_result.feedback.quality_score, 4)

        # 4. Verify buffer has the feedback
        self.assertGreaterEqual(len(self.engine.state.feedback_buffer), 1)


class TestBuildToFeedbackLoop(unittest.TestCase):
    """build → simulate execution → feedback → verify quality tracking."""

    def setUp(self):
        self.engine = create_engine()

    def test_full_build_feedback_cycle(self):
        # 1. Build: generate 8-section prompt
        build_req = PromptCraftRequest(
            task="implement user authentication API",
            mode=Mode.FULL,
            context=Context(tech_stack="Python FastAPI"),
        )
        build_result = self.engine.invoke_build(build_req)
        self.assertIn("Technique Selected", build_result.response.prompt)
        self.assertIn("Reference file", build_result.response.prompt)

        # 2. Feedback: record execution (simulated partial success)
        feedback_req = PromptCraftRequest(
            task="implement user authentication API",
            mode=Mode.FEEDBACK,
            feedback={
                "output": "Auth API implemented with JWT",
                "success": True,
                "constraint_violations": ["Missing rate limiting"],
                "manual_fixes_needed": "Added rate limit after initial implementation",
            },
        )
        fb_result = self.engine.invoke_feedback(feedback_req)
        # With constraint violations, score should be lower than 5
        self.assertIsNotNone(fb_result.feedback)
        self.assertLessEqual(fb_result.feedback.quality_score, 4)

        # 3. Verify quality tracking
        self.assertEqual(self.engine.state.call_count, 2)
        self.assertGreaterEqual(len(self.engine.state.quality_trend), 1)


class TestSilentAnalysisTrigger(unittest.TestCase):
    """≥10 feedback records → silent analysis automatically triggers."""

    def setUp(self):
        self.engine = create_engine()

    def _feed_n_records(self, n: int, quality: int = 4):
        """Feed n identical feedback records to the engine."""
        for i in range(n):
            req = PromptCraftRequest(
                task=f"task-{i}",
                mode=Mode.FEEDBACK,
                feedback={"output": f"result-{i}", "success": True},
            )
            self.engine.invoke_feedback(req)

    def test_silent_analysis_runs_at_threshold(self):
        # Feed 9 records — silent analysis should NOT run
        self._feed_n_records(9)
        h = self.engine.maybe_silent_analyze()
        self.assertFalse(h.analysis_ran_this_time)
        self.assertFalse(h.pattern_detected)

        # Feed the 10th record — silent analysis SHOULD run
        self._feed_n_records(1)  # Now 10 total
        h = self.engine.maybe_silent_analyze()
        self.assertTrue(h.analysis_ran_this_time)
        self.assertTrue(h.pattern_detected)
        self.assertEqual(h.recommended_action, "run_analysis")


class TestEvolutionSignal(unittest.TestCase):
    """≥20 high-consistency records → evolution_ready=True."""

    def test_evolution_ready_with_high_consistency(self):
        records = []
        for i in range(20):
            records.append({
                "quality_score": 4,
                "overlay_used": ["check-gas", "check-reentrancy", "check-access-control"],
            })
        h = HealthReport.compute(records)
        self.assertTrue(h.pattern_detected)
        self.assertTrue(h.evolution_ready)
        self.assertEqual(h.recommended_action, "review_evolution")
        self.assertIn("High-consistency", h.summary)

    def test_not_evolution_ready_with_low_consistency(self):
        records = []
        for i in range(20):
            records.append({
                "quality_score": 4,
                "overlay_used": [f"item-{i}", f"other-{i}"],  # All different
            })
        h = HealthReport.compute(records)
        self.assertTrue(h.pattern_detected)
        self.assertFalse(h.evolution_ready)
        self.assertEqual(h.recommended_action, "run_analysis")


class TestCreationSignal(unittest.TestCase):
    """≥30 records → creation_ready=True."""

    def test_creation_ready_at_threshold(self):
        records = []
        for i in range(30):
            records.append({
                "quality_score": 4,
                "overlay_used": ["check-gas", "check-reentrancy"],
            })
        h = HealthReport.compute(records)
        self.assertTrue(h.creation_ready)
        self.assertEqual(h.recommended_action, "review_creation")
        self.assertIn("Strong pattern", h.summary)

    def test_not_creation_at_29(self):
        records = []
        for i in range(29):
            records.append({
                "quality_score": 4,
                "overlay_used": ["check-gas"],
            })
        h = HealthReport.compute(records)
        self.assertFalse(h.creation_ready)
        self.assertTrue(h.evolution_ready)  # Should be evolution at 29


class TestStalledDetection(unittest.TestCase):
    """3 consecutive no-improvement iterations → stalled=True."""

    def test_stalled_after_three_flat_low_scores(self):
        records = []
        for i in range(7):
            records.append({"quality_score": 4, "overlay_used": []})
        # Last 3 are flat and low
        records.extend([
            {"quality_score": 2, "overlay_used": []},
            {"quality_score": 2, "overlay_used": []},
            {"quality_score": 2, "overlay_used": []},
        ])
        h = HealthReport.compute(records)
        self.assertTrue(h.stalled)
        self.assertEqual(h.recommended_action, "stalled_needs_human")

    def test_not_stalled_when_quality_high(self):
        """Flat scores at quality=4 are not stalled (too good to break)."""
        records = [{"quality_score": 4, "overlay_used": []}] * 10
        h = HealthReport.compute(records)
        self.assertFalse(h.stalled)
        self.assertNotEqual(h.recommended_action, "stalled_needs_human")

    def test_stalled_with_declining_trend(self):
        records = [{"quality_score": 4, "overlay_used": []}] * 7
        records.extend([
            {"quality_score": 3, "overlay_used": []},
            {"quality_score": 2, "overlay_used": []},
            {"quality_score": 1, "overlay_used": []},
        ])
        h = HealthReport.compute(records)
        self.assertTrue(h.stalled)


if __name__ == "__main__":
    unittest.main(verbosity=2)
