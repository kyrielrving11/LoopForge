import { createHash } from "node:crypto";
import type { VaultEntry } from "./backends/interface.js";
import type { RegressionObligation, RoundEvidenceEnvelope } from "./protocol.js";
import { parseWorkflowEventEntry, type WorkflowEvent } from "./workflow-events.js";

function obligationId(sourceStepId: string, checkName: string, claimId: string): string {
  const digest = createHash("sha256").update(`${sourceStepId}\0${checkName}\0${claimId}`).digest("hex").slice(0, 18);
  return `ro-${digest}`;
}

function statusForCheck(envelope: RoundEvidenceEnvelope, checkName: string): RegressionObligation["lastStatus"] {
  const check = envelope.checks.value.find((item) => item.name === checkName);
  if (!check) return "unavailable";
  const confidence = envelope.checkProvenance?.[checkName]?.confidence;
  if (check.status === "failed" || confidence === "contradicted") return "contradicted";
  if (check.status === "passed" && (confidence === "verified" || envelope.checkProvenance?.[checkName]?.source === "command" || envelope.checkProvenance?.[checkName]?.source === "provider")) return "verified";
  return "unavailable";
}

function checkReferences(envelope: RoundEvidenceEnvelope, claimId: string): string[] {
  return envelope.claims.find((claim) => claim.targetId === claimId)?.evidenceRefs
    .filter((reference) => reference.startsWith("check:"))
    .map((reference) => reference.slice("check:".length)) ?? [];
}

/** Rebuilds regression obligations from accepted workflow events. No obligation
 * state is stored separately, so replay/backtrack remains deterministic. */
export function deriveRegressionObligations(entries: VaultEntry[], throughRound?: number): RegressionObligation[] {
  const events = entries
    .filter((entry) => entry.task_type === "workflow_step_result" || entry.task_type === "workflow_backtrack_restored")
    .map((entry) => parseWorkflowEventEntry(entry))
    .filter((event): event is WorkflowEvent => Boolean(event))
    .sort((a, b) => a.round - b.round || a.eventId.localeCompare(b.eventId));
  const active: WorkflowEvent[] = [];
  for (const event of events) {
    if (throughRound !== undefined && event.round > throughRound) continue;
    if (event.eventType === "backtrack_restored") {
      const target = event.payload.to_round;
      for (let index = active.length - 1; index >= 0; index--) {
        if (active[index].eventType === "step_result" && active[index].round > target) active.splice(index, 1);
      }
      continue;
    }
    active.push(event);
  }
  const obligations = new Map<string, RegressionObligation>();
  for (const event of active) {
    if (event.eventType !== "step_result" || !event.payload.evidence) continue;
    const envelope = event.payload.evidence;
    for (const claim of envelope.claims.filter((item) => item.targetId.startsWith("er-"))) {
      for (const checkName of checkReferences(envelope, claim.targetId)) {
        const id = obligationId(event.payload.step_id, checkName, claim.targetId);
        const status = statusForCheck(envelope, checkName);
        const current = obligations.get(id);
        const next: RegressionObligation = current ?? {
          id,
          sourceStepId: event.payload.step_id,
          sourcePlanVersion: event.planVersion ?? 0,
          checkName,
          claimId: claim.targetId,
          lastStatus: status,
          lastVerifiedRound: status === "verified" ? event.round : null,
          latestEvidenceRef: `check:${checkName}`,
        };
        if (current && current.lastStatus !== status) next.lastStatus = status;
        if (status === "verified") next.lastVerifiedRound = event.round;
        next.latestEvidenceRef = `check:${checkName}`;
        obligations.set(id, next);
      }
    }
    // A later accepted check can regress an obligation even when the current
    // step did not repeat the original claim.
    for (const current of obligations.values()) {
      const status = statusForCheck(envelope, current.checkName);
      if (!envelope.checks.value.some((check) => check.name === current.checkName)) continue;
      current.lastStatus = status;
      if (status === "verified") current.lastVerifiedRound = event.round;
      current.latestEvidenceRef = `check:${current.checkName}`;
    }
  }
  return [...obligations.values()].sort((a, b) => a.id.localeCompare(b.id));
}

export function regressionSummary(obligations: RegressionObligation[]): { total: number; verified: number; gaps: number } {
  const verified = obligations.filter((item) => item.lastStatus === "verified").length;
  return { total: obligations.length, verified, gaps: obligations.length - verified };
}
