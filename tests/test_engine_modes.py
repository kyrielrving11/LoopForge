"""Tests for engine.py — all 5 invoke_* methods + maybe_silent_analyze.

Run:  python tests/test_engine_modes.py
"""

import sys
import unittest
from pathlib import Path

AGENT_DIR = Path(__file__).resolve().parent.parent / "promptcraft-agent"
sys.path.insert(0, str(AGENT_DIR))

from protocol import (
    AgentStatus, BatchRequest, BatchItem, Mode, PromptCraftRequest,
)
from engine import create_engine, PromptCraftEngine
from health_report import HealthReport


class TestInvokeOverlay(unittest.TestCase):
    """invoke_overlay() — Skill personalisation."""

    def setUp(self):
        self.engine = create_engine()

    def test_overlay_with_skill_name(self):
        r = PromptCraftRequest(
            task="audit contract",
            mode=Mode.OVERLAY,
            skill_name="solidity-audit",
        )
        result = self.engine.invoke_overlay(r)
        self.assertEqual(result.status, AgentStatus.OK)
        self.assertIn("Personalization Overlay", result.response.prompt)
        self.assertIn("solidity-audit", result.response.prompt)

    def test_overlay_without_skill_name_errors(self):
        r = PromptCraftRequest(task="audit", mode=Mode.OVERLAY)
        result = self.engine.invoke_overlay(r)
        self.assertEqual(result.status, AgentStatus.ERROR)
        self.assertIn("skill_name", result.response.error)


class TestInvokeBuild(unittest.TestCase):
    """invoke_build() — full 8-section prompt generation."""

    def setUp(self):
        self.engine = create_engine()

    def test_build_returns_technique_selection(self):
        """Build mode now returns technique selection + LLM instructions,
        not a pre-generated 8-section prompt."""
        r = PromptCraftRequest(task="build a REST API", mode=Mode.FULL)
        result = self.engine.invoke_build(r)
        self.assertEqual(result.status, AgentStatus.OK)
        prompt = result.response.prompt
        self.assertIn("Technique Selected", prompt)
        self.assertIn("Reference file", prompt)
        self.assertIn("Next Step", prompt)
        self.assertIn("Generate the complete 8-section prompt", prompt)
        # Analysis should contain the selected technique
        self.assertIsNotNone(result.response.analysis)
        self.assertIn(result.response.analysis.technique,
                      ["zero-shot", "few-shot", "zero-shot-cot", "few-shot-cot",
                       "step-back", "least-to-most", "tree-of-thought"])

    def test_build_tracks_state(self):
        r = PromptCraftRequest(task="test", mode=Mode.FULL)
        self.engine.invoke_build(r)
        self.assertEqual(self.engine.state.call_count, 1)


class TestInvokeFeedback(unittest.TestCase):
    """invoke_feedback() — execution feedback collection."""

    def setUp(self):
        self.engine = create_engine()

    def test_feedback_success_records(self):
        r = PromptCraftRequest(
            task="test task",
            mode=Mode.FEEDBACK,
            feedback={"output": "ok", "success": True},
        )
        result = self.engine.invoke_feedback(r)
        self.assertEqual(result.status, AgentStatus.OK)
        self.assertIsNotNone(result.feedback)
        self.assertGreaterEqual(result.feedback.quality_score, 4)

    def test_feedback_accumulates_in_buffer(self):
        r = PromptCraftRequest(
            task="task", mode=Mode.FEEDBACK,
            feedback={"output": "ok", "success": True},
        )
        self.engine.invoke_feedback(r)
        self.assertGreaterEqual(len(self.engine.state.feedback_buffer), 1)


class TestInvokeAnalyze(unittest.TestCase):
    """invoke_analyze() — pattern analysis."""

    def setUp(self):
        self.engine = create_engine()

    def test_analyze_insufficient_data(self):
        r = PromptCraftRequest(task="analyze", mode=Mode.ANALYZE)
        result = self.engine.invoke_analyze(r)
        # With insufficient records, returns ERROR with an informative message
        text = (result.response.prompt or "") + (result.response.error or "")
        self.assertTrue(len(text) > 0)  # Some message is returned


class TestInvokeAdvise(unittest.TestCase):
    """invoke_advise() — skill advisor."""

    def setUp(self):
        self.engine = create_engine()

    def test_advise_insufficient_data(self):
        r = PromptCraftRequest(task="advise", mode=Mode.ADVISE)
        result = self.engine.invoke_advise(r)
        # With insufficient data, may return an informative message or error
        text = (result.response.prompt or "") + (result.response.error or "")
        self.assertTrue(len(text) > 0)


class TestMaybeSilentAnalyze(unittest.TestCase):
    """maybe_silent_analyze() — silent pattern analysis."""

    def setUp(self):
        self.engine = create_engine()

    def test_returns_health_report(self):
        h = self.engine.maybe_silent_analyze()
        self.assertIsInstance(h, HealthReport)

    def test_null_state_returns_empty_health(self):
        self.engine.state = None
        h = self.engine.maybe_silent_analyze()
        self.assertEqual(h.feedback_buffer_size, 0)

    def test_insufficient_data_no_analysis(self):
        # Force lazy init via a method call
        self.engine._ensure_init(
            PromptCraftRequest(task="t", mode=Mode.FEEDBACK)
        )
        self.engine.state.feedback_buffer = [{"quality_score": 4}] * 5
        h = self.engine.maybe_silent_analyze()
        self.assertFalse(h.analysis_ran_this_time)

    def test_sufficient_data_triggers_analysis(self):
        self.engine._ensure_init(
            PromptCraftRequest(task="t", mode=Mode.FEEDBACK)
        )
        self.engine.state.feedback_buffer = [{"quality_score": 4}] * 10
        h = self.engine.maybe_silent_analyze()
        self.assertTrue(h.analysis_ran_this_time)
        self.assertTrue(h.pattern_detected)


class TestBackwardCompatInvoke(unittest.TestCase):
    """invoke() still routes correctly (backward compatibility)."""

    def setUp(self):
        self.engine = create_engine()

    def test_invoke_full_delegates_to_build(self):
        r = PromptCraftRequest(task="test", mode=Mode.FULL)
        result = self.engine.invoke(r)
        self.assertEqual(result.status, AgentStatus.OK)
        self.assertIn("Technique Selected", result.response.prompt)

    def test_invoke_overlay_mode(self):
        r = PromptCraftRequest(
            task="audit", mode=Mode.OVERLAY,
            skill_name="solidity-audit",
        )
        result = self.engine.invoke(r)
        self.assertIn("Personalization Overlay", result.response.prompt)


class TestInvokeBatch(unittest.TestCase):
    """Phase 5: batch processing mode."""

    def setUp(self):
        self.engine = create_engine()

    def test_batch_empty_items_returns_error(self):
        """Empty items list returns error."""
        req = BatchRequest(items=[])
        resp = self.engine.invoke_batch(req)
        self.assertEqual(resp.status, AgentStatus.ERROR)
        self.assertIn("at least one item", resp.error)

    def test_batch_single_item_no_skill(self):
        """One item without skill_name calls invoke_build."""
        req = BatchRequest(items=[BatchItem(task="audit token")])
        resp = self.engine.invoke_batch(req)
        self.assertEqual(resp.batch_summary.total, 1)
        self.assertEqual(resp.batch_summary.succeeded, 1)
        self.assertEqual(resp.item_results[0]["status"], "ok")

    def test_batch_single_item_with_skill(self):
        """One item with skill_name calls invoke_overlay."""
        req = BatchRequest(items=[
            BatchItem(task="audit staking", skill_name="solidity-audit")
        ])
        resp = self.engine.invoke_batch(req)
        self.assertEqual(resp.batch_summary.total, 1)
        self.assertEqual(resp.batch_summary.succeeded, 1)

    def test_batch_multiple_items_mixed(self):
        """Mixed items (with and without skill) all processed."""
        req = BatchRequest(items=[
            BatchItem(task="audit token", skill_name="solidity-audit"),
            BatchItem(task="write API docs"),
            BatchItem(task="audit staking", skill_name="solidity-audit"),
        ])
        resp = self.engine.invoke_batch(req)
        self.assertEqual(resp.batch_summary.total, 3)
        self.assertEqual(len(resp.item_results), 3)

    def test_batch_summary_counts(self):
        """BatchSummary counts reflect all items."""
        req = BatchRequest(items=[
            BatchItem(task="task a"),
            BatchItem(task="task b"),
        ])
        resp = self.engine.invoke_batch(req)
        s = resp.batch_summary
        self.assertEqual(s.total, 2)
        self.assertEqual(s.succeeded + s.failed, 2)


if __name__ == "__main__":
    unittest.main(verbosity=2)
