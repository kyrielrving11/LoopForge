import type { ProviderSnapshot } from "./evidence-provider.js";
import type {
  AgentEvidenceReport,
  ContextRequest,
  NormalizedRoundEvaluation,
  PlanStep,
  RoundCheckReport,
  RoundEvidenceClaim,
  RoundEvidenceEnvelope,
  RoundReportV1,
  StructuredPlan,
  WorkerResult,
  WorkflowPhase,
  ReportClaimTarget,
} from "./protocol.js";
import { deriveStableItemId } from "./token-utils.js";

function strings(value: unknown, max = 50): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
        .map((item) => item.trim()).filter(Boolean).slice(0, max)
    : [];
}

function hasOnlyKeys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
  const keys = new Set(allowed);
  return Object.keys(value).every((key) => keys.has(key));
}

function parseChecks(value: unknown): RoundCheckReport[] | null {
  if (!Array.isArray(value)) return null;
  const checks: RoundCheckReport[] = [];
  for (const item of value.slice(0, 50)) {
    if (!item || typeof item !== "object" || Array.isArray(item)) return null;
    const raw = item as Record<string, unknown>;
    if (!hasOnlyKeys(raw, ["name", "status", "summary", "counts"])) return null;
    const name = typeof raw.name === "string" ? raw.name.trim() : "";
    if (!name || !["passed", "failed", "not_run"].includes(String(raw.status))) return null;
    if ("summary" in raw && typeof raw.summary !== "string") return null;
    let counts: RoundCheckReport["counts"];
    if ("counts" in raw) {
      if (!raw.counts || typeof raw.counts !== "object" || Array.isArray(raw.counts)) return null;
      const countsRaw = raw.counts as Record<string, unknown>;
      if (!hasOnlyKeys(countsRaw, ["passed", "failed", "skipped"])) return null;
      if (![countsRaw.passed, countsRaw.failed, countsRaw.skipped]
        .every((count) => typeof count === "number" && Number.isInteger(count) && count >= 0)) return null;
      counts = {
        passed: countsRaw.passed as number,
        failed: countsRaw.failed as number,
        skipped: countsRaw.skipped as number,
      };
    }
    checks.push({
      name,
      status: raw.status as RoundCheckReport["status"],
      summary: typeof raw.summary === "string" && raw.summary.trim() ? raw.summary.trim() : undefined,
      counts,
    });
  }
  return checks;
}

function parseClaims(value: unknown): RoundEvidenceClaim[] | null {
  if (!Array.isArray(value)) return null;
  const claims: RoundEvidenceClaim[] = [];
  for (const item of value.slice(0, 100)) {
    if (!item || typeof item !== "object" || Array.isArray(item)) return null;
    const raw = item as Record<string, unknown>;
    if (!hasOnlyKeys(raw, ["targetId", "evidenceRefs"])) return null;
    const targetId = typeof raw.targetId === "string" ? raw.targetId.trim() : "";
    if (!targetId || !Array.isArray(raw.evidenceRefs)) return null;
    claims.push({ targetId, evidenceRefs: strings(raw.evidenceRefs, 20) });
  }
  return claims;
}

function parseEvidence(value: unknown): AgentEvidenceReport | null | undefined {
  if (value === undefined) return undefined;
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  if (!hasOnlyKeys(raw, ["files", "checks", "claims", "noChangeReason"])) return null;
  if ("files" in raw && !Array.isArray(raw.files)) return null;
  if ("noChangeReason" in raw && typeof raw.noChangeReason !== "string") return null;
  const checks = "checks" in raw ? parseChecks(raw.checks) : [];
  const claims = "claims" in raw ? parseClaims(raw.claims) : [];
  if (checks === null || claims === null) return null;
  const evidence: AgentEvidenceReport = {
    files: strings(raw.files, 200),
    checks,
    claims,
    noChangeReason: typeof raw.noChangeReason === "string" && raw.noChangeReason.trim()
      ? raw.noChangeReason.trim()
      : undefined,
  };
  return evidence.files?.length || evidence.checks?.length || evidence.claims?.length || evidence.noChangeReason
    ? evidence
    : undefined;
}

function parseContextRequest(value: unknown): ContextRequest | null | undefined {
  if (value === undefined) return undefined;
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  if (!hasOnlyKeys(raw, ["emphasize", "confusion_points"])) return null;
  if (["emphasize", "confusion_points"].some((key) => key in raw && !Array.isArray(raw[key]))) return null;
  const request: ContextRequest = {
    emphasize: strings(raw.emphasize, 5),
    confusion_points: strings(raw.confusion_points, 3).map((item) => item.slice(0, 200)),
  };
  return request.emphasize?.length || request.confusion_points?.length
    ? request
    : undefined;
}

function parseDelegations(value: unknown): WorkerResult[] | null | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) return null;
  const items: WorkerResult[] = [];
  for (const item of value) {
    if (!item || typeof item !== "object" || Array.isArray(item)) return null;
    const raw = item as Record<string, unknown>;
    if (!hasOnlyKeys(raw, ["agentId", "subAgentType", "subTask", "resultSummary", "success", "discoveredConstraints"])) return null;
    if (typeof raw.agentId !== "string" || typeof raw.subTask !== "string" ||
        typeof raw.resultSummary !== "string" || typeof raw.success !== "boolean") return null;
    if ("subAgentType" in raw && typeof raw.subAgentType !== "string") return null;
    if ("discoveredConstraints" in raw && !Array.isArray(raw.discoveredConstraints)) return null;
    items.push({
      agentId: raw.agentId,
      subAgentType: typeof raw.subAgentType === "string" ? raw.subAgentType : "",
      subTask: raw.subTask,
      resultSummary: raw.resultSummary,
      success: raw.success,
      discoveredConstraints: strings(raw.discoveredConstraints),
    });
  }
  return items.length ? items : undefined;
}

export function parseRoundReport(value: unknown): RoundReportV1 | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  if (!hasOnlyKeys(raw, [
    "status", "summary", "violations", "evidence", "blocker", "discoveries",
    "planChangeRequest", "delegations", "contextRequest",
  ])) return null;
  if (!["completed", "in_progress", "blocked"].includes(String(raw.status)) ||
      typeof raw.summary !== "string" || !raw.summary.trim()) return null;
  if ("violations" in raw && !Array.isArray(raw.violations)) return null;

  const evidence = parseEvidence(raw.evidence);
  const delegations = parseDelegations(raw.delegations);
  const contextRequest = parseContextRequest(raw.contextRequest);
  if (evidence === null || delegations === null || contextRequest === null) return null;

  let blocker: RoundReportV1["blocker"];
  if ("blocker" in raw) {
    if (!raw.blocker || typeof raw.blocker !== "object" || Array.isArray(raw.blocker)) return null;
    const item = raw.blocker as Record<string, unknown>;
    if (!hasOnlyKeys(item, ["kind", "reason", "references"]) ||
        !["dependency", "external", "needs_human_input", "plan_change"].includes(String(item.kind)) ||
        typeof item.reason !== "string" || !item.reason.trim() ||
        ("references" in item && !Array.isArray(item.references))) return null;
    blocker = {
      kind: item.kind as NonNullable<RoundReportV1["blocker"]>["kind"],
      reason: item.reason.trim(),
      references: strings(item.references),
    };
  }

  let discoveries: RoundReportV1["discoveries"];
  if ("discoveries" in raw) {
    if (!raw.discoveries || typeof raw.discoveries !== "object" || Array.isArray(raw.discoveries)) return null;
    const item = raw.discoveries as Record<string, unknown>;
    const fields = ["wrongAssumptions", "emergedWork", "facts", "newConstraints"] as const;
    if (!hasOnlyKeys(item, fields) || fields.some((key) => key in item && !Array.isArray(item[key]))) return null;
    discoveries = {
      wrongAssumptions: strings(item.wrongAssumptions),
      emergedWork: strings(item.emergedWork),
      facts: strings(item.facts),
      newConstraints: strings(item.newConstraints),
    };
  }

  let planChangeRequest: RoundReportV1["planChangeRequest"];
  if ("planChangeRequest" in raw) {
    if (!raw.planChangeRequest || typeof raw.planChangeRequest !== "object" || Array.isArray(raw.planChangeRequest)) return null;
    const item = raw.planChangeRequest as Record<string, unknown>;
    if (!hasOnlyKeys(item, ["timing", "reason", "affectedIds"]) ||
        !["before_continue", "next_boundary"].includes(String(item.timing)) ||
        typeof item.reason !== "string" || !item.reason.trim() ||
        !Array.isArray(item.affectedIds)) return null;
    planChangeRequest = {
      timing: item.timing as NonNullable<RoundReportV1["planChangeRequest"]>["timing"],
      reason: item.reason.trim(),
      affectedIds: strings(item.affectedIds),
    };
  }

  return {
    status: raw.status as RoundReportV1["status"],
    summary: raw.summary.trim(),
    violations: strings(raw.violations),
    evidence,
    blocker,
    discoveries,
    planChangeRequest,
    delegations,
    contextRequest,
  };
}

export function stableClaimId(prefix: "ac" | "er" | "cr", text: string): string {
  return `${prefix}-${deriveStableItemId(text)}`;
}

export function stepClaimTargets(step: PlanStep): Array<{ id: string; text: string; kind: "acceptance" | "evidence" }> {
  return [
    ...step.acceptanceCriteria.map((text) => ({ id: stableClaimId("ac", text), text, kind: "acceptance" as const })),
    ...step.evidenceRequirements.map((text) => ({ id: stableClaimId("er", text), text, kind: "evidence" as const })),
  ];
}

export function auditClaimTargets(plan: StructuredPlan): Array<{ id: string; text: string }> {
  return plan.successCriteria.map((text) => ({ id: stableClaimId("cr", text), text }));
}

export function validateRoundReport(
  report: RoundReportV1,
  phase: WorkflowPhase,
  activeStep: PlanStep | null,
  plan: StructuredPlan | null,
  extraTargets: ReportClaimTarget[] = [],
): string[] {
  const errors: string[] = [];
  if (phase !== "executing" && phase !== "auditing") errors.push(`round report is not valid during ${phase}`);
  if (report.status === "blocked" && !report.blocker) errors.push("blocked report requires blocker");
  if (report.status !== "blocked" && report.blocker) errors.push("blocker is only valid for blocked reports");
  if ((report.discoveries?.newConstraints?.length ?? 0) > 0 && !report.planChangeRequest) {
    errors.push("newConstraints requires planChangeRequest");
  }
  if (report.planChangeRequest && report.planChangeRequest.affectedIds.length === 0) {
    errors.push("planChangeRequest requires affectedIds");
  }

  const targets = phase === "auditing" && plan
    ? auditClaimTargets(plan)
    : activeStep ? stepClaimTargets(activeStep) : [];
  const allTargets = [...targets, ...extraTargets];
  const targetIds = new Set(allTargets.map((target) => target.id));
  for (const claim of report.evidence?.claims ?? []) {
    if (!targetIds.has(claim.targetId)) errors.push(`unknown claim target: ${claim.targetId}`);
    if (claim.evidenceRefs.length === 0) errors.push(`claim ${claim.targetId} requires evidenceRefs`);
  }
  if (report.status === "completed") {
    if (!report.evidence) errors.push("completed report requires evidence");
    const claimed = new Set(report.evidence?.claims?.map((claim) => claim.targetId) ?? []);
    const missing = [...targetIds].filter((id) => !claimed.has(id));
    if (missing.length) errors.push(`completed report is missing claims: ${missing.join(", ")}`);
    if (report.violations?.length) errors.push("completed report cannot contain violations");
  }
  return errors;
}

function initialEnvelope(report: RoundReportV1): RoundEvidenceEnvelope {
  const checks = report.evidence?.checks ?? [];
  return {
    files: {
      value: report.evidence?.files ?? [],
      confidence: report.evidence?.files?.length ? "claimed" : "unavailable",
      source: "agent",
    },
    checks: {
      value: checks,
      confidence: checks.length ? "claimed" : "unavailable",
      source: "agent",
    },
    claims: report.evidence?.claims ?? [],
    noChangeReason: report.evidence?.noChangeReason ?? null,
    providerNames: [],
    checkProvenance: Object.fromEntries(checks.map((check) => [check.name, {
      confidence: "claimed" as const,
      source: "agent" as const,
    }])),
    providerClaims: {},
    contradictions: [],
  };
}

export function normalizeRoundReport(
  report: RoundReportV1,
  phase: WorkflowPhase,
  activeStepId: string | null,
  _requiredClaimIds: string[],
): NormalizedRoundEvaluation {
  if (phase !== "executing" && phase !== "auditing") {
    throw new Error(`cannot normalize report during ${phase}`);
  }
  return {
    reportVersion: 1,
    phase,
    activeStepId,
    report,
    evidenceEnvelope: initialEnvelope(report),
  };
}

function providerChecks(snapshots: ProviderSnapshot[]): RoundCheckReport[] {
  return snapshots.flatMap((snapshot): RoundCheckReport[] => {
    if (snapshot.data.kind !== "command") return [];
    const status = snapshot.data.status;
    return [{
      name: typeof snapshot.data.commandName === "string" ? snapshot.data.commandName : snapshot.provider,
      status: status === "passed" ? "passed" : status === "failed" || status === "timeout" ? "failed" : "not_run",
      summary: typeof snapshot.data.stderr === "string" && snapshot.data.stderr.trim()
        ? snapshot.data.stderr.trim().slice(0, 500)
        : undefined,
    }];
  });
}

function providerSucceeded(snapshot: ProviderSnapshot): boolean {
  const status = snapshot.data.status;
  if (typeof status === "string") return status === "passed" || status === "success" || status === "ok";
  if (typeof snapshot.data.success === "boolean") return snapshot.data.success;
  return true;
}

function providerClaimIds(snapshot: ProviderSnapshot): string[] {
  const claimIds = snapshot.data.claimIds;
  return providerSucceeded(snapshot) && Array.isArray(claimIds)
    ? claimIds.filter((id): id is string => typeof id === "string" && id.trim().length > 0)
    : [];
}

function providerFileFingerprints(snapshot: ProviderSnapshot): Record<string, string> | null {
  const value = snapshot.data.fingerprints;
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return Object.fromEntries(Object.entries(value)
    .filter((entry): entry is [string, string] => typeof entry[1] === "string"));
}

export function mergeRuntimeEvidence(
  evaluation: NormalizedRoundEvaluation,
  snapshots: ProviderSnapshot[],
  previous?: NormalizedRoundEvaluation,
): RoundEvidenceEnvelope {
  const envelope = evaluation.evidenceEnvelope;
  envelope.providerNames = [...new Set(snapshots.map((snapshot) => snapshot.provider))];
  envelope.checkProvenance ??= {};
  envelope.providerClaims = {};
  const git = snapshots.find((snapshot) => snapshot.provider === "git");
  if (git) {
    const fingerprints = providerFileFingerprints(git);
    envelope.fileFingerprints = fingerprints ?? {};
    const fingerprintedFiles = Object.keys(fingerprints ?? {});
    const actual = [...new Set(fingerprintedFiles.length ? fingerprintedFiles : git.files)].sort();
    const claimed = [...envelope.files.value].sort();
    if (claimed.length && JSON.stringify(claimed) !== JSON.stringify(actual)) {
      envelope.contradictions.push(`claimed files [${claimed.join(", ")}] do not match git [${actual.join(", ")}]`);
      envelope.files = { value: actual, confidence: "contradicted", source: "git" };
    } else {
      envelope.files = { value: actual, confidence: "verified", source: "git" };
    }
  }
  const runtimeChecks = providerChecks(snapshots);
  if (runtimeChecks.length) {
    const claimed = new Map(envelope.checks.value.map((check) => [check.name, check.status]));
    const merged = [...envelope.checks.value];
    for (const check of runtimeChecks) {
      const expected = claimed.get(check.name);
      if (expected && expected !== check.status) {
        envelope.contradictions.push(`check ${check.name} claimed ${expected} but provider reported ${check.status}`);
      }
      const existing = merged.findIndex((item) => item.name === check.name);
      if (existing >= 0) merged[existing] = check;
      else merged.push(check);
      const snapshot = snapshots.find((item) =>
        item.data.kind === "command" &&
        (typeof item.data.commandName === "string" ? item.data.commandName : item.provider) === check.name);
      envelope.checkProvenance[check.name] = {
        confidence: check.status === "passed" ? "verified" : "contradicted",
        source: snapshot?.data.kind === "command" ? "command" : "provider",
        provider: snapshot?.provider,
      };
    }
    envelope.checks = {
      value: merged,
      confidence: envelope.contradictions.length
        ? "contradicted"
        : merged.length && merged.every((check) => envelope.checkProvenance?.[check.name]?.confidence === "verified")
          ? "verified"
          : "claimed",
      source: runtimeChecks.length && merged.every((check) => envelope.checkProvenance?.[check.name]?.source === "command")
        ? "command"
        : "derived",
    };
  }
  for (const snapshot of snapshots) {
    const claimIds = providerClaimIds(snapshot);
    if (claimIds.length) envelope.providerClaims[snapshot.provider] = claimIds;
  }

  const signals: string[] = [];
  const priorClaims = new Set(previous?.evidenceEnvelope.claims.map((claim) => claim.targetId) ?? []);
  if (envelope.claims.some((claim) => !priorClaims.has(claim.targetId) && claimHasVerifiedEvidence(envelope, claim))) {
    signals.push("new_verified_claim");
  }
  const priorFingerprints = previous?.evidenceEnvelope.fileFingerprints;
  const currentFingerprints = envelope.fileFingerprints;
  if (git?.files.length) {
    signals.push("new_git_change");
  } else if (priorFingerprints && currentFingerprints) {
    const candidates = new Set([...Object.keys(priorFingerprints), ...Object.keys(currentFingerprints)]);
    if ([...candidates].some((file) => priorFingerprints[file] !== currentFingerprints[file])) {
      signals.push("new_git_change");
    }
  } else if (!git && previous) {
    const priorFiles = new Set(previous?.evidenceEnvelope.files.value ?? []);
    if (envelope.files.value.some((file) => !priorFiles.has(file))) signals.push("new_git_change");
  }
  const priorChecks = new Map(previous?.evidenceEnvelope.checks.value.map((check) => [check.name, check.status]) ?? []);
  if (envelope.checks.value.some((check) =>
    check.status === "passed" && priorChecks.get(check.name) !== "passed")) signals.push("check_improved");
  const discoveries = evaluation.report.discoveries;
  if ((discoveries?.wrongAssumptions?.length ?? 0) + (discoveries?.facts?.length ?? 0) +
      (discoveries?.emergedWork?.length ?? 0) + (discoveries?.newConstraints?.length ?? 0) > 0) {
    signals.push("new_discovery");
  }
  if (evaluation.report.planChangeRequest) signals.push("plan_change_requested");
  if (evaluation.report.status !== (previous?.report.status ?? "in_progress")) signals.push("status_changed");
  evaluation.materialAdvancement = {
    material: signals.length > 0,
    signals,
    stepId: evaluation.activeStepId ?? undefined,
  };
  return envelope;
}

function claimHasVerifiedEvidence(envelope: RoundEvidenceEnvelope, claim: RoundEvidenceClaim): boolean {
  return claim.evidenceRefs.some((ref) => {
    if (ref.startsWith("file:")) return envelope.files.confidence === "verified" && envelope.files.value.includes(ref.slice(5));
    if (ref.startsWith("check:")) {
      const name = ref.slice(6);
      return envelope.checks.value.some((check) => check.name === name && check.status === "passed") &&
        envelope.checkProvenance?.[name]?.confidence === "verified";
    }
    if (ref.startsWith("provider:")) {
      const provider = ref.slice(9);
      return (envelope.providerClaims?.[provider] ?? []).includes(claim.targetId);
    }
    return false;
  });
}

export function claimHasVerifiedEvidenceForEnvelope(
  envelope: RoundEvidenceEnvelope,
  claim: RoundEvidenceClaim,
): boolean {
  return claimHasVerifiedEvidence(envelope, claim);
}
