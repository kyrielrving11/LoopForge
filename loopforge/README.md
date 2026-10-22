# LoopForge package

The `loopforge` package is the TypeScript runtime behind LoopForge. It keeps
round state durable, collects machine evidence, verifies submitted claims, and
compiles the next prompt. The external coding Agent still owns planning, file
changes, tool use, and execution.

For the product model and the contract mental model, read the
[root README](../README.md) or [中文说明](../README.zh-CN.md). This document is
the package and integration reference.

**Requirements:** Node.js >= 18. Zero runtime dependencies. The package version
is defined only by the `version` field in `package.json`.

## Install and run

```bash
npm install -g loopforge
loopforge init --client claude
claude mcp add loopforge -- npx loopforge mcp
```

The CLI provides the following entry points:

```text
loopforge mcp [--workspace DIR]
loopforge init --client claude|codex|generic [--target DIR] [--workspace DIR] [--force]
loopforge doctor [--json]
loopforge inspect LOOP_ID [--round N] [--prompt] [--json]
loopforge explain LOOP_ID [--round N] [--json]
```

`loopforge mcp` starts the synchronous MCP server. `init` installs the client
configuration, `doctor` reports local readiness, `inspect` reads persisted loop
state, and `explain` shows why a committed round received its disposition.

The two directory flags answer different questions and are not
interchangeable:

- `--target DIR` is where the **client skill** is installed
  (`DIR/forge/SKILL.md`). Without it, the skill goes to the client's own
  skills directory.
- `--workspace DIR` is the **runtime boundary**: `loop_policy.json`,
  `.loopforge/`, evidence commands, and every workspace check resolve against
  it. Without it, the current directory is used.

`loopforge mcp --workspace DIR` switches to that directory before the server
reads its policy or resolves its store root, which is why the policy it uses is
always the one in the workspace it was started against.

## MCP integration

The MCP server exposes nine tools:

- `loopforge_start` creates a session and returns the first prompt.
- `loopforge_next` submits the structured evaluation for the held round.
- `loopforge_status` returns session, loop, audit, or explain views.
- `loopforge_stop` intentionally stops a session.
- `loopforge_pause` pauses a session at a round boundary.
- `loopforge_resume` reconstructs a durable session.
- `loopforge_replay` reads the committed timeline and round diffs.
- `loopforge_gate_check` preflights a high-risk action.
- `loopforge_gate_resolve` records the decision for an opened user gate.

The two gate tools are opt-in through `policy.gate.enabled` and are hidden from
`tools/list` when disabled. A gate decision is an auditable process record. It
does not prove that a human was present because the Agent submits the resolve
call.

Every `loopforge_next` submission must include the four strict evaluation
fields: `success`, `output_summary`, `constraint_violations`, and
`should_continue`. `round_contract`, `subgoal_updates`, and
`execution_report.contract_item_claims` are also strict structural boundaries.
Malformed payloads return a retryable error for the same `roundId` without
writing session state, a round, gate records, rejection counters, or metrics.
Agent reports remain claims. Only independent observations can support a
verified fact.

Prepared responses carry `submission_guidance` with the real contract item and
sub-goal ids, real criterion ids/text, usable commands and the fields that apply
now. The prompt's evaluation block uses a compact trigger checklist rather than
a field catalog; omitting an optional field whose event did not happen remains
correct. Each submission returns `submission_receipt`, which separates saved
reports, derived-state effects and machine verification; a rejected attempt is
never shown as applied. `execution_report.files_changed` is the boundary net
change from round preparation, including deletions — a commit alone adds no
entry when content is unchanged. The receipt's `files_reconciliation` compares
the report with the derived round delta's `changedFiles`; raw observation
`files` is display data only. A missing or unobservable boundary is `null`,
never the dirty list and never an empty diff. A worker's
`discoveredConstraints` stays a report; only top-level `discovered_constraints`
promotes it into the active set. Unknown or retired optional fields are
diagnosed and dropped, never silently accepted; field metrics separate
attempted from retained values. A success claim with an empty report is a
reporting gap (warn), not an acceptance gate.

## TypeScript API

The package exports the runtime in separate entry points:

```text
loopforge          protocol types, policy, store, compiler, engine, evidence,
                   transactions, metrics, and MCP classes
loopforge/compiler compiler helpers
loopforge/replay   ReplayBackend
loopforge/mcp      MCP server entry point
```

The main exports include `createEngine` and `LoopForgeEngine` for an in-process
engine, `FileLoopStore` for durable JSON storage, `compileLoop` for compiling a
prompt from committed facts, `ReplayBackend` for read-only history queries,
`McpServer` for the MCP transport, and `SessionManager` for durable MCP
sessions. Type declarations are emitted alongside the runtime in `dist/`.

Example import:

```ts
import { createEngine, FileLoopStore, compileLoop } from "loopforge";
```

Use the generated `.d.ts` files in `dist/` for the exact signatures and input
types. The public protocol constructors and types are exported from the main
entry point.

## Persistence and policy

LoopForge stores durable loop data under `.loopforge/loops/` and derived human
state under `.loopforge/state/`. Committed typed round documents are the source
of truth. The state file can be regenerated and must not be treated as a second
history.

The prompt is a current-governance projection, not a replay of the Agent's own
progress summaries. `output_summary` remains a committed report for audit,
replay, explain and backtrack diagnosis; full history is read on demand from the
derived state file or the read-only views.

Machine progress is provider-neutral. Git keeps its complete-boundary/HEAD/
restore-point rule; a configured custom provider opts in by persisting a
versioned fingerprint snapshot (`data.progressCapable` + `data.progress`).
Command observations are verification evidence, not progress. Stall requires
the committed window and the submitted round to be proven unchanged; unknown
and not-applicable never stall.

Runtime behavior is controlled by `loop_policy.json`, read from the workspace
the process was started in. Evidence commands are explicitly configured, run
without a shell, and restricted to the workspace. The default policy keeps the
optional user gate disabled.

A **missing** policy file is normal: the defaults apply. A file that exists but
cannot be read or parsed is reported as `policy_invalid` with its path rather
than silently ignored — a configuration nobody chose must not look like a
working one. `loopforge doctor` reports the policy, the store root, provider
registration, every configured command's static validity, and the current
evidence posture; it never executes a command.

## Development

Run these commands from this directory:

```bash
npm run check
npm run build
npm test
npm pack --dry-run --json
npm run verify:artifacts
git diff --check
```

The build generates `../loopforge-protocol.json` and `dist/`. Change protocol
types in `src/protocol.ts` first, then run the build. Do not edit generated
artifacts by hand.

## License

MIT
