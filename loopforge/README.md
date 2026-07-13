# LoopForge

LoopForge is a cognitive state runtime for AI coding agents. It keeps a task's
objective, constraints, evidence, decisions, progress, and recovery state stable
across many Agent-driven rounds.

The Agent still reads code, edits files, runs tools, and decides how to reason.
LoopForge does not provide a model, scheduler, or unattended worker. Its job is
to make a long task resumable and auditable without letting the prompt become the
only copy of the state.

LoopForge 2.0 is currently available as `2.0.0-rc.1`. It requires Node.js 18 or
newer and has no runtime dependencies.

## Install

```bash
npm install -g loopforge@next
loopforge init --client claude
claude mcp add loopforge -- npx loopforge mcp
```

For Codex:

```bash
loopforge init --client codex
codex mcp add loopforge -- npx loopforge mcp
```

For another MCP client:

```bash
loopforge init --client generic
```

The generic command prints an MCP configuration fragment and installs the
Perception skill under `.loopforge/skills/` unless `--target` is supplied.

## How a loop works

1. The Agent calls `loopforge_start` with the task and hard constraints.
2. LoopForge compiles one prompt from the canonical state.
3. The Agent executes that prompt and submits a structured evaluation through
   `loopforge_next`.
4. LoopForge captures evidence, verifies the evaluation, enforces the round
   boundary, and either commits, rejects, or stops the round.
5. If work remains, the next prompt is compiled from the committed state.

A rejected attempt keeps the same logical round ID, increments its attempt
number, and commits no feedback. A process restart can recover the current prompt
and the last committed decision without advancing the round twice.

## Prompt views

LoopForge renders exactly one prompt artifact for each attempt. L0, L1, and L2
describe how much state is included, not which reasoning method the Agent must
use.

| Level | Use |
| --- | --- |
| L0 | Same-round retry with the rejection reason and changed evidence |
| L1 | Normal continuation with a compact state capsule |
| L2 | First round, checkpoint, goal change, or full state rehydration |

Every artifact records its state hash, prompt hash, level reasons, included
sections, character budget, round ID, and attempt number.

## Durable storage

Typed JSON documents are stored by loop under:

```text
.loopforge/
  loops/<sha256(loopId)>/
    metadata.json
    session.json
    rounds/<round>.json
  state/<loopId>-state.md
```

The JSON session and round documents are the durable transaction truth. The
Markdown state file is a human-readable derived view and may be disabled with
`state_file.enabled`.

To import a pre-2.0 vault without deleting it:

```bash
loopforge migrate
loopforge migrate --from path/to/prompt_vault.json --json
```

The migration is idempotent and writes a marker under `.loopforge/migrations/`.

## MCP tools

The stdio server exposes synchronous Agent-driven tools:

- `loopforge_start`
- `loopforge_next`
- `loopforge_status`
- `loopforge_pause`
- `loopforge_resume`
- `loopforge_stop`
- `loopforge_list`
- `loopforge_replay`
- `loopforge_health`

Tool results include `structuredContent` and a serialized text block for older
clients. LoopForge intentionally does not implement MCP Tasks. Long-running work
belongs to the Agent that is already executing the user's task.

Running sessions use renewable leases so two MCP processes cannot advance the
same loop at once. Paused and running sessions can be reconstructed from the
typed store after a restart.

## Command evidence

Git evidence is enabled by default. Verification commands are explicit and
disabled unless added to `loop_policy.json`:

```json
{
  "evidence": {
    "providers": ["git"],
    "timeout_ms": 120000,
    "commands": [
      {
        "name": "tests",
        "enabled": true,
        "executable": "npm",
        "args": ["test"],
        "cwd": ".",
        "phase": "after",
        "required": true,
        "timeout_ms": 120000,
        "max_output_chars": 20000,
        "success_exit_codes": [0]
      }
    ]
  }
}
```

Commands run with `shell: false`. Their working directory must resolve inside
the workspace. Output is capped at 20,000 characters and timeouts abort the
child process. If an Agent claims success while a required command fails, times
out, is missing, or has an invalid working directory, the verification verdict
is `contradicted`.

## CLI

```bash
loopforge mcp
loopforge init --client claude|codex|generic [--target DIR] [--force]
loopforge doctor [--json]
loopforge inspect LOOP_ID [--round N] [--prompt] [--json]
loopforge migrate [--from PATH] [--json]
```

`inspect` hides full prompts unless `--prompt` is present. `doctor` checks the
Node version, store permissions, Git availability, and configured command
evidence paths without running verification commands.

## Library API

```typescript
import { run } from "loopforge";

const result = await run({
  task: "Audit this repository and fix confirmed defects",
  constraintsFromPlan: ["Do not change the public API"],
  execute: async (prompt, context) => {
    return agent.execute(prompt, { signal: context.signal });
  },
});
```

For an embedding that already owns long-term context or telemetry, use explicit
hooks instead of auto-discovery:

```typescript
const result = await run({
  task,
  execute,
  contextProvider: async ({ loopId, round, lastEvaluation }) => {
    return myContextStore.read({ loopId, round, lastEvaluation });
  },
  terminalSinks: [async (event) => myTelemetry.record(event)],
});
```

Custom evidence providers, trace sinks, checkpoint sinks, and `LoopStore`
implementations remain dependency-free extension points.

## Development

```bash
npm run check
npm test
npm pack --dry-run --json
```

The schema in `../loopforge-protocol.json` is generated from `src/protocol.ts`.
Do not edit it by hand.

## 2.0 compatibility boundary

The 2.0 release removes the prompt-technique catalog, strategy heuristics, MCP
Tasks, automatic memory discovery, global PromptCraft vaults, Markdown lineage
fallbacks, `Technique` and `Analysis` wire fields, and the `loopforge-mcp`
binary. Use `loopforge mcp`, the typed `FileLoopStore`, and explicit providers.

## License

MIT
