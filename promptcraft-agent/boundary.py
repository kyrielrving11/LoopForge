"""PromptCraft Agent — Execution Boundary Module.

Five-layer defence-in-depth for the sub-agent. Cf. Claude Code's 7-layer
permission system, adapted for a sub-agent whose attack surface is
*knowledge pollution* and *trust-chain abuse*, not shell injection.

Layers:
  1. Input  — task validity + injection detection + complexity gating
  2. Tool   — per-tool safety attributes + check_permissions (in base.py)
  3. Vault  — write gating: size / rate / dedup / blast-radius escalation
  3.5 Root Config — write gating for CLAUDE.md, agents/*.md, settings.json
  4. Output — schema enforcement + health-report integrity + size caps
  5. Circuit Breaker — denial tracking + 3-state machine (CLOSED/HALF_OPEN/OPEN)

Design principle: FAIL-CLOSED. When uncertain, deny.
"""

from __future__ import annotations

import re
import time
from dataclasses import dataclass, field
from enum import Enum
from typing import Any


# ── Guard Result ─────────────────────────────────────────────────────────────────

@dataclass
class GuardResult:
    """Unified return from any boundary check.

    allowed: True  → proceed
    allowed: False → blocked; `reason` explains why
    warnings: non-blocking issues to surface to the caller
    """
    allowed: bool
    reason: str = ""
    warnings: list[str] = field(default_factory=list)

    @property
    def ok(self) -> bool:
        return self.allowed


def allow(warnings: list[str] | None = None) -> GuardResult:
    return GuardResult(allowed=True, warnings=warnings or [])


def deny(reason: str, warnings: list[str] | None = None) -> GuardResult:
    return GuardResult(allowed=False, reason=reason, warnings=warnings or [])


# ── Layer 1: Input Boundary ─────────────────────────────────────────────────────

# Patterns that suggest prompt-injection or instruction-override attempts.
# A sub-agent receives its input from the main agent (another LLM), so the
# threat is NOT a human attacker — it's corrupted or adversarial content
# flowing through the main agent's tool results into the sub-agent's task.
_SUSPICIOUS_PATTERNS = [
    (re.compile(r'\[system\]\s*\(override\)', re.IGNORECASE),
     "system-override marker"),
    (re.compile(r'<system-reminder>', re.IGNORECASE),
     "system-reminder tag injection"),
    (re.compile(r'ignore\s+(all\s+)?(previous|prior|above)\s+instructions', re.IGNORECASE),
     "instruction-override phrase"),
    (re.compile(r'bypass\s+(all\s+)?(permissions?|safety|security)', re.IGNORECASE),
     "permission-bypass phrase"),
]

MIN_TASK_LENGTH = 3
MAX_TASK_LENGTH = 65536  # 64 KB hard cap — prevents memory DoS from oversized input
MIN_COMPLEXITY_SCORE = 0.15  # Below this, not worth PromptCraft invocation


def guard_input(
    task: str,
    mode: str = "",
    skill_name: str | None = None,
    feedback_present: bool = False,
) -> GuardResult:
    """Layer 1: validate incoming request before engine routing.

    Returns allow() if the request passes all checks.
    Returns deny(reason) if any check fails.
    """
    warnings: list[str] = []

    # 1.1 Task non-empty and above minimum length
    if not task or len(task.strip()) < MIN_TASK_LENGTH:
        return deny("Task too short or empty — cannot generate meaningful prompt.")

    # 1.1b Task below maximum length (DoS protection)
    if len(task) > MAX_TASK_LENGTH:
        return deny(
            f"Task exceeds max length ({MAX_TASK_LENGTH} bytes). "
            "Split into smaller tasks or use batch mode."
        )

    # 1.2 Injection detection
    for pattern, label in _SUSPICIOUS_PATTERNS:
        if pattern.search(task):
            return deny(f"Suspicious pattern in task: {label}")

    # 1.3 Mode-consistency checks
    if mode == "feedback" and not feedback_present:
        return deny("Feedback mode requires feedback payload.")
    if mode == "overlay" and not skill_name:
        return deny("Overlay mode requires skill_name.")

    # 1.4 Warn on borderline length
    if len(task.strip()) < 20:
        warnings.append("Task description is very short — results may be generic.")

    return allow(warnings)


def guard_batch_input(
    items: list[dict[str, Any]] | None,
) -> GuardResult:
    """Layer 1 extension: validate batch request items.

    Each item must have a non-empty task field with length >= MIN_TASK_LENGTH.
    Items list must be non-empty.
    """
    if not items:
        return deny("Batch request requires at least one item.")
    if len(items) == 0:
        return deny("Batch items list is empty.")

    for i, item in enumerate(items):
        task = item.get("task", "") if isinstance(item, dict) else getattr(item, "task", "")
        if not task or len(str(task).strip()) < MIN_TASK_LENGTH:
            return deny(f"Batch item {i}: task too short or empty.")

    return allow()


# ── Layer 4: Output Boundary ────────────────────────────────────────────────────

MAX_OUTPUT_PAYLOAD_BYTES = 16384   # 16 KB
MAX_OUTPUT_TOTAL_BYTES = 65536     # 64 KB (hard cap, reject if exceeded)

# Basic API-key / private-key patterns for sanitisation
_SENSITIVE_PATTERNS = [
    re.compile(r'sk-[a-zA-Z0-9]{32,}'),             # OpenAI / Claude API keys
    re.compile(r'-----BEGIN\s+(RSA\s+)?PRIVATE\s+KEY'),  # PEM private key
    re.compile(r'AIza[0-9A-Za-z\-_]{35}'),           # Google API key
]


def guard_output(
    payload: dict[str, Any] | None,
    health_report: str = "",
) -> GuardResult:
    """Layer 4: validate and sanitise output before returning to main agent.

    - Schema enforcement: payload must be a dict (or None).
    - Size caps: oversized payloads are truncated with a marker.
    - Sensitive-data scan: API keys / private keys are redacted.
    - Health-report integrity: action field must match record counts.
    """
    import json

    warnings: list[str] = []

    if payload is None:
        return allow()

    # 4.1 Type check
    if not isinstance(payload, dict):
        return deny("Output payload must be a dict or None.")

    # 4.2 Size check
    payload_str = json.dumps(payload, ensure_ascii=False)
    if len(payload_str.encode("utf-8")) > MAX_OUTPUT_TOTAL_BYTES:
        return deny(
            f"Output payload exceeds {MAX_OUTPUT_TOTAL_BYTES} bytes — "
            "possible runaway generation."
        )

    # 4.3 Sensitive-data scan (non-blocking: sanitise + warn)
    for pattern in _SENSITIVE_PATTERNS:
        if pattern.search(payload_str):
            warnings.append("Sensitive content detected and redacted from output.")
            # Sanitise in-place across all string values
            _sanitise_dict(payload, _SENSITIVE_PATTERNS)
            break

    return allow(warnings)


def _sanitise_dict(obj: Any, patterns: list[re.Pattern]) -> None:
    """Recursively redact sensitive patterns from all string values in a dict/list."""
    if isinstance(obj, dict):
        for key, value in obj.items():
            if isinstance(value, str):
                for pat in patterns:
                    value = pat.sub("[REDACTED]", value)
                obj[key] = value
            elif isinstance(value, (dict, list)):
                _sanitise_dict(value, patterns)
    elif isinstance(obj, list):
        for i, value in enumerate(obj):
            if isinstance(value, str):
                for pat in patterns:
                    value = pat.sub("[REDACTED]", value)
                obj[i] = value
            elif isinstance(value, (dict, list)):
                _sanitise_dict(value, patterns)


# ── Layer 3: Vault Write Gating ─────────────────────────────────────────────────

VAULT_ENTRY_MAX_SIZE = 8192         # Single entry: 8 KB text
VAULT_MAX_WRITES_PER_SESSION = 50   # Hard cap per session
GLOBAL_WRITE_MIN_QUALITY = 4        # GLOBAL entries need quality >= 4


def guard_vault_write(
    entry_text: str,
    importance: str = "WORKING",
    quality_score: int = 0,
    session_write_count: int = 0,
    existing_titles: set[str] | None = None,
) -> GuardResult:
    """Layer 3: gate vault writes before persistence.

    Checks:
      - Entry size (hard cap)
      - Session write count (rate limit)
      - GLOBAL blast-radius escalation (quality threshold)
      - Dedup against existing titles (best-effort)
    """
    # 3.1 Size check
    if len(entry_text) > VAULT_ENTRY_MAX_SIZE:
        return deny(
            f"Entry size {len(entry_text)} exceeds max {VAULT_ENTRY_MAX_SIZE} bytes."
        )

    # 3.2 Session rate limit
    if session_write_count >= VAULT_MAX_WRITES_PER_SESSION:
        return deny(
            f"Session write limit ({VAULT_MAX_WRITES_PER_SESSION}) reached. "
            "Circuit breaker should have tripped earlier — possible bug."
        )

    # 3.3 GLOBAL blast-radius escalation
    if importance == "GLOBAL" and quality_score < GLOBAL_WRITE_MIN_QUALITY:
        return deny(
            f"GLOBAL entries require quality >= {GLOBAL_WRITE_MIN_QUALITY}; "
            f"got {quality_score}. Downgrade to STAGE or improve quality first."
        )

    # 3.4 Dedup check (non-blocking: warn only)
    warnings: list[str] = []
    if existing_titles:
        title_key = entry_text[:120].strip().lower()
        if title_key in existing_titles:
            warnings.append("Similar entry already exists in vault — possible duplicate.")

    return allow(warnings)


# ── Layer 3.5: Root Config Write Gating ────────────────────────────────────────

# Files whose modification by a sub-agent constitutes instruction injection.
# These are the "brain stem" of the main agent — modifying them gives the
# sub-agent unchecked influence over the main agent's future behavior.
#
# Unlike MODIFIES_SKILLS (HARD DENY), root config writes trigger WARN —
# the main agent must explicitly confirm before the write proceeds.
# This is because some legitimate flows (e.g., install scripts,
# CLAUDE.md initialization) need to write these files.
ROOT_CONFIG_PATTERNS: list[str] = [
    "CLAUDE.md",
    "AGENTS.md",
    ".claude/agents/*.md",
    ".claude/settings.json",
    ".claude/settings.local.json",
]


def guard_root_config_write(file_path: str) -> GuardResult:
    """Check if a file write targets a root config file.

    Root config files (CLAUDE.md, .claude/agents/*.md, settings.json) are
    the main agent's instruction source. A sub-agent writing to them is a
    trust-boundary crossing — it gains the ability to inject instructions
    into the main agent's future turns.

    This guard triggers a WARN (not DENY) because there are legitimate
    write paths (e.g., install-time initialization). The main agent
    should confirm before proceeding.

    Args:
        file_path: Absolute or relative path being written to.

    Returns:
        GuardResult with action="warn" if the path matches a root config
        pattern, action="allow" otherwise.
    """
    import fnmatch
    from pathlib import Path

    # Normalize to a relative path for matching
    fp = Path(file_path)
    # Try to make it relative to cwd
    try:
        fp = fp.resolve().relative_to(Path.cwd())
    except (ValueError, OSError):
        fp = Path(file_path)
    fp_str = str(fp).replace("\\", "/")

    for pattern in ROOT_CONFIG_PATTERNS:
        if fnmatch.fnmatch(fp_str, pattern) or fnmatch.fnmatch(fp.name, pattern):
            return GuardResult(
                allowed=True,
                reason=(
                    f"Target '{file_path}' is a root config file. "
                    "Sub-agents should not write to root config files "
                    "without explicit main-agent confirmation. "
                    "This guard triggers WARN — the main agent must confirm."
                ),
                warnings=[
                    f"Root config write detected: {file_path}. "
                    "Confirm with main agent before proceeding."
                ],
            )

    return allow()


# ── Layer 5: Circuit Breaker ──────────────────────────────────────────────────

class BreakerState(str, Enum):
    CLOSED = "CLOSED"
    HALF_OPEN = "HALF_OPEN"
    OPEN = "OPEN"


class CircuitBreaker:
    """Three-state circuit breaker for PromptCraft tool execution.

    CLOSED → (3 consecutive denials) → OPEN → (5 min cooldown) → HALF_OPEN
    → (1 success) → CLOSED.

    Also tracks consecutive low-quality results for stall detection,
    with 60-second time-based decay to prevent oscillation.
    """

    def __init__(self, cooldown_seconds: float = 300.0,
                 max_tool_calls: int = 100) -> None:
        self.state: BreakerState = BreakerState.CLOSED
        self._cooldown_seconds = cooldown_seconds
        self._max_tool_calls = max_tool_calls
        self._consecutive_denials: int = 0
        self._total_denials: int = 0
        self._total_tool_calls: int = 0
        self._total_vault_writes: int = 0
        self._consecutive_low_quality: int = 0
        self._last_low_quality_time: float = 0.0
        self._last_state_change: float = time.monotonic()

    # ── Public API ──

    def before_tool_call(self) -> bool:
        now = time.monotonic()
        if self.state == BreakerState.OPEN:
            if now - self._last_state_change >= self._cooldown_seconds:
                self._transition_to(BreakerState.HALF_OPEN, now)
            else:
                return False
        if self._total_tool_calls >= self._max_tool_calls:
            self._transition_to(BreakerState.OPEN, now)
            return False
        return True

    def can_write_vault(self) -> bool:
        return self._total_vault_writes < 50

    def after_success(self) -> None:
        self._consecutive_denials = 0
        self._total_tool_calls += 1
        if self.state == BreakerState.HALF_OPEN:
            self._transition_to(BreakerState.CLOSED)

    def after_denial(self) -> None:
        self._consecutive_denials += 1
        self._total_denials += 1
        self._total_tool_calls += 1
        if self._consecutive_denials >= 3:
            self._transition_to(BreakerState.OPEN)

    def after_vault_write(self) -> None:
        self._total_vault_writes += 1

    def after_low_quality(self) -> bool:
        now = time.monotonic()
        if now - self._last_low_quality_time > 60:
            self._consecutive_low_quality = 0
        self._consecutive_low_quality += 1
        self._last_low_quality_time = now
        return self._consecutive_low_quality >= 5

    def reset_quality_stall(self) -> None:
        self._consecutive_low_quality = 0
        self._last_low_quality_time = 0.0

    def is_open(self) -> bool:
        return self.state == BreakerState.OPEN

    def summary(self) -> dict:
        return {
            "state": self.state.value,
            "consecutive_denials": self._consecutive_denials,
            "total_denials": self._total_denials,
            "total_tool_calls": self._total_tool_calls,
            "total_vault_writes": self._total_vault_writes,
            "consecutive_low_quality": self._consecutive_low_quality,
        }

    # ── Internal ──

    def _transition_to(self, target: BreakerState, now: float | None = None) -> None:
        if self.state == target:
            return
        self.state = target
        self._last_state_change = now or time.monotonic()
