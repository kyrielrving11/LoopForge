# LoopForge

**Durable work continuity and machine evidence for multi-round coding agents.**

Coding agents can make progress quickly. The hard part is keeping that progress
reliable across rounds: a conversation may be summarized, interrupted, or
restarted, while accepted work, failed attempts, machine observations, and
abandoned changes all risk blending together.

LoopForge gives each work round a durable boundary. It records what was
committed, keeps machine observations attached to that record, and prepares the
prompt for the next model invocation from the resulting state. The agent still
decides what the task means and how to do it; LoopForge makes the process around
that work traceable and recoverable.

[中文说明](./README.zh-CN.md) · [Package and integration guide](./loopforge/README.md)

## The problem

A long coding task is not one uninterrupted action. It is a sequence of work
slices, decisions, checks, and sometimes course corrections. Conversation
history is useful, but it is not a dependable record of that sequence. It can
include unsubmitted work, rejected attempts, claims that checks did not confirm,
and changes that were later abandoned.

LoopForge treats each accepted round as a transaction in a typed history. The
next round is prepared from committed state, not inferred from an informal
summary. When something is uncertain, that uncertainty remains visible instead
of being converted into a pass or an empty result.

## How a round works

```text
LoopForge prepares a prompt from committed state
                       |
                       v
Agent interprets the task and performs a work slice
                       |
                       v
Agent submits a structured result or requests recovery
                       |
                       v
LoopForge observes, validates, and commits or rejects
                       |
                       v
The next prompt is derived from the resulting state
```

A round is a coherent work slice with a before/after evidence boundary. The
agent decides whether that slice is complete and whether to continue. A
rejected attempt does not become committed round history. An invalid submission
does not advance the round. Accepted outcomes and their observations are
recorded together.

For example, when an agent builds a feature over several slices, each accepted
slice leaves a typed record and observations from the same boundary. The next
model conversation starts from committed state rather than the old transcript.
If the agent decides to abandon its approach, it can request a restore; LoopForge
verifies the target workspace before work resumes.

## What makes LoopForge different

### Durable rounds, not conversation summaries

LoopForge stores committed rounds as typed records in the Vault. That history
is the factual source for prompts and read-only views. A state file, receipt,
replay, audit, or explanation is a projection of that history, never a parallel
ledger. This keeps accepted work distinct from attempts that were rejected or
later abandoned.

### Agent reports and machine evidence stay separate

The agent reports what it believes it changed or completed. LoopForge records
those reports as claims. Git workspace observations and explicitly configured
verification commands provide machine-visible evidence. A claim alone does not
verify a result, and an unavailable observation remains unknown. The persisted
evidence posture is derived once at commit and reused by prompts, receipts, and
read-only views.

When an effective success claim is supported by an after-phase command whose
entrypoint and configuration are untampered and whose result passed, the
verification gate persists `machineBackedSuccess` in that round's evidence
posture. Read surfaces reuse this fact instead of re-deriving it. A loop
reported as `completed` has passed its configured stop gates; that lifecycle
result is not a universal proof that the task is correct.

For work that benefits from a bounded slice, the agent can propose a Round
Contract: a deliverable, acceptance conditions, and configured commands that
can check them. LoopForge validates the structure and bindings. The agent and
operator remain responsible for deciding whether the deliverable and checks
make sense.

### A clean model conversation at each new round

At a round boundary, `fresh_invocation` starts a new model conversation. The
previous transcript, tool outputs, and uncommitted reasoning do not carry into
it. LoopForge prepares continuity explicitly from committed governance facts,
Machine Evidence, bounded Working Memory, and any applicable recovery or retry
lessons. The prompt is a compact projection with a minimal submission template;
detailed field facts stay in the live `submission_guidance`. Agent reports
remain labelled as reports; they do not become machine facts.

This is a model-conversation boundary, not a host restart or workspace reset.
The same loop identity and current modified workspace continue, and a live host
may keep its MCP connection, tools, and installed skill files warm. A
`same_round_retry` can continue the original invocation for an in-context repair;
context mode is reported explicitly and is independent of prompt density. Only
rollback or recovery restores a checkpoint.

### Recovery with a verified restore boundary

When the agent decides its current direction should be abandoned, it can request
recovery to an available workspace checkpoint. LoopForge records the rollback
directive, restores the files and Git state, and verifies the complete restore
boundary before issuing the redo prompt. Machine-triggered backtracks use the
same restore protocol.

Recovery does not fabricate a successful evaluation or treat a restore as
progress. The redo continues with the recovery lessons and verified workspace
state, while the abandoned path remains distinguishable from current work.

## Responsibility boundary

The agent owns task interpretation, planning, tool use, implementation, and the
decision to request recovery. LoopForge owns committed round history, configured
observations, deterministic boundary checks, and verified restore mechanics.

LoopForge is not a coding agent, planner, or guarantee that a task is correct.
It does not manage private model memory or provider caches. It gives an external
agent a durable process around its work, while leaving the reasoning and
decisions with that agent.

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
