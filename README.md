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

Each prompt carries a derived context strategy. `fresh_invocation` is clean
context: the host starts a new Agent invocation, so the previous transcript,
tool logs and uncommitted reasoning do not leak into the next round. It is used
for the first round, a normal next round, a recovery redo, or repeated
same-check rejection escalation, and it may describe the SAME logical round. Clean
context is not a workspace reset; only rollback/recovery restores a checkpoint.
`same_round_retry` is in-context repair: it continues the
original invocation and injects the rejection notice, findings and failure
reason. A `rejection_escalation` retry is clean-context repair: a new invocation
that still carries those failure lessons. Prompt density and context boundary
are independent; follow the returned `contextMode` and `contextReason`, rather
than inferring the boundary from L0, L1, or L2.

Round results keep three kinds of facts separate: the Agent report
(`agent_stop_reason` among its claims), the LoopForge decision
(`loop_stop_reason`), and the persisted Machine evidence. Explain, terminal
stop output and `resume` of a stopped loop render the same three blocks;
`completed` never implies machine-backed success.

Continuity may include bounded Working Memory derived from the current branch's
committed rounds and rollback directives: recent reports, falsified assumptions
and retractions, open questions, consumed recoveries and contract redirects.
Its source window and per-item limits are fixed code constants, not policy.
L1 and L2 render the same full fixed projection; L0 stays compact. The default
prompt ceilings are 5,000 characters for L0, 50,000 for L1 and 100,000 for L2.
These are safety ceilings, not targets for routine memory omission. Working
Memory is one indivisible optional section, so it can be dropped whole if the
prompt cannot fit it; the prompt artifact records that omission and its counts.
It is part of the one canonical cognitive state, never a second history or
memory store, and Agent-reported entries never enter a verification gate.
Machine Evidence (observed providers, command statuses and verified contract
items) is a separate protected section and informs verification. Older history
is retrieved explicitly with `loopforge_replay` or `loopforge_status view:
\"explain\"`.

For work that benefits from a bounded slice, the agent can propose a Round
Contract: a deliverable, acceptance conditions, and commands to check them.
LoopForge validates the structure and command bindings. An item is verified
when the agent claims it is met and its bound commands pass in the closing
round with the declared binding. A later command disable or reconfigure does
not rewrite a historical pass, and Agent-reported test counts never upgrade a
criterion claim. Whether the proposed deliverable or test is semantically
appropriate remains the agent's and operator's judgment. The agent's declared `scope` is a
report-only intent, not a permission, and an active slice can be explicitly
redirected with `contract_transition`; the old contract then closes as
`superseded` and stays visible in the audit record.

## Recovery with the agent in control

The agent may recognize that its current direction is wrong and request
recovery to a workspace checkpoint, the automatic before-image of a prepared
round or an explicit `loopforge_checkpoint` savepoint. LoopForge does not
diagnose the mistake or choose the destination. It resolves the checkpoint
through the branch's transaction refs, records the rollback as a durable event,
then restores the files and HEAD itself and verifies the complete Git boundary
before issuing the redo prompt.

LoopForge can also trigger a backtrack when a machine rule requires it. Both
paths use the same restore protocol and remain visible in history. Redo
continues on a child branch. The rollback directive keeps the abandoned
approaches, wrong assumptions, machine-observed vs Agent-reported skipped
files, compact trigger findings and Recovery Brief facts; a same-round redo
replaces that numeric round's feedback slot, so the abandoned evaluation itself
is not kept as a second copy. The current branch never treats abandoned work as
current work.

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
current committed governance facts, compact machine evidence, and bounded
Agent-report Working Memory. The optional state file is a derived view, not
another source of truth.

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
