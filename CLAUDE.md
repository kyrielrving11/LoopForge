# CLAUDE.md

This is the PromptCraft skills repository — a suite of prompt-engineering
Skills for AI coding agents (CodeBuddy / Codex).

## Project layout

```
skills/
├── prompt-craft/          # Core 6-step workflow (SKILL.md)
│   └── references/        # routing-matrix, build-checklist
├── prompt-memory/         # Dual-storage vault I/O
│   ├── scripts/           # checkpoint.py, hydrate.py
│   └── references/        # vault-schema
├── prompt-techniques/     # Reference catalog of 7 techniques (SKILL.md)
│   └── references/        # zero-shot, few-shot, cot, step-back, least-to-most, tot
└── prompt-review/         # Quality audit (SKILL.md)
    └── references/        # review-checklist
```

## Working with this repo

- **Python scripts** (checkpoint.py / hydrate.py) use stdlib only — zero
  external dependencies. They read/write `.promptcraft/prompt_vault.json` and
  `.promptcraft/prompts/<task_id>/<version_tag>.md`.
- **All SKILL.md files** are markdown with YAML frontmatter (`name`,
  `description`). The `prompt-craft` skill is the main entry point.
- **References** are loaded on-demand by skills — never pre-load all.
- **.gitignore** excludes `.promptcraft/` (runtime vault data).

## Conventions

- Vault entries are append-only. New versions use `checkpoint.py --version-of`.
- Script output is always JSON to stdout. Errors use `{"status": "error", ...}`.
- `importance: GLOBAL` entries are always returned by hydrate.py regardless of
  query match — inject their constraints unconditionally.
- Encoding: UTF-8 for all vault I/O; `utf-8-sig` for stdin/file input in
  checkpoint.py main (handles Windows BOM).
- Path separators: forward slash in vault `md_path` values (`as_posix()`).

## Testing changes

```bash
# Create a test vault
python -c "
import json, os
os.makedirs('.promptcraft', exist_ok=True)
json.dump({'version':'1','entries':[]}, open('.promptcraft/prompt_vault.json','w'))
"

# Test checkpoint
echo '{"task_id":"test","user_intent":"test save"}' | python skills/prompt-memory/scripts/checkpoint.py

# Test hydrate
python skills/prompt-memory/scripts/hydrate.py --query "test save"

# Cleanup
rm -rf .promptcraft
```
