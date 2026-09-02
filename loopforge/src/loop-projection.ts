/** v2.12: Typed cognitive state projection — runtime-derived facts shipped
 *  with advance/status outputs. Pure function, zero persistence; every
 *  input already exists in compile outputs and vault entries.
 *
 *  Discipline: every field has a consumer (advance output for the main
 *  agent, status for human/tooling, resume handoff). No display-only
 *  decoration — the runtime provides facts, the agent decides actions.
 */

import { deriveTodoId } from "./cognitive-governance.js";
import type { VaultEntry } from "./loop-store.js";
import type { LoopForgeResponse, LoopProjection, SubGoal } from "./protocol.js";
import { makeLoopProjection } from "./protocol.js";
import { isRecord, entryRound as sharedEntryRound } from "./token-utils.js";

export interface ProjectionInput {
  loopId: string;
  currentRound: number;
  /** Compiler output with v2.12 derived-state passthrough. */
  compileResponse: LoopForgeResponse | null;
  vaultEntries: VaultEntry[];
  /** cr-IDs backed by verified claims (P0 provenance layer). */
  verifiedClaims?: string[];
  /** Undecided user gate descriptions (recorded gate_opened without a
   *  matching gate_decision). */
  openGates?: string[];
}

function entryRound(entry: VaultEntry): number {
  return sharedEntryRound(entry as unknown as Record<string, unknown>);
}

/** Focus: the most recent non-failed round's output summary. */
function deriveFocus(
  entries: VaultEntry[],
  currentRound: number,
): LoopProjection["focus"] {
  const candidates = entries
    .filter((entry) => {
      const round = entryRound(entry);
      return round >= 1 && round < currentRound &&
        typeof entry.output_summary === "string" &&
        entry.output_summary.length > 0 &&
        entry.success !== false;
    })
    .sort((a, b) => entryRound(b) - entryRound(a));
  const latest = candidates[0];
  if (!latest) return null;
  return {
    what: (latest.output_summary as string).slice(0, 200),
    since_round: entryRound(latest),
  };
}

/** Todo: pending/blocked sub-goals (derived) + declared next_action /
 *  emerged subtasks (agent intent). Capped at 10. */
function deriveTodo(
  compileResponse: LoopForgeResponse | null,
  entries: VaultEntry[],
): LoopProjection["todo"] {
  const todo: LoopProjection["todo"] = [];
  const push = (item: string, reason: string, source: "derived" | "agent_intent", priority: number): void => {
    if (todo.length >= 10) return;
    if (item.trim().length === 0) return;
    todo.push({ id: deriveTodoId(item), item: item.slice(0, 200), reason, source, priority });
  };

  // Derived: pending/blocked sub-goals from the compiler's dashboard.
  for (const subGoal of compileResponse?.sub_goals ?? []) {
    const sg = subGoal as SubGoal;
    if (sg.status === "pending") {
      push(sg.description, "pending sub-goal", "derived", sg.priority ?? 5);
    } else if (sg.status === "blocked") {
      push(sg.description, "blocked sub-goal", "derived", 9);
    }
  }

  // Agent intent: the declared next action from the most recent round.
  const latest = [...entries]
    .filter((entry) => typeof entry.next_action === "string" &&
      (entry.next_action as string).length > 0)
    .sort((a, b) => entryRound(b) - entryRound(a))[0];
  if (latest) {
    push(latest.next_action as string, "agent-declared next action", "agent_intent", 0);
    const emerged = Array.isArray(latest.emerged_subtasks)
      ? (latest.emerged_subtasks as string[])
      : [];
    for (const subtask of emerged) push(subtask, "agent-declared emerged work", "agent_intent", 6);
  }
  return todo;
}

/** Phase: milestone boundaries in round order; current = the phase after
 *  the last milestone. */
function derivePhase(
  compileResponse: LoopForgeResponse | null,
): LoopProjection["phase"] {
  const milestones = compileResponse?.rolling_summary?.milestones;
  if (!milestones || milestones.length === 0) return null;
  const boundaries = milestones
    .filter((m) => typeof m.round_range?.end === "number")
    .map((m) => ({ label: m.label, round: m.round_range.end as number }));
  const last = boundaries[boundaries.length - 1];
  return {
    current: last ? last.label : "",
    label: last ? last.label : "",
    boundaries,
  };
}

/** Delegation: record view of the main agent's reported worker results.
 *  Facts only — never a task book. */
function deriveDelegation(
  entries: VaultEntry[],
): LoopProjection["delegation"] {
  const journals = entries
    .filter((entry) => entry.task_type === "delegation_journal")
    .sort((a, b) => entryRound(b) - entryRound(a));
  const latest = journals[0];
  if (!latest) return { pending: 0, last_results: [] };
  const lineage = isRecord(latest.loop_lineage) ? latest.loop_lineage : null;
  const delegations = Array.isArray(lineage?.delegations)
    ? lineage.delegations as Array<Record<string, unknown>>
    : [];
  const round = entryRound(latest);
  const lastResults = delegations.slice(-5).map((d) => ({
    agentId: typeof d.agentId === "string" ? d.agentId : "",
    outcome: typeof d.outcome === "string" ? d.outcome : d.success === true ? "success" : "failed",
    round,
    summary: typeof d.resultSummary === "string" ? d.resultSummary.slice(0, 200) : "",
  }));
  return {
    pending: delegations.filter((d) => d.outcome === "partial" || d.outcome === "failed" ||
      (d.outcome === undefined && d.success !== true)).length,
    last_results: lastResults,
  };
}

/** Handoff: resume capsule. verified = P0 provenance cr-IDs; open_risks =
 *  recurring issues + undecided user gates. */
function deriveHandoff(
  compileResponse: LoopForgeResponse | null,
  verifiedClaims: string[],
  openGates: string[],
): LoopProjection["handoff"] {
  const rolling = compileResponse?.rolling_summary;
  const summary = rolling?.loop_synthesis ?? "";
  const openRisks = [...new Set([
    ...(rolling?.recurring_issues ?? []).slice(0, 5),
    ...openGates.slice(0, 3).map((gate) => `user gate pending: ${gate}`),
  ])];
  return {
    summary,
    verified: verifiedClaims ?? [],
    open_risks: openRisks,
  };
}

/** Build the typed projection. Returns null only when nothing meaningful
 *  can be derived (fresh loop with no compile response). */
export function buildLoopProjection(input: ProjectionInput): LoopProjection | null {
  const projection = makeLoopProjection({
    focus: deriveFocus(input.vaultEntries, input.currentRound),
    todo: deriveTodo(input.compileResponse, input.vaultEntries),
    phase: derivePhase(input.compileResponse),
    delegation: deriveDelegation(input.vaultEntries),
    handoff: deriveHandoff(input.compileResponse, input.verifiedClaims ?? [], input.openGates ?? []),
  });
  const empty = projection.focus === null && projection.todo.length === 0 &&
    projection.phase === null && projection.delegation.last_results.length === 0 &&
    projection.handoff.summary.length === 0;
  return empty ? null : projection;
}
