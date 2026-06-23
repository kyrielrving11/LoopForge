@CLAUDE.md

## Agent-specific notes

- **Sub-agent `promptcraft`** is available for prompt engineering tasks —
  use `Agent(subagent_type="promptcraft", ...)`. Auto-trigger rules are
  in CLAUDE.md under "PromptCraft 自动触发规则".
- **Vault** is at `.promptcraft/` (project) + `~/.promptcraft/` (global).
- **Verify** with: `python -m unittest discover -s tests -p "test_*.py"`
