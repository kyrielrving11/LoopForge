# Field-usage evaluation (manual protocol)

This is the behavior-validity protocol for the 3.9.3 committed-fact prompt
level and field-decision channel. It is deliberately separate from `npm test`:
unit tests prove the mechanism, but only real agent runs can show that an agent
reports the right event at the right time and does not fabricate detail.

Do not replace this with simulated payloads when reporting results. Report the
unit-test result and the real-run result separately.

## What to compare

Run the same sample tasks against the pre-change build (3.9.2) and the
post-change build (3.9.3), with the same agent/model/harness and the same task
text. Keep at least three runs per build when the task is stochastic.

## Prompt-level sequence

For every run, record per round:

- `level` and its reason (`same_round_retry`,
  `failed_without_observable_new_information`, `state_capsule`, or an L2
  fact);
- machine motion (Git changed files / HEAD) and after-phase command results;
- whether the committed evaluation declared any semantic evolution;
- whether the next round stayed L0 even though machine activity was observed
  (must be zero);
- whether a failed round with an unobservable Git/command boundary stayed L1
  rather than L0 (must be one);
- whether the L0 prompt offered the same applicable trigger set as L1/L2,
  including the real `cr-`/`rci-`/`sg-` ids;
- whether `round_contract` was proposed using the current requirement and a
  real command, and whether it became the next round's Current Task;
- whether `submission_receipt.files_reconciliation: mismatch` produced a
  concrete fix action in the next prompt and disappeared after a corrected
  report.

Use these labeled opportunity points in each sample task:

| Opportunity | Expected field | How the evaluator checks it |
| --- | --- | --- |
| A new limit is discovered | `discovered_constraints` | The submitted text is in the expected list and appears in the next round's active constraints |
| Evidence falsifies an earlier assumption | `wrong_assumptions` | The text matches the seeded false assumption; recovery/state shows it |
| A sub-problem appears | `emerged_subtasks` | A new `sg-` id is created and survives later rounds |
| A sub-goal changes status | `subgoal_updates` | The exact rendered `sg-` id reaches the expected status |
| A worker result returns | `worker_results` | The report is stored; its `discoveredConstraints` does **not** enter the active set |
| A contract slice is planned | `round_contract` | A proposal is committed and activates on the next round; its items close by machine evidence |
| A criterion is met | `criterion_claims` / `contract_item_claims` | The claim cites a real `cr-` id/text from the prompt; unknown references are dropped with a diagnostic; verification status is derived by the machine |
| Files changed | `execution_report.files_changed` | The receipt's `files_reconciliation` reports match/mismatch/unknown/not_applicable with reported/observed sets |
| A round is blocked | `outcome`, `blocker` | The Agent's `agent_stop_reason` is `blocked` and the blocker is retained |
| No event in this round | none of the above | No optional field is fabricated; diagnostics stay empty |

Control rounds: include at least one round per task where no labeled event
occurs. A control round with invented discoveries/assumptions fails the run.

Metric basis: `retainedFieldUsage` is the adoption metric; it counts only
rounds whose field accounting is complete. `attemptedFieldUsage` is a comparison
counter, never the usage rate. Always report `fieldAccountingRounds` and
`fieldAccountingIncompleteRounds` with the counts, and treat a field that was
attempted but dropped as "not used". The receipt's report handling (saved,
truncated, normalized, dropped) shows what happened to each attempt.

## Procedure

### Optional real-model runner

The repository includes `scripts/real-field-usage-experiment.ts` as a
transport and accounting harness. It starts the real LoopForge MCP server,
passes each returned prompt to `codex exec`, submits only the model's parsed
JSON response, and writes a per-round trace. Run it from `loopforge/` after a
build:

```bash
node --experimental-strip-types scripts/real-field-usage-experiment.ts
```

The runner records an unavailable or unparseable model response as an
experiment failure and never manufactures an evaluation. A standalone model
process is not equivalent to an agent with LoopForge MCP tools: if it tries to
read the state file or call `loopforge_next` itself, the run has tested the
executor boundary, not field adoption. For a valid adoption run, the model
must receive the prompt through the same MCP/client integration used in
production, or the harness must explicitly force evaluation-only output while
retaining the full prompt and its field guidance.

1. Prepare the sample task, the constraints, and a list of labeled opportunity
   points with the round in which each is expected.
2. Run the agent loop with LoopForge 3.9.2; store each `loopforge_next`
   response's `evaluation`, level, and enforcement result.
3. Run the same task with 3.9.3; store each response plus `submission_guidance`
   and `submission_receipt`.
4. For every labeled opportunity, record:
   - reported correctly (field present, structurally valid, content accurate);
   - entered the expected derived state (sub-goal/contract/constraint/checkpoint);
   - used by later work (next prompt/state/recovery);
   - fabricated (content not supported by the workspace or the prompt);
   - evidence misreport (a claim presented as verified when it is not).
5. For control rounds, record any optional field that was invented.
6. Compare the per-opportunity counts between builds. Also record repeated
   forgetting and wrong `rci-`/`sg-` references.

## Reporting

Report a table of `task × opportunity` with before/after counts and a short
note per miss. Use `retainedFieldUsage` (with its round coverage) for the
adoption column. Do not summarize field-usage counts as a quality score: the
question is whether the information was correct and used, not how many fields
were filled.

If a run discovers a protocol gap (for example, an event that has no field),
record it as a product finding; do not force the agent to invent a field.
