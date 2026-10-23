# LoopForge

LoopForge is durable round infrastructure for coding agents. It records which
rounds were committed, keeps machine observations with those records, and
prepares each next prompt from committed state. The external agent retains
control of task interpretation, planning, workspace changes, and recovery
choices.

The package runs as an MCP server or as a TypeScript library. It requires
Node.js 18 or newer and has zero runtime dependencies. The version in
`package.json` is the package version source.

For the product rationale and responsibility boundary, see the
[project README](../README.md) or [Chinese overview](../README.zh-CN.md).

## Install and connect

```bash
npm install -g loopforge
loopforge init --client claude
claude mcp add loopforge -- npx loopforge mcp
```

`loopforge init` supports `claude`, `codex`, and `generic` clients. The CLI
entry points are:

```text
loopforge mcp [--workspace DIR]
loopforge init --client claude|codex|generic [--target DIR] [--workspace DIR] [--force]
loopforge doctor [--json]
loopforge inspect LOOP_ID [--round N] [--prompt] [--json]
loopforge explain LOOP_ID [--round N] [--json]
```

`mcp` starts the synchronous JSON-RPC server over stdio. `doctor` checks local
readiness and configured evidence capabilities without running evidence
commands. `inspect` reads stored state, and `explain` shows why a committed
round received its disposition.

`--target` selects where the client skill is installed. `--workspace` selects
the runtime boundary for policy, storage, evidence commands, and workspace
checks. If omitted, the current directory is used.

## MCP workflow

The core loop is `loopforge_start` followed by `loopforge_next` for each held
round. Use the `roundId` from the latest response when submitting. A submission
is either an evaluation or an Agent-requested recovery, never both. Invalid
core fields can be corrected for the same round without committing that
attempt.

The four required evaluation fields are `success`, `output_summary`,
`constraint_violations`, and `should_continue`. They are the Agent's report,
not evidence. Optional fields let the Agent report events such as changed files,
discovered constraints, or contract item claims. LoopForge returns guidance
with the real references and currently applicable fields, plus a receipt that
distinguishes saved reports from derived effects and machine verification.
Optional fields are not a completion checklist.

The server also provides status, stop, pause, resume, and replay tools. Two gate
tools are available only when `policy.gate.enabled` is true. See the MCP tool
schemas for exact input and output shapes.

## Evidence and contracts

Configured observations and commands let LoopForge compare Agent reports with
machine-visible facts. Git observes the complete tracked and non-ignored
untracked workspace boundary. Explicitly configured commands run with an
executable and argument list, without a shell, and are restricted to the
workspace. Command evidence is disabled by default. Unavailable or unknown
observations remain unknown; they are not treated as a pass or an empty diff.

An Agent may propose a Round Contract for a bounded deliverable. Its acceptance
items bind to configured verification commands. LoopForge validates the
structure, references, bindings, and file boundary. An item becomes verified
when the Agent claims it is met and all bound commands pass in the closing
round with the declared binding intact. LoopForge does not judge whether the
deliverable or its tests are semantically appropriate.

## Recovery and durable history

The Agent may request recovery to an earlier committed evaluation on the
current branch. LoopForge validates that target and its observed Git restore
point, records a rollback directive, and checks the workspace against the
restore point before redo work can commit. LoopForge does not choose the target
or interpret the Agent's reason. Machine-triggered backtracks are also recorded
as directives. Redo uses a child branch; abandoned work remains auditable and
is excluded from the active branch history.

Committed typed round documents in the Vault are the factual source.
`CommittedRoundView` is the shared history read model, and `CanonicalLoopState`
is compiled from committed facts. Prompts, status views, replay, audit, explain,
and the optional state file are read or derived views. The state file is
regenerable and is not a second source of truth.

The prompt contains current governance facts rather than a replay of recent
Agent summaries or external memory. LoopForge does not execute the coding
task, automatically plan or decompose it, or guarantee task completion.

## TypeScript API

The package exposes these entry points:

```text
loopforge          engine, protocol, policy, storage, compiler, evidence, MCP
loopforge/compiler prompt compiler helpers
loopforge/replay   read-only ReplayBackend
loopforge/mcp      MCP server entry point
```

The main entry exports `createEngine`, `LoopForgeEngine`, `FileLoopStore`,
`compileLoop`, `ReplayBackend`, `McpServer`, `SessionManager`, and protocol
types. Type declarations are emitted in `dist/`.

```ts
import { createEngine, FileLoopStore, compileLoop } from "loopforge";
```

Use the generated declarations for exact signatures and input types.

## Policy and storage

Runtime policy is read from `loop_policy.json` in the selected workspace. A
missing file uses defaults; a present but invalid file is reported as
`policy_invalid`. Durable loop data is stored under `.loopforge/loops/`, with
regenerable state views under `.loopforge/state/`.

Evidence commands are explicitly configured and disabled by default. The
optional user gate is also disabled by default. `loopforge doctor` reports
policy validity, storage readiness, provider registration, command
configuration, and evidence posture; it does not execute commands.

## Development

Run from this directory:

```bash
npm run check
npm run build
npm test
npm run verify:artifacts
```

The build generates `../loopforge-protocol.json` and `dist/`. Edit protocol
types in `src/protocol.ts` first, then build to regenerate artifacts. Do not
edit generated files by hand.

## License

MIT
