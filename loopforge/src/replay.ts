/** ReplayBackend — time-travel queries over vault lineage.
 *
 * Depends on VaultBackend interface — no direct filesystem access.
 * Enables audit, comparison, and timeline analysis of loop rounds.
 */

import type { VaultBackend, VaultEntry } from "./backends/interface.js";
import { buildGovernanceGraph } from "./governance-graph.js";
import type { GovernanceGraphView } from "./governance-graph.js";
import { parseWorkflowEventEntry } from "./workflow-events.js";

export type {
  GovernanceGraphDiagnostic,
  GovernanceGraphDiagnosticCode,
  GovernanceGraphEdge,
  GovernanceGraphEdgeKind,
  GovernanceGraphNode,
  GovernanceGraphNodeKind,
  GovernanceGraphSummary,
  GovernanceGraphView,
} from "./governance-graph.js";

// ═══════════════════════════════════════════════════════════════════════════
// ReplayBackend
// ═══════════════════════════════════════════════════════════════════════════

export class ReplayBackend {
  private readonly backend: VaultBackend;

  constructor(backend: VaultBackend) {
    this.backend = backend;
  }

  // ── Single-round lookup ────────────────────────────────────────────────

  getRound(loopId: string, roundNum: number): VaultEntry | null {
    const prefix = `loop:${loopId}:r${roundNum}`;
    const entries = this.backend.queryEntries({ prefix });

    const lineageEntries = entries.filter(
      (e) => !String(e.task_id ?? "").endsWith(":feedback"),
    );

    if (!lineageEntries.length) return null;

    const preferred = lineageEntries.find((entry) => entry.task_type === "loop_lineage")
      ?? lineageEntries.find((entry) => entry.task_type === "feedback")
      ?? lineageEntries[0];
    const entry = { ...preferred };

    // Merge feedback success flag
    const fbEntries = this.backend.queryEntries({
      prefix,
      feedbackOnly: true,
    });
    if (fbEntries.length) {
      const fbSuccess = fbEntries[0].success;
      if (fbSuccess !== undefined) {
        entry.success = fbSuccess;
        const lineage = (entry.loop_lineage ?? {}) as Record<string, unknown>;
        (lineage as Record<string, unknown>).success = fbSuccess;
        entry.loop_lineage = lineage;
      }
    }

    return entry;
  }

  // ── Multi-round replay ─────────────────────────────────────────────────

  replay(
    loopId: string,
    opts?: { start?: number; end?: number },
  ): VaultEntry[] {
    const start = opts?.start ?? 1;
    let end = opts?.end;
    if (end === undefined) {
      end = this.maxRound(loopId);
      if (end === 0) return [];
    }

    const results: VaultEntry[] = [];
    for (let rnd = start; rnd <= end; rnd++) {
      const entry = this.getRound(loopId, rnd);
      if (entry) results.push(entry);
    }
    return results;
  }

  // ── Timeline ──────────────────────────────────────────────────────────

  timeline(loopId: string): Record<string, unknown>[] {
    const entries = this.replay(loopId);
    const timeline: Record<string, unknown>[] = [];

    for (const entry of entries) {
      const lineage = (entry.loop_lineage ?? {}) as Record<string, unknown>;
      const round = Number(lineage.round ?? 0);
      const workflowEvents = this.backend.queryEntries({ prefix: `loop:${loopId}:r${round}:workflow:` });
      const parsedWorkflow = workflowEvents.map(parseWorkflowEventEntry).filter((event) => event !== null);
      const latestWorkflow = parsedWorkflow.at(-1);
      timeline.push({
        round,
        recompile_level: lineage.recompile_level ?? "l2",
        success: entry.success ?? lineage.success ?? false,
        task: (lineage.task as string) ?? "",
        goal_id: lineage.goal_id ?? "",
        phase: latestWorkflow?.phase ?? null,
        plan_version: latestWorkflow?.planVersion ?? null,
        active_step_id: latestWorkflow?.activeStepId ?? null,
        workflow_events: parsedWorkflow.map((event) => ({
          type: event.eventType,
          step_id: "step_id" in event.payload ? event.payload.step_id : null,
          step_status: event.eventType === "step_result" ? event.payload.step_status : null,
        })),
      });
    }

    timeline.sort((a, b) => (a.round as number) - (b.round as number));
    return timeline;
  }

  graph(loopId: string, options?: { throughRound?: number }): GovernanceGraphView {
    const entries = this.backend.queryEntries({ prefix: `loop:${loopId}:` });
    return buildGovernanceGraph(loopId, entries, options);
  }

  // ── Helpers ─────────────────────────────────────────────────────────────

  private maxRound(loopId: string): number {
    const prefix = `loop:${loopId}:r`;
    const entries = this.backend.queryEntries({ prefix });
    let maxR = 0;

    for (const e of entries) {
      const lineage = (e.loop_lineage ?? {}) as Record<string, unknown>;
      const rnd = lineage.round as number;
      if (typeof rnd === "number" && rnd > maxR) maxR = rnd;
    }

    return maxR;
  }
}
