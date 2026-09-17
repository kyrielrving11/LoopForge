---
name: perception
description: Drive multi-round coding tasks through LoopForge MCP so objectives, constraints, evidence, and decisions survive context loss and restarts. The external Agent remains responsible for planning, file changes, tools, and execution.
---

# Perception

Use LoopForge when a task spans several meaningful work slices, must survive a
restart or context loss, or needs an auditable distinction between Agent claims
and machine-verified facts.

LoopForge has one factual source, committed typed round documents in the Vault,
and one cognitive source, Canonical State compiled from those documents. The
Agent still decides what to do and how to reason.

## Start

Call `loopforge_status` with `view: "all"` before starting. Reuse an existing
session for the same objective instead of opening a second loop.

Call `loopforge_start` with:

- `task`: the complete user objective;
- `constraints`: hard boundaries that must survive every round;
- optional `maxRounds`, `domain`, `loopId`, and `planSource`.

Keep the returned `sessionId`, `roundId`, prompt, and level. Pass the latest
`roundId` to every `loopforge_next`; it anchors the submission to the exact
round being reported.

## What is a round?

A round is one coherent work slice that can be described, checked, and
disposed of at the next boundary. It is not a fixed number of files, tokens,
commits, or minutes. A capable Agent may complete a large change in one round
when the change shares one objective, one evidence story, and one recovery
path. Split it when those boundaries diverge.

Before choosing the slice, ask:

1. **Coherence:** does the work serve one immediate objective rather than
   several unrelated goals?
2. **Verifiability:** can the result and its hard constraints be checked with
   the available tests, commands, or other machine observations?
3. **Disposition:** will the boundary produce a clear continuation, stop,
   blocker, rejection, or recovery decision?
4. **Recovery:** can the slice be safely retried or rolled back without
   invalidating unrelated work?

Make a round larger when changes are tightly coupled and can be verified
together. Make it smaller when uncertainty, external effects, evidence gaps,
or rollback risk is high. Do not combine independent objectives merely because
the Agent can edit them in one context. Do not split a single atomic change
only to create more round records.

At the end of a round, inspect the actual diff, relevant tests, hard
constraints, and remaining work. A completed slice is not the same as a
completed task.

## Plan the next slice

For work that spans rounds, submit `round_contract` as a proposal for the next
slice. Keep `work_item` narrow, bind each item to a configured evidence command
with `verify_with`, and limit `scope` to files or directories that slice may
touch. The proposal becomes active only after its declaring round commits.
While it is open, restating the same proposal continues it; a different
proposal is ignored as `contract_premature`. If the slice is blocked, report
`outcome: "blocked"` with a concrete `blocker` instead of silently replacing
the active contract.

This is a planning aid, not a second gate. LoopForge learns the plan only from
committed evaluation fields, contract proposals, observations, and changes.

## Execute a round

1. Execute the returned prompt and do the repository work.
2. Use the tools and reasoning approach that fit the slice.
3. Check actual evidence before claiming success.
4. Submit exactly one structured evaluation with `loopforge_next`.

After the strict boundary accepts the payload, LoopForge collects before/after
evidence, runs the **verification gate**, then runs the **enforcement gate**.
The verification gate checks evaluation consistency, evidence integrity, plan
and contract conformance, and progress and recovery. The enforcement gate
turns those findings into one disposition: accept, reject, backtrack, or
terminate.

The four core evaluation fields are strict:

| Field | Requirement |
| --- | --- |
| `success` | Boolean. `true` only when the whole objective and hard constraints are satisfied. |
| `output_summary` | String describing what changed and what was verified. |
| `constraint_violations` | Array of real violations, preferably using `c-XXXXXXXX` IDs. |
| `should_continue` | Boolean. `false` only when the whole task is complete. |

Useful optional fields include `execution_report` (`files_changed`,
`tests_reported`, `criterion_claims`, `contract_item_claims`, and
`progress_estimate`), `discovered_constraints`, `emerged_subtasks`,
`subgoal_updates`, `prompt_requests`, `round_contract`, `retroactiveClaims`,
`gate_ids`, `worker_results`, and objective or constraint revisions.

`emerged_subtasks` is the only sub-goal creation channel. It contains plain
descriptions, never `sg-` IDs. `subgoal_updates` changes existing active IDs;
done and canceled are terminal and cannot be reopened.

`outcome` may be `success`, `partial`, `failed`, or `blocked`. A blocked
outcome needs a concrete `blocker`; `stop_reason` of `blocked` or
`needs_human_input` also stops without claiming success.

Optional malformed values are normalized or dropped. The strict exceptions are
`subgoal_updates`, `round_contract`, and
`execution_report.contract_item_claims`. Shape, reference, duplicate, command,
and workspace-containment errors return `evaluation_invalid` or
`contract_invalid` before advance. Correct the payload and resubmit the same
`roundId`; nothing is committed and no rejection counter moves.

Every successful round still needs an `execution_report` with
`files_changed` and `tests_reported`. `no_change_reason` is an escape only when
no enabled verification command exists. It never creates evidence and never
excuses an open contract.

Agent reports are claims quoted for audit. They never become verified facts.
Do not infer a missing field from natural language or put a guessed evaluation
in free text.

## IDs and contracts

Prompts render stable IDs beside constraints, criteria, sub-goals, and contract
items. Prefer those IDs for `constraint_violations`, criterion claims, status
updates, and item claims.

A sub-goal ID belongs to its declaration event. Re-declaring the same text in a
later round creates a new sub-goal. Status changes require the exact active
`sg-` ID; description matching is not a fallback.

A Round Contract is a set of evidence-bound items, not prose. Each item must
bind at least one configured, enabled, after-capable command. The runtime
derives content-addressed `rc-XXXXXXXX` and `rci-XXXXXXXX` IDs, so restating an
unchanged proposal keeps its identity. `subgoal_refs` belongs on the item; a
machine-verified item backs exactly the sub-goals it names, without changing
their declared `SubGoal.status`.

Item status is machine-derived:

- `pending`: not claimed as met;
- `insufficient`: claimed as met but not backed by all required observations;
- `contradicted`: a bound observation fails, or its entrypoint/configuration is
  no longer trustworthy;
- `verified`: the Agent claims `met`, every bound command passes in the closing
  round's after phase, and the declaration binding remains intact.

The contract closes only when every item is `verified` or a round reports
`outcome: "blocked"`. Repeated unbacked claims create bounded verification
debt. The same-check streak escalates at
`engine.unverified_claim_streak_limit` (default 3) instead of retrying forever.

Sub-goals may evolve during execution. LoopForge does not use fuzzy intent or
similarity to judge drift. The enforced boundary is contract `scope`: work
outside it is `round_scope_drift`, a machine fact no explanation waives. Revert
the out-of-scope change, or close the contract as blocked and declare the
expanded scope in a new proposal whose `scope` covers **every** file this round
changed outside the current one — a partial expansion is still drift.

## Evidence commands

Contract items are backed by commands the OPERATOR configures. The Agent never
declares one, and does not discover or run project scripts to invent one. They
live in `loop_policy.json` under `evidence.commands`, in the workspace the
server was started in:

```json
{
  "version": "4",
  "evidence": {
    "commands": [{
      "name": "verify",
      "enabled": true,
      "executable": "node",
      "args": ["scripts/verify.mjs"],
      "cwd": ".",
      "phase": "after",
      "required": true,
      "timeout_ms": 120000,
      "max_output_chars": 8000,
      "success_exit_codes": [0]
    }]
  }
}
```

`executable` and `args` are spawned without a shell and confined to the
workspace. `loopforge doctor` statically checks every configured command —
its name, executable, arguments, timeouts, and workspace containment — and
never executes one.

Every prepared round returns `capability`: which providers are available, which
commands are enabled and after-capable, and `contractVerificationAvailable`.
When that is `false`, no configured command can back a contract item: run
rounds without a contract instead of declaring items that cannot close. The
`warnings` list states the same thing in words.

A command's ENTRYPOINT is the file it names plus `package.json` when a package
manager runs it. It must already be part of the workspace when the round
starts, and it must not change during the round that runs it — the runtime
records those files at round start and compares them afterwards, whether or not
git can see them. A changed entrypoint makes the observation untrustworthy:
restore it to its round-start content. Do not author the verification script
inside the round you expect it to verify — that round cannot be closed by it.

To keep a script that must survive a rollback, it has to be part of the
committed workspace rather than an uncommitted change: the post-backtrack
restore check rejects a skipped file that is still byte-identical to its state
at the rollback, so a script left sitting in the working tree blocks the redo.
Prepare it before the round that depends on it.

## Backtrack and recovery

A progress stall is machine-first when Git history is observable over the
lookback window. Self-reported `progress_estimate` is only a fallback when
machine history cannot be read. Machine motion can excuse a stall but cannot
create one. A machine-backed success round is finishing, even if its closing
round changes no files.

Backtrack records a rollback directive and restores the round counter to the
last clean committed round. Rejected attempts are never history. The next
submission is the redo of `restorePoint + 1` and must reuse the prompt's round
ID. A successful redo retires the rollback record.

The Recovery Brief identifies the trigger, restore point, redo ID, failed
approaches, falsified assumptions, valid discoveries, files to revert, and
target HEAD. It states restoration facts, not a prescribed command.

When backtrack occurs:

1. Restore the workspace exactly as requested before doing more work.
2. Read the Recovery Brief, restored prompt, and derived state.
3. Do not repeat a failed approach without addressing its cause.
4. Carry valid discoveries into later evaluations.

If the rolled-back work used an active contract, close the stalled contract in
the redo with `outcome: "blocked"` and declare the revised contract in that
same submission. Restating the stalled contract commits more of the same.

## Interpret results

- Non-null `prompt`: execute it and submit the next evaluation.
- `enforcementAction: "reject"`: retry the same logical round and ID; the
  attempt increases.
- `enforcementAction: "backtrack"`: restore the workspace, then continue from
  the restored prompt and round.
- Null `prompt`: inspect `stopReason`.

Read `verificationStatus`, `roundSuccess`, `level`, `warnings`, and
`enforcementReason` before planning the next slice. `trusted` means claimed
work is machine-backed, `insufficient` means evidence is missing, and
`contradicted` means a machine fact denies a claim. These are evidence
postures, not subjective quality scores.

Errors use `{ok: false, error: {code, message, retryable, ...}}`. Branch on the
stable `code`, not the prose in `message`. Payload errors such as
`evaluation_invalid`, `contract_invalid`, `policy_invalid`, and round-ID
errors are retryable with the same ID. `session_not_found`, `state_unavailable`,
and `gate_disabled` describe state or policy; do not blindly resubmit.

`completed` means success plus every active contract item is `verified`, or
there is no active contract. Explicit `blocked` always wins over success.
`incomplete` means completion was not machine-verified. Other terminal reasons
include `failed`, `max_rounds`, `stalled`, `enforcement_terminated`, `paused`,
and `cancelled`.

## Prompt levels and views

L0 is a lean same-round retry, L1 normal continuation, and L2 full
rehydration. They control state density only, never a reasoning technique. L2
comes from round facts such as the first round, a plan or checkpoint boundary,
recovery, contradiction, or repeated rejection. It is not a round-count timer.

Use `loopforge_status` with `view: "session"` for the live round,
`view: "loop"` for committed health, `view: "all"` after a restart,
`view: "audit"` for completeness and evidence, and `view: "explain"` for a
round's active contract, observations, flags, and decision. Use
`loopforge_replay` for the committed timeline and diffs.

The optional `.loopforge/state/<loopId>-state.md` is derived and regenerable.
Read it when an L2 prompt points to it, but never treat it as a second source
of truth.

## Gates and delegation

Use `loopforge_pause` for an intentional interruption,
`loopforge_resume` to reconstruct a durable session, and `loopforge_stop` only
for an intentional terminal stop.

The two gate tools are opt-in through `policy.gate.enabled`. When enabled,
`loopforge_gate_check` preflights a structured action with its description,
scope, effects, reversibility, and authorization. Classification is
conservative: anything not provably safe becomes `user_required`. Present the
approval question, record the decision with `loopforge_gate_resolve`, and cite
the approved gate ID in `evaluation.gate_ids`. LoopForge records the process,
but cannot prove that a human was present because the Agent submits the resolve
call. Safe investigation and dry-runs need no gate.

Delegation does not create another LoopForge mode. Give each worker a
self-contained subtask and hard constraints, then place the result in
`worker_results` so it can enter the next Canonical State.

## Rules

1. Execute the prompt instead of generating another prompt.
2. Submit one honest structured evaluation after each attempt.
3. Treat required command evidence and verification findings as authoritative.
4. Restore the workspace before working after backtrack.
5. Keep one loop focused on one user objective.
6. Do not advance a paused or stopped session through another process.
7. Continue in the same Agent task when possible. LoopForge preserves state but
   does not create a background Agent.
