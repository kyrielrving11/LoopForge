# LoopForge

**A context window is not memory. Memory needs a runtime.**

> **v3.5.0** — `npm install -g loopforge`. Node.js ≥ 18. Zero runtime dependencies.
> [中文文档](../README.zh-CN.md)

---

## The real problems with long-horizon tasks

Any AI coding agent, given a long enough task, hits three walls. Not because the model isn't smart enough. Not because the context window isn't large enough. These are **architectural** problems.

### Problem 1: The summary cascade

Context fills up → compress. Fills up again → compress again. The third compression is a summary of a summary of a summary. Every cycle evaporates information — critical constraints get silently deleted because the summarizer judged them "no longer relevant." Researchers found that after 3–4 summary cycles, constraint violation rates spike from 0% to 59%. The agent doesn't know what it forgot, because the forgetting itself was compressed away.

### Problem 2: Self-correction doesn't work

Models cannot reliably improve themselves through introspection — they talk themselves out of correct answers. Effective recovery requires an **external verifier** — an independent observer that doesn't share the agent's context, doesn't participate in its reasoning, and only looks at inputs and outputs.

### Problem 3: Compound error (p^N)

If each step succeeds with probability p, N sequential steps succeed with probability p^N. Frontier agents nail nearly 100% of tasks under 4 minutes but crater to under 10% on tasks over 4 hours. Small errors at each step become the correct input for the next step.

**These three problems amplify each other. The summary cascade loses information → lost information becomes errors → the agent can't self-correct because those errors look reasonable within its own context.**

---

## What LoopForge does about it

LoopForge doesn't compete on context window size. It runs **outside** the agent and provides three things:

### 1. Breaks the summary cascade: Vault → compile, not summary → summary

Each round's self-evaluation is written to a **typed vault** (JSON documents). The next round's prompt is not generated from the previous prompt's summary — it's **recompiled from the vault**. Milestones aren't summaries of summaries; they're recomputed from raw vault entries. Constraints and criteria carry stable IDs (`c-XXXXXXXX`, `cr-XXXXXXXX`) for exact matching — no Jaccard guesswork.

```
❌ Traditional: prompt → summary → next prompt → re-summarize → … (information evaporates each cycle)
✅ LoopForge:  prompt → vault entry → next prompt (recompiled from vault, zero evaporation)
```

### 2. External judgment: the perspective the agent cannot provide for itself

The verification gate cross-checks every agent claim against independent evidence — Git snapshots, test runner output, explicit verification commands. The enforcement gate detects what the agent cannot self-diagnose:

- R1: You claimed success but criteria remain unmet → **you're deceiving yourself**
- R3: You claimed success with no verifiable evidence → **your claim is empty**
- R4: You've been stuck for 3 rounds → **you're stalled and you don't know it**
- R5: Your progress is exactly zero → **you're going through the motions**
- R7: You said you'd do X but did Y → **your intent and actions are disconnected**

**The agent cannot self-detect these. The agent is the system that produced those narratives. External judgment is necessary.**

### 3. Walk back from dead ends

Progress stall or flatline → roll back to the last clean round instead of terminating. A diagnosis of why the path failed is injected. The backtrack prompt includes concrete workspace restore commands — `git checkout -- . && git clean -fd` with affected file lists. The verification gate checks that the workspace was actually restored before the next submission. Valid discoveries from skipped rounds are preserved.

---

## What LoopForge is not

- ❌ **Not a memory system** — the state file is a derived view. The vault is truth. No RAG, no vector DB.
- ❌ **Not a context compressor** — doesn't compress prompts, doesn't do smart summarization. Recompiles from vault, not from the previous prompt.
- ❌ **Not a constraint tracker** — constraints are one signal the verification gate monitors. The core value is external judgment.
- ❌ **Not a replacement for the agent** — the agent still reads code, edits files, runs tools, and decides how to reason. LoopForge owns the **round boundary**.

---

## Install

```bash
npm install -g loopforge
loopforge init --client claude
claude mcp add loopforge -- npx loopforge mcp
```

Works with Claude Code, Codex CLI, or any MCP-compatible client.

The MCP server path (`loopforge mcp`) is the primary integration. It provides
the full cognitive infrastructure: verification gate, enforcement gate,
backtrack, evidence collection, and crash recovery. The engine is also
available as a library for custom integrations.

---

## Architecture

```
┌─────────────────────────────────────────────────────┐
│                  Agent executes round                 │
│  Reads code · Edits files · Runs tools · Reasons      │
└──────────────────────┬──────────────────────────────┘
                       │ Agent submits SelfEvaluation
                       ▼
┌─────────────────────────────────────────────────────┐
│               LoopForge round boundary                │
│                                                       │
│  Evidence → Verify → Enforce → Commit → Compile       │
│  (Git/cmd) (28 checks) (14 rules) (vault) (next)    │
│                                                       │
│  accept:  commit state, compile next round             │
│  reject:  retry same round, zero state mutation        │
│  backtrack: roll back to last clean round, restore     │
│  terminate: persist terminal state                     │
└──────────────────────┬──────────────────────────────┘
                       │ Recompile prompt from vault
                       ▼
┌─────────────────────────────────────────────────────┐
│             Vault (typed JSON persistence)            │
│  loops/<id>/rounds/<n>.json · session.json · policy   │
│  Source of truth. Not a summary chain.                 │
└─────────────────────────────────────────────────────┘
```

---

## Key capabilities

**Vault → compile, not summary → summary.** Every round's self-evaluation is written to the vault. The next prompt is recompiled from vault entries. Stable IDs (`c-` / `cr-` / `sg-XXXXXXXX`) enable exact constraint, criterion, and sub-goal matching — no Jaccard false positives.

**External judgment.** The verification gate cross-checks agent claims against independent evidence. The enforcement gate detects cognitive integrity violations — progress stalls, intent-action gaps, empty success claims. The judge never shares the agent's context.

**Model expresses information needs.** Each round, the agent tells the compiler: what to emphasize, which sections to expand, where it's confused. The compiler reorders within safety boundaries — mandatory sections untouched, budget respected.

**Walk back from dead ends.** Progress stall → roll back to last clean round with a diagnosis. Workspace restore is prompted and verified — the next submission is rejected if files from skipped rounds are still dirty.

**Substantive drift, not filler.** R7 accepts intentional pivots only when the clarification references concrete IDs or file paths. Three consecutive weak clarifications terminate the loop.

**Thin prompt, fat state file.** L0 (retry) / L1 (continuation) / L2 (full rehydration) control density only — reasoning strategy belongs to the agent. Truth is in the vault.

**Pause · Resume · Replay.** Cross-process session leases. Idempotent resume after interruption. Time-travel queries over committed rounds.

**Nine MCP tools.** `start` · `next` · `status` · `stop` · `pause` · `resume` · `replay` + `gate_check` · `gate_resolve`. `status` is the unified inspection tool (`view=session|loop|all|audit`). Every tool returns JSON content blocks.

**Zero dependencies. Policy-driven.** Node.js stdlib only. All thresholds, budgets, and intervals live in `loop_policy.json`. 783 tests.

---

## Development

```bash
npm run check
npm test
npm pack --dry-run --json
```

The protocol schema in `../loopforge-protocol.json` is generated from `src/protocol.ts`. Do not edit it by hand.

---

## License

MIT
