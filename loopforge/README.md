# LoopForge

**A context window is not memory. Memory needs a runtime.**

> **v3.7.0** — `npm install -g loopforge`. Node.js ≥ 18. Zero runtime dependencies.
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

LoopForge runs outside the agent and owns the boundary between rounds. Its
design has two explicit sources:

- **One factual source:** committed typed round documents in the Vault.
- **One cognitive source:** Canonical State compiled from those facts.

`loopforge_next` accepts a structured evaluation. The core fields `success`,
`output_summary`, `constraint_violations`, and `should_continue` are strict;
optional fields are normalized. Invalid input returns `evaluation_invalid` and
can be corrected with the same `roundId` without saving session state, writing
a round, entering either gate, or changing metrics.

Valid submissions pass through evidence collection, a verification gate
organized into four domains (evaluation consistency, evidence integrity, plan
& contract, progress & recovery), and an enforcement gate driven by one
ordered strategy table across four action classes (evidence contradiction,
contract & scope, plan drift, progress recovery). Only an allowed round joins
committed history. The shared internal `CommittedRoundView` gives Replay,
Audit, Metrics, contracts, the compiler, and gate history one decoder and one
filtering policy. It does not create another storage format.

The compiler evolves Canonical State from committed history, then derives
focus, todo, phase, delegation, and handoff for prompts and status views. The
next prompt therefore comes from typed cognitive state, not from a summary of
the previous prompt.

```text
Traditional: prompt -> summary -> next prompt -> another summary
LoopForge:    committed rounds -> Canonical State -> next prompt
```

The verification gate compares claims with Git snapshots, test output, and
configured command evidence. The enforcement gate can accept, reject,
backtrack, or terminate. A rejected submission commits nothing. A stalled-
progress evaluator can restore the last clean round, inject a diagnosis, and
verify workspace restoration before work continues.

---

## What LoopForge is not

- **Not a memory database.** The optional state file is derived. Committed
  rounds hold facts, and Canonical State supplies runtime cognition.
- **Not a context compressor.** It recompiles prompts from typed state instead
  of compressing the prior prompt.
- **Not a constraint tracker.** Constraints are one input to external judgment.
- **Not an agent or unattended executor.** The external agent owns planning,
  code changes, and tool use. LoopForge governs round transitions.

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

```text
External agent
  -> structured evaluation
  -> evidence / verification / enforcement
  -> accept, reject, backtrack, or terminate
       reject / terminate: no round commit
       accept / stop / backtrack: commit transaction decision
  -> committed round documents        [factual source]
  -> CommittedRoundView                [shared read model]
       -> Replay                       [what happened]
       -> Audit / Metrics              [evidence and diagnostics]
       -> Canonical State              [cognitive source]
            -> DerivedCognitiveFacts
            -> prompt / state file / status
            -> external agent, next round
```

---

## Key capabilities

- Structured evaluation with strict core fields, lenient optional normalization,
  and retryable `evaluation_invalid` responses.
- One committed-round history for the compiler, contracts, gates, Replay,
  Audit, and Metrics.
- One Canonical State for prompts, the optional state file, and current-status
  cognition.
- Evidence-backed accept, reject, backtrack, and terminate decisions, including
  Round Contract and workspace-restore checks.
- L0, L1, and L2 prompt density, five-state sub-goals, constraint lifecycle,
  milestones, and agent-requested emphasis or confusion points.
- Separate Replay and Audit views. Replay answers what happened; Audit checks
  evidence and completeness.
- Durable sessions with atomic round documents, sequence checks, owned locks,
  renewable leases, pause, resume, and idempotent recovery.
- Nine MCP tools: `start`, `next`, `status`, `stop`, `pause`, `resume`, `replay`,
  `gate_check`, and `gate_resolve`.
- Zero runtime dependencies. Policy controls thresholds, budgets, and intervals.

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
