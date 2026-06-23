# CLAUDE.md

This is the PromptCraft repository — a suite of prompt-engineering tools
for AI coding agents (CodeBuddy / Codex / Claude Code).

**Version:** v2.8 | **Tests:** 178 passing | **Python:** stdlib only

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

## PromptCraft 自动触发规则

在每轮用户输入后，检查以下条件（纯文本判断，零成本）。满足任一条件时，
自动调用对应的 PromptCraft 模式。误报代价极低（仅一次 cheap 的 Python 调用）。

<!-- PROMPTCRAFT-MANAGED-BEGIN -->
### 触发条件

1. **纠错信号** — 用户消息包含纠正性语言
   （"不对""错了""still broken""不是这样""try again""还是不行""没用"），
   且上轮使用了 PromptCraft 生成的 prompt → 自动调用 `mode=feedback`
   （携带 implicit_edit signal）

2. **意图翻转** — 用户消息包含翻转标记
   （"其实""我是说""instead""rather than""换一种""应该是"），
   且在 PromptCraft 输出后 2 轮内 → 调用 `mode=feedback`，
   feedback 中包含翻转前的理解和翻转后的要求

3. **同错误复现** — 同一 error message 或同一异常类型在当前会话出现 >=2 次
   → 调用 `mode=build`，将 error 文本作为 context 注入
   （让 PromptCraft 生成针对性约束）

4. **需求累积** — 用户在当前任务中追加了 >=3 个额外需求
   （关键词: "also""and""还有""别忘了""make sure""don't forget""另外""再加上"）
   → 考虑调用 `mode=overlay` 重构 prompt，
   将累积的需求提升为 hard_constraints

5. **任务动词** — 任务描述核心动词 ∈ {design, architect, refactor, investigate,
   audit, optimize, migrate, integrate, restructure, harden, review, evaluate,
   assess, diagnose, troubleshoot}
   → 即使 hydrate 无匹配，也触发 `mode=build`
   （这些动词暗示结构化推理需求，默认值得用 PromptCraft）

6. **低保真信号**（中等置信度 — 先跑 hydrate preflight 再决定）
   - 任务描述 > 200 字符
   - 3+ 个技术关键词在同一句中
   - 涉及 "migration" / "refactor" / "deprecate"
   - 用户说 "best practice" / "standard" / "production"
   - 新项目首次任务（无 vault 历史）
<!-- PROMPTCRAFT-MANAGED-END -->

### 不应触发的场景

- 单步 CRUD / 格式化 / lint / 重命名 / 简单查找
- "What is X?" 类事实性问题
- < 3 个平凡步骤可完成的任务
- 纯粹的文件读写（无推理需求）

### Health Report 信号速查

| Health Report 显示 | 含义 | 动作 |
|-------------------|------|------|
| `[PC: N records, normal]` | 正常运行 | 继续 |
| `[PC: N records \| hint: ...]` | 有可用历史智慧 | 考虑调用 overlay/build |
| `action=run_analysis` | >=10 条记录 | 调用 `mode=analyze` |
| `action=review_evolution` | >=20 条 + 高一致性 | 调用 `mode=advise`，呈现建议给用户 |
| `action=review_creation` | >=30 条 + 稳定模式 | 调用 `mode=advise`，建议创建新 Skill |
| `STALLED` / `breaker=OPEN` | 熔断触发 | 转发给用户，等待人工干预 |

## Project Layout

```
skills/
├── prompt-memory/         # Dual-storage vault I/O + federation
│   ├── scripts/           # checkpoint.py, hydrate.py
│   └── references/        # vault-schema (incl. federation + feedback schemas)
├── prompt-techniques/     # Reference catalog of 7 techniques (SKILL.md)
│   └── references/        # zero-shot, few-shot, cot, step-back, least-to-most, tot
promptcraft-agent/
├── subagent_adapter.py    # Unified entry point — 6-mode routing + health report
├── engine.py              # Outer loop manager — 6 invoke_* methods + silent analyze
├── builder.py             # Technique router (keyword heuristic) + quality scoring
├── protocol.py            # I/O schemas (8 Mode values, SubagentOutput, etc.)
├── health_report.py       # HealthReport dataclass + threshold gating
├── context.py             # EngineContext — 3-layer shared state container
├── boundary.py            # Execution boundary — 5-layer guards + circuit breaker
├── AGENT.md               # Claude Code sub-agent definition
├── README.md              # promptcraft-agent standalone docs
└── tools/                 # Four-engine tool system
    ├── __init__.py        # ToolRegistry singleton
    ├── base.py            # Tool / ToolResult base + safety attributes
    ├── personalization.py # Skill overlay injection
    ├── prompt_build.py    # Structured prompt generation — adaptive to complexity (fallback)
    ├── pattern_analysis.py # N-execution aggregate analysis
    └── skill_advisor.py   # Evolution/creation suggestions
.claude/agents/
└── promptcraft.md         # Sub-agent registration
tests/
├── test_scripts.py           # checkpoint, hydrate, federation
├── test_health_report.py     # thresholds, stall, consistency, compact_str
├── test_subagent_adapter.py  # routing, parsing, formatting, E2E
├── test_engine_modes.py      # 6 invoke_* + maybe_silent_analyze
├── test_integration.py       # full closed-loop workflows
└── test_boundary.py          # 5-layer guards, circuit breaker, tool safety
```

## Key Features (v2.6)

- **Execution Boundary Module**: 5-layer defence-in-depth for the sub-agent: Input → Tool → Vault → Output → Circuit Breaker. Adapted from Claude Code's 7-layer permission system for a sub-agent whose threat model is knowledge pollution and trust-chain abuse, not shell injection.
- **Batch Processing**: Process multiple tasks in a single PromptCraft call — hydrate once, group by Skill match, execute in parallel (max 4 workers), aggregate results.
- **Batch Feedback Persistence**: Buffered vault writes — feedback records accumulate in-memory and flush to vault in batches (NDJSON), reducing subprocess overhead.
- **Engine Metrics**: Observable silent-failure counters (vault write errors, subprocess timeouts, analysis errors) surfaced via HealthReport degradation signals.
- **Proactive Health Signals**: Every response includes `proactive_signals` — vault context hints (similar tasks, common pitfalls) without changing the passive-trigger model.
- **Multi-Project Federation**: Two-tier vault — global (`~/.promptcraft/`) + project (`./.promptcraft/`)
- **Query Expansion**: Synonym-based query expansion with cross-language (CJK→EN) mapping before Jaccard search (zero-dependency)
- **Vault Pruning**: `hydrate.py --prune --older-than N` for stale entry cleanup — GLOBAL entries never pruned, .md files preserved
- **Execution Feedback Loop**: Structured quality scoring (1-5) written back to vault
- **GLOBAL Entry Injection**: GLOBAL entries always returned regardless of query match
- **Multi-Script Tokenizer**: CJK + Japanese Kana + Korean Hangul + Latin + Cyrillic

## Conventions

- Vault entries are append-only. New versions use `checkpoint.py --version-of`.
- Script output is always JSON to stdout. Errors use `{"status": "error", ...}`.
- Verify all changes with: `python -m unittest discover -s tests -p "test_*.py"`
- `importance: GLOBAL` entries are always returned by hydrate.py — inject their
  constraints unconditionally into every session.
- Execution feedback uses `importance: REFERENCE` — consultable but not auto-injected.
- Encoding: UTF-8 for vault I/O; `utf-8-sig` for stdin/file input (handles Windows BOM).
- Path separators: forward slash in vault `md_path` values (`as_posix()`).
- Global vault: `~/.promptcraft/global_vault.json` — hydrate.py auto-merges.
- Use `checkpoint.py --global` for cross-project entries; `hydrate.py --no-global` to opt out.
- Execution boundary is FAIL-CLOSED: guards deny when uncertain. MODIFIES_SKILLS is bypass-immune hard-deny for all tools.
- Circuit breaker trips after 3 consecutive denials (OPEN), probes after cooldown (HALF_OPEN), resets on success (CLOSED).
- Low-quality counter has 60-second time-based decay — prevents oscillation between scores 2-3 from never resetting.
- `checkpoint.py --batch` reads NDJSON (one JSON per line) for efficient multi-record writes.
- `hydrate.py --prune --older-than N` cleans stale entries; `--dry-run` previews without modifying.

## PromptCraft Sub-Agent (v2.2)

PromptCraft is available as a sub-agent (`promptcraft`). It handles prompt
engineering, skill personalization, and execution feedback collection.

### Quick Usage

```bash
# Generate a prompt (build mode — no matching Skill)
echo '{"task":"audit ERC20 token","mode":"build"}' | python promptcraft-agent/subagent_adapter.py

# Personalise a Skill (overlay mode — matching Skill exists)
echo '{"task":"audit contract","mode":"overlay","skill_name":"solidity-audit"}' | python promptcraft-agent/subagent_adapter.py

# Collect execution feedback
echo '{"task":"audit contract","mode":"feedback","feedback":{"output":"...","success":true}}' | python promptcraft-agent/subagent_adapter.py

# Run pattern analysis (when health report signals ->analyze)
echo '{"task":"audit patterns","mode":"analyze"}' | python promptcraft-agent/subagent_adapter.py

# Get skill advice (when health report signals ->advise)
echo '{"task":"suggest improvements","mode":"advise"}' | python promptcraft-agent/subagent_adapter.py

# Batch process multiple tasks
echo '{"mode":"batch","items":[{"task":"audit token","skill_name":"solidity-audit"},{"task":"write docs"}]}' | python promptcraft-agent/subagent_adapter.py
```

### Modes

| Mode | When | What It Returns |
|------|------|-----------------|
| overlay | Skill exists, needs personalization | Overlay constraints + health report + proactive signals |
| build | No matching skill | Structured prompt (adaptive sections) + health report + proactive signals |
| feedback | After execution | Feedback confirmation + health report |
| analyze | Health report recommends it | Pattern analysis report |
| advise | Evolution/creation ready | Skill advice (suggestions only, no auto-modify) |
| batch | Multiple tasks | BatchSummary + per-item results + health report |

### Health Report Signals

Every call returns a compact health line: `[PromptCraft] records=N quality=X.X ->action`

- `->analyze` — >=10 records, run analyze mode for detailed insights
- `->advise` — >=20 records + high consistency, skill evolution/creation warranted
- `->break` — 3 consecutive no-improvement iterations, needs user intervention
- (no arrow) — normal operation, continue

### Architecture

The Engine has 6 public `invoke_*` methods (one per mode) plus `maybe_silent_analyze()`
which runs after every invocation — if >=10 feedback records, pattern analysis triggers
silently (vault write only, nothing returned to main agent).

The subagent_adapter.py is the single entry point — it routes to the appropriate
engine method, calls silent analysis, and returns a SubagentOutput with the health
report and payload.

## Memory

Persistent project memory at: `C:\Users\Dell\.claude\projects\C--Users-Dell-Desktop-PromptCraft-Skills\memory\`
- `MEMORY.md` — index
- `project-overview.md` — what PromptCraft is, current state
- `agent-architecture.md` — agent evolution plan
- `design-decisions.md` — key architectural decisions
