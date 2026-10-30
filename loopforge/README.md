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

`--target` selects where the Forge skill directory is installed. `--workspace`
selects the runtime boundary for policy, storage, evidence commands, and
workspace checks. If omitted, the current directory is used. A normal `init`
leaves an existing Forge skill untouched; if the installed files differ from
the packaged skill (for example after an upgrade), `init` reports `Stale:` and
`loopforge doctor` warns, but neither overwrites your tree. `--force` replaces
the package-owned skill tree (including its `references/` files).

## MCP workflow

The core loop is `loopforge_start` followed by `loopforge_next` for each held
round. Every response that holds a round returns a `submissionHandle` and the
durable `loopId`; keep both. Pass the handle unchanged to `loopforge_next`,
`loopforge_checkpoint`, and `loopforge_gate_check`. Never edit or reconstruct
it. A rejection keeps the logical round but returns a new handle; an invalid
evaluation keeps the same handle. A stale handle never submits work: if only the
handle was lost while the current prompt is still in context, re-anchor it with
`loopforge_status` using the live `sessionId` or durable `loopId`; if the prompt
was also lost, or status reports no live session or no current handle, use
`loopforge_resume` with the `loopId`. After a process restart,
`loopforge_resume` requires the `loopId` (not `sessionId`).
A submission is either an evaluation or an Agent-requested recovery, never
both. Invalid core fields can be corrected for the same round without
committing that attempt.

Every returned prompt declares its derived context strategy in the header.
`fresh_invocation` is clean context: a new Agent invocation without the previous
transcript, used for the first round, the next round, recovery redo, or repeated
same-check rejection escalation. It may describe the SAME logical round.
`same_round_retry` (in-context repair) continues the original invocation with
the failure lessons injected. Prompt density and context boundary are independent; use the
returned `contextMode` and `contextReason` at any L0/L1/L2 density. Clean context
is not a workspace reset: the current modified workspace and the loop identity
continue; only recovery restores a checkpoint.

Round results keep three kinds of facts separate: the **Agent report**
(`success_claim`, `outcome`, `agent_stop_reason`), the **LoopForge decision**
(`action`, `loop_stop_reason`, `enforcement_reason`), and the persisted
**Machine evidence** (the round's `evidencePosture`). Explain, a terminal
`stopDetail` and `resume` of a stopped loop render the same blocks. `completed`
means the Agent's stop declaration passed the gates; it does not imply
machine-backed success. `agent_stop_reason` is the Agent's report, never a loop
terminal reason.

A clean-context prompt carries compact Machine Evidence (the previous committed
round's evidence posture: workspace/change counts, provider and command
statuses, contract item statuses, and stable finding ids) plus bounded Working
Memory compiled from committed reports, assumptions, open questions, consumed
recoveries, and contract redirects. Machine Evidence is protected and informs
verification. Working Memory is optional, indivisible, and may be dropped whole
if the prompt budget cannot fit it; the artifact records whether it rendered
and its source/rendered/omitted counts. L1 and L2 include the same full fixed
Working Memory projection, while L0 remains compact. The default prompt
ceilings are 5,000 / 50,000 / 100,000 characters for L0 / L1 / L2. They are
safety ceilings, not targets for routine memory omission. Working Memory is
derived from the canonical state, never a second history, and does not feed a
gate. Older history is available through `loopforge_replay` (`start`/`end`;
default last 10 committed positions, at most 50 in an explicit window) and
`loopforge_status view: "explain"`.

The four required evaluation fields are `success`, `output_summary`,
`constraint_violations`, and `should_continue`. They are the Agent's report,
not evidence. Optional fields let the Agent report events such as changed files,
discovered constraints, or contract item claims. `subtask_boundary` /
`subtask_boundary_label` declare an L2 rehydration boundary; they are not a
workspace checkpoint. LoopForge returns guidance with the real references and
currently applicable fields, plus a receipt that distinguishes saved reports
from derived effects and machine verification. Read surfaces use
`agentSuccessClaim`/`agentOutcome` for the Agent's claim and
`evidencePosture`/`machineBackedSuccess` for machine facts; they are never
merged. Optional fields are not a completion checklist.

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
structure, references, and bindings; the Agent's optional `scope` is a
report-only intent statement (drift is an info fact, not a rejection). An item
becomes verified when the Agent claims it is met and all bound commands pass in
the closing round with the declared binding intact. A command disabled or
reconfigured later does not rewrite that historical observation; a claim is
never upgraded by Agent-reported test counts. LoopForge does not judge whether
the deliverable or its tests are semantically appropriate.

If the active slice is no longer the right route, the Agent can submit an
explicit `contract_transition` (kind `supersede`, the exact active `rc-*` id,
and a successor `round_contract` whose acceptance items actually change). The
old contract closes as `superseded`; its item statuses remain in audit/explain,
the workspace is not restored, and the redirect round cannot be `completed`.
A stale target, missing successor, blocked declaration, stop, or unchanged
items is `contract_invalid`.

Progress is a Git workspace fact with an explicit coverage range. The stall rule
and prompt freshness consume only that fixed coverage. A custom observation is
an ordinary report: it is shown in replay and explain as raw observation data,
but it cannot supply a progress fact or affect stall, freshness, or any other
decision.

## Recovery and durable history

The Agent may request recovery to a workspace checkpoint: the automatic
before-image of a prepared round or an explicit mid-round savepoint created with
`loopforge_checkpoint`. LoopForge resolves the checkpoint through the current
branch's transaction refs, records a rollback directive, then executes and
verifies the restore itself against the manifest's complete Git boundary and
recorded HEAD. Only after verification does it issue the redo prompt; a failed
restore leaves the directive pending and the session resumable. LoopForge does
not choose the target or interpret the Agent's reason. Machine-triggered
backtracks use the same restore protocol. Redo uses a child branch and is
excluded from the active branch history. The directive preserves the abandoned
approaches, wrong assumptions, machine-observed vs Agent-reported skipped
files, compact trigger findings and the Recovery Brief; the Brief states the
real restore marker (or `restore NOT verified`). A same-round redo replaces
that numeric round's feedback slot, so the abandoned evaluation is not retained
as a second copy. Explain, replay, audit and the receipt expose the committed
checkpoints/restore marker and the directive digest.

Committed typed round documents in the Vault are the factual source.
`CommittedRoundView` is the shared history read model, and `CanonicalLoopState`
is compiled from committed facts. Prompts, status views, replay, audit, explain,
and the optional state file are read or derived views. The state file is
regenerable and is not a second source of truth.

The prompt contains current governance facts, compact Machine Evidence, and a
bounded Agent-report Working Memory. It is not a replay of external memory or
an unbounded conversation summary. LoopForge does not execute the coding task,
automatically plan or decompose it, or guarantee task completion.

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
