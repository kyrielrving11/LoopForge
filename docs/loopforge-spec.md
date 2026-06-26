# LoopForge Protocol Specification v1.2

**Language-agnostic loop cognition protocol for AI coding agents.**

LoopForge is a Loop-Time Intelligence Layer — a per-iteration prompt compiler
that maintains cognitive stability across long-horizon agent loops through
structured memory, constraint inheritance, and drift correction.

This document defines the protocol. Reference implementation: TypeScript (v1.2).

---

## 1. Concepts

### Loop
A **loop** is a multi-round agent session pursuing a single objective.
Each loop is identified by a `loop_id` (kebab-case string, e.g. `audit-erc20`).
A loop persists across rounds via the vault — each round's lineage is written
after compilation and can be queried by subsequent rounds.

### Round
A **round** is one iteration of the agent loop. Each round produces:
- A compiled prompt (via loop_compile mode)
- An execution result (via feedback mode)
- A lineage entry in the vault

Rounds are 1-indexed.

### Goal
A **goal** is the stable semantic identity of a loop. Tracked via:
- `goal_id` (primary key) — a kebab-case identifier that should remain stable
  across rounds. Changing `goal_id` triggers a hard L2 recompile.
- `goal_text_hash` (auxiliary) — SHA-256 of the normalized task text. Hash
  divergence across rounds is a soft advisory (drift warning), not a hard gate.

### Constraint
A **constraint** is a hard requirement that must be reflected in compiled
prompts. Constraints enter the system via:
- `constraints_from_plan` — extracted from a plan/spec file at round 1
- `new_since_last_round` — ad-hoc additions from the agent
- GLOBAL entries in the vault federation layer

Constraints are tracked in `constraints_active` and automatically retired
after N consecutive rounds with no activity signal (see §7).

### Vault
The **vault** is the append-only persistence layer. Dual-storage architecture:
- **JSON vault** (`.promptcraft/prompt_vault.json`) — structured, searchable
  source of truth. Contains an `entries` array of lineage and feedback records.
- **Markdown lineage** (`.promptcraft/prompts/loop-{id}/r{n}.md`) — human-readable,
  git-friendly projection with YAML frontmatter.

Read path: JSON vault primary → Markdown lineage fallback.

### Lineage
A **lineage entry** records one round's compilation: goal_id, recompile_level,
technique_used, constraints_active, task, success, quality_score. Each entry
is identified by `task_id: loop:{loop_id}:r{round_num}`.

### Replay
**Replay** is the time-travel audit capability: query any past round's full
lineage, replay a range of rounds, diff two rounds, or view a timeline
summary. See §10.

---

## 2. Modes

LoopForge exposes 3 public modes and 1 internal path:

### loop_compile (public)
**Primary entry point.** Called once per agent loop iteration. Accepts a
`LoopCompileRequest` and returns a `LoopCompileResponse` containing the
compiled prompt for this round.

Recompile strategy is determined by a 4-gate hard routing system (§3).

### feedback (public)
**Execution recording.** Called after the agent executes a compiled prompt.
Accepts an `ExecutionFeedback` payload and persists quality scores to the
vault. Drives:
- Quality trend tracking (circuit breaker input)
- Adaptive technique routing (quality → technique rotation)
- Lineage quality backfill (feedback scores merged into lineage entries)

### review (public)
**Offline audit.** Reads a historical prompt from the vault and checks:
- Structural completeness (all required sections present)
- Constraint compliance (all active constraints reflected)

### build (internal)
**Prompt generation.** Internal path delegated by loop_compile L2. Selects a
technique from the routing table and generates a minimal prompt. Not exposed
as a public mode — callers use loop_compile, which delegates to build at L2.

---

## 3. Recompile Levels

Each round, the 4-gate hard router determines the recompile level:

### Gate 1: Force Level Override
If `force_level` is set to `l0`, `l1`, or `l2`, that level is used.
**Exceptions:** Round 1 always forces L2 (no cached prompt exists). A
`plan_source` being provided always forces L2 (anchors the loop with a
loop_objective).

### Gate 2: First Call / Plan Source
- Round 1 → L2 (full compile, create loop_objective)
- `plan_source` provided → L2 (extract constraints + objective from plan)

### Gate 3: Goal ID Stability
- `goal_id` matches previous round → pass to Gate 4
- `goal_id` changed → L2 (semantic identity shift — full rebuild)

### Gate 4: Failure / Constraint Signals
- New constraints added → L1 (patch previous prompt)
- Repeated failure (2+ consecutive rounds quality < 3) → L1
- Repair signal (manual_fixes_needed non-empty) → L1
- Strategy collapse (3+ consecutive rounds quality < 3) → L2
- Severe alignment drop (task_alignment < 0.3) → L2
- None of the above → L0 (fast path — reuse cached prompt)

### L0: Fast Path
Reuses the actual cached prompt from the previous round (retrieved from
Markdown lineage). Goal unchanged, no new failures, no new constraints.

### L1: Patch
Incremental update to the previous prompt. New constraints are injected,
repair signals are addressed, failure context is added. The core structure
and technique are preserved.

### L2: Full Recompile
Complete rebuild. New technique selection, full constraint audit, loop
objective re-anchoring. Delegates to build (internal) for prompt generation.

---

## 4. Loop Objective

Created at round 1 via 3 sources (priority order):
1. **Explicit** — `loop_objective` field in the request
2. **Plan source** — extracted from the plan/spec file at `plan_source` path
3. **Auto** — derived from the task description

The loop objective contains:
- `objective` — one-sentence goal statement
- `success_criteria` — list of measurable outcomes
- `hard_constraints` — list of non-negotiable requirements
- `created_at_round` — always 1
- `loop_id` — the loop this objective anchors

The objective is stored in the vault with importance=GLOBAL and referenced
by every subsequent lineage entry. Task alignment (§5) checks each round's
task against this objective.

---

## 5. Advisory System

All advisories are **non-blocking** — they inform the caller but never
prevent execution. The caller (main agent) always has the final say.

### Task Alignment
Checks the agent-proposed next task against the loop objective using Jaccard
similarity of tokenized text:
- **aligned** (score ≥ 0.5) — no warning
- **warn** (0.3 ≤ score < 0.5) — mild drift detected
- **block** (score < 0.3) — severe drift, advisory escalation

### Loop Health
Computed every N rounds (configurable via `summary.health_check_interval`):
- `goal_alignment` — Jaccard(current_task, loop_objective)
- `constraint_integrity` — fraction of active constraints found in last output
- `drift_detected` — goal_id matched but goal_text_hash diverged 3+ rounds
- `strategy_stability` — 3 consecutive rounds with quality ≥ 4
- `task_continuity` — Jaccard(this_round_task, last_round_task)

---

## 6. Vault Schema

### Entry Structure
```json
{
  "id": "uuid",
  "task_id": "loop:{loop_id}:r{round_num}" | "loop:{loop_id}:r{round_num}:feedback",
  "version_tag": "v1",
  "is_active": true,
  "timestamp": "ISO-8601 UTC",
  "user_intent": "human-readable summary",
  "task_type": "loop_lineage" | "feedback",
  "quality_score": 0-5,
  "skill_used": "technique name",
  "technique_used": "technique name",
  "loop_id": "kebab-case identifier",
  "loop_lineage": { ... },
  "loop_objective": { ... } | null,
  "execution_feedback": "{ ... }",
  "task": "current task description",
  "output_summary": "previous round execution summary",
  "constraint_violations": ["...", "..."],
  "tags": ["...", "..."]
}
```

### Task ID Convention
- Lineage entries: `loop:{loop_id}:r{round_num}` (e.g., `loop:audit-erc20:r3`)
- Feedback entries: `loop:{loop_id}:r{round_num}:feedback` (e.g., `loop:audit-erc20:r3:feedback`)

### Dual Write
1. **JSON vault write** (primary) — structured entry appended to `entries[]`
2. **Markdown write** (secondary) — `.promptcraft/prompts/loop-{id}/r{n}.md`
   with YAML frontmatter + full prompt body

### Dual Read
1. **JSON vault read** — prefix match on `task_id` via `VaultBackend.query_entries()`
2. **Markdown fallback** — `VaultBackend.scan_lineage_md()` when JSON vault
   has no matching entries

### Federation (v2)
Two-tier vault: project-local (`.promptcraft/`) + global (`~/.promptcraft/`).
GLOBAL entries are always returned regardless of query match. v1 implements
only project-local storage.

---

## 7. Constraint Lifecycle

### Activation
Constraints enter the active set via:
- `constraints_from_plan` in the loop_compile request
- `new_since_last_round` field
- GLOBAL federation entries

### Tracking
Each round, `constraints_active` is written to the lineage entry. The
feedback mode reports `constraint_violations` — constraints that were not
satisfied in the execution output.

### Retirement (v3.5)
After `constraints.retire_window` consecutive rounds (default: 3) with **no
activity signal** for a constraint, it is automatically retired to
`constraints_retired`. An activity signal is a case-insensitive substring
match of the constraint text in the round's task, output_summary, or
constraint_violations.

Retirement is append-only — retired constraints stay retired. This prevents
prompt bloat across long loops.

`constraints.max_active` (default: 12) caps the number of active constraints
to prevent unbounded growth.

---

## 8. Rolling Summary

Every `summary.window` rounds (default: 5), a deterministic rolling summary
is built from the last N rounds in the vault. No LLM generation — pure data
synthesis.

### Fields
- `quality_trajectory` — last N quality scores
- `trajectory_direction` — "improving" | "declining" | "stable" | "volatile"
- `what_worked` — output_summary from high-score rounds (≥4)
- `recurring_issues` — constraint violations appearing 2+ times
- `key_lessons` — output_summary from high-score rounds (truncated to 200 chars)
- `rounds_sampled` — number of rounds used
- `generated_at_round` — which round produced this summary

### Injection
Rolling summaries are injected into L1 and L2 prompts. L0 (fast path) does
not include the summary — it reuses the cached prompt as-is.

---

## 9. Technique Routing

### Keyword Heuristic (default)
Task text is classified on two axes:
- **Independence**: continuous (fix, modify, refactor...) vs independent
- **Cognitive load**: high (security, audit, crypto...) vs low (rename,
  format, config...) vs medium (default)

The routing table maps (independence, load) pairs to techniques:
| Independence | Load   | Technique        |
|-------------|--------|------------------|
| continuous  | low    | zero-shot        |
| independent | low    | zero-shot        |
| continuous  | medium | few-shot         |
| independent | medium | zero-shot-cot    |
| continuous  | high   | few-shot-cot     |
| independent | high   | tree-of-thought  |

### Adaptive Fallback
When the same technique yields N consecutive low-quality rounds (quality <
`technique.adaptive_quality_threshold`, default: 3), the router rotates to
the next technique in the fallback chain:

```
zero-shot → few-shot → zero-shot-cot → few-shot-cot → tree-of-thought
```

`tree-of-thought` is the ceiling — no further rotation. Step-back and
least-to-most enter the chain when manually selected.

### Configuration
All routing parameters are externalized in `loop_policy.json` (§11).

---

## 10. Replay & Audit

The Replay Engine provides time-travel queries over vault lineage. All
queries go through the `VaultBackend` interface — no direct filesystem access.

### API

| Method | Returns | Description |
|--------|---------|-------------|
| `get_round(loop_id, round_num)` | `Entry \| None` | Full lineage entry with `full_prompt` enrichment and merged feedback quality_score |
| `replay(loop_id, start, end)` | `Entry[]` | Range replay, end=None → all rounds |
| `timeline(loop_id)` | `Summary[]` | Compact timeline: round, recompile_level, technique, quality_score, task, goal_id |
| `diff(loop_id, round_a, round_b)` | `Diff` | Field-by-field comparison: goal_id, recompile_level, technique, quality_score, task, constraints (added/removed) |

### Diff Output
```json
{
  "round_a": 1,
  "round_b": 3,
  "changes": [
    {"field": "recompile_level", "label": "Recompile Level", "before": "l2", "after": "l1"},
    {"field": "constraints_active", "label": "Active Constraints",
     "before": ["check ownership"], "after": ["check ownership", "check flash loans"],
     "added": ["check flash loans"], "removed": []}
  ],
  "unchanged": ["goal_id", "technique_used"],
  "missing": null
}
```

### Use Cases
- **Debug drift** — diff round 1 vs round N to see how the task evolved
- **Quality forensics** — replay all rounds to find where quality degraded
- **Technique benchmarking** — timeline shows which techniques produced what scores

---

## 11. Policy Configuration

All tunable parameters live in `loop_policy.json` at the project root.
The default policy matches historical hardcoded values exactly.

```json
{
  "version": "1",
  "constraints": {
    "retire_window": 3,
    "max_active": 12
  },
  "summary": {
    "window": 5,
    "health_check_interval": 1
  },
  "recompile_triggers": {
    "l1": ["new_constraints", "repeated_failure", "repair_signal"],
    "l2": ["goal_id_changed", "plan_source_provided",
           "strategy_collapse", "severe_alignment_drop"]
  },
  "technique": {
    "fallback_chain": { ... },
    "adaptive_quality_threshold": 3,
    "adaptive_consecutive_rounds": 2,
    "routing_table": { ... }
  },
  "engine": {
    "feedback_flush_interval": 5,
    "max_circuit_breaker": 3
  },
  "backend": {
    "vault_path": ".promptcraft/prompt_vault.json",
    "global_vault_path": "~/.promptcraft/global_vault.json"
  }
}
```

Custom policy values are merged over defaults — unset fields retain default
values. See `loop_policy.json` in the repository for the complete default.

---

## 12. Storage Backend

LoopForge abstracts storage behind a `VaultBackend` interface (TypeScript
`interface`). This enables future backends without changing engine logic.

### Interface
```typescript
interface VaultBackend {
  // JSON vault
  readVault(): Record<string, unknown>;
  writeVault(data: Record<string, unknown>): void;

  // Entry queries
  queryEntries(opts?: { prefix?: string; taskIdPattern?: string;
    feedbackOnly?: boolean }): VaultEntry[];
  appendEntry(entry: VaultEntry): void;
  appendEntries(entries: VaultEntry[]): number;

  // Markdown lineage
  writeLineageMd(loopId: string, roundNum: number,
    content: string, metadata: Record<string, unknown>): string | null;
  readLineageMd(loopId: string, roundNum: number): string | null;
  scanLineageMd(loopId: string): VaultEntry[];
}
```

### FSBackend (v1)
Filesystem implementation — wraps JSON vault read/write
and handles Markdown lineage under `.promptcraft/prompts/`. All file I/O
is contained in this single module.

### Future Backends
- **SQLite** — when entry count exceeds practical JSON I/O limits
- **Object store** — for cloud deployments (S3, GCS)

---

## 13. Wire Format

All public mode I/O is JSON. The protocol is defined by `promptcraft-protocol.json`
(JSON Schema, draft 2020-12). 17 type definitions — 14 interfaces + 3 enums.

### Request Envelope
```json
{
  "mode": "loop_compile",
  "loop_id": "audit-erc20",
  "round": 1,
  "goal_id": "audit-erc20",
  "task": "Audit ERC20 token for security vulnerabilities",
  "domain": "solidity-security",
  "force_level": "auto"
}
```

### Health Line
Every response includes a compact health line: `[PC: N records, normal]`
- `normal` — normal operation
- `STALLED` — circuit breaker tripped
- Silent-failure counters appended when non-zero: `write_err`, `write_timeout`, `cache_miss`

---

## 14. Versioning

| Version | Date       | Changes |
|---------|------------|---------|
| v3.5    | 2025-06   | Constraint retirement, rolling summary, adaptive technique routing |
| v3.5.1  | 2025-06   | Feedback→lineage quality backfill, loop-aware task_ids |
| v1.0    | 2026-06   | TypeScript reference implementation — VaultBackend abstraction, Replay Engine, Policy externalization, JSON Schema, CLI + Library API |
| v1.2    | 2026-06   | Loop Runtime — event-driven autonomous loop driver with heartbeat, round timeout, stall detection, graceful shutdown. `run({ task, execute })` convenience function with 2 required fields. Removed hook-stop and autonomous.ts. |

**Compatibility:** Protocol additions are backward-compatible (new fields with defaults).
Removals follow a deprecation cycle: mark deprecated → 2 versions → remove.

---

## 15. Architecture Diagram

```
Main Agent (Claude Code / CLI)
    │
    │  JSON stdin/CLI args
    ▼
┌─────────────────────────────────────┐
│         adapter.ts                   │  ← Mode routing + health line
│         (loop_compile | feedback     │
│          | review)                   │
└──────────────┬──────────────────────┘
               │
               ▼
┌─────────────────────────────────────┐     ┌──────────────────────┐
│         engine.ts                    │     │    runtime.ts (v1.2) │
│         (invokeLoopCompile,          │     │    LoopRuntime       │
│          invokeFeedback,             │◄────│    + run()           │
│          invokeBuild)                │     │                      │
└──────┬──────────────┬───────────────┘     │  heartbeat, timeout, │
       │              │                      │  stall, SIGINT,      │
       ▼              ▼                      │  executor-failure    │
┌──────────────┐  ┌───────────────────┐     └──────────────────────┘
│ loop-compiler│  │ backends/fs.ts    │
│ .ts          │  │ (FSBackend)       │
│ (pure funcs) │  │                   │
│              │  │  ├─ JSON vault    │
│ L0/L1/L2     │  │  └─ Markdown .md  │
│ advisory     │  │                   │
│ retirement   │  └───────────────────┘
│ summary      │
└──────┬───────┘
       │
       ▼
┌──────────────┐
│ builder.ts   │
│ (technique   │
│  routing)    │
└──────────────┘
       │
       ▼
┌──────────────┐     ┌────────────────┐
│ policy.ts    │     │ replay.ts      │
│ (loop_policy │     │ (ReplayBackend)│
│  .json)      │     │                │
└──────────────┘     └────────────────┘
```

---

## 16. Loop Runtime (v1.2)

The Loop Runtime is an event-driven autonomous loop driver that wraps the
compilation engine with heartbeat monitoring, timeout/stall detection, and
graceful shutdown. It replaces the passive `autonomous.ts` (v1.1) with an
active driver that manages the entire loop lifecycle.

### Concepts

| Term | Definition |
|------|-----------|
| **Executor** | The user-provided function `(prompt, ctx) => Promise<string>` that calls an AI agent |
| **Heartbeat** | A timer that fires at `heartbeat_interval_ms`, checks round elapsed time, and emits health events |
| **Round timeout** | When a round exceeds `round_timeout_ms`, `ctx.signal.aborted` is set to `true` so the executor can abort |
| **Stall** | Timeout + `stall_grace_ms` elapsed with no response — the runtime status becomes `STALLED` |
| **Executor failure** | `max_consecutive_errors` consecutive `execute()` throws — stops the loop |

### Primary API

```typescript
import { run } from "loopforge";

const result = await run({
  task: "Audit ERC20 token for security vulnerabilities",
  execute: async (prompt, ctx) => await callAiApi(prompt),
});
// result: { success, stopReason, roundsCompleted, qualityTrajectory }
```

Only `task` and `execute` are required. All other fields have sensible defaults
from `loop_policy.json`.

### Advanced API (EventEmitter)

```typescript
import { LoopRuntime } from "loopforge";

const rt = new LoopRuntime({
  task: "Audit ERC20 token",
  execute: myAgent,
  maxRounds: 10,
  roundTimeoutMs: 300_000,
});

rt.on("round:start", (info) => console.log("Round", info.round));
rt.on("round:complete", (info) => console.log("Quality", info.quality));
rt.on("timeout", (info) => console.warn("Timeout round", info.round));
rt.on("done", (result) => console.log("Stopped:", result.stopReason));

const result = await rt.start();
```

### Events

| Event | Payload | When |
|-------|---------|------|
| `start` | — | Loop begins |
| `round:start` | `RoundStartInfo` | Each round's prompt is compiled |
| `round:complete` | `RoundCompleteInfo` | Agent output received and evaluated |
| `heartbeat` | `HeartbeatInfo` | Every `heartbeat_interval_ms` during a round |
| `timeout` | `TimeoutInfo` | Round exceeds `round_timeout_ms` |
| `health:warning` | `HealthWarning` | Approaching timeout (≥80%) |
| `stalled` | `{ reason, lastRound, elapsedMs, message }` | Timeout + grace period exceeded |
| `stop` | — | `stop()` called (SIGINT/SIGTERM or manual) |
| `done` | `RunResult` | Loop terminates |

### Stop Reasons

| Reason | Meaning |
|--------|---------|
| `task_complete` | Agent returned `should_continue: false` with valid structured self-eval |
| `circuit_breaker` | Quality trend is non-increasing for `max_circuit_breaker` rounds |
| `max_rounds` | `maxRounds` reached |
| `stalled` | Timeout + grace period elapsed, or heuristic extraction could not parse agent output |
| `stopped` | Manual `stop()` call (SIGINT, SIGTERM, or programmatic) |
| `executor_failure` | `max_consecutive_errors` consecutive `execute()` exceptions |

### Lifecycle

```
IDLE → start() → RUNNING → (loop) → STOPPED/STALLED
                       ↓
                    stop()
```

- **IDLE**: Initial state. `start()` transitions to RUNNING.
- **RUNNING**: Main loop active. Heartbeat fires, rounds execute.
- **STALLED**: Heartbeat detected timeout + grace period exceeded. Loop stops.
- **STOPPED**: Loop ended normally or via `stop()`.

### Configuration

All runtime parameters are externalized in `loop_policy.json` under `runtime`:

```json
{
  "runtime": {
    "max_rounds": 20,
    "round_timeout_ms": 600000,
    "heartbeat_interval_ms": 30000,
    "stall_grace_ms": 300000,
    "max_consecutive_errors": 3
  }
}
```

Per-invocation overrides are passed via `RuntimeConfig` fields with the same names
(camelCase: `maxRounds`, `roundTimeoutMs`, etc.).

### Interactive Mode

When `interactive: true`, the heartbeat still emits events but timeout/stall logic
is disabled. This is used by the CLI `loopforge run` command, where a human
pastes agent output each round.

```bash
loopforge run '{"task":"Audit ERC20","loop_id":"audit","interactive":true}'
```

### Self-Evaluation Contract

The executor MUST return output containing a structured self-evaluation block:

```
---loopforge-eval
{
  "success": true,
  "output_summary": "<what was DONE this round>",
  "constraint_violations": [],
  "should_continue": false
}
---end-loopforge-eval
```

If the block is missing or invalid JSON, the runtime falls back to heuristic
extraction (keyword scanning). Heuristic extraction always stops the loop
(`stopReason: stalled`) because the confidence is too low to continue
autonomously.
