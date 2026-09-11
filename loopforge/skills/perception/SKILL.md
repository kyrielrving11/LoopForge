---
name: perception
description: Drive a multi-round coding task through LoopForge MCP so goals, constraints, evidence, and decisions survive context loss and restarts. Use when a task needs several rounds, must survive context compression or a process restart, or needs an auditable record of what was verified by the machine rather than claimed by the model. The external Agent stays the execution owner.
---

# Perception

Use LoopForge when a coding task needs several rounds, must survive context
compression or process restart, or benefits from an auditable record of goals,
constraints, evidence, and decisions.

LoopForge has one factual source, the committed typed round documents in the
Vault, and one cognitive source, the Canonical State compiled from them. You
remain the Agent that reads files, edits code, runs commands, delegates work,
and decides how to reason.

## Start

Call `loopforge_start` with:

- `task`: the complete user objective.
- `constraints`: hard boundaries that must survive every round.
- `maxRounds`: optional positive safety limit. The default is 200 from policy.
- `domain`: optional context label.
- `loopId`: optional stable loop id. Generated for you when omitted — pass one
  when the caller already knows it, so later calls can address the loop.
- `planSource`: optional path to a plan document to extract constraints from.

Before starting, `loopforge_status` with `view: "all"` lists the loops the
runtime already holds — reuse an existing session instead of opening a second
one for the same objective.

Keep the returned `sessionId`, `roundId`, prompt, and level. Always pass the
most recent `roundId` to `loopforge_next`. It anchors the submission to the
exact round being reported.

## Plan round boundaries

LoopForge does not decide how the Agent thinks about a large task. The Agent
chooses the next useful slice of work, while LoopForge checks the submitted
facts and evidence at the round boundary. Do not try to predict an exact number
of rounds before inspecting the repository. Re-plan after each committed round.

Choose a round around a coherent, verifiable change:

1. Start with the dependency or discovery work that determines later choices.
2. Group changes that must be edited and tested together; split unrelated work
   or work with different rollback risks.
3. End the round when its slice has a concrete result, a known blocker, or a
   machine-checkable next boundary. A round may be small when uncertainty or
   risk is high, and larger when the changes are tightly coupled.
4. Before submitting, check the actual diff, relevant tests, hard constraints,
   and what is still open. Do not mark the whole task complete because one
   slice is complete.

For work that spans several rounds, declare a `round_contract` as a proposal for
the next slice. Keep its `work_item` narrow, declare `items` that each bind a
configured evidence command in `verify_with`, and constrain `scope` to the files
or directories that slice may touch. The proposal becomes active only after the
current round commits, and the prompt then renders its `rc-` / `rci-` ids. If
the slice is blocked, report `outcome: "blocked"` with a concrete `blocker`; do
not silently replace the active contract.

This is a granularity preflight, not another gate: ask whether the slice has a
clear boundary, evidence, and recovery path. LoopForge cannot see an implicit
plan inside the model. It learns only from committed evaluation fields,
Round Contract proposals, observed evidence, and the resulting changes. A
reasonable split may therefore be revised by the next prompt, a verification
finding, or a backtrack diagnosis.

## Execute a round

1. Execute the returned prompt and do real repository work.
2. Use the tools and reasoning approach that fit the task.
3. Check actual evidence before claiming success.
4. Submit one structured `evaluation` with `loopforge_next`.

The four core evaluation fields are strict:

| Field | Rule |
| --- | --- |
| `success` | Boolean. Use `true` only when the whole objective and every hard constraint are satisfied. |
| `output_summary` | String. State what changed and what was verified this round. |
| `constraint_violations` | Array of strings. Report real violations; prefer constraint IDs such as `c-XXXXXXXX`. |
| `should_continue` | Boolean. Use `false` only when the entire task is complete. |

All other evaluation fields are optional and normalized by LoopForge. Useful
fields include `execution_report` (`files_changed`, `tests_reported`,
`criterion_claims`, `contract_item_claims`, `progress_estimate`),
`discovered_constraints`, `emerged_subtasks` (the only sub-goal creation
channel — never an `sg-` ID; at most 50 entries, 500 characters each),
`subgoal_updates` (explicit status transitions: active `sg-` IDs with a target
status; done/canceled are terminal and never reopen), `prompt_requests`,
`round_contract`, `retroactiveClaims`, `gate_ids` (only when the gate layer is
enabled), and `worker_results` (entries need `agentId`, `subTask`,
`resultSummary` and an `outcome` of `success` / `partial` / `failed`; entries
missing any of these are dropped).

The objective and the constraint set evolve only through your own reports:
`objective_refinement` deepens the objective, `revised_success_criteria` (each
entry `{old, new}`) replaces a criterion, `retracted_constraints` retires a
constraint you now consider wrong, `wrong_assumptions` records what you
believed and had to correct, and `compression_checkpoint` with a
`checkpoint_label` marks a subtask boundary that forces a full-state prompt.
`outcome` is the declared outcome (`success` / `partial` / `failed` /
`blocked`) and `blocker` describes a `blocked` outcome; `stop_reason`
(`"blocked"` or `"needs_human_input"`) is how you stop without claiming
success. `no_change_reason` is the honest escape hatch for a round that
genuinely produced no machine-verifiable work: it downgrades the "success with
no machine evidence" finding to info, but only while NO enabled verification
command is configured — a configured command closes that escape. It never
excuses a success claim with no `execution_report` at all, and it never
excuses a contract check: every successful round still needs `execution_report`
with `files_changed` and `tests_reported`.

Optional malformed values are ignored or defaulted — the Round Contract
declaration, `contract_item_claims`, and `subgoal_updates` are the strict
exceptions. They do not turn a valid submission into a transport error. Missing
or mistyped core fields return `evaluation_invalid` with `details.missing` and
`details.invalid`. Correct the payload and resubmit the same `roundId`. This
does not save session state, write a round, enter either gate, increment
rejection state, or record metrics.

Minimal evaluation:

```json
{
  "success": false,
  "output_summary": "Implemented the parser and added 8 passing tests.",
  "constraint_violations": [],
  "should_continue": true,
  "execution_report": {
    "files_changed": ["src/parser.ts", "tests/parser.test.ts"],
    "tests_reported": { "passed": 8, "failed": 0, "skipped": 0 },
    "criterion_claims": [
      { "criterion_id": "cr-b5a6c7d8", "outcome": "remaining" }
    ],
    "contract_item_claims": [
      { "item_id": "rci-9c8b7a65", "outcome": "met" }
    ],
    "progress_estimate": 0.4
  }
}
```

Everything in `execution_report` is your CLAIM, quoted back for audit — it never
becomes a verified fact. Only machine observations create facts. Do not put a
guessed evaluation in free text. The structured object is the authoritative
submission; `output` is optional supporting context.

If a submission warns that its `roundId` no longer matches, the reported round
already committed. Use the returned held prompt and its `roundId` rather than
submitting against a later round.

## Stable IDs and contracts

Prompts render stable IDs beside constraints, criteria, sub-goals, and contract
items:

- Constraints: `[c-a3f2b1c0] No plaintext passwords`
- Criteria: `[cr-b5a6c7d8] Unit test coverage >= 90%`
- Sub-goals: `[sg-f1e2d3c4] Add error handling to login`
- Contract items: `[rci-9c8b7a65] All parser edge cases covered`

Prefer IDs for `constraint_violations` and criterion claims. A sub-goal ID is
scoped to its declaration event: re-declaring the same text in a later round is
a NEW sub-goal, so never reuse an old `sg-` ID for a fresh item. Sub-goal status
changes REQUIRE exact ACTIVE `sg-` IDs via `subgoal_updates` — description
matching is not a fallback there. Unknown, terminal (done/canceled), or illegal
transitions return `evaluation_invalid` before the round advances: fix the
payload and resubmit the same `roundId` (nothing is committed, no rejection
counter moves).

An optional `round_contract` is a proposal for the next round. It becomes
active only after the declaring round commits, and it is then derived from
committed rounds on every later compile. A contract is items, not prose:

```json
{
  "work_item": "Harden the parser",
  "scope": ["src/parser.ts", "tests/parser.test.ts"],
  "items": [
    {
      "description": "All parser edge cases covered",
      "criterion_refs": ["cr-b5a6c7d8"],
      "subgoal_refs": ["sg-f1e2d3c4"],
      "verify_with": ["unit-tests"]
    }
  ]
}
```

Every item must bind at least one configured, enabled, after-capable evidence
command in `verify_with`, and `scope` entries must stay inside the workspace.
The runtime derives one `rci-XXXXXXXX` ID per item and an `rc-XXXXXXXX`
contract ID from the proposal's content only — restating an unchanged contract
keeps both, so keep citing the IDs the prompt rendered.

`subgoal_refs` sits on the ITEM: an item the machine verifies backs exactly the
sub-goals it names here. That is what produces a derived verified-sub-goal fact
— and it never changes `SubGoal.status`, which stays your declaration.

Item status is machine-derived: `pending` (never claimed met), `insufficient`
(claimed `met`, not backed), `contradicted` (a bound command failed, or a
passing command's entrypoint changed that round), `verified` (you claimed `met`
AND every bound command was observed passing — after phase, entrypoint
untampered, same command configuration as at declaration). Claim an item by
citing its `rci-` ID in `execution_report.contract_item_claims`.

A claim never creates a verified fact, and machine evidence can only go stale
in one direction: the LATEST observation at or after your claim decides, so a
command that passed early and FAILED in the closing round makes the item
`contradicted` — a pass cannot outlive a later failure. Claimed-but-unbacked is
`insufficient`: the round still commits and the debt is surfaced, but once the
debt persists for `engine.unverified_claim_streak_limit` consecutive rounds
(default 3) the round is rejected; a repeat of the SAME check rejects again with
an escalation notice, and the third consecutive same-check rejection terminates
the loop as `incomplete`.

The contract closes when every item is `verified`, or when a round reports
`outcome: "blocked"` with a `blocker`. While it is open, a DIFFERENT proposal is
ignored (`contract_premature`) — restate the active contract unchanged to
continue it. Git changes outside the declared `scope` are scope drift, a machine
fact no explanation waives: revert the out-of-scope files, or close the contract
with `outcome: "blocked"` and declare the extended scope in the same submission.
Repeated drift terminates the loop.

Declaration and item claims are a strict structural boundary — `contract_invalid`
with a same-`roundId` retry and zero state change: a contract with no items, more
items/scope/refs than the declared limits allow (20 items, 20 `criterion_refs`,
20 `subgoal_refs` and 20 commands per item, 50 `scope` entries), an item with no
`verify_with`, an item naming an unknown, disabled, or non-after-capable
command, a `scope` entry that is not a string or that leaves the workspace, a
malformed `subgoal_refs` entry, a `subgoal_refs` ID that names no sub-goal of
this loop (including a sub-goal beyond the 50-entry `emerged_subtasks` intake),
and a malformed, duplicate, or unknown `contract_item_claims` entry.
`criterion_claims` are advisory and lenient: an entry with an unknown or
malformed criterion ID, or an outcome other than `met` / `remaining`, is
dropped with a warning and never rejects the round.

The commands `verify_with` may name are the ones your `loop_policy.json`
declares under `evidence.commands` and enables there; the runtime runs them
itself, without a shell, inside the workspace. An item whose bound command
changed configuration since the contract was declared is `insufficient`, not
`verified` — the declaration stamps the command configuration it was made
under.

## Backtrack

A progress stall can trigger backtrack to the last clean committed round — the
most recent committed round with no error-level verification flags. The stall
window is 3 committed rounds (the breaker tier that follows it uses
`engine.stall_lookback_rounds`, default 3), and the verdict is MACHINE-first:
when git observations exist for the window, machine motion alone decides it,
and your `progress_estimate` does not enter — a rising estimate cannot cancel a
stall, and git motion can only excuse one (it never creates one). Your reported
estimates are consulted only when the loop has no machine history to read (no
git provider, or fewer rounds than the window). One machine fact is exempt by
construction: a round whose success the machine verified is finishing, not
churning — the closing round of a loop often changes no files at all. So the way
out of a stall is real, observable work.

The backtrack commits a rollback directive that stays out of final history:
your next submission is the REDO of round `restorePoint + 1` and must reuse the
round ID the prompt carries; when it commits, the rollback record is replaced
and disappears from history views.

The backtrack prompt opens with a derived **Recovery Brief**:

- the trigger rule and the restore point;
- the redo round's ID (pass it back unchanged to `loopforge_next`);
- the failed rounds and their approaches — what must NOT be repeated;
- falsified assumptions — do not rebuild on these;
- discoveries from the skipped rounds that remain valid;
- the files to revert and the HEAD the workspace must return to. The prompt
  states these as FACTS and never prescribes a command — the restore is yours
  to perform, by whatever means you judge best.

The same brief renders in `.loopforge/state/<loopId>-state.md` under Recent
while the recovery window is open; it is derived from committed rounds plus
the in-flight attempt (rejected payloads are never a source) and disappears
once the redo commits.

When backtrack occurs:

1. Restore the workspace exactly as requested before doing more work — the
   next submission's git evidence is checked against the restore point's HEAD.
2. Read the Recovery Brief, the restored prompt, and the derived state.
3. Do not repeat a failed approach listed in the brief without addressing it.
4. Keep valid discoveries from skipped rounds in later evaluations.

If the workspace is not restored, the next submission is rejected with
`backtrack_workspace_not_restored`.

When the rolled-back rounds executed under an ACTIVE contract, the redo follows
the contract path instead of a plain retry: close the stalled contract in the
redo submission with `outcome: "blocked"` plus a `blocker` explaining why it
stalled, and declare the REVISED contract in the same submission. Restating the
stalled contract unchanged keeps it active and commits more of the same, and a
different proposal while an old contract is still open is ignored as
`contract_premature`.

## Interpret results

- `prompt` is non-null: execute it and submit the next evaluation.
- `enforcementAction: "reject"`: redo the same logical round. The round ID is
  stable and the attempt increases.
- `enforcementAction: "backtrack"`: restore the workspace, then continue from
  the restored prompt and round.
- `prompt` is null: inspect `stopReason`.

Each response also carries the posture of the round that just committed:
`verificationStatus` (`trusted` when everything you claimed is machine-backed,
`insufficient` when claims are unbacked but nothing is denied, `contradicted`
when a machine fact denies a claim — it is never a judgement about the quality
of your work), `roundSuccess`, `level`, and `warnings`. `enforcementReason`
explains a rejection or termination. Read these before planning the next round:
an `insufficient` posture is a statement about evidence, not about effort.

Errors arrive as `{ok: false, error: {code, message, retryable, ...}}`. `code` is
stable — branch on it, not on the prose in `message`. `evaluation_invalid`,
`contract_invalid`, `policy_invalid`, `round_id_required`, `round_id_mismatch`,
and `invalid_argument` are `retryable`: fix the payload and resubmit the same
`roundId`. `state_unavailable` means the record you asked for is not there (no
audit data for that loop, no such gate record), `session_not_found` that the
session is gone: state conditions, not payload defects — do not resubmit the
same payload hoping for a different answer. `gate_disabled` means the gate layer
is off in this policy, and `loop_already_running` that a session for this loop
already exists in this process — inspect or resume it instead of starting a
duplicate.

`completed` means the machine verified the completion: success plus every
contract item `verified`, or no active contract. An explicit `outcome:
"blocked"` (or `stop_reason: "blocked"` / `"needs_human_input"`) always stops as
`blocked`, never as `completed`. `incomplete` means you stopped while the
machine could not verify completion — claims the bound commands did not back;
contract verification debt that persisted past
`engine.unverified_claim_streak_limit` also ends here rather than accepting
another unverified round. `failed` means the Agent gave up. `max_rounds` is the
safety limit. `stalled` means the runtime could not produce the next round's
prompt. `enforcement_terminated` means repeated integrity failures reached a
terminal ladder. `paused` means the durable session remains available for
resume, and `cancelled` that the session was deleted.

## Prompt levels and views

L0 is a lean same-round retry, L1 is normal continuation, and L2 is full
rehydration. They control state density only and never prescribe a reasoning
technique. L2 is chosen from FACTS about the round — the first round, a plan or
checkpoint boundary, a committed recovery, a machine contradiction, a repeated
rejection, a changed objective, a previous state the runtime can no longer read
— never from a round counter, so nothing changes in the prompt just because the
loop has been running for a while. Protected prompt sections and
the token budget remain enforced; when the protected content alone exceeds the
ceiling the prompt records `protectedOverflow` rather than dropping it, and
which sections were rendered is recorded in the prompt artifact.

Use `loopforge_status` with `view: "session"` for the live round and typed
projection, `view: "loop"` for machine counts over committed rounds, `view: "all"`
after a restart, `view: "audit"` for the read-only completeness and evidence
audit, and `view: "explain"` (loopId, optional `round`) for the per-round "why"
view — the active contract, item statuses, observations, and flags. The same
view is available from the CLI as `loopforge explain LOOP_ID [--round N]
[--json]`. Use `loopforge_replay` for the committed timeline and round diffs.
Replay answers what happened; Audit checks whether facts and claims are
supported; Explain shows why a round was decided the way it was.

The optional `.loopforge/state/<loopId>-state.md` file is derived and can be
regenerated. In L2 the prompt may omit the full markdown state and point at
that file instead (pointer mode), so read it when the prompt says so — but it
is a derived view, never an independent source of truth.

## Control and delegation

Use `loopforge_pause` before an intentional interruption,
`loopforge_resume` to reconstruct a durable session, and `loopforge_stop` only
for an intentional terminal stop.

The two gate tools are opt-in (`policy.gate.enabled`, default false) and are
hidden from `tools/list` when disabled (a direct call then returns
`gate_disabled`). When enabled, preflight a high-risk action with
`loopforge_gate_check`, whose `action` is a structured descriptor:

- `description`: what the action does ("Deploy to production");
- `scope`: files, systems or services it touches;
- `effects`: any of `workspace_write`, `production`, `credentials`,
  `data_migration`, `public_api`, `publish`, `payment`,
  `external_communication`, `network`;
- `reversibility`: `reversible` / `recoverable` / `irreversible` / `unknown`;
- `authorization`: `agent_allowed` / `user_required` / `unknown`.

Classification is conservative: anything not provably safe is `user_required`,
which returns a gate id and an approval question. Present that question to the
human, record their decision with `loopforge_gate_resolve`, and cite the
approved gate id via `evaluation.gate_ids` in the round that performs the
action — an unapproved or unknown cited gate rejects the round. Safe
preparation work (investigation, dry-runs, rollback evidence) never needs a
gate. Remember: approval is recorded through you, the Agent — LoopForge cannot
machine-verify a human is present.

Delegation does not create a separate LoopForge mode. Give each worker a
self-contained subtask and relevant hard constraints, then place its result in
`worker_results` so discoveries can enter the next Canonical State.

## Rules

1. Execute the prompt instead of generating another prompt.
2. Submit one honest structured evaluation after each attempt.
3. Restore the workspace before working after backtrack.
4. Treat required command evidence and verification errors as authoritative.
5. Keep one loop focused on one user objective.
6. Do not advance a paused or stopped session through another process.
7. Continue within the same Agent task when possible. LoopForge preserves state
   but does not create a background Agent.
