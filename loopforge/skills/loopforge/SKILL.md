---
name: loopforge
description: Govern long-horizon coding work with durable objectives, constraints, structured plans, evidence, approval gates, and recovery state. Use for multi-round, cross-session, high-constraint, or auditable tasks; skip short, single-file, exploratory, or rapidly changing work.
---

# LoopForge

LoopForge is the external state and verification layer. You remain the Agent
that reads code, edits files, runs tests, and makes engineering decisions.
LoopForge is not a second engineer and does not execute work in the background.

## Start and plan

1. Determine the target workspace. In a multi-root task, ask the user when the
   target is ambiguous; never infer it from the MCP process CWD.
2. Call `loopforge_start` with `workspaceRoot`, the complete objective, and hard
   constraints. Do not add a separate initialization tool call.
3. Verify `capabilityPreflight`, especially the server/report versions,
   workspace/store binding, and Git/command evidence availability, before
   following `requiredAction`. Treat `commandEvidence: "blocked"` as an
   explicit host authorization boundary; do not edit a workspace policy to
   bypass it. The MCP host must set `LOOPFORGE_ALLOW_WORKSPACE_COMMANDS=1`.
4. When it returns `submit_plan`, inspect the repository without modifying it.
5. Submit a structured plan with `loopforge_plan_submit`. Use stable `ps-*`
   IDs, a global outline, and fully refine only the next one to three executable
   steps. This first plan is the task's global topology, not a disposable first
   phase plan. Use `dependsOn` only for real artifact, decision, gate, or
   serialized-resource dependencies.
6. If `approve_plan` is returned, show the user the exact plan version, risk
   tags, scope, and impact. Call `loopforge_plan_approve` only after the user
   decides.

Approval defaults to `risk_only`: low-risk revisions and stage refinements may
continue automatically, but fixed high-risk tags always require user approval.
When the user wants review at every plan boundary, start the session with
`approvalPolicy: "every_revision"` or configure
`workflow.approval_policy` in `loop_policy.json`. Treat the returned session
policy as authoritative for the rest of the task.

Skip LoopForge when the work is a small bug, single-file edit, explanation,
one-off script, styling tweak, or an exploration whose objective is not stable.

## Execute one round

When `requiredAction` is `execute_prompt`, execute only the returned
`activeStepId` and its direct tests. Then call `loopforge_next` with an honest
`roundId` and compact `report` containing:

- `status`: `completed`, `blocked`, or `in_progress`.
- `summary`: only concrete facts established in this round.
- `evidence`: changed files when Git cannot derive them, actual checks, and
  `ac-*`/`er-*` claim references. A final audit uses `cr-*` claims.
- `blocker` only for blocked work, and `violations` only when real.
- `discoveries`, `delegations`, `contextRequest`, or `planChangeRequest` only
  when those events actually occurred.

Do not send `active_step_id`, subjective progress, or a second task-state
machine. LoopForge derives the active step and required action from the fenced
`roundId` and approved plan. Repeating summaries or unchanged dirty files is
not evidence movement; three accepted no-advancement rounds trigger the stall
gate.

When `requiredAction` is `refine_plan`, inspect current evidence and submit a
full replacement with `loopforge_plan_update`, the exact `baseVersion`, reason,
change summary, and evidence references. Refine the existing plan graph rather
than starting a second plan; new executable children must identify the prior
outline with `refinesStepId`. Never delete or rewrite completed steps.

## Retry, backtrack, and audit

- `resubmit_round`: correct the report or work and retry the same `roundId`.
- `restore_workspace`: restore the workspace described by the backtrack prompt
  before continuing. The logical round and effective plan state were rewound.
- `execute_audit`: verify every success criterion, hard constraint, and required
  command against real evidence. Completion requires a successful audit.

Never claim the user task is complete while `terminal` is false. Passing tests
inside an execution round only complete that plan step. External gates must end
honestly as blocked or needing human input when they cannot be satisfied.

## Recovery and control

Use `loopforge_status`, `loopforge_replay`, and `loopforge_health` for audit and
diagnosis. Use `loopforge_pause` before an interruption. After restart, the
first call must be `loopforge_resume` with both the durable loop ID and target
`workspaceRoot`; verify the returned runtime before executing its prompt. If a
diagnostic identifies one alternate Store, retry with its recommended
arguments. Show multiple matches to the user and let them select the Store.
For a terminal external gate, resume only with the exact `planVersion`,
`stepId`, summary, and non-empty evidence references returned by the blocked
session. Resolve one gate at a time.
Never recover from Markdown because it is only a derived view. Use
`loopforge_stop` only for an intentional terminal stop.

Pre-release schema 1/2 or missing-workflow sessions cannot be resumed. When
`incompatibleSessions` or `session_version_unsupported` is returned, explain
that the files remain untouched and start a new loop instead of attempting a
session migration.

LoopForge never auto-discovers context providers, never becomes a runtime
dependency of the target project, and never owns a background Agent.
