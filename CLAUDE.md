# CLAUDE.md

This is the PromptCraft repository — a suite of prompt-engineering tools
for AI coding agents (CodeBuddy / Codex / Claude Code).

**Version:** v2.1 | **Tests:** 42 passing | **Python:** stdlib only

## Quick Start

```bash
# Run all tests
python tests/test_scripts.py

# Create a test vault
echo '{"task_id":"test","user_intent":"test save"}' | python skills/prompt-memory/scripts/checkpoint.py

# Search vault (auto-merges global + project)
python skills/prompt-memory/scripts/hydrate.py --query "test save"

# Save to global vault (cross-project)
echo '{"task_id":"org-standard","user_intent":"all contracts must pass Certora"}' | \
  python skills/prompt-memory/scripts/checkpoint.py --global
```

## Project Layout

```
skills/
├── prompt-craft/          # Core 6-step workflow (SKILL.md)
│   └── references/        # routing-matrix, build-checklist
├── prompt-memory/         # Dual-storage vault I/O + federation
│   ├── scripts/           # checkpoint.py, hydrate.py
│   └── references/        # vault-schema (incl. federation + feedback schemas)
├── prompt-techniques/     # Reference catalog of 7 techniques (SKILL.md)
│   └── references/        # zero-shot, few-shot, cot, step-back, least-to-most, tot
└── prompt-review/         # Quality audit with technique-specific checks (SKILL.md)
    └── references/        # review-checklist
docs/
└── AGENT_ARCHITECTURE.md  # Full plan for evolving to Sub-Agent model
tests/
└── test_scripts.py        # 42 unit tests (checkpoint, hydrate, federation)
```

## Key Features (v2.1)

- **Multi-Project Federation**: Two-tier vault — global (`~/.promptcraft/`) + project (`./.promptcraft/`)
- **Query Expansion**: LLM-generated cross-language keywords before Jaccard search (zero-code)
- **Execution Feedback Loop**: Structured quality scoring (1-5) written back to vault
- **GLOBAL Entry Injection**: GLOBAL entries always returned regardless of query match
- **Multi-Script Tokenizer**: CJK + Japanese Kana + Korean Hangul + Latin + Cyrillic

## Conventions

- Vault entries are append-only. New versions use `checkpoint.py --version-of`.
- Script output is always JSON to stdout. Errors use `{"status": "error", ...}`.
- `importance: GLOBAL` entries are always returned by hydrate.py — inject their
  constraints unconditionally into every session.
- Execution feedback uses `importance: REFERENCE` — consultable but not auto-injected.
- Encoding: UTF-8 for vault I/O; `utf-8-sig` for stdin/file input (handles Windows BOM).
- Path separators: forward slash in vault `md_path` values (`as_posix()`).
- Global vault: `~/.promptcraft/global_vault.json` — hydrate.py auto-merges.
- Use `checkpoint.py --global` for cross-project entries; `hydrate.py --no-global` to opt out.

## Next: Agent Architecture

The current Skills architecture runs prompt engineering inside the main agent's
context (~30% overhead). The planned evolution is a dedicated PromptCraft
sub-agent with its own context. See `docs/AGENT_ARCHITECTURE.md` for the
complete design. Implementation phases:
1. Agent system prompt + registration
2. Dispatcher skill (lightweight main-agent glue)
3. Protocol refinement
4. Migration + compatibility
5. Advanced features (batch, templates, proactive suggestions)

## Memory

Persistent project memory at: `C:\Users\Dell\.claude\projects\C--Users-Dell-Desktop-PromptCraft-Skills\memory\`
- `MEMORY.md` — index
- `project-overview.md` — what PromptCraft is, current state
- `agent-architecture.md` — agent evolution plan
- `design-decisions.md` — key architectural decisions
