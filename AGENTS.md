# LoopForge

LoopForge is a cognitive state runtime for external AI coding Agents. It keeps
objectives, constraints, evidence, decisions, and recovery state stable across
Agent-driven rounds. It does not provide a model or unattended executor.

## Project rules

- TypeScript only.
- Node.js 18 or newer.
- Zero runtime dependencies.
- The npm package is in `LoopForge/` and is currently `2.0.0-rc.1`.
- Preserve user changes in a dirty worktree.
- Edit `src/protocol.ts`, then run the build to regenerate
  `loopforge-protocol.json`.
- Do not restore MCP Tasks, prompt-technique routing, automatic memory discovery,
  PromptCraft vault writes, or Markdown lineage fallback.

## Commands

```bash
cd LoopForge
npm run check
npm run build
npm test
npm pack --dry-run --json
```

Run the full test suite in a temporary mirror when generated files in the active
worktree must remain untouched.

## Current architecture

```text
LoopForge/src/
  canonical-state.ts    CanonicalLoopState and deterministic hashing
  prompt-policy.ts      L0/L1/L2 view selection
  prompt-assembler.ts   Single-pass PromptArtifact renderer
  loop-compiler.ts      State evolution and prompt compilation
  engine.ts             Engine state, feedback, and lineage projection
  round-driver.ts       Shared Runtime and MCP round preparation/completion
  round-transaction.ts  Stable round ID, attempts, evidence, commit recovery
  round-coordinator.ts  Verify, enforce, and stop decision pipeline
  verification-gate.ts  Cross-round and evidence consistency checks
  enforcement-gate.ts   Accept, reject, or terminate rules
  loop-store.ts         Typed, atomic per-loop JSON persistence and migration
  evidence-provider.ts  Git, custom async, and explicit command evidence
  runtime.ts            Event-driven Agent executor wrapper
  replay.ts             Typed round timeline and diff queries
  policy.ts             Runtime policy and safe derived state-file writes
  observability.ts      Structured tracing
  policy-metrics.ts     Verification and round outcome metrics
  interop.ts            Portable cognitive checkpoints
  cli.ts                Unified loopforge command
  mcp/
    session.ts          Durable leased MCP sessions
    tools.ts            Nine validated tools and output schemas
    server.ts           Synchronous JSON-RPC stdio server
```

## Invariants

- One canonical state produces one PromptArtifact per attempt.
- L0, L1, and L2 control state density, not reasoning technique.
- Rejection keeps the logical round ID, increments attempt, and commits nothing.
- Runtime and MCP use the same RoundDriver and round transaction path.
- Typed JSON session and round documents are the durable truth.
- `.loopforge/state/<loopId>-state.md` is an optional derived view.
- Session and round writes are atomic and protected by owned locks.
- MCP mutations are serialized per session and fenced by renewable leases.
- The external Agent owns long-running work. LoopForge does not implement MCP
  Tasks or a background Agent.
- Context providers, terminal sinks, trace sinks, and checkpoint sinks are
  explicit. Never auto-discover integrations.
- Command evidence is disabled by default, uses executable plus args with
  `shell: false`, and may only run inside the workspace.
- A required command failure contradicts a success claim before commit.

## Storage layout

```text
.loopforge/
  loops/<sha256(loopId)>/
    metadata.json
    session.json
    rounds/<round>.json
  state/<loopId>-state.md
  migrations/
```

Legacy `.promptcraft/prompt_vault.json` is read only by the explicit migration
command. Migration must not delete the source.

## CLI

```bash
loopforge mcp
loopforge init --client claude|codex|generic [--target DIR] [--force]
loopforge doctor [--json]
loopforge inspect LOOP_ID [--round N] [--prompt] [--json]
loopforge migrate [--from PATH] [--json]
```

## Before changing a hotspot

- Prompt changes require PromptArtifact budget, hashing, and same-round retry
  coverage.
- Transaction changes require reject, commit replay, concurrent next, pause,
  stop, and restart tests.
- Store changes require prefix isolation, live and stale lock ownership,
  migration idempotence, and cross-process lease tests.
- Evidence changes require timeout, abort, unavailable provider, output cap,
  workspace boundary, and verification contradiction tests.
- MCP changes require primitive JSON, strict arguments, structured output, and
  process-level stdio tests.
