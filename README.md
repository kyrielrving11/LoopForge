# LoopForge

**A context window is not memory. Memory needs a runtime.**

**Version per `LoopForge/package.json`** — `npm install -g loopforge`. Node.js ≥ 18. Zero runtime dependencies.
> [中文文档](./README.zh-CN.md)

---

## The real problems with long-horizon tasks

Any AI coding agent, given a long enough task, hits three walls. Not because
the model isn't smart enough. Not because the context window isn't large
enough. These are **architectural** problems.

### Problem 1: The summary cascade

Context fills up → compress. Fills up again → compress again. The third
compression is a summary of a summary of a summary. Every cycle evaporates
information — critical constraints get silently deleted because the summarizer
judged them "no longer relevant." Researchers found that after 3–4 summary
cycles, constraint violation rates spike from 0% to 59%. The agent doesn't
know what it forgot, because the forgetting itself was compressed away.

**This is what happens when you treat cognitive state as context. The bucket
always leaks.**

### Problem 2: Self-correction doesn't work

Google DeepMind's conclusion is clear: models cannot reliably improve
themselves through introspection. They talk themselves out of correct answers.
Effective recovery requires an **external verifier** — an independent observer
that doesn't share the agent's context, doesn't participate in its reasoning,
and only looks at inputs and outputs. The verifier must never be the same
context that made the mistake.

### Problem 3: Compound error (p^N)

If each step succeeds with probability p, N sequential steps succeed with
probability p^N. METR found that frontier agents nail nearly 100% of tasks
a human finishes in under 4 minutes, then crater to under 10% on tasks taking
more than 4 hours. Small errors at each step become the correct input for the
next step. The agent builds on errors, each step looking locally reasonable,
while the entire trajectory is fiction.

**These three problems amplify each other. The summary cascade loses
information → lost information becomes errors → the agent can't self-correct
because those errors look reasonable within its own context.**

---

## What LoopForge does about it

LoopForge runs outside the agent and owns the boundary between rounds. It
accepts a structured report, collects evidence, checks the report, decides
whether the round may commit, and recompiles the next prompt from committed
facts.

The runtime keeps two sources deliberately separate:

- **One factual source:** committed typed round documents in the Vault.
- **One cognitive source:** Canonical State compiled from those committed
  facts.

This separation prevents a presentation view, metric, or model narrative from
quietly becoming a second history.

### 1. One factual source

`loopforge_next` accepts a structured `evaluation`. Four core fields are
strict: `success`, `output_summary`, `constraint_violations`, and
`should_continue`. Optional fields are normalized by the runtime. Missing or
mistyped core fields return `evaluation_invalid`; the agent can correct the
payload and resubmit it with the same `roundId`. This path does not save the
session, write a round, run either gate, or change rejection and metrics state.

After validation, LoopForge collects Git and command evidence, runs the
verification and enforcement gates, and commits only an allowed round. The
committed round documents are the durable record. Rejected and in-flight
attempts do not join that record, and rolled-back backtrack decisions are
excluded from final history views.

All historical readers use the same internal `CommittedRoundView`. It decodes,
orders, deduplicates, and filters round documents once for Replay, Audit,
Metrics, contracts, compilation, and gate history. It is a read model, not a
second persistence format.

### 2. One cognitive source

The compiler evolves Canonical State from committed facts. Objectives,
constraints, evidence, milestones, sub-goals, decisions, and progress enter the
next prompt through this state, rather than through a summary of the previous
prompt.

`DerivedCognitiveFacts` derives focus, todo, phase, delegation, and handoff from
Canonical State and committed rounds. The prompt, optional state file, and
status projection consume the same facts. Deleting the state file loses no
truth because LoopForge can regenerate it.

Stable IDs (`c-`, `cr-`, and `sg-XXXXXXXX`) provide exact references where the
agent supplies them. Natural-language references still use policy-controlled
similarity matching as a fallback.

```text
Traditional: prompt -> summary -> next prompt -> another summary
LoopForge:    committed rounds -> Canonical State -> next prompt
```

### 3. External verification and enforcement

The verification gate organizes its checks into four verification domains —
evaluation consistency, evidence integrity, plan & contract conformance, and
progress & recovery — against Git snapshots, test output, and explicitly
configured commands. The enforcement gate turns those findings into accept,
reject, backtrack, or terminate decisions through one ordered strategy table
whose rows fall into four action classes: evidence contradiction, contract &
scope, plan drift, and progress recovery. A single success-evidence policy
covers unbacked success claims (a passed command or a declared
`no_change_reason` is the only backing), a single stall evaluator covers both
stalled and exactly-flat progress windows, and contract checks are framed as
declaration / execution / closure stages.

Round Contracts let a committed round propose bounded work for the next round.
The active contract is derived from committed history, remains active through
retry and resume, and closes only when its criteria are claimed complete or the
agent reports it blocked. Contract completion with a verification plan must be
backed by passing observations from that round.

Machine evidence can excuse a progress-stall verdict when Git motion is
observed. Self-reported progress cannot create a machine verdict or cancel one.

### 4. Recovery without rewriting history

A rejected submission keeps the same logical `roundId`, increments its attempt,
and commits no round. The agent receives a focused retry prompt.

A stalled-progress evaluator can backtrack to the last clean committed round.
LoopForge injects a diagnosis, identifies affected files, and verifies
workspace restoration on the next submission. Valid discoveries from skipped
rounds are preserved, while the rolled-back path stays out of final history.

Durable sessions, owned locks, renewable leases, and idempotent replay let the
agent resume after process interruption without skipping or double-committing
a round.

---

## What LoopForge is not

- **Not a memory database.** The optional state file is derived. Committed
  round documents hold facts, and Canonical State supplies runtime cognition.
  LoopForge has no RAG or vector database.
- **Not a context compressor.** It recompiles prompts from typed state instead
  of compressing the prior prompt.
- **Not a constraint tracker.** Constraints are one input to external
  verification and enforcement, not the product boundary.
- **Not an agent or unattended executor.** The external agent reads code,
  edits files, runs tools, and chooses its reasoning. LoopForge governs round
  transitions.

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
available as a library for custom integrations — see the
[API reference](./loopforge/README.md).

---

## Architecture

```text
External agent
  executes work and submits structured evaluation
                         |
                         v
Evaluation boundary
  strict core fields, lenient optional normalization
  invalid -> retry same roundId, no state mutation
                         |
                         v
Round boundary
  collect evidence -> verification gate -> enforcement gate
                         |
             +-----------+-----------+
             |                       |
      reject/terminate          accept/stop/backtrack
      no round commit            commit transaction decision
                                       |
                                       v
Committed round documents
  single durable factual source
                                       |
                                       v
CommittedRoundView
  one decoder and one history policy
                         |
              +----------+----------+
              |          |          |
       Canonical State  Replay   Audit / Metrics
       cognitive source timeline evidence / diagnostics
              |
              v
DerivedCognitiveFacts
  focus, todo, phase, delegation, handoff
              |
              v
PromptArtifact / state file / status projection
              |
              v
External agent, next round
```

The current-round gates also inspect the submitted evaluation and fresh
evidence before commit. Their historical inputs still come through the shared
committed-round view.

---

## Core capabilities

### Structured round protocol

The MCP boundary validates primitive JSON arguments and structured tool
outputs. The four required evaluation fields are strict, while optional
evaluation detail is normalized and bounded. Format errors are retryable and
cannot contaminate round state.

### Deterministic state reconstruction

The compiler reconstructs state from committed rounds. It tracks five-state
sub-goals, time-aware discovered constraints, phase milestones, evidence,
trust, and the active Round Contract without adding another persistence model.
L0, L1, and L2 select prompt density only. They do not prescribe a reasoning
technique.

### Evidence-backed decisions

Verification derives claim provenance and machine status from collected
snapshots. Enforcement turns those findings into accept, reject, backtrack, or
terminate decisions. Metrics remain diagnostic and never decide correctness,
gate outcomes, stop conditions, or contracts.

### Separate observation views

Replay answers what happened by exposing the committed timeline and round
diffs. Audit answers whether the final facts are complete and whether claims
have supporting evidence. Status projects the current cognitive state. These
interfaces stay separate because they answer different questions, but they
share the same committed-round decoder and filtering policy.

### Controlled recovery

Retries preserve the logical round identity. Backtrack restores the last clean
round, carries forward valid discoveries, and checks that the workspace matches
the restore target. Session documents, monotonic round sequences, atomic
writes, locks, and renewable leases protect restart and concurrency paths.

### Agent-owned execution

The external agent remains responsible for planning and tool use. It can ask
the compiler to emphasize known state or surface confusion points, but cannot
remove mandatory prompt sections or bypass the budget. LoopForge does not run
a background agent.

Nine MCP tools expose the runtime: `start`, `next`, `status`, `stop`, `pause`,
`resume`, `replay`, `gate_check`, and `gate_resolve`. The two gate tools are
opt-in — hidden from `tools/list` unless `policy.gate.enabled` is true (the
default is false). `status` provides `session`, `loop`, `all`, and `audit`
views. The package uses only the Node.js standard library at runtime, and
policy controls thresholds, budgets, and intervals.

---

## License

MIT
