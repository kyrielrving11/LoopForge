# Evidence and Round Contracts

This reference explains concepts. The live prompt, `submission_guidance`, and
the `tools/list` schema are authoritative for applicability, legal shapes, real
ids, limits, and usable commands. This file is not a second rule set.

## Evaluation field groups (conceptual)

- **Reports:** `execution_report`, `discovered_constraints`,
  `wrong_assumptions`, `open_questions`, and `worker_results`.
- **State transitions:** `emerged_subtasks`, `subgoal_updates`, and
  `retracted_constraints` (Agent-discovered constraints only; operator
  criteria and hard constraints are immutable).
- **Claims and proposals:** one `execution_report.claims` channel
  (`cr-` criterion claims are advisory, `rci-` active-contract item claims are
  strict) and `round_contract` with its optional `supersedes` modifier.
- **Lifecycle controls:** `subtask_boundary` / `subtask_boundary_label`,
  `outcome`, `blocker`, `objective_refinement`, `no_change_reason`, and
  `gate_ids`.

A field is included only when its event actually happened. The live
`submission_guidance` decides current applicability and the exact legal shape.
`wrong_assumptions` and `open_questions` are report-only: they feed bounded
Working Memory, replay, and explain, never the verification gate, success,
contract closure, or machine evidence.

## What a Round Contract is

A Round Contract is the Agent's proposal for a bounded, machine-checkable
slice. It is not a round, a second plan ledger, or an unconditional
requirement. A proposal becomes active only after its declaring round commits,
and it governs the next round.

The live prompt and `submission_guidance` state when a proposal is required,
when an open contract may continue, and when a closed contract needs a
successor. Declare a contract only when the next slice has one bounded
deliverable and each acceptance item can be checked by an available, enabled,
after-capable verification command. If no configured command can verify the
slice, do not invent a contract.

## Proposal shape and binding (conceptual)

Use the current `submission_guidance` for the exact shape and limits.

- `work_item` is the bounded deliverable this slice produces — an outcome, not
  an activity.
- `items[]` are acceptance conditions inside that slice, not a task checklist.
- Each item binds its own `verify_with` command ids. One condition may use
  several commands; one command may back several conditions.
- `scope` is an optional, report-only declaration of intended files or
  directories. It grants no permission and is never containment-checked.
- `criterion_refs` may cite real `cr-*` ids rendered by the current prompt.
- Sub-goals remain an Agent plan report; contract items do not link to them.

The runtime validates structure, references, and command bindings. Unknown
fields, free text where an id is required, duplicate refs, duplicate normalized
items, unavailable commands, and a missing `work_item` are reported as
`contract_invalid`; correct the payload and resubmit with the same handle.

Contract and item ids are content-addressed (`rc-*`, `rci-*`) from the
proposal's content, so restating an unchanged proposal preserves identity.
`scope` and `supersedes` are modifiers, not part of that identity.

## Redirecting an active contract

If investigation shows the active slice is the wrong route, use the ONE
contract channel in the same evaluation and attach `supersedes` with the active
`rc-*` id and a different set of acceptance items. The successor activates next
round; the old contract closes as `superseded`, its item statuses stay in the
audit record, and the workspace is not restored.

The live guidance and runtime state the exact legality and error codes. A
stale target, unchanged acceptance items, a blocked outcome, or a stop
declaration cannot redirect a contract. Stop and blocked rounds cannot leave a
new proposal.

## Item status and closure (conceptual)

Item status is machine-derived:

- `pending`: not claimed as met;
- `insufficient`: claimed as met but not backed by every required observation;
- `contradicted`: a bound observation fails, or its entrypoint/configuration is
  no longer trustworthy;
- `verified`: the Agent claims `met`, every bound command passes in the closing
  round's after phase, and the declaration binding remains intact.

Closure is derived from the active contract, its items, and the round's
declaration. The live prompt and submission receipt state the current closure
and item statuses; do not re-derive them from this reference. A superseded
contract keeps its item statuses for audit and never restores the workspace.

A claimed-but-unbacked item is verification debt. The runtime's verification
findings, not this reference, own the current escalation rule.

## Evidence commands

Contract items are backed by commands the **operator** configures in
`loop_policy.json`. The Agent never declares one and does not discover project
scripts to invent one.

The live policy and guidance own the executable/argument form, workspace
confinement, phase, timeout, output cap, success exit codes, and configuration
hash. `loopforge doctor` statically checks configured commands and never
executes one. When no command is available, run without a contract rather than
declaring items that cannot close.

A command's **entrypoint** is the file it names plus `package.json` when a
package manager runs it. It must already be part of the workspace when the
round starts and must not change during the round that runs it. The runtime
records and compares those files; a changed entrypoint makes the observation
untrustworthy. Do not author the verification script inside the round you
expect it to verify.

To keep a script that must survive a rollback, make it part of the committed
workspace before the round that depends on it. Restoring to an earlier
checkpoint discards work the target boundary did not already carry.

## IDs and Agent judgment

Prompts render stable IDs beside constraints (`c-*`), criteria (`cr-*`),
sub-goals (`sg-*`), contracts (`rc-*`), and contract items (`rci-*`). Use those
ids where a field asks for a reference. Never invent one; when an id is absent,
omit the field rather than guessing.

LoopForge validates structure, command bindings, and references. It does not
judge whether a `work_item` sounds like a deliverable, whether an item
semantically matches a command, whether a command is the "right" acceptance
test, or whether the declared `scope` is the right route. Those remain Agent
and operator judgment.
