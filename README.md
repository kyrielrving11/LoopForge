# PromptCraft

[中文文档](README.zh-CN.md)

PromptCraft is a suite of **prompt engineering Skills** for AI coding agents
(CodeBuddy / Codex / Claude Code). The core philosophy: before asking a model to
"think harder", first polish the task brief you hand it.

> **Task Enhancement** — improving the quality of the input before the model
> starts reasoning. And then **remembering** what worked, what didn't, and what
> constraints were discovered — across sessions and across projects.

---

## Key Innovations

| Innovation | Description |
|---|---|
| **LLM-as-a-Router** | Zero-code routing. The host model evaluates *independence × cognitive load* and selects the best technique from a catalog of 7. No external API calls. |
| **Workspace-Anchored Memory** | Prompt history lives in human-readable JSON + Markdown files. The host tool's file system provides indexing, portability, and git-diff. No database, no proprietary APIs. |
| **Git-Style Version Control** | Every revision is appended, never overwritten. An `is_active` pointer marks the current version. `hydrate.py --rollback-to v1` switches back instantly. |
| **Multi-Project Federation** | A two-tier vault: `~/.promptcraft/global_vault.json` for cross-project constraints, `.promptcraft/prompt_vault.json` for project-specific history. hydrate.py merges both automatically. |
| **Query Expansion** | Before searching the vault, the LLM generates cross-language keyword expansions (e.g. Chinese → English synonyms). Overcomes Jaccard's synonym blindness without external dependencies. |
| **Execution Feedback Loop** | After prompt-craft executes a prompt, it analyzes the output against hard constraints and writes structured feedback back to the vault. Future sessions learn from past results. |

---

## Project Structure

```
PromptCraft/
├── skills/
│   ├── prompt-craft/          # Core workflow: route → build → save → execute
│   │   ├── SKILL.md           #   6-step workflow + LLM router + query expansion + feedback loop
│   │   └── references/        #   routing matrix + build checklist
│   ├── prompt-memory/         # Workspace-anchored memory I/O + federation
│   │   ├── SKILL.md
│   │   ├── scripts/           #   checkpoint.py + hydrate.py
│   │   └── references/        #   vault schema (incl. federation & feedback sub-schemas)
│   ├── prompt-techniques/     # Catalog of 7 prompt-engineering techniques
│   │   ├── SKILL.md
│   │   └── references/        #   zero-shot, few-shot, cot, step-back, least-to-most, tot
│   └── prompt-review/         # Prompt quality audit with technique-specific guidance
│       ├── SKILL.md
│       └── references/        #   review checklist
├── tests/
│   └── test_scripts.py        # 42 unit tests (checkpoint + hydrate + federation)
├── CLAUDE.md                  # Project conventions for Claude Code
├── .promptcraft/              # Runtime storage (created on first use)
│   ├── prompt_vault.json      #   lightweight metadata index (~200 tokens/entry)
│   └── prompts/               #   complete prompt archive (.md files)
├── LICENSE
└── README.md / README.zh-CN.md
```

Global vault (cross-project): `~/.promptcraft/global_vault.json`

---

## The 4 Skills

| Skill | Role | When to use |
|---|---|---|
| `prompt-craft` | Core entry: query expansion → vault hydration → LLM routing → technique selection → conditional case generation → prompt build → vault save → execute + feedback write-back | You need to write or improve a high-quality prompt |
| `prompt-memory` | Dual-storage I/O with federation: `checkpoint.py` (save, `--global` for cross-project), `hydrate.py` (search with auto-merge of global + project vaults, `--no-global` to opt out) | Persist / load / version prompt history |
| `prompt-techniques` | Reference catalog of 7 techniques with JSON input templates, design rules, case generation rules, search strategies, and output templates | Loaded on-demand by other skills |
| `prompt-review` | Quality gate with technique-specific checks: completeness → constraints → technique fit → context quality → anti-patterns → edge cases. Severity-tagged findings (BLOCKER/MAJOR/MINOR) | Audit an existing prompt |

---

## The Pipeline 

Loading `prompt-craft` triggers an automatic pipeline:

```
Step 0a: Query Expansion → LLM generates cross-language keywords to improve
         Jaccard overlap with vault entries (zero-code, zero-API)
Step 0b: hydrate.py → auto-merges global + project vaults;
         GLOBAL entries (both vaults) unconditionally injected into context;
         top-k relevant entries by Jaccard score
Step 1: LLM Router → independence × cognitive load → select technique
Step 2: Read technique details → load method_steps + design_rules from references/
Step 2.5: Conditional Case Generation → only when user provides domain knowledge
Step 3: Build enhanced prompt → 8-section structure with approved cases
Step 4: checkpoint.py → save to project vault (or --global for cross-project)
Step 5: Action selection
        ├── 🚀 Execute now   → execute → analyze output → feedback written back
        │                      to vault (structured: status + quality_score + violations)
        ├── 💾 Save for later → persist; hydrate.py --full loads it later
        └── 🔍 Review & improve → load prompt-review, new version auto-appended
```

---

## Multi-Project Federation

PromptCraft supports a two-tier vault:

| Tier | Path | Use case |
|------|------|----------|
| **Global** | `~/.promptcraft/global_vault.json` | Org-wide standards ("all SQL must have rollback scripts"), shared templates |
| **Project** | `.promptcraft/prompt_vault.json` | Project-specific decisions, bug-specific prompts |

**hydrate.py** automatically merges both vaults on every query. Project entries
take precedence when the same `task_id` exists in both. Use `--no-global` to
search only the project vault.

**checkpoint.py** saves to the project vault by default. Use `--global` to
save to the global vault instead.

```bash
# Save org-wide constraint
echo '{"task_id":"org-security","user_intent":"All contracts must pass Certora"}' | \
  python checkpoint.py --global

# Search (auto-merges both vaults)
python hydrate.py --query "audit contract security"

# Project-only search
python hydrate.py --query "audit contract" --no-global
```

---

## Install & Use

Copy the 4 Skill directories from `skills/` into your project or user
Skills directory (e.g. `.codex/skills/` for CodeBuddy):

```
your-project/.codex/skills/prompt-craft/
your-project/.codex/skills/prompt-memory/
your-project/.codex/skills/prompt-techniques/
your-project/.codex/skills/prompt-review/
```

The scripts default to `.promptcraft/` as the vault root and
`.codex/skills/prompt-memory/scripts/` as the scripts path. Override via
`--vault` / `--prompts-dir` flags.

Then, in a CodeBuddy / Codex / Claude Code chat:

> Load prompt-craft. Help me write a high-quality prompt.

The AI automatically runs the full pipeline.

---

## Tech Stack

- **Python stdlib only**: zero external dependencies
- **Dual storage**: JSON vault = lightweight index; `.md` files = complete prompts
- **Two-tier federation**: global vault (`~/`) + project vault (`./`)
- **Zero-code routing**: LLM-as-a-Router embedded in SKILL.md
- **Query expansion**: LLM-generated cross-language keywords (no embeddings, no APIs)
- **Semantic search**: Jaccard similarity on multi-script tokens (CJK + Latin + Cyrillic)
- **Context economics**: compact mode ~200 tokens; `--full` reads `.md` files on demand
- **Feedback loop**: structured execution feedback written back to vault

## Design Principles

- Enhance input quality — never replace the model's reasoning
- Zero external model calls — no API costs, no embedding services
- No proprietary memory APIs — plain filesystem, human-readable JSON/Markdown
- No closed databases — the vault is editable, diffable, version-controllable
- Append, never overwrite — full version history preserved
- Dual storage: JSON for fast metadata search, `.md` for complete prompt readability
- Federation: global vault for cross-project constraints, project vault for local decisions
- Rich technique references — design rules, JSON templates, case generation rules

## License

MIT License. See [LICENSE](LICENSE).
