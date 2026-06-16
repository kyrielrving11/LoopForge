# PromptCraft

[中文文档](README.zh-CN.md)

PromptCraft is a suite of **prompt engineering Skills** for CodeBuddy / Codex. The
core philosophy: before asking a model to "think harder", first polish the task
brief you hand it.

> **Task Enhancement** — improving the quality of the input before the model
> starts reasoning.

---

## Three Innovations

| Innovation | Description |
|---|---|
| **Workspace-Anchored Memory** | Prompt history lives in `.promptcraft/prompt_vault.json` — human-readable, editable, auto-indexed by the host tool's file system. Cross-tool portable. |
| **LLM-as-a-Router** | Zero-code routing. The host model uses an embedded system prompt to evaluate *independence × cognitive load* and select the best prompt-engineering technique from a catalog of 7. |
| **Git-Style Version Control** | Every revision for the same task is appended, never overwritten. An `is_active` pointer marks the current version. `hydrate.py --rollback-to v1` switches back instantly. |

## Project Structure

```
PromptCraft/
├── skills/
│   ├── prompt-craft/          # Core workflow: route → build → save → execute
│   │   ├── SKILL.md           #   6-step workflow + LLM router system prompt
│   │   └── references/        #   routing matrix + build checklist
│   ├── prompt-memory/         # Workspace-anchored memory I/O
│   │   ├── SKILL.md
│   │   ├── scripts/           #   checkpoint.py + hydrate.py
│   │   └── references/        #   vault schema
│   ├── prompt-techniques/     # Catalog of 7 prompt-engineering techniques
│   │   ├── SKILL.md
│   │   └── references/        #   zero-shot, few-shot, cot, step-back, least-to-most, tot
│   └── prompt-review/         # Prompt quality audit & improvement
│       ├── SKILL.md
│       └── references/        #   review checklist
├── .promptcraft/              # Runtime storage (dual-storage architecture, created on first use)
│   ├── prompt_vault.json      #   lightweight metadata index (~200 tokens/entry)
│   └── prompts/               #   complete prompt archive
│       └── <task_id>/
│           └── v1.md          #   full prompt (Markdown, human-readable)
├── LICENSE
└── README.md / README.zh-CN.md
```

## The 4 Skills

| Skill | Role | When to use |
|---|---|---|
| `prompt-craft` | Core entry: LLM routing → technique selection → conditional case generation → prompt build → vault save → one-click execute | You need to write or improve a high-quality prompt |
| `prompt-memory` | Dual storage I/O: `checkpoint.py` writes (metadata → JSON index, complete prompt → `.md` file), `hydrate.py` searches (compact mode for context injection, `--full` reads from `.md` for reuse). | Persist / load / version prompt history |
| `prompt-techniques` | Reference catalog of 7 prompt-engineering techniques. Each reference includes JSON input templates, design rules, case generation rules, search strategies, and execution mode guides. | Loaded on-demand by other skills |
| `prompt-review` | Quality gate: completeness audit + improvement suggestions; new versions appended, never overwritten | Audit an existing prompt |

## The 6-Step Pipeline

Loading `prompt-craft` triggers an automatic pipeline:

```
Step 0: hydrate.py → load `hard_constraints` and successful patterns from vault
Step 1: LLM Router → independence × cognitive load → select technique
Step 2: Read technique details → load method_steps + design_rules from references/
Step 2.5: Conditional Case Generation → only generates examples when the user
         provides domain knowledge (sample data, field definitions, reference ranges);
         otherwise skips and the user fills examples in Step 3.
Step 3: Build enhanced prompt → embed approved cases + role + task + format + constraints
Step 4: checkpoint.py → save complete prompt to .md file, metadata to JSON index
        (ALWAYS runs before Step 5, regardless of user's action choice)
Step 5: Action selection
        ├── 🚀 Execute now     → prompt already saved, execute in current session
        ├── 💾 Save for later  → already persisted, hydrate.py --full loads it later
        └── 🔍 Review & improve → load prompt-review, new version auto-appended
```

## Install & Use

Copy the 4 Skill directories from `skills/` into your project or user
Skills directory (e.g. `.codebuddy/skills/` for CodeBuddy, or your tool's equivalent):

```
your-project/.codebuddy/skills/prompt-craft/
your-project/.codebuddy/skills/prompt-memory/
your-project/.codebuddy/skills/prompt-techniques/
your-project/.codebuddy/skills/prompt-review/
```

The scripts default to `.promptcraft/` as the vault root and
`.codebuddy/skills/prompt-memory/scripts/` as the scripts path. Override via
`--vault` / `--prompts-dir` flags if your layout differs.

Then, in a CodeBuddy / Codex chat:

> Load prompt-craft. Help me write a high-quality prompt.

The AI automatically runs the full 6-step pipeline.

## Tech Stack

- **Python stdlib only**: `checkpoint.py` / `hydrate.py` have zero external dependencies
- **Dual storage**: JSON vault = lightweight metadata index; `.md` files = complete prompts
- **Workspace file anchoring**: `.promptcraft/` — all state is file-based, no database
- **Zero-code routing**: the router is a system prompt embedded in `prompt-craft/SKILL.md`
- **Semantic search**: keyword overlap / Jaccard similarity (no embeddings yet)
- **Context economics**: compact mode returns metadata only (~200 tokens); `--full` reads `.md` files on demand

## Design Principles

- Enhance input quality — never replace the model's reasoning
- Zero external model calls — no API costs
- No proprietary memory APIs — plain filesystem
- No closed databases — the vault is human-readable and editable
- Append, never overwrite — full version history preserved
- Dual storage: JSON for fast metadata search, `.md` for complete prompt readability
- Rich technique references — design rules, JSON templates, case generation rules (domain-grounded), not stripped-down method steps

## Version

This is the **v2.0 Skills Edition** — a complete rewrite from the MCP-based v0.1 prototype
to a native CodeBuddy Skills architecture. The MCP prototype has been retired (see git
history). Current focus: technique reference enrichment, conditional case generation (domain-grounded),
and full-prompt persistence.

## License

MIT License. See [LICENSE](LICENSE).
