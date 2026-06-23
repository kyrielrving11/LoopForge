# PromptCraft

[中文文档](README.zh-CN.md)

PromptCraft is a **prompt-engineering sub-agent** for AI coding agents
(Claude Code / Codex / CodeBuddy). It manages the full lifecycle of prompts
and skills: generation, personalisation, execution feedback, pattern analysis,
and evolution suggestions — backed by a persistent vault that improves across
sessions and projects.

> **v2.8** — LLM-driven prompt generation: Python selects the technique,
> the LLM sub-agent reads the technique reference and generates the prompt.
> 4-engine tool system, 5-layer execution boundary, 178 tests. Python stdlib only.

---

## Architecture

```
Main Agent (Claude Code / Codex)
  │
  └─ PromptCraft Sub-Agent (LLM — isolated context)
        │
        ├─ Python layer (data & safety)
        │   ├─ builder.py           ← technique router (keyword heuristic)
        │   ├─ engine.py            ← lifecycle + vault I/O + circuit breaker
        │   ├─ boundary.py          ← 5-layer defence-in-depth
        │   └─ tools/               ← pattern_analysis / skill_advisor
        │
        └─ LLM layer (generation)
            ├─ Read technique reference .md
            ├─ Generate structured prompt (adaptive sections)
            └─ Generate Skill overlay
```

**Design:** Python handles classification + data + safety. The LLM handles
creative prompt writing — it reads technique reference files and applies
them to the task. This split keeps Python lean (no string-template prompt
generation) and lets the LLM do what it does best.

## Six Modes

| Mode | Trigger | Returns |
|------|---------|---------|
| **build** | No Skill + high-risk task | Technique selection → LLM reads reference → generates structured prompt |
| **overlay** | Matching Skill + vault history | Domain-filtered constraints → LLM generates overlay for Skill |
| **feedback** | After execution | Quality score + improvement notes |
| **analyze** | Health report signals `->analyze` | Pattern report from accumulated data |
| **advise** | Health report signals `->advise` | Skill evolution/creation suggestions |
| **batch** | Multiple tasks | BatchSummary + per-item results |

**Build/Overlay flow**: Python pre-processor selects technique + gathers vault
context → LLM sub-agent reads the technique reference file → LLM generates
the complete prompt/overlay → checkpoint to vault → return to main agent.

**Feedback/Analyze/Advise flow**: Python handles everything (data processing).

Every response includes a compact **Health Report**: `[PC: 5 records | hint: similar→solidity-audit q=4.2, normal]`
— vault hints are available even below the 10-record analysis threshold.

## Quick Start

Deploy PromptCraft as a Claude Code sub-agent in your project:

```bash
# 1. Copy the 3 core directories into your project
cp -r promptcraft-agent/ skills/ .claude/ <your-project>/

# 2. Initialize the vault
cd <your-project>
echo '{"task_id":"init","user_intent":"promptcraft initialized"}' \
  | python skills/prompt-memory/scripts/checkpoint.py

# 3. Verify — the sub-agent auto-registers via .claude/agents/promptcraft.md
echo '{"task":"write a hello function","mode":"build"}' \
  | python promptcraft-agent/subagent_adapter.py
```

The sub-agent is now available as `promptcraft` in Claude Code. Auto-trigger
rules in CLAUDE.md handle invocation for complex tasks.

## Execution Boundary (5-Layer Defence-in-Depth)

Adapted from Claude Code's 7-layer permission system for a sub-agent whose
threat model is **knowledge pollution**, not shell injection.

| Layer | Guards | Hard-Deny Triggers |
|-------|--------|-------------------|
| 1 — Input | Injection detection, mode consistency | System-override patterns, mode-protocol mismatch |
| 2 — Tool | Per-tool safety attributes + `check_permissions()` | **MODIFIES_SKILLS** (bypass-immune) |
| 3 — Vault | Size cap (8KB), rate limit (50/session), dedup, GLOBAL quality ≥4 | Exceeding caps, GLOBAL with low quality |
| 3.5 — Root Config | Write gating for CLAUDE.md, agents/*.md, settings.json | Sub-agent writes to root config → WARN |
| 4 — Output | Schema enforcement, sensitive-data scan, size cap | Schema violation, payload overflow |
| 5 — Breaker | Denial tracking, 3-state machine (CLOSED/HALF_OPEN/OPEN) | 3 consecutive denials → OPEN (5 min cooldown) |

**Key rule:** `MODIFIES_SKILLS = False` for all tools. Skill modification is
bypass-immune — PromptCraft only suggests, the main agent executes.

## Project Structure

```
PromptCraft/
├── promptcraft-agent/
│   ├── subagent_adapter.py    # Unified entry point, 6-mode routing
│   ├── engine.py              # Lifecycle manager + vault I/O + circuit breaker
│   ├── builder.py             # Technique router (keyword heuristic) + quality scoring
│   ├── protocol.py            # I/O schemas, 6 Mode values
│   ├── health_report.py       # HealthReport + threshold gating
│   ├── boundary.py            # 5-layer execution boundary + circuit breaker
│   ├── AGENT.md               # Claude Code sub-agent definition
│   └── tools/                 # 4-engine tool system
│       ├── base.py            # Tool base + safety attributes
│       ├── personalization.py # Skill overlay injection
│       ├── prompt_build.py    # Technique selector (prepares context for LLM)
│       ├── pattern_analysis.py # Aggregate pattern discovery
│       └── skill_advisor.py   # Evolution/creation suggestions
├── skills/
│   ├── prompt-memory/         # Dual-storage vault I/O + federation
│   │   ├── scripts/           #   checkpoint.py + hydrate.py
│   │   └── references/        #   vault schema
│   ├── prompt-techniques/     # Catalog of 7 techniques
│   │   └── references/        #   LLM reads these to generate prompts
├── tests/
│   ├── test_scripts.py        # checkpoint, hydrate, federation, freshness
│   ├── test_health_report.py  # thresholds, stall, consistency, proactive
│   ├── test_subagent_adapter.py # routing, parsing, batch, E2E
│   ├── test_engine_modes.py   # 5 invoke_* + silent analyze + batch
│   ├── test_integration.py    # full closed-loop workflows
│   └── test_boundary.py       # 5-layer guards, breaker, tools, batch input
├── .claude/agents/            # Sub-agent registration + system prompt
├── CLAUDE.md                  # Project conventions + auto-trigger rules
└── README.md / README.zh-CN.md
```

## Key Features

- **LLM-Driven Prompt Generation**: Python selects the technique via keyword
  heuristic; the LLM sub-agent reads the technique reference file and generates
  a structured prompt adaptive to task complexity. No hardcoded string templates.
- **Sub-Agent Architecture**: Isolated context, vault-backed persistence,
  cross-session improvement — auto-trigger rules in CLAUDE.md with vault-hydrate preflight
- **Auto-Trigger Rules**: CLAUDE.md includes 6 behavioural trigger conditions
  (correction spirals, intent flips, repeated errors, requirement accumulation,
  task verbs) — zero-cost pattern matching, false-positive cost is minimal
- **Proactive Vault Hints**: Health Report surfaces similar past tasks even
  below the 10-record analysis threshold (`hint: similar→solidity-audit q=4.2`)
- **Batch Processing**: Process multiple tasks in one call — hydrate once,
  group by Skill match, execute in parallel (max 4 workers)
- **5-Layer Execution Boundary**: Defence-in-depth with root-config write gating
  (Layer 3.5) — sub-agent cannot silently modify CLAUDE.md or settings.json
- **Circuit Breaker**: 3-state machine (CLOSED → OPEN → HALF_OPEN) with
  denial tracking and automatic cooldown, merged into boundary.py
- **Multi-Project Federation**: Two-tier vault — global (`~/.promptcraft/`)
  + project (`./.promptcraft/`)
- **Query Expansion**: Synonym-based query expansion with cross-language
  (CJK→EN) mapping before Jaccard search (zero-dependency)
- **Batch Feedback Persistence**: Buffered vault writes — feedback records
  accumulate in-memory and flush to vault in batches (NDJSON), reducing
  subprocess overhead
- **Engine Metrics**: Observable silent-failure counters (vault write errors,
  subprocess timeouts, analysis errors) surfaced via HealthReport degradation
- **Vault Pruning**: `hydrate.py --prune --older-than N` for stale entry
  cleanup — GLOBAL entries never pruned, `.md` files preserved
- **Execution Feedback Loop**: Structured quality scoring (1-5) written back
  to vault after every execution
- **Health Report**: Compact one-line signal — `[PC: N records, action=...]` —
  tells the main agent when to run analysis or advice
- **Skill-Advisor**: Data-backed evolution/creation suggestions — never
  auto-modifies Skills
- **Append-only Vault**: Full version history, rollback support, dual storage
  (JSON index + Markdown prompts)
- **Multi-Script Tokenizer**: CJK + Japanese Kana + Korean Hangul + Latin + Cyrillic

## Tech Stack

- **Python stdlib only** — no pip install, no venv
- **Dual storage** — JSON vault (metadata) + `.md` files (full prompts)
- **Two-tier federation** — global vault + project vault, auto-merged
- **Sub-agent model** — isolated context, trigger-based wake-up
- **Jaccard similarity** — multi-script tokenizer, zero external deps
- **Zero external API calls** — no embedding services, no proprietary APIs

## Design Principles

- **Python classifies, LLM generates** — technique selection is keyword heuristic
  (fast, zero-cost); prompt writing is LLM-driven (reads references, applies technique)
- **Enhance, don't replace** — Skills own the workflow, PromptCraft provides overlay
- **Fail-closed** — guards deny when uncertain; MODIFIES_SKILLS is bypass-immune
- **Health Report only** — internal vault state is never exposed to the main agent
- **Never auto-modify Skills** — suggestions only, execution is the main agent's job
- **importance = blast radius** — GLOBAL affects all projects, escalation requires data
- **Append, never overwrite** — full version history preserved
- **Zero external dependencies** — plain filesystem, human-readable JSON/Markdown

## License

MIT License. See [LICENSE](LICENSE).
