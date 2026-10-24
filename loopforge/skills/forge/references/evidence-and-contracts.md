# Evidence and Round Contracts

This reference explains concepts and lifecycle rules. The live
`submission_guidance` remains the only source for field applicability, legal
shapes, real ids, and usable commands.

## Optional evaluation field groups (conceptual)

- **Reports:** `execution_report`, `discovered_constraints`,
  `wrong_assumptions`, and `worker_results` (the minimal audit shape:
  `agentId`, `subTask`, `resultSummary`, `outcome`).
- **State transitions:** `emerged_subtasks`, `subgoal_updates`,
  `retracted_constraints` (Agent-discovered constraints only; operator
  criteria/hard constraints are immutable).
- **Claims and verification proposals:** criterion claims, active contract item
  claims, and `round_contract`.
- **Lifecycle controls:** `compression_checkpoint` / `checkpoint_label`,
  `outcome`, `blocker`, `stop_reason`, `no_change_reason`, and `gate_ids`.

A field is included only when its event actually happened. The live guidance
decides current applicability and the exact legal shape.

## What a Round Contract is

A Round Contract is the Agent's proposal for a bounded, machine-checkable
slice. It is not a round, a second plan ledger, or a required field. A proposal
becomes active only after its declaring round commits, and it activates on the
next round.

Declare a contract only when:

- the next slice has one bounded deliverable;
- each acceptance item can be checked by an available, enabled,
  after-capable verification command;
- the Agent can state what "done" means without asking the runtime to judge
  semantics.

If no configured command can verify the slice, do not invent a contract.
Continue with Agent-directed work and report the evidence honestly.

## Proposal shape and binding

Use the current `submission_guidance` for the exact legal shape. Conceptually:

- `work_item` is the bounded deliverable this slice produces — an outcome, not
  an activity.
- `items[]` are acceptance conditions inside that slice, not a task checklist.
- Each item binds its own `verify_with` command ids. One condition may use
  several commands; one command may back several conditions. The binding never
  moves to the contract/work_item level.
- `scope` is an optional, report-only declaration of intended files or
  directories. It grants no permission, is never containment-checked, and
  changes outside it are an info fact only.
- `criterion_refs` must cite real `cr-*` ids from the active criterion set the
  current prompt rendered.
- Sub-goals remain an Agent plan report. Contract items do not link to them;
  their closure depends only on the item, its bound commands and machine
  evidence.

Unknown fields, free text where an id is required, duplicate refs, duplicate
normalized items, unconfigured/disabled/not-after commands, and a missing
`work_item` are `contract_invalid`. Correct the payload and resubmit with the
same `submissionHandle`.

Contract and item ids are content-addressed (`rc-*`, `rci-*`). Restating an
unchanged proposal preserves identity. While a contract is open, omitting
`round_contract` continues it; you do not need to restate it.

A different proposal while the active contract is open is ignored as
`contract_premature`, unless it is part of a valid `contract_transition`.

## Redirecting an active contract

If investigation shows the active slice is the wrong route, do not report it as
blocked and do not quietly propose another contract. Submit an explicit
redirection in the same evaluation:

```json
{
  "contract_transition": {
    "kind": "supersede",
    "contract_id": "<the active rc-XXXXXXXX id rendered in this prompt>",
    "reason": "why the active slice is no longer the right route"
  },
  "round_contract": {
    "work_item": "<the successor deliverable>",
    "items": [{
      "description": "<a different acceptance condition>",
      "criterion_refs": [],
      "verify_with": ["verify"]
    }]
  }
}
```

The successor is required, its acceptance items must differ from the active
contract's, and `should_continue` must stay true. The old contract closes as
`superseded` — not `verified`, not `blocked` — its item statuses stay in the
audit record, the workspace is not restored, and the redirect round cannot be
reported as `completed`. The successor activates next round.

A stale or mismatched `contract_id`, a missing successor, unchanged items, a
blocked outcome, or `should_continue=false` returns `contract_invalid`; fix the
payload and resubmit the same handle.

## Item status and closure

Item status is machine-derived:

- `pending`: not claimed as met;
- `insufficient`: claimed as met but not backed by all required observations;
- `contradicted`: a bound observation fails, or its entrypoint/configuration is
  no longer trustworthy;
- `verified`: the Agent claims `met`, every bound command passes in the closing
  round's after phase, and the declaration binding remains intact.

Closure priority is `blocked > superseded > verified > open`:

- every item `verified` closes the contract as verified;
- a round reporting `outcome: "blocked"` closes it as blocked;
- an explicit `contract_transition` closes it as superseded;
- otherwise it remains open.

A superseded contract keeps every item status for audit and never restores the
workspace. Its redirect round cannot be `completed`.

A claimed-but-unbacked item is verification debt. Repeated claims escalate at
`engine.unverified_claim_streak_limit` on the same check's streak. An honest
supersede with no `met` claim retires the old debt finding; a supersede that
still claims an old item `met` keeps it.

## Evidence commands

Contract items are backed by commands the **operator** configures in
`loop_policy.json` under `evidence.commands`. The Agent never declares one and
does not discover project scripts to invent one.

Commands:

- run with an explicit executable and argument list, without a shell;
- are confined to the workspace;
- run in the after phase (or both);
- have their own timeout and output cap;
- determine pass/fail from the configured success exit codes;
- have a content-addressed configuration hash bound into the contract item.

`loopforge doctor` statically checks every configured command and never
executes one. When no command is available, no configured command can back a
contract item; run without a contract rather than declaring items that cannot
close.

A command's **entrypoint** is the file it names plus `package.json` when a
package manager runs it. It must already be part of the workspace when the
round starts, and it must not change during the round that runs it. The runtime
records those files at round start and compares them afterwards, whether or not
git can see them. A changed entrypoint makes the observation untrustworthy:
restore it to its round-start content. Do not author the verification script
inside the round you expect it to verify.

To keep a script that must survive a rollback, make it part of the committed
workspace before the round that depends on it. Restoring to an earlier
checkpoint discards work the target boundary did not already carry.

## IDs and Agent judgment

Prompts render stable IDs beside constraints (`c-*`), criteria (`cr-*`),
sub-goals (`sg-*`), contracts (`rc-*`), and contract items (`rci-*`). Use those
ids where a field asks for a reference. Never invent one; when an id is absent,
omit the field rather than guessing.

LoopForge validates structure, configured/enabled/after-capable command
bindings, and references. It does not judge whether:

- a `work_item` sounds like a deliverable;
- an item semantically matches a command;
- a command is the "right" acceptance test;
- the declared `scope` is the right route.

Those remain Agent and operator judgment. `round_scope_drift` is an info fact
only; it never rejects, terminates, backtracks, stalls, or reaches the rejection
counter.
