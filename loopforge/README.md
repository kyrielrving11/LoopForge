# LoopForge package

LoopForge v3 is a zero-runtime-dependency TypeScript runtime for governing
long-horizon AI coding tasks. It persists approved objectives, constraints,
structured plans, approvals, evidence, round transactions, and recovery state
while an external Agent remains the execution owner.

It does not provide a model, background Agent, MCP Tasks, automatic memory
discovery, or code-level autonomous planning.

## Install

```bash
npm install -g loopforge
loopforge init --client codex
loopforge init --client codex --register
```

Use `--client claude` for Claude Code. Without `--register`, init only installs
the `$loopforge` skill and prints the absolute-path registration command.

## Default workflow

```text
loopforge_start(workspaceRoot, ...)
  -> planning prompt
loopforge_plan_submit
  -> executing Round 1 or awaiting_approval
loopforge_plan_approve
  -> executing Round 1
loopforge_next(sessionId, roundId, report)
  -> same-step continuation, retry, next step, refinement, audit, or terminal
```

There is no direct-execution compatibility mode. Pre-release schema 1 or
2, or missing-workflow sessions remain unchanged on disk, are reported as
incompatible, and cannot be resumed by v3.

The first submitted plan is the global topology. It contains the objective,
constraints, criteria, real dependencies, and outline phases. Later updates
refine that same versioned plan instead of creating separate phase plans. New
executable children identify their source outline with `refinesStepId`;
`dependsOn` is only for real artifact, decision, gate, or resource flow.

## Commands

```bash
loopforge mcp [--workspace DIR] [--store-dir DIR]
loopforge init --client claude|codex|generic [--target DIR] [--register] [--force]
loopforge doctor [--workspace DIR] [--store-dir DIR] [--client claude|codex] [--workflow] [--json]
loopforge inspect LOOP_ID [--workspace DIR] [--store-dir DIR] [--round N] [--prompt] [--json]
loopforge migrate [--workspace DIR] [--store-dir DIR] [--from PATH] [--json]
```

## MCP contract

The server exposes 12 tools: start, three plan tools, next, status, stop,
pause, list, replay, resume, and health. Advancing responses include `phase`,
`requiredAction`, `terminal`, `planVersion`, `activeStepId`, `roundId`, and
`prompt`.

Approval policy is session-scoped. `risk_only` is the default: low-risk plan
revisions and outline refinements continue automatically, while fixed
high-risk tags always require user approval. Set
`workflow.approval_policy: "every_revision"` in `loop_policy.json`, or pass
`approvalPolicy: "every_revision"` to `loopforge_start`, to review every plan
version. The selected policy is persisted with the session.

`loopforge_next` accepts only the exact returned `roundId` and a compact
`RoundReportV1`. Completed steps must prove every `ac-*` and `er-*` claim. The
final audit must prove every `cr-*` claim and required command. Completion is
only possible from the audit phase.

Verification establishes evidence provenance, consistency, constraint
compliance, and workflow closure; it does not establish domain-level semantic
correctness. Git evidence verifies reported file identity and content state,
not behavior. Agent-claimed checks cannot complete an audit without runtime
provenance, while required commands and `ro-*` obligations always require
runtime-verified passing checks.

Each non-L0 prompt receives a bounded active-step graph slice. Replay exposes
the deterministic read-only governance graph and diagnostics. Neither surface
executes nodes, schedules Agents, or persists a second truth.

Start and resume return `capabilityPreflight`, including server/report
versions, tool count, workspace/Store state, and current Git/command evidence
capability. A blocked external gate can be resumed with an exact
`gateResolution`; a plan update cannot forge gate completion.

Workspace-configured command evidence is host-authorized. It remains blocked
unless the MCP host explicitly sets `LOOPFORGE_ALLOW_WORKSPACE_COMMANDS=1`.
When blocked, no configured workspace subprocess is launched and preflight
reports `commandEvidence: "blocked"`.

## Library exports

```ts
import {
  LOOPFORGE_VERSION,
  stableClaimId,
  validatePlan,
  validateRoundReport,
  type RoundReportV1,
  type StructuredPlan,
  type WorkflowProgress,
} from "loopforge";
```

The root package intentionally does not export Engine, Compiler,
SessionManager, or normalized internal evaluation types.
Supported subpaths are `loopforge/mcp` and `loopforge/replay`; there is no
`loopforge/compiler` export.

## Persistence

Schema 3 typed JSON session and round documents under `.loopforge/loops/` are
the durable truth. Plan versions, refinement lineage, approvals, outcomes, and
evidence relations are reconstructed from typed workflow events. The read-only
governance graph is derived from those documents; it is not a second Store or
an executor. `.loopforge/state/*-state.md` is an optional derived view and is
 never a recovery source.

New sessions use the minimal planning profile by default: the durable plan
fixes the objective and constraints while exposing only the next one to three
ready nodes. Later outlines are refined at a boundary; the full profile is
available when a complete known topology is important. Verified evidence
checks may derive `ro-*` regression obligations, rebuilt from events and round
evidence and enforced again by later steps and final audit.

Material advancement is evidence-based. A changed Git fingerprint, improved
check, new verified claim, structured discovery, or step transition counts;
repeated summaries, unchanged dirty paths, and `noChangeReason` alone do not.
The default stall window is three accepted `in_progress` rounds and is
controlled by `evolution.progress_stall_rounds`.

Command evidence is disabled by default, uses an executable plus argument
array with `shell: false`, and cannot run outside the bound workspace.

## Development

```bash
npm run check
npm test
npm run build
npm pack --dry-run --json
git diff --exit-code -- dist ../loopforge-protocol.json
```

The generated public protocol schema comes from `src/protocol.ts`; do not edit
it by hand.

## License

MIT
