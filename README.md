# LoopForge

**Durable round infrastructure for coding agents.**

Coding agents can reason and change code. Work that spans multiple turns also
needs continuity: which results were accepted, what the configured checks
observed, and where work can safely resume. LoopForge provides that continuity
around the agent's work.

LoopForge records accepted rounds, preserves machine observations, and prepares
the next prompt from committed state. The agent remains in control of the task:
it interprets the request, chooses an approach, changes the workspace, and
decides when to request recovery. LoopForge makes committed outcomes durable
and checks the boundaries around them.

[中文说明](./README.zh-CN.md) · [Package and integration guide](./loopforge/README.md)

## Why LoopForge

An agent conversation is not a reliable transaction log. It can contain work
that was never submitted, a rejected attempt, or changes later abandoned. A
summary of that conversation can blur the difference between committed work
and what remains uncertain.

LoopForge gives each round a durable outcome. Accepted work becomes typed,
committed history; rejected attempts do not. Machine observations are kept with
the round so later decisions can distinguish an agent's report from what the
configured checks observed. The next prompt is derived from committed facts,
not from a separate progress narrative maintained alongside them.

## How it works

```text
LoopForge prepares current committed context
                    |
                    v
Agent chooses and performs the work
                    |
                    v
Agent submits a result or requests recovery
                    |
                    v
LoopForge records observations and applies round rules
                    |
          commit, reject, or restore
                    |
                    v
Next prompt from the resulting committed state
```

An agent report describes what the agent believes happened. It is not proof by
itself. LoopForge compares reports with available observations, such as Git
workspace changes and explicitly configured verification commands. If an
observation is unavailable, LoopForge preserves that uncertainty instead of
treating it as a pass or as an empty change set.

For work that benefits from a bounded slice, the agent can propose a Round
Contract: a deliverable, acceptance conditions, and commands to check them.
LoopForge validates the structure and command bindings. An item is verified
when the agent claims it is met and its bound commands pass in the closing
round. Whether the proposed deliverable or test is semantically appropriate
remains the agent's and operator's judgment.

## Recovery with the agent in control

The agent may recognize that its current direction is wrong and request
recovery to a workspace checkpoint — the automatic before-image of a prepared
round or an explicit `loopforge_checkpoint` savepoint. LoopForge does not
diagnose the mistake or choose the destination. It resolves the checkpoint
through the branch's transaction refs, records the rollback as a durable event,
then restores the files and HEAD itself and verifies the complete Git boundary
before issuing the redo prompt.

LoopForge can also trigger a backtrack when a machine rule requires it. Both
paths use the same restore protocol and remain visible in history. Redo
continues on a child branch, preserving the abandoned work for audit without
treating it as current work.

## The responsibility boundary

The agent owns meaning and action: task interpretation, planning, tool use,
implementation, and the choice to request recovery. LoopForge owns continuity
and process guarantees: committed round history, machine observations,
deterministic validation and disposition, and checkpoint restore verification.

LoopForge exists to help the agent's own reasoning and course corrections
survive across rounds. It does not replace them with a fixed plan or a
harness-authored account of progress.

LoopForge does not execute the coding task, guarantee that a task is correct or
complete, or manage the agent's private conversation memory. Its prompt carries
current committed governance facts. The optional state file is a derived view,
not another source of truth.

## Install

```bash
npm install -g loopforge
loopforge init --client claude
claude mcp add loopforge -- npx loopforge mcp
```

LoopForge requires Node.js 18 or newer and has zero runtime dependencies. For
supported clients, CLI options, MCP tools, and the TypeScript API, see the
[package and integration guide](./loopforge/README.md). The package version is
defined by [`loopforge/package.json`](./loopforge/package.json).

## License

MIT
