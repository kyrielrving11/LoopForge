# LoopForge

**A cognitive state runtime for long-running AI coding tasks.**

LoopForge runs outside the coding Agent and governs the boundary between
rounds. It records committed facts, collects independent machine evidence,
decides whether the current round may commit, and compiles the next prompt
from persistent state.

**Version:** the `version` field in [`loopforge/package.json`](./loopforge/package.json) is the single source of truth. Node.js >= 18. Zero runtime dependencies.

> [中文文档](./README.zh-CN.md)

## Why LoopForge?

Most Coding Agents look impressive on tasks that finish within five rounds,
but often break down on real software projects that run for more than twenty:

1. **Summary cascade:** Long tasks inevitably hit context limits. Asking an
   LLM to summarize its own history is a game of broken telephone. Memory gets
   less reliable each round, and the original objective and hard constraints
   may be almost entirely forgotten after fifteen rounds.
2. **Fake success and test escape:** Under pressure, a probabilistic model may
   edit a test script, weaken an assertion, or simply claim that all tests
   passed without machine evidence.
3. **Irreversible workspace pollution:** Without version-control discipline, an
   Agent that reaches a dead-end architecture keeps patching the contaminated
   workspace until its context is exhausted.
4. **Strategic scope drift:** Without a round contract, the model can lose
   focus during exploration and refactor low-level modules unrelated to the
   current objective.

**LoopForge does not perform prompt-technique tricks. It acts as a cold external
system kernel: immutable event sourcing protects memory, machine exit codes
check claims, and structured contracts constrain the modification scope. This
gives a Coding Agent engineering stability across dozens of rounds.**

## Core idea

LoopForge deliberately keeps two sources separate:

- **Committed facts:** typed round documents in the Vault. Rejected and
  in-flight attempts are not history. One factual source.
- **Canonical State:** cognitive state compiled from committed facts. Prompts,
  status views, and the optional state file are derived views. One cognitive
  source.

The Agent still owns planning, code changes, tool use, and the choice of
reasoning approach. LoopForge owns the round boundary and the checks around it.

```text
Agent executes work
  -> submits a structured evaluation (claim)
  -> LoopForge collects machine evidence
  -> verification gate
  -> enforcement gate
  -> accept / reject / backtrack / terminate
  -> committed facts
  -> Canonical State
  -> next prompt
```

This is the difference from a summary loop:

```text
Traditional: prompt -> summary -> next prompt -> another summary
LoopForge:   committed rounds -> Canonical State -> next prompt
```

## The contract mental model

LoopForge does not treat the Agent's output as fact merely because its format
is valid or its tone is confident. An evaluation comes from the participant
who performed the work, so it starts as a claim. A Round Contract turns that
claim into a three-stage process:

```text
Before: declare the next round's contract
During: execute under the active contract
After:  close items with independent machine evidence
```

### Before: Declaration

The Agent submits `round_contract` as a proposal for the next round. The
submission boundary checks its structure, item limits, evidence bindings,
workspace scope, and criterion or sub-goal references. A proposal becomes
active only after its declaring round commits. While the active contract is
open, a different proposal is ignored; restating it unchanged continues the
current contract.

### During: Execution

The Agent works under the active contract. The **verification gate** checks
claim consistency, evidence integrity, plan and contract conformance, and
progress and recovery state. It compares the Agent's claims with Git snapshots,
configured command observations, and committed round history. A change outside
the active contract's declared scope produces `round_scope_drift`, a machine
fact that cannot be waived by explanation.

### After: Closure

The Agent may claim that an item is complete, but the item becomes `verified`
only when every bound command passes in the closing round's after phase and the
command configuration and entrypoint remain trustworthy. An unsupported claim
is `insufficient`; a failed observation is `contradicted`. The contract closes
only when every item is `verified` or the Agent reports `outcome: "blocked"`.

The **enforcement gate** applies the consequences of these checks through an
ordered policy: accept, reject, backtrack, or terminate. Repeated failure of
the same check escalates instead of becoming an infinite retry loop. Agent
output can explain intent and claim completion, but it cannot create evidence,
mark an item `verified`, cancel a machine contradiction, or complete a contract
by itself.

Sub-goals may evolve during execution: `emerged_subtasks` can add work and
`subgoal_updates` explicitly changes the state of an existing sub-goal.
LoopForge does not use fuzzy intent or similarity to judge sub-goal drift. The
machine-enforced boundary is the contract scope: if newly discovered work
requires files outside the active scope, close the current contract first,
then submit a new proposal with the expanded scope.

## What makes it different

### Round dispositions

After strict payload validation, LoopForge collects before and after
observations, runs the verification gate, and lets the enforcement gate apply
its policy. The result is an explicit round disposition:

- **Accept:** commit the round and continue.
- **Reject:** commit no round and retry the same logical `roundId`.
- **Backtrack:** record a rollback directive, restore the last clean point, and
  redo the round with a Recovery Brief.
- **Terminate:** stop the loop without writing a rejected or unsafe attempt as
  normal history.

### Contracts close only on machine-backed facts

A Round Contract is a set of items bound to evidence commands. An item becomes
`verified` only when the Agent claims it is met and every bound command is
observed passing in the closing round. Claimed but unbacked work is recorded as
`insufficient`, creating bounded verification debt instead of silently passing.

### Recovery does not rewrite history

Rejected attempts never enter committed history. Backtrack preserves valid
discoveries, records failed approaches and falsified assumptions, checks that
the workspace was restored on the next submission, and lets a successful redo
replace the rollback record.

## Install and connect

```bash
npm install -g loopforge
loopforge init --client claude
claude mcp add loopforge -- npx loopforge mcp
```

The MCP service is the primary integration. It supports Claude Code, Codex CLI,
and other MCP-compatible clients. The package also provides a TypeScript
library for custom integrations. See [`loopforge/README.md`](./loopforge/README.md).

## One round in practice

1. The user calls `loopforge` and declares the task, success criteria, and hard
   constraints.
2. LoopForge returns a prompt and a stable `roundId`.
3. The Agent changes the workspace and submits a structured `evaluation` with
   `loopforge_next`.
4. LoopForge validates the payload, observes the workspace, verifies the claim,
   and returns the round disposition.
5. An accepted round enters history; the next prompt is compiled from the new
   committed state.

The four core evaluation fields are strict: `success`, `output_summary`,
`constraint_violations`, and `should_continue`. A malformed core payload
returns `evaluation_invalid`, can be retried for the same round, and does not
modify the session, Vault, gates, rejection counter, or metrics. Round Contract
declarations and `contract_item_claims` are also strict structural boundaries.

## Architecture

```text
External Agent
       |
       v
Submission boundary
  strict structure, same-round retry
       |
       v
Round lifecycle
  observations -> verification -> enforcement
       |
       +--> reject / terminate: no committed round
       |
       +--> accept / stop / backtrack: commit transaction decision
                                      |
                                      v
                           CommittedRoundView
                         one history decoder/window
                         /          |          \
                    Replay       Audit      Canonical State
                  what happened  evidence   cognitive facts
                                                   |
                                          prompt / status / state file
                                                   |
                                                   v
                                            next Agent round
```

All history consumers use the same `CommittedRoundView` and derivation
window. Replay answers what happened, Audit checks fact completeness and
evidence, and Explain answers why a round was decided as it was. None of them
is a second persistence source.

## Scope boundaries

LoopForge is not a memory database, RAG system, context compressor, or
unattended Agent. It does not execute the Agent's work. The optional state file
is a regenerable human-facing view, not the source of truth.

## Core capabilities

- Structured MCP round protocol with stable error codes and retry semantics.
- Deterministic state reconstruction from committed typed history.
- Machine evidence from Git and explicitly configured commands.
- Content-addressed `rc-` and `rci-` identities for Round Contracts.
- Verification debt, scope drift, progress stalls, and recovery decisions.
- Durable sessions, atomic writes, locks, leases, pause, resume, and replay.
- L0/L1/L2 prompt density without choosing a reasoning technique for the Agent.

## License

MIT
