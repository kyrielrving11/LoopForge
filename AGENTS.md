# LoopForge

LoopForge is an external state, constraint, plan-execution, and evidence
governance runtime for long-horizon AI coding tasks. It does not provide a
model, background Agent, unattended executor, or code-level planner.

## Product boundary

The external Agent reads code, makes engineering decisions, edits files, runs
tests, and communicates with the user. LoopForge owns:

```text
objective and hard constraints
-> versioned plan and risk approval
-> one active step and fenced round
-> normalized evidence and verification
-> retry, refinement, backtrack, or next step
-> final audit and terminal state
```

Prompts are recompiled from typed state so context compression does not create
a summary-of-summary chain. LoopForge verifies Agent reports against runtime
evidence and stops or backtracks before repeated errors compound.

## Project rules

- TypeScript only; Node.js 18 or newer.
- The npm package is in `loopforge/` and remains `3.0.0` until release.
- Zero runtime dependencies.
- Preserve user changes in a dirty worktree.
- Edit `loopforge/src/protocol.ts`, then build to regenerate
  `loopforge-protocol.json`.
- Typed JSON session and round documents are durable truth. Markdown state is
  a rebuildable projection only.
- Do not restore v2 session compatibility, `legacy_execution`, direct
  execution mode, embedded evaluation blocks, MCP Tasks, prompt-technique
  routing, automatic memory discovery, PromptCraft writes, or Markdown
  fallback.
- `loopforge migrate` may only import an explicitly requested PromptCraft
  vault. It must not upgrade sessions or delete the source.
- Do not add telemetry, external services, background execution, or another
  persistence database.

## Current architecture

```text
loopforge/src/
  protocol.ts           Internal and supported v3 protocol types
  plan.ts               Plan DAG, validation, risk, refinement, progress
  round-report.ts       Strict RoundReportV1 parsing and evidence normalization
  canonical-state.ts    Prompt/state projection and deterministic hashing
  prompt-policy.ts      L0/L1/L2 state-density selection
  prompt-assembler.ts   Single-pass PromptArtifact rendering
  loop-compiler.ts      Five prompt modes and typed state compilation
  verification-gate.ts Evidence and cross-round checks
  enforcement-gate.ts  Accept, reject, backtrack, or terminate
  round-coordinator.ts  Verification/enforcement/stop pipeline
  round-transaction.ts Schema 3 transaction, retry, commit, crash replay
  round-driver.ts       Shared prompt preparation and round completion
  engine.ts             Internal lineage and normalized feedback persistence
  loop-store.ts         Schema 3 typed JSON storage and PromptCraft import
  workspace-runtime.ts Workspace/store identity and recovery locator
  evidence-provider.ts Git, command, and explicit async evidence
  policy.ts             Runtime policy and Markdown projection writes
  replay.ts             Read-only timeline and governance graph replay
  workflow-events.ts    Typed workflow event decoder and deterministic IDs
  governance-graph.ts   Derived plan/execution/evidence graph and slices
  cli.ts                Unified CLI
  mcp/session.ts        Workflow reducer, durable sessions, leases, recovery
  mcp/tools.ts          Twelve strict MCP tools
  mcp/server.ts         JSON-RPC stdio server
```

The only supported execution chain is:

```text
RoundReportV1
-> NormalizedRoundEvaluation
-> verification/enforcement
-> schema 3 transaction commit
-> workflow events
-> next PromptArtifact
```

`NormalizedRoundEvaluation`, Engine, Compiler, and SessionManager are internal.
The root package exports version information, supported plan/report/workflow
types, pure validators, stable claim-ID helpers, and replay. Supported package
subpaths are `loopforge/mcp` and `loopforge/replay`.

## Invariants

- One canonical state produces one PromptArtifact per attempt.
- Planning does not consume an engineering round.
- A rejected attempt keeps the logical `roundId`, increments attempt, and
  commits nothing.
- One execution round has one server-derived `activeStepId`.
- A completed step must prove all `ac-*` and `er-*` claims.
- Only an auditing `completed` report with all `cr-*` claims and required
  commands can complete the loop.
- Evidence verification establishes provenance, consistency, constraint
  compliance, and workflow closure; it does not prove domain-level semantic
  correctness. Git evidence proves file identity/content state, not behavior.
- Failed investigations count as material advancement only when they add a
  structured discovery. Repeated summaries, unchanged dirty paths, and
  `noChangeReason` alone do not advance the stall window.
- Plan changes use a full replacement, exact `baseVersion`, and server diff.
  Completed steps are immutable.
- The initial plan is the global topology. Later versions refine its outline
  nodes through server-validated `refinesStepId` lineage; `dependsOn` records
  real work-product dependencies, not presentation order.
- New sessions default to the `minimal` planning profile: commit the durable
  objective, constraints, success criteria, and only the next 1-3 ready nodes;
  use `full` when the complete known topology is required. Plan replacements
  are classified as `none`, `tactical`, `contract`, or `risk` by the server.
- Verified evidence checks from accepted steps may derive `ro-*` regression
  obligations. Later completions and final audit must keep them passing; the
  obligations are rebuilt from typed events and evidence, not stored separately.
- Governance graphs and graph slices are deterministic projections of typed
  plans, events, rounds, and evidence. They are never persisted as a second
  truth and never execute or schedule nodes.
- High-risk plan versions require exact `approvalId` and `planVersion`.
- Backtrack restores the effective plan version and step outcomes at the clean
  round, discards skipped commits, and preserves independently valid
  discoveries.
- Session and round writes are atomic. MCP mutations are serialized per
  session and fenced by renewable leases.
- Command evidence is disabled by default, uses `shell: false`, and stays
  inside the bound workspace.
- The external Agent owns long-running work. LoopForge never owns a background
  task.

## Compatibility policy

This is the first public release. Session and round schema version is 3.
Schema 1, missing-workflow, or otherwise pre-release sessions remain unchanged
on disk, are listed under `incompatibleSessions`, and cannot be resumed. Do not
add automatic session migration or a compatibility execution path.

The non-authoritative Store locator records workspace/Store identity only. It
does not record loop IDs, prompts, constraints, plans, or evidence, and it does
not scan the disk.

## Before changing a hotspot

- Prompt changes require budget, hash, five-mode, compression recovery, and
  same-round retry coverage.
- Transaction changes require reject, retry, commit replay, pause, stop,
  concurrent next, restart, lease, and backtrack coverage.
- Store changes require schema 3 validation, schema 1/2 rejection, prefix
  isolation, lock ownership, incomplete-store detection, and byte-preservation
  tests for unsupported sessions.
- Evidence changes require timeout, abort, unavailable provider, output cap,
  workspace boundary, contradiction, and required-command tests.
- MCP changes require primitive JSON rejection, strict nested arguments,
  structured output, 12-tool count, schema budgets, and process-level stdio
  tests.
- Plan changes require ID uniqueness, dependency existence, DAG acyclicity,
  criterion coverage, horizon/refinement, stale version, completed-step
  immutability, and risk approval tests.
- Governance graph changes require deterministic replay, malformed-event,
  evidence provenance, refinement lineage, through-round, and prompt-budget
  coverage.

## Commands

```powershell
cd loopforge
npm.cmd run check
npm.cmd test
npm.cmd run build
npm.cmd pack --dry-run --json
git diff --exit-code -- dist ../loopforge-protocol.json
```

Run the full test suite in a temporary mirror when generated files in the
active worktree must remain untouched.
