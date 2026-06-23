"""Tests for subagent_adapter.py — mode routing, parsing, formatting.

Run:  python tests/test_subagent_adapter.py
"""

import json
import sys
import unittest
from pathlib import Path

AGENT_DIR = Path(__file__).resolve().parent.parent / "promptcraft-agent"
sys.path.insert(0, str(AGENT_DIR))

from protocol import Mode, PromptCraftRequest, AgentLoopResult, AgentStatus, PromptCraftResponse
from subagent_adapter import (
    MODE_MAP, _parse_request, _route_to_engine, _build_agent_response,
    handle,
)
from engine import create_engine
from health_report import HealthReport


class TestModeMap(unittest.TestCase):
    """MODE_MAP covers all 5 sub-agent modes + legacy."""

    def test_all_five_modes_mapped(self):
        self.assertEqual(MODE_MAP["overlay"], Mode.OVERLAY)
        self.assertEqual(MODE_MAP["build"], Mode.FULL)
        self.assertEqual(MODE_MAP["feedback"], Mode.FEEDBACK)
        self.assertEqual(MODE_MAP["analyze"], Mode.ANALYZE)
        self.assertEqual(MODE_MAP["advise"], Mode.ADVISE)

    def test_legacy_modes_mapped(self):
        self.assertEqual(MODE_MAP["full"], Mode.FULL)
        self.assertEqual(MODE_MAP["quick"], Mode.QUICK)
        self.assertEqual(MODE_MAP["review"], Mode.REVIEW)


class TestParseRequest(unittest.TestCase):
    """_parse_request handles dict and string input."""

    def test_parse_dict(self):
        r = _parse_request({"task": "test", "mode": "build"})
        self.assertIsInstance(r, PromptCraftRequest)
        self.assertEqual(r.task, "test")
        self.assertEqual(r.mode, Mode.FULL)  # "build" → Mode.FULL in MODE_MAP

    def test_parse_default_mode(self):
        r = _parse_request({"task": "test"})
        self.assertEqual(r.mode, Mode.FULL)

    def test_parse_invalid_mode_falls_back(self):
        r = _parse_request({"task": "test", "mode": "garbage"})
        self.assertEqual(r.mode, Mode.FULL)


class TestRouteToEngine(unittest.TestCase):
    """_route_to_engine dispatches to the correct engine method."""

    def setUp(self):
        self.engine = create_engine()

    def test_route_overlay_with_skill(self):
        r = PromptCraftRequest(task="audit", mode=Mode.OVERLAY, skill_name="solidity-audit")
        result = _route_to_engine(self.engine, r)
        self.assertEqual(result.status, AgentStatus.OK)
        self.assertIn("Personalization Overlay", result.response.prompt)

    def test_route_build(self):
        r = PromptCraftRequest(task="build API", mode=Mode.FULL)
        result = _route_to_engine(self.engine, r)
        self.assertEqual(result.status, AgentStatus.OK)
        self.assertIn("Technique Selected", result.response.prompt)

    def test_route_analyze_insufficient_data(self):
        r = PromptCraftRequest(task="analyze", mode=Mode.ANALYZE)
        result = _route_to_engine(self.engine, r)
        # With insufficient records, returns an informative error message
        text = (result.response.prompt or "") + (result.response.error or "")
        self.assertTrue(len(text) > 0)

    def test_route_advise_insufficient_data(self):
        r = PromptCraftRequest(task="advise", mode=Mode.ADVISE)
        result = _route_to_engine(self.engine, r)
        # With insufficient data, returns an informative message
        text = (result.response.prompt or "") + (result.response.error or "")
        self.assertTrue(len(text) > 0)


class TestBuildAgentResponse(unittest.TestCase):
    """_build_agent_response produces correct SubagentOutput JSON."""

    def test_response_format_structure(self):
        result = AgentLoopResult(
            status=AgentStatus.OK,
            response=PromptCraftResponse(
                status=AgentStatus.OK,
                prompt="test prompt",
            ),
        )
        health = HealthReport(feedback_buffer_size=5)
        raw = _build_agent_response(result, health, "build")
        data = json.loads(raw)
        self.assertIn("health", data)
        self.assertIn("status", data)
        self.assertIn("result", data)
        self.assertEqual(data["status"], "ok")
        self.assertEqual(data["result"]["mode"], "build")
        self.assertEqual(data["result"]["prompt_or_overlay"], "test prompt")

    def test_response_error(self):
        result = AgentLoopResult(
            status=AgentStatus.ERROR,
            response=PromptCraftResponse(
                status=AgentStatus.ERROR,
                error="Something went wrong",
            ),
        )
        health = HealthReport()
        raw = _build_agent_response(result, health, "build")
        data = json.loads(raw)
        self.assertEqual(data["status"], "error")

    def test_response_stalled(self):
        from protocol import StalledResponse
        result = AgentLoopResult(
            status=AgentStatus.STALLED,
            stalled=StalledResponse(
                tries=3,
                quality_trend=[2, 2, 2],
                blocker="quality_stagnation",
                question_for_main_agent="Should we try a different technique?",
            ),
        )
        health = HealthReport(stalled=True)
        raw = _build_agent_response(result, health, "")
        data = json.loads(raw)
        self.assertIn("different technique", data["result"]["prompt_or_overlay"])


class TestHandleE2E(unittest.TestCase):
    """End-to-end handle() tests."""

    def test_handle_health_always_returned(self):
        """Every response includes a health line."""
        for mode in ["build", "analyze"]:
            raw = handle({"task": "test", "mode": mode})
            data = json.loads(raw)
            self.assertIn("health", data)
            self.assertTrue(data["health"].startswith("[PC:"))


class TestBatchAdapter(unittest.TestCase):
    """Phase 5: batch mode in adapter."""

    def test_mode_map_contains_batch(self):
        """MODE_MAP has batch -> Mode.BATCH."""
        self.assertIn("batch", MODE_MAP)
        self.assertEqual(MODE_MAP["batch"], Mode.BATCH)

    def test_batch_input_empty_items(self):
        """Batch with empty items returns error."""
        raw = handle({"mode": "batch", "items": []})
        data = json.loads(raw)
        self.assertEqual(data["status"], "error")
        self.assertIn("at least one item", data["result"]["error"])

    def test_batch_input_valid(self):
        """Batch with valid items succeeds."""
        raw = handle({
            "mode": "batch",
            "items": [
                {"task": "audit token", "skill_name": "solidity-audit"},
                {"task": "write docs"},
            ]
        })
        data = json.loads(raw)
        self.assertEqual(data["result"]["mode"], "batch")
        self.assertIn("health", data)


if __name__ == "__main__":
    unittest.main(verbosity=2)
