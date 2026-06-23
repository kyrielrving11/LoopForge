# PromptCraft Agent

A self-aware prompt-engineering sub-agent. The main coding agent (Claude Code,
Codex, etc.) wakes PromptCraft on-demand when it needs structured, high-quality
prompts. The Agent has its own context, its own memory (vault), and improves
over time through an execution feedback loop.

**This is an Agent — not a Skill.** It has its own system prompt, its own
state, and its own lifecycle. The main agent communicates with it via a
structured JSON protocol.

## Architecture

```
promptcraft-agent/
├── protocol.py           # I/O schemas (Request, Response, Stalled, etc.)
├── builder.py            # Single-build pipeline (stateless)
├── engine.py             # Outer loop — iteration lifecycle manager
├── subagent_adapter.py   # Unified entry point (stdin/stdout protocol)
└── README.md             # This file
```

### Double-Layer Separation

| Layer | File | Scope | State |
|-------|------|-------|-------|
| **Engine** | `engine.py` | Iteration lifecycle — should we refine, stop, or escalate? | Session-persistent (quality trend, circuit breaker count) |
| **Builder** | `builder.py` | Single build pipeline — route → build → save | Stateless per call |

Cf. Claude Code's QueryEngine vs query() — same separation principle, different
domain (prompt quality vs tool execution).

## Quick Start

```bash
# Run the sub-agent adapter (the unified entry point)
echo '{"task":"audit a smart contract for reentrancy","mode":"build"}' | python promptcraft-agent/subagent_adapter.py

# With explicit parameters (use subagent_adapter.py — the unified CLI)
echo '{"task":"build a REST API","mode":"build","context":{"tech_stack":"Python, FastAPI"}}' | python promptcraft-agent/subagent_adapter.py

# Run with PRD context
echo '{"task":"implement user management","mode":"build","context":{"prd":"docs/prd.md"}}' | python promptcraft-agent/subagent_adapter.py
```

## The Agent Loop

```
Main Agent                    PromptCraft Agent              Vault
    │                               │                         │
    ├─ senses need ────────────────→│                         │
    │  (fuzzy / complex / risky)    │                         │
    │                               ├─ hydrate ──────────────→│
    │                               │←─ history + feedback ───┤
    │                               ├─ route technique        │
    │                               ├─ build structured prompt │
    │                               ├─ checkpoint ───────────→│
    │←─ PromptCraftResponse ───────┤                         │
    │                               │                         │
    ├─ execute prompt               │                         │
    ├─ collect feedback             │                         │
    │                               │                         │
    ├─ feedback mode ──────────────→│                         │
    │                               ├─ assess quality         │
    │                               ├─ checkpoint v2 ────────→│
    │←─ FeedbackResponse ──────────┤                         │
    │                               │                         │
    │  (if stalled → circuit breaker → structured escalation) │
```

### Continue Sites

Like Claude Code's 7 continue sites, PromptCraft Engine has decision points
that determine whether the loop continues:

| Reason | Trigger | Action |
|--------|---------|--------|
| `first_call` | Initial invocation | Normal build |
| `next_turn` | Feedback received, refining | Rebuild with feedback context |
| `technique_switch` | Current technique unsuitable | Re-route, try different technique |
| `constraint_conflict` | Two constraints cannot both be satisfied | Escalate to main agent |
| `scope_change` | User requirements shifted | Realign prompt to new scope |

### Circuit Breaker

After 3 consecutive iterations with no quality improvement, the Engine trips
the circuit breaker. It returns a **StalledResponse** — a structured question
for the main agent, NOT a raw prompt dump. The user never sees the prompt
internals; they answer a concrete question like "Should we relax constraint
X or switch technique Y?"

## The Self-Awareness Loop

Self-awareness is **not a separate step**. It is the natural flow of vault
data through every decision:

- `hydrate` returns past similar tasks + their feedback
- The Router reads this context and adjusts technique selection
- The Builder injects past constraints and avoids known pitfalls
- Feedback from execution flows back into vault
- Next time hydrate runs, this cycle's results are part of the context

## Design Philosophy

> The main agent already writes prompts internally — just implicitly,
> unstructured, and discarded after one use. PromptCraft makes this process
> explicit, structured, persistent, and self-improving.

See `memory/design-philosophy.md` for the full philosophy.

## Related

- `skills/prompt-memory/` — Vault I/O scripts (checkpoint.py, hydrate.py)
- `skills/prompt-techniques/` — 7 technique reference files
- `skills/prompt-craft/` — Legacy Skills-based workflow (lightweight fallback)
- `skills/prompt-review/` — Quality audit checklists
- `docs/AGENT_ARCHITECTURE.md` — Full architecture design document
- `memory/` — Persistent project memory
