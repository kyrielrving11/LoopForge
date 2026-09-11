# LoopForge

**A context window is not memory. Memory needs a runtime.**

**Version per `LoopForge/package.json`** — `npm install -g loopforge`. Node.js ≥ 18. Zero runtime dependencies.
> [中文文档](./README.zh-CN.md)

---

## The real problems with long-horizon tasks

Any AI coding agent, given a long enough task, hits three walls. Not because
the model isn't smart enough. Not because the context window isn't large
enough. These are **architectural** problems.

### Problem 1: The summary cascade

Context fills up → compress. Fills up again → compress again. The third
compression is a summary of a summary of a summary. Every cycle evaporates
information — critical constraints get silently deleted because the summarizer
judged them "no longer relevant." Researchers found that after 3–4 summary
cycles, constraint violation rates spike from 0% to 59%. The agent doesn't
know what it forgot, because the forgetting itself was compressed away.

**This is what happens when you treat cognitive state as context. The bucket
always leaks.**

### Problem 2: Self-correction doesn't work

Google DeepMind's conclusion is clear: models cannot reliably improve
themselves through introspection. They talk themselves out of correct answers.
Effective recovery requires an **external verifier** — an independent observer
that doesn't share the agent's context, doesn't participate in its reasoning,
and only looks at inputs and outputs. The verifier must never be the same
context that made the mistake.

### Problem 3: Compound error (p^N)

If each step succeeds with probability p, N sequential steps succeed with
probability p^N. METR found that frontier agents nail nearly 100% of tasks
a human finishes in under 4 minutes, then crater to under 10% on tasks taking
more than 4 hours. Small errors at each step become the correct input for the
next step. The agent builds on errors, each step looking locally reasonable,
while the entire trajectory is fiction.

**These three problems amplify each other. The summary cascade loses
information → lost information becomes errors → the agent can't self-correct
because those errors look reasonable within its own context.**

---

## What LoopForge does about it

LoopForge runs outside the agent and owns the boundary between rounds. It
accepts a structured report, collects evidence, checks the report, decides
whether the round may commit, and recompiles the next prompt from committed
facts.

The runtime keeps two sources deliberately separate:

- **One factual source:** committed typed round documents in the Vault.
- **One cognitive source:** Canonical State compiled from those committed
  facts.

This separation prevents a presentation view, metric, or model narrative from
quietly becoming a second history.

### 1. One factual source

`loopforge_next` accepts a structured `evaluation`. Four core fields are
strict: `success`, `output_summary`, `constraint_violations`, and
`should_continue`. Optional fields are normalized by the runtime, with two
exceptions — the Round Contract declaration and `contract_item_claims` are
strict structural boundaries that return `contract_invalid` before the round
advances. Missing or mistyped core fields return `evaluation_invalid`; the
agent can correct the payload and resubmit it with the same `roundId`. This
path does not save the session, write a round, run either gate, or change
rejection and metrics state.

After validation, LoopForge collects machine observations (Git and configured
commands), runs the verification and enforcement gates, and commits only an
allowed round. The agent's own report is a claim, never evidence: it carries
`files_changed`, `tests_reported`, `criterion_claims`, `contract_item_claims`,
and `progress_estimate`, and none of it can create a verified fact — only the
observations can. The committed round documents are the durable record.
Rejected and in-flight attempts do not join that record, and rolled-back
backtrack decisions are excluded from final history views.

All historical readers use the same internal `CommittedRoundView`. It decodes,
orders, deduplicates, and filters round documents once for Replay, Audit,
Metrics, contracts, compilation, and gate history. It is a read model, not a
second persistence format.

### 2. One cognitive source

The compiler evolves Canonical State from committed facts. Objectives,
constraints, evidence, milestones, sub-goals, decisions, and progress enter the
next prompt through this state, rather than through a summary of the previous
prompt.

`DerivedCognitiveFacts` derives focus, todo, phase, delegation, and handoff from
Canonical State and committed rounds. The prompt, optional state file, and
status projection consume the same facts. Deleting the state file loses no
truth because LoopForge can regenerate it.

Stable IDs (`c-`, `cr-`, `sg-`, `rc-`, and `rci-XXXXXXXX`) provide exact
references where the agent supplies them. Everything else is matched by
normalized-exact text — there is no similarity fallback: a paraphrase is a
different criterion, constraint or emphasis target, not a fuzzy match.
Sub-goal creation is deliberately the opposite of a content hash: a `sg-` ID is
scoped to its declaration event, so re-declaring the same text in a later round
is a new sub-goal. Within one declaration round, exact repeats keep only their
first entry and are reported as `duplicate_declaration`.
`subgoal_updates` — the only way to change a sub-goal's status — must cite ACTIVE
`sg-` IDs exactly: unknown, terminal (done/canceled), or illegal transitions are
rejected as `evaluation_invalid` before the round advances.

```text
Traditional: prompt -> summary -> next prompt -> another summary
LoopForge:    committed rounds -> Canonical State -> next prompt
```

### 3. External verification and enforcement

The verification gate organizes its 20 checks into four verification domains —
evaluation consistency, evidence integrity, plan & contract, and progress &
recovery — against Git snapshots, command observations, and explicitly
configured commands. The enforcement gate turns those findings into accept,
reject, backtrack, or terminate decisions through one ordered strategy table;
each row carries its own escalation ladder, so repeated rejections of the same
check escalate and eventually terminate instead of looping. A single
success-evidence policy covers unbacked success claims — machine backing means
an untampered, passed after-phase verification command; a declared
`no_change_reason` is the honest escape only when NO verification command is
configured (machine verification was structurally impossible). A single stall
evaluator covers both stalled and exactly-flat progress windows. Machine
evidence can excuse a progress-stall verdict when Git motion is observed;
self-reported progress cannot create a machine verdict or cancel one.

Providers emit typed machine observations with statuses `observed | passed |
failed | timeout | unavailable | error | aborted`. A configured provider always
produces one — unavailability, timeouts, errors, and aborts are recorded in the
round's factual record rather than filtered away. The committed transaction
persists only the before/after observation collections; the round delta is
derived from them, never stored. A legacy transaction envelope is a hard break:
those rounds are not history, and the audit lists them explicitly.

Round Contracts are item-based. A proposal declares `items`, each bound to at
least one configured, enabled evidence command, and becomes the active contract
once the declaring round commits. The runtime derives one stable `rci-` item ID
per item and one `rc-` contract ID, both from content only — restating a
contract unchanged keeps the identity the agent already cited.
Item status (`pending`, `insufficient`, `contradicted`, `verified`) is
machine-derived: `verified` requires the agent to have claimed `met` AND every
bound command to have been observed passing in the closing round (after phase,
entrypoint untampered, same command configuration as at declaration). The active
contract is derived from committed history, remains active through retry and
resume, and closes when every item is `verified` or a round reports
`outcome: "blocked"`. While it is open, a different proposal is ignored
(`contract_premature`) — a fresh contract is only legal after the old one
closes.

Verification debt is bounded. A claimed-but-unbacked item is `insufficient`:
recorded, never a rejection, and the round still commits. But once the debt
persists for `engine.unverified_claim_streak_limit` consecutive committed rounds
(default 3) the enforcement gate rejects with instructions, and the next
same-check strike terminates the loop. The streak is derived from committed
round flags, so an agent self-report cannot move it and Git motion does not
excuse it. Scope drift is likewise a machine fact with no clarification waiver:
out-of-scope Git changes reject the round, and repeated drift terminates it.

### 4. Recovery without rewriting history

A rejected submission keeps the same logical `roundId`, increments its attempt,
and commits no round. The agent receives a focused retry prompt.

A stalled-progress evaluator can backtrack to the last clean committed round —
the most recent committed round with no error-level verification flags. The
backtrack commits a rollback directive that is excluded from final history:
the round counter returns to `restorePoint + 1`, the redo submission reuses
that round's `roundId`, and once the redo commits it physically replaces the
rollback record — so the rolled-back path never appears in Replay, Audit, or
progress windows.

The rollback directive carries a derived **Recovery Brief**:

- why it happened (the trigger rule) and the restore point;
- the redo round's ID (`loop:<id>:round:<restorePoint + 1>`);
- the failed rounds, each with the approach that must not be repeated;
- falsified assumptions — do not rebuild on these;
- preserved discoveries from the skipped rounds;
- the files that must be reverted and the HEAD the workspace must return to.

Its sources are COMMITTED rounds above the restore point plus the in-flight
attempt that triggered the rollback. Rejected payloads are not durable history
and are never a source. The brief renders at the top of the backtrack prompt
and in the state file's Recent tier for the duration of the recovery window;
the redo commit removes it by construction.

The workspace restore itself is executed by the AGENT. The backtrack prompt
states the restore FACTS — the target HEAD, the files that must be reverted —
and never prescribes a command; the prompt plus the gate's restore check are
the whole mechanism. What the verification gate "enforces" is the CHECK: on the next
submission it compares machine evidence — the git HEAD must have returned to
the restore point, and any skipped file whose git fingerprint is still
byte-identical to its failed-round state is machine proof that the workspace
was never restored (`backtrack_workspace_not_restored` keeps rejecting the
redo until it is actually clean). A redo touching the same files again is
guidance only — self-reports never buy a verdict against the agent — so
legitimate multi-file redos survive the check. A stalled Round Contract is not
a separate backtrack trigger — rollbacks come only from the progress-stall
evaluator or an unrestored workspace. But when the rolled-back rounds were
executing under
an ACTIVE Round Contract, the redo follows the contract path instead of a
plain redo: close the stalled contract with `outcome: "blocked"` (+ blocker)
and declare the revised contract in the same submission — the blocked outcome
closes the old contract, so the new proposal becomes active next round.
Restating the stalled contract unchanged only continues it.

Durable sessions, owned locks, renewable leases, and idempotent replay let the
agent resume after process interruption without skipping or double-committing
a round.

---

## What LoopForge is not

- **Not a memory database.** The optional state file is derived. Committed
  round documents hold facts, and Canonical State supplies runtime cognition.
  LoopForge has no RAG or vector database.
- **Not a context compressor.** It recompiles prompts from typed state instead
  of compressing the prior prompt.
- **Not a constraint tracker.** Constraints are one input to external
  verification and enforcement, not the product boundary.
- **Not a self-report ledger.** Everything the agent writes about its own work
  is a claim. Only committed machine observations can mark a contract item
  `verified`, and no claim ever becomes a fact.
- **Not an agent or unattended executor.** The external agent reads code,
  edits files, runs tools, and chooses its reasoning. LoopForge governs round
  transitions.

---

## Install

```bash
npm install -g loopforge
loopforge init --client claude
claude mcp add loopforge -- npx loopforge mcp
```

Works with Claude Code, Codex CLI, or any MCP-compatible client.

The MCP server path (`loopforge mcp`) is the primary integration. It provides
the full cognitive infrastructure: verification gate, enforcement gate,
backtrack, evidence collection, and crash recovery. The engine is also
available as a library for custom integrations — see the
[API reference](./loopforge/README.md).

---

## Architecture

```text
External agent
  executes work and submits a structured evaluation (claims)
                         |
                         v
Evaluation boundary
  strict core fields + strict contract / sub-goal structure
  lenient optional normalization
  invalid -> retry same roundId, no state mutation
                         |
                         v
Round boundary
  machine observations (before/after) -> verification gate
  -> enforcement gate
                         |
             +-----------+-----------+
             |                       |
      reject/terminate          accept/stop/backtrack
      no round commit            commit transaction decision
                                       |
                                       v
Committed round documents
  single durable factual source
  transaction schema 2: observations persisted, delta derived
                                       |
                                       v
CommittedRoundView
  one decoder and one history policy
                         |
              +----------+----------+
              |          |          |
       Canonical State  Replay   Audit / Metrics / Explain
       cognitive source timeline evidence, diagnostics, why
              |
              v
DerivedCognitiveFacts
  focus, todo, phase, delegation, handoff
              |
              v
PromptArtifact / state file / status projection
              |
              v
External agent, next round
```

The current-round gates also inspect the submitted evaluation and fresh
observations before commit. Their historical inputs still come through the
shared committed-round view.

---

## Core capabilities

### Structured round protocol

The MCP boundary validates primitive JSON arguments and structured tool
outputs. The four required evaluation fields are strict, while optional
evaluation detail is normalized and bounded. Two optional structures are strict
as well — the Round Contract declaration and `contract_item_claims` — and
return `contract_invalid` for a same-`roundId` retry with zero state change.
Format errors are retryable and cannot contaminate round state.

### Deterministic state reconstruction

The compiler reconstructs state from committed rounds. It tracks five-state
sub-goals, discovered constraints, phase milestones, machine observations and
the active Round Contract without adding another persistence model. Diagnostics
— the progress dashboard, per-round stats, the recurring-flag history — live in
the state file and the read-only status views, never in the prompt.
L0, L1, and L2 select prompt density only. They do not prescribe a reasoning
technique.

### Evidence-backed decisions

Verification derives claim provenance and machine status from collected
observations. Enforcement turns those findings into accept, reject, backtrack,
or terminate decisions, and bounds verification debt by terminating a loop that
keeps claiming unverified contract items. Metrics remain diagnostic and never
decide correctness, gate outcomes, stop conditions, or contracts.

### Separate observation views

Replay answers what happened by exposing the committed timeline and round
diffs. Audit answers whether the final facts are complete and whether claims
have supporting evidence — including any rounds dropped by a legacy
transaction schema. Explain answers why a round was decided the way it was:
its contract and item statuses, its observations, and its flags. Status
projects the current cognitive state. These interfaces stay separate because
they answer different questions, but they share the same committed-round
decoder and filtering policy.

### Controlled recovery

Retries preserve the logical round identity. Backtrack restores the last clean
round, carries forward valid discoveries, checks that the workspace matches
the restore target, and hands the agent a structured Recovery Brief — trigger,
restore point, redo round ID, failed approaches, and falsified assumptions —
in the prompt and the state file's Recent tier until the redo commits. Session
documents, monotonic round sequences, atomic writes, locks, and renewable
leases protect restart and concurrency paths.

### Agent-owned execution

The external agent remains responsible for planning and tool use. It can ask
the compiler to emphasize known state (by stable id or exact text) or surface
confusion points, but cannot remove protected prompt sections or bypass the
budget: when protected content alone exceeds the ceiling the prompt says so
(`protectedOverflow`) rather than dropping it. LoopForge does not run a
background agent.

Nine MCP tools expose the runtime: `start`, `next`, `status`, `stop`, `pause`,
`resume`, `replay`, `gate_check`, and `gate_resolve`. The two gate tools are
opt-in — hidden from `tools/list` unless `policy.gate.enabled` is true (the
default is false). 

---

## License

MIT
