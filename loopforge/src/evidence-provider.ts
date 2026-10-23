/** EvidenceProvider — Pluggable machine-observation capture (v1.18 / v3.8).
 *
 * v3.8: providers produce `MachineObservation`s, not ad-hoc snapshots. A
 * configured provider ALWAYS yields an observation: unavailability, timeouts,
 * errors and aborts are recorded as observations with the matching status and
 * are never silently filtered out of the round's factual record. Only
 * observations can create a `verified` fact — agent self-reports never can.
 *
 * Built-in: GitEvidenceProvider — git file state capture with parallel async
 * execution (v2.0.1), plus explicitly configured shell-free command providers.
 */

import { createHash } from "node:crypto";
import {
  readFileSync,
  realpathSync,
  statSync,
} from "node:fs";
import { spawn } from "node:child_process";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { GIT_OBSERVATION_SCHEMA_VERSION } from "./protocol.js";
import type {
  CommandObservation,
  ConfiguredCapability,
  EvidenceCapability,
  MachineObservation,
  ObservationStatus,
  ObservedCapability,
  ProgressCoverage,
  ProgressSnapshot,
} from "./protocol.js";
import {
  GIT_WORKSPACE_COVERAGE,
  gitMotionSignal,
  observedGitHead,
} from "./git-motion.js";
import { containInWorkspace } from "./workspace.js";
import { isRecord } from "./token-utils.js";
import { captureBoundary, GitCaptureFailure } from "./git-boundary.js";
import type { BoundaryCapture, BoundaryMaterializer } from "./git-boundary.js";

// v3.9.8: the Git boundary implementation moved to git-boundary.ts so evidence
// and workspace checkpoints share ONE scan. These re-exports keep the existing
// test/library surface stable.
export { captureGitFileStateAsync } from "./git-boundary.js";
export type {
  GitCaptureResult,
  GitCaptureStatus,
  GitFileState,
  GitTrackedEntry,
} from "./git-boundary.js";
import { commandConfigHash, deriveConfiguredCapability, getPolicy, resolveStateDirectory } from "./policy.js";
import type { CommandEvidencePolicy, LoopPolicy } from "./policy.js";
import { logEvent } from "./observability.js";
import { policyMetrics } from "./policy-metrics.js";

// ── Types ──────────────────────────────────────────────────────────────────

/** Interface for evidence capture providers.
 *
 * Implementations may be synchronous or asynchronous. Async implementations
 * should observe context.signal so timed-out work can release resources. */
export interface EvidenceCaptureContext {
  /** Aborted when the provider exceeds its configured deadline. */
  signal: AbortSignal;
  timeoutMs: number;
  loopId?: string;
  phase: "before" | "after";
  /** Workspace root override (tests capture against temp repos). */
  cwd?: string;
  /** v3.9.8: when present, the Git provider materializes dirty/untracked
   *  content in the SAME boundary scan that produces the evidence. */
  materializer?: BoundaryMaterializer;
  /** v3.9.8: receives the captured boundary (fingerprints/head/contents) so a
   *  checkpoint can be built without re-hashing the workspace. */
  boundarySink?: (boundary: BoundaryCapture) => void;
  /** v3.9.8: hard cap on the boundary path count; only meaningful together
   *  with a materializer. A larger boundary yields an explicit error instead
   *  of a truncated map. */
  maxPaths?: number;
}

export type EvidenceCaptureResult =
  | MachineObservation
  | null
  | Promise<MachineObservation | null>;

export interface EvidenceProvider {
  /** Unique provider name. Used in policy to enable/disable. */
  readonly name: string;
  /** Observation kind this provider produces (used for the synthetic
   *  unavailable/timeout/error observations too). */
  readonly kind: MachineObservation["kind"];
  /** v3.9.9: the evidence range this provider observes, when it can report
   *  progress. This is a FACT DESCRIPTION, not a policy flag: a provider never
   *  gains a vote — a rule must explicitly select this exact coverage (and the
   *  observation kind) before any fact can affect it. When present, every
   *  custom observation this provider emits carries `data.progress`, including
   *  failures (same coverage, `complete:false`, null fingerprint). */
  readonly progressCoverage?: ProgressCoverage;
  /** Capture an observation. Returns null when the provider is structurally
   *  unavailable (e.g. not a git repository); the collector converts that
   *  into an explicit `unavailable` observation rather than dropping it. */
  capture(context?: EvidenceCaptureContext): EvidenceCaptureResult;
}

export interface EvidenceCollectOptions {
  timeoutMs?: number;
  loopId?: string;
  phase?: "before" | "after";
  /** Workspace root override; command providers and the Git provider use it. */
  cwd?: string;
  /** v3.9.8: enables content materialization in the same Git boundary scan. */
  materializer?: BoundaryMaterializer;
  /** v3.9.8: receives the Git boundary captured by this collection. */
  boundarySink?: (boundary: BoundaryCapture) => void;
  /** v3.9.8: boundary path cap for a checkpoint-bearing capture. */
  maxPaths?: number;
}

export type EvidenceProviderFactory = () => EvidenceProvider;

const providerFactories = new Map<string, EvidenceProviderFactory>();

/** Register a provider factory used by policy-driven collectors. */
export function registerEvidenceProvider(
  name: string,
  factory: EvidenceProviderFactory,
): void {
  if (!name.trim()) throw new Error("Evidence provider name must not be empty");
  providerFactories.set(name, factory);
}

export function unregisterEvidenceProvider(name: string): boolean {
  if (name === "git") return false;
  return providerFactories.delete(name);
}

/** v3.8: Whether a provider factory is registered for this name. Readiness
 *  of the RUNTIME (PATH resolution, executables) is a `doctor` concern and is
 *  deliberately not part of the hashed capability. */
export function isProviderRegistered(name: string): boolean {
  return providerFactories.has(name);
}

// ── The single machine-backed predicate ────────────────────────────────────

/** v3.8: The ONE machine-backed predicate. A command observation proves a
 *  claim only when it is an after-phase command that PASSED and whose
 *  entrypoint was not modified in the same round. Before-phase observations
 *  are the baseline and never evidence.
 *
 *  `not_applicable` (no Git provider participated) leaves the entrypoint arm
 *  out; `unknown` (a Git boundary existed but its change set is unobservable)
 *  is NOT a pass — the boundary cannot rule out entrypoint tampering.
 *
 *  v3.8 replaced two divergent implementations (the gate excluded tampered
 *  commands, evidence-claims did not) with this single function. */
export function isPassedAfterObservation(
  observation: MachineObservation,
  git: GitDeltaState,
): boolean {
  if (observation.kind !== "command") return false;
  if (observation.phase !== "after") return false;
  if (observation.status !== "passed") return false;
  if (git.state === "unknown") return false;
  const entrypoints = Array.isArray(observation.data.entrypointFiles)
    ? observation.data.entrypointFiles.filter(
        (file): file is string => typeof file === "string")
    : [];
  if (git.state === "observed" && entrypoints.some((file) => git.changedFiles.has(file))) {
    return false;
  }
  return true;
}

/** v3.8: Live capability derived from observations. Rendered only — never
 *  hashed, never persisted independently (it is a pure function of the
 *  observations it is given). */
export function deriveObservedCapability(
  observations: ReadonlyArray<MachineObservation>,
  configured: ConfiguredCapability,
): ObservedCapability {
  const latest = new Map<string, ObservationStatus>();
  const latestCommand = new Map<string, { status: ObservationStatus; configHash: string }>();
  for (const observation of observations) {
    latest.set(observation.providerId, observation.status);
    if (observation.kind === "command") {
      latestCommand.set(observation.data.commandId, {
        status: observation.status,
        configHash: observation.data.configHash,
      });
    }
  }
  return {
    providers: configured.providers.map((provider) => ({
      providerId: provider.providerId,
      status: latest.get(provider.providerId) ?? "unavailable",
    })),
    commands: configured.commands.map((command) => {
      const seen = latestCommand.get(command.commandId);
      return {
        commandId: command.commandId,
        status: seen?.status ?? "unavailable",
        configHash: seen?.configHash ?? command.configHash,
      };
    }),
  };
}

/** v3.8: Human-readable capability warnings for start/resume/status. A loop
 *  with no machine verification can still run — its success claims are simply
 *  recorded as `insufficient` instead of `verified`.
 *
 *  v3.8.2: `policy` is read for the per-command entrypoint warning. The three
 *  checks above it speak only when capability is ABSENT (no provider, no
 *  command, a dead provider); this one speaks when a command IS configured but
 *  its true entrypoint is unobservable — the case where a reader would
 *  otherwise believe the runtime is watching files it cannot see. Derived from
 *  policy alone (no probing): the predicate is the same `isPackageManager-
 *  Command` the entrypoint resolver uses, so the warning and the check that
 *  would (not) fire can never disagree. */
export function capabilityWarnings(
  configured: ConfiguredCapability,
  policy: LoopPolicy,
  observed?: ObservedCapability,
): string[] {
  const warnings: string[] = [];
  if (!configured.observationConfigured) {
    warnings.push(
      "No evidence provider is configured — the runtime can observe nothing " +
      "this loop; success claims will be recorded as insufficient.",
    );
  }
  if (!configured.contractVerificationAvailable) {
    warnings.push(
      "No enabled verification command is configured — Round Contract items " +
      "cannot be machine-verified; contract closure will require an explicit " +
      "blocked outcome.",
    );
  }
  // v3.9.9: the stall rule selects Git workspace coverage explicitly. Without
  // the Git provider configured there is no workspace evidence basis for a
  // stall verdict — other providers' facts remain visible but cannot affect
  // that rule. This is a fact statement, not a blocker.
  const providerNames = Array.isArray(policy.evidence.providers)
    ? policy.evidence.providers
    : [];
  if (!providerNames.includes("git")) {
    warnings.push(
      "The Git workspace evidence provider is not configured — the stall rule " +
      "has no workspace evidence basis this loop. Progress facts from other " +
      "providers are recorded and displayed but cannot affect stall decisions.",
    );
  }
  // v3.8.2: a configured command whose harness is named in package.json. The
  // entrypoint set for `npm test` is ["package.json"], so the test files the
  // script actually runs are never in it: editing one is a warning, not a
  // machine fact. Stated as fact + consequence — the operator owns the policy,
  // so this never reads as an instruction the Agent should carry out.
  for (const command of policy.evidence.commands) {
    if (command.enabled !== true) continue;
    if (!isPackageManagerCommand(command.executable)) continue;
    warnings.push(
      `Command "${command.name}" runs through a package manager — what it ` +
      "actually executes is named in package.json, so the scripts or test " +
      "files it invokes are not entrypoint-protected: changing one in the " +
      "same round is recorded as a warning and does not invalidate the " +
      "command's result.",
    );
  }
  if (observed) {
    const dead = observed.providers.filter(
      (provider) => provider.status === "unavailable" || provider.status === "error",
    );
    if (dead.length > 0) {
      warnings.push(
        `Evidence provider(s) unavailable: ${dead.map((p) => p.providerId).join(", ")}.`,
      );
    }
  }
  return warnings;
}

/** v3.8: The ONE capability derivation. Everything that speaks about
 *  capability — `RoundDriver.prepare()`, MCP start/resume/next/status, the
 *  capability warnings — reads this, so the surfaces cannot drift into
 *  different stories about what the runtime can observe.
 *
 *  `available` is provider-REGISTRY state (code, not policy): it is rendered
 *  and reported by `doctor`, never hashed. The hashed half stays
 *  `deriveConfiguredCapability(policy)` inside the canonical state. */
export function deriveEvidenceCapability(
  policy: LoopPolicy,
  observations: ReadonlyArray<MachineObservation> = [],
): EvidenceCapability {
  const configured = deriveConfiguredCapability(policy);
  const observed = deriveObservedCapability(observations, configured);
  const statusByProvider = new Map(
    observed.providers.map((provider) => [provider.providerId, provider.status] as const),
  );
  return {
    schemaVersion: 1,
    providers: configured.providers.map((provider) => ({
      providerId: provider.providerId,
      available: isProviderRegistered(provider.providerId),
      status: statusByProvider.get(provider.providerId) ?? "unavailable",
    })),
    commands: configured.commands.map((command) => ({
      commandId: command.commandId,
      enabled: command.enabled,
      phase: command.phase,
      configHash: command.configHash,
      ready: command.enabled && (command.phase === "after" || command.phase === "both"),
    })),
    contractVerificationAvailable: configured.contractVerificationAvailable,
    warnings: capabilityWarnings(configured, policy, observed),
  };
}

// ── EvidenceCollector ──────────────────────────────────────────────────────

/** v3.8: The stand-in for a name in `policy.evidence.providers` that no
 *  registered factory answers. Configuring a provider is a factual claim that
 *  it observes something; when the runtime has no such provider the claim must
 *  still leave a record, so this one captures `unavailable` instead of the
 *  name vanishing from the round. Registration is code state (a `doctor`
 *  concern), so the observation is the only place the gap can legitimately
 *  appear in the Vault. */
function unregisteredProvider(name: string): EvidenceProvider {
  return {
    name,
    kind: "custom",
    capture(context?: EvidenceCaptureContext): MachineObservation {
      return syntheticObservation(
        name,
        "custom",
        context?.phase ?? "after",
        Date.now(),
        "unavailable",
        "provider is not registered in this runtime (see `loopforge doctor`)",
      );
    },
  };
}

/** v3.8: Build the observation a failed capture resolves to. The status names
 *  the machine fact; `detail` explains it for the audit trail. */
/** v3.9.9: THE per-kind base observation schema table. Custom observations
 *  keep base 1; only their nested progress snapshot moved to inner 2. */
export function expectedObservationSchemaVersion(
  kind: "git" | "command" | "custom",
): 1 | 2 {
  return kind === "git" ? GIT_OBSERVATION_SCHEMA_VERSION : 1;
}

function syntheticObservation(
  providerId: string,
  kind: MachineObservation["kind"],
  phase: "before" | "after",
  startedAt: number,
  status: ObservationStatus,
  detail: string,
): MachineObservation {
  return {
    // v3.9.1: a failed Git capture still carries the current Git observation
    // schema so the committed snapshot can be parsed; its non-observed status
    // is what tells consumers the boundary is unavailable. Every synthetic
    // observation goes through the ONE per-kind table.
    schemaVersion: expectedObservationSchemaVersion(kind),
    providerId,
    kind,
    phase,
    startedAt,
    finishedAt: Date.now(),
    status,
    files: [],
    data: { detail },
  } as MachineObservation;
}

const PROGRESS_FINGERPRINT_RE = /^[a-f0-9]{64}$/;
const COVERAGE_FIELD_MAX_CHARS = 200;

/** v3.9.9: one coverage descriptor's four fields are non-empty, length-bounded
 *  and already trimmed. "Trimmed" is part of identity: `" workspace"` and
 *  `"workspace"` are different declared ranges, so a snapshot that relies on
 *  implicit trimming is rejected instead of silently normalized. */
function isValidProgressCoverage(value: unknown): value is ProgressCoverage {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const coverage = value as Record<string, unknown>;
  for (const field of ["domain", "object", "scope"] as const) {
    const text = coverage[field];
    if (typeof text !== "string" || text.length === 0 ||
        text.trim() !== text || text.length > COVERAGE_FIELD_MAX_CHARS) {
      return false;
    }
  }
  return typeof coverage.version === "number" &&
    Number.isInteger(coverage.version) && coverage.version >= 1;
}

/** v3.9.9: THE nested progress-snapshot shape check, shared by the collector
 *  and the persisted-transaction parser. Version 2 requires the coverage
 *  descriptor and the completeness assertion; `fingerprint` is 64 lowercase
 *  hex when the capture was observed and may be null only when it failed. */
export function isValidProgressSnapshot(
  value: unknown,
  status: ObservationStatus,
): value is ProgressSnapshot {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const snapshot = value as Record<string, unknown>;
  if (snapshot.schemaVersion !== 2) return false;
  if (!isValidProgressCoverage(snapshot.coverage)) return false;
  if (typeof snapshot.complete !== "boolean") return false;
  if (snapshot.fingerprint === null) return status !== "observed";
  return typeof snapshot.fingerprint === "string" &&
    PROGRESS_FINGERPRINT_RE.test(snapshot.fingerprint);
}

/** The explicit unknown every failed/undeclared capture still records. */
function failureProgressSnapshot(
  coverage: ProgressCoverage | undefined,
): ProgressSnapshot | null {
  if (!coverage) return null;
  return {
    schemaVersion: 2,
    coverage: { ...coverage },
    complete: false,
    fingerprint: null,
  };
}

function sameCoverage(
  left: ProgressCoverage,
  right: ProgressCoverage,
): boolean {
  return left.domain === right.domain &&
    left.object === right.object &&
    left.scope === right.scope &&
    left.version === right.version;
}

function progressErrorObservation(
  provider: EvidenceProvider,
  phase: "before" | "after",
  startedAt: number,
  detail: string,
): MachineObservation {
  return {
    schemaVersion: expectedObservationSchemaVersion("custom"),
    providerId: provider.name,
    kind: "custom",
    phase,
    startedAt,
    finishedAt: Date.now(),
    status: "error",
    files: [],
    data: {
      detail,
      ...(provider.progressCoverage
        ? { progress: failureProgressSnapshot(provider.progressCoverage) }
        : {}),
    },
  };
}

/** v3.9.9: validate and persist the provider's DECLARED coverage on every
 *  observation. A provider without a declaration cannot smuggle progress data
 *  in; a provider with one must supply a comparable observed snapshot or the
 *  observation becomes an explicit `error`, and every failed capture carries
 *  the declared coverage with a null fingerprint so "unknown" never
 *  disappears. No capability/policy marker is ever written. */
function normalizeProgressObservation(
  provider: EvidenceProvider,
  observation: MachineObservation,
  phase: "before" | "after",
  startedAt: number,
): MachineObservation {
  const declared = provider.progressCoverage;
  if (declared && !isValidProgressCoverage(declared)) {
    return progressErrorObservation(
      provider,
      phase,
      startedAt,
      "provider declared a malformed progressCoverage",
    );
  }
  if (declared && provider.kind !== "custom") {
    return progressErrorObservation(
      provider,
      phase,
      startedAt,
      "progressCoverage is only supported for custom observations",
    );
  }
  if (observation.kind !== "custom") {
    if (declared) {
      return progressErrorObservation(
        provider,
        phase,
        startedAt,
        "progressCoverage is only supported for custom observations",
      );
    }
    return observation;
  }
  // The SAME per-kind/nested version judgment the transaction parser and the
  // legacy reporter use. A live provider emitting a retired marker or an
  // unsupported envelope becomes an explicit error observation here instead
  // of writing a round this runtime cannot read back.
  const versionIssue = observationVersionIssue(
    observation.kind, observation.schemaVersion, observation.data,
    observation.status);
  if (versionIssue) {
    return progressErrorObservation(
      provider,
      phase,
      startedAt,
      versionIssue.reason === "progress_capable"
        ? "the retired progressCapable field is not accepted; declare progressCoverage instead"
        : `custom observation envelope is not supported (${versionIssue.reason})`,
    );
  }
  if (!declared) {
    if (Object.hasOwn(observation.data, "progress")) {
      return progressErrorObservation(
        provider,
        phase,
        startedAt,
        "provider emitted progress data without declaring progressCoverage",
      );
    }
    return observation;
  }

  if (observation.status === "observed") {
    const snapshot = observation.data.progress;
    if (!isValidProgressSnapshot(snapshot, "observed")) {
      return progressErrorObservation(
        provider,
        phase,
        startedAt,
        "progress provider did not emit a valid observed snapshot (inner schema 2)",
      );
    }
    if (!sameCoverage(snapshot.coverage, declared)) {
      return progressErrorObservation(
        provider,
        phase,
        startedAt,
        "progress snapshot coverage does not match the provider's declared progressCoverage",
      );
    }
    const { progressCapable: _retired, ...data } =
      observation.data as Record<string, unknown>;
    return {
      ...observation,
      data: { ...data, progress: snapshot },
    };
  }

  const { progressCapable: _retired, ...data } =
    observation.data as Record<string, unknown>;
  return {
    ...observation,
    data: { ...data, progress: failureProgressSnapshot(declared) },
  };
}

/** v3.9.9: ONE observation-version judgment shared by the collector's parser
 *  (`parseMachineObservations`) and the legacy report (`legacyTransactionRounds`).
 *  Custom observations keep base schema 1; only the NESTED progress snapshot
 *  moved to inner schema 2. A historical custom round without progress stays
 *  readable; one carrying the retired marker or an inner-1 snapshot is
 *  reported as observation legacy instead of vanishing. */
export interface ObservationVersionIssue {
  envelope: "observation";
  schemaVersion: number;
  reason: "schema" | "progress" | "progress_capable" | "malformed";
}

export function observationVersionIssue(
  kind: unknown,
  schemaVersion: unknown,
  data: unknown,
  status?: unknown,
): ObservationVersionIssue | null {
  if (kind !== "git" && kind !== "command" && kind !== "custom") {
    return {
      envelope: "observation",
      schemaVersion: typeof schemaVersion === "number" ? schemaVersion : -1,
      reason: "schema",
    };
  }
  if (!isRecord(data)) {
    return {
      envelope: "observation",
      schemaVersion: typeof schemaVersion === "number" ? schemaVersion : -1,
      reason: "malformed",
    };
  }
  const expected = expectedObservationSchemaVersion(kind);
  if (schemaVersion !== expected) {
    return {
      envelope: "observation",
      schemaVersion: typeof schemaVersion === "number" ? schemaVersion : -1,
      reason: "schema",
    };
  }
  if (kind !== "custom") return null;
  if (Object.hasOwn(data, "progressCapable")) {
    return {
      envelope: "observation",
      schemaVersion: expected,
      reason: "progress_capable",
    };
  }
  if (!Object.hasOwn(data, "progress")) return null;
  const progress = data.progress;
  if (progress === null || progress === undefined) {
    if (status === "observed") {
      return {
        envelope: "observation",
        schemaVersion: expected,
        reason: "progress",
      };
    }
    return null;
  }
  if (!isValidProgressSnapshot(progress, status as ObservationStatus)) {
    return {
      envelope: "observation",
      schemaVersion: isRecord(progress) && typeof progress.schemaVersion === "number"
        ? progress.schemaVersion
        : -1,
      reason: "progress",
    };
  }
  return null;
}

/** Collects observations from all configured providers (always async).
 *
 * v3.8: every configured provider produces exactly one observation per
 * collection. A provider that returns null, throws, times out, or is aborted
 * yields an observation with `unavailable` / `error` / `timeout` / `aborted`
 * — the round's factual record keeps the gap instead of hiding it. */
export class EvidenceCollector {
  constructor(private providers: EvidenceProvider[]) {}

  /** Build the collector described by loop_policy.json. Every configured name
   *  yields exactly one provider, in configuration order: a name with no
   *  registered factory gets `unregisteredProvider`, which records
   *  `unavailable` rather than letting a configured provider vanish without a
   *  trace. */
  static fromProviderNames(providerNames: string[]): EvidenceCollector {
    const providers: EvidenceProvider[] = providerNames
      .map((name) => providerFactories.get(name)?.() ?? unregisteredProvider(name));
    return new EvidenceCollector(providers);
  }

  /** Build built-ins and explicitly configured command providers. */
  static fromPolicy(): EvidenceCollector {
    const policy = getPolicy().evidence;
    const providerNames = Array.isArray(policy.providers)
      ? policy.providers.filter((name): name is string => typeof name === "string")
      : [];
    const providers = EvidenceCollector.fromProviderNames(providerNames).providers;
    const commands = Array.isArray(policy.commands) ? policy.commands : [];
    for (const command of commands) {
      if (command?.enabled) providers.push(new CommandEvidenceProvider(command));
    }
    return new EvidenceCollector(providers);
  }

  /** Capture all providers concurrently with per-provider timeout isolation. */
  async collectAsync(options: EvidenceCollectOptions = {}): Promise<MachineObservation[]> {
    const timeoutMs = options.timeoutMs ?? getPolicy().evidence.timeout_ms;
    const phase = options.phase ?? "after";
    const captures = this.providers.map(async (provider) => {
      const startedAt = Date.now();
      const controller = new AbortController();
      let timer: ReturnType<typeof setTimeout> | undefined;
      let timedOut = false;
      try {
        const capture = Promise.resolve(provider.capture({
          signal: controller.signal,
          timeoutMs,
          ...(options.loopId !== undefined ? { loopId: options.loopId } : {}),
          phase,
          ...(options.cwd !== undefined ? { cwd: options.cwd } : {}),
          ...(options.materializer
            ? { materializer: options.materializer }
            : {}),
          ...(options.boundarySink
            ? { boundarySink: options.boundarySink }
            : {}),
          ...(options.maxPaths !== undefined
            ? { maxPaths: options.maxPaths }
            : {}),
        }));
        const observation = timeoutMs > 0
          ? await Promise.race([
              capture,
              new Promise<MachineObservation | null>((resolveRace) => {
                timer = setTimeout(() => {
                  timedOut = true;
                  controller.abort(new Error(`Evidence provider timed out after ${timeoutMs}ms`));
                  resolveRace(null);
                }, timeoutMs);
              }),
            ])
          : await capture;

        if (timedOut) {
          policyMetrics.recordEvidence(provider.name, "timeout", Date.now() - startedAt, options.loopId);
          logEvent("evidence_provider_timeout", { provider: provider.name, timeoutMs });
          return normalizeProgressObservation(
            provider,
            syntheticObservation(
              provider.name, provider.kind, phase, startedAt, "timeout",
              `provider exceeded ${timeoutMs}ms`,
            ),
            phase,
            startedAt,
          );
        }
        if (!observation) {
          policyMetrics.recordEvidence(provider.name, "unavailable", Date.now() - startedAt, options.loopId);
          const unavailable = syntheticObservation(
            provider.name, provider.kind, phase, startedAt, "unavailable",
            "provider reported no observation",
          );
          return normalizeProgressObservation(provider, unavailable, phase, startedAt);
        }
        const normalized = normalizeProgressObservation(
          provider,
          observation,
          phase,
          startedAt,
        );
        policyMetrics.recordEvidence(
          provider.name,
          normalized.status === "timeout" ? "timeout" : "available",
          Date.now() - startedAt,
          options.loopId,
        );
        return normalized;
      } catch (error) {
        policyMetrics.recordEvidence(provider.name, "failure", Date.now() - startedAt, options.loopId);
        logEvent("evidence_provider_error", { provider: provider.name, error: String(error) });
        return normalizeProgressObservation(
          provider,
          syntheticObservation(
            provider.name, provider.kind, phase, startedAt, "error", String(error),
          ),
          phase,
          startedAt,
        );
      } finally {
        if (timer) clearTimeout(timer);
      }
    });
    return await Promise.all(captures);
  }
}

function commandCwd(configured: string | undefined): string {
  // v3.3.1: delegated to the shared containment check (workspace.ts) — the
  // command execution boundary must use the same double check as every
  // other workspace path, not a private copy. The cwd must additionally be
  // an existing directory (commands spawn inside it).
  const actual = containInWorkspace(process.cwd(), configured ?? ".");
  if (!statSync(actual).isDirectory()) {
    throw new Error("command cwd resolves outside the workspace");
  }
  return actual;
}

/** v3.3: Resolve the workspace files a verification command depends on.
 *  Candidates: every arg that resolves to an existing file inside the
 *  workspace, a path-shaped executable (e.g. "./scripts/verify.mjs"), and
 *  package.json (npm test / script indirection). Directories and non-workspace
 *  paths are skipped. Returns forward-slash paths (git convention) so the
 *  gate can intersect them with the round's git diff. Empty result = the
 *  command's entrypoint cannot be observed (external command) — fail open. */
/** Package-manager executables, whose own configuration IS the command's
 *  harness: `npm test` runs whatever `scripts.test` names, so an edit there
 *  changes what the machine will execute. Any other command's harness is what
 *  its own command line names. */
const PACKAGE_MANAGER_EXECUTABLES = new Set([
  "npm", "npm.cmd", "npm.exe",
  "npx", "npx.cmd", "npx.exe",
  "pnpm", "pnpm.cmd", "yarn", "yarn.cmd", "yarnpkg",
  "bun", "bunx",
]);

function isPackageManagerCommand(executable: string): boolean {
  const base = executable.split(/[\\/]/).pop() ?? executable;
  return PACKAGE_MANAGER_EXECUTABLES.has(base.trim().toLowerCase());
}

/** The candidate workspace paths a command's execution depends on: the script
 *  it names on its own command line, plus package.json when a package manager
 *  is what runs it. Whether each candidate EXISTS is the caller's question —
 *  `resolveEntrypointFiles` keeps only the ones that do, while
 *  `captureEntrypointTrust` must also record the absent ones. */
function entrypointCandidates(executable: string, args: string[]): string[] {
  const candidates = [...args];
  if (executable.includes("/") || executable.includes("\\")) {
    candidates.unshift(executable);
  }
  // v3.8.1: `package.json` is a candidate only for a package-manager
  // invocation, which is the only case where it defines what runs. Adding it
  // unconditionally made EVERY command's entrypoint set include it, so a round
  // that touched package.json — for any reason at all, with any command — was
  // reported as "the verification entrypoint changed" and rejected, however
  // unrelated the file was to what actually executed.
  if (isPackageManagerCommand(executable)) candidates.push("package.json");
  return candidates;
}

/** v3.8.3: The content fingerprint of one workspace file — `"<mode>:<sha256>"`,
 *  or the `"missing"` sentinel when it cannot be read. ONE definition, shared
 *  by the git provider's per-file map and the entrypoint trust baseline, so a
 *  value captured at round start is literally comparable to one captured later
 *  (and to a value inside a git observation). */
function fileFingerprint(absolutePath: string): string {
  try {
    const stat = statSync(absolutePath);
    const hash = createHash("sha256").update(readFileSync(absolutePath)).digest("hex");
    return `${stat.mode}:${hash}`;
  } catch {
    // Deleted files are evidence too. A stable sentinel lets the diff
    // distinguish deleted/restored transitions across a round.
    return "missing";
  }
}

/** v3.8.3: The round-start state of every enabled after-capable command's
 *  entrypoint files — the TRUSTED baseline the tamper check compares against.
 *
 *  Taken from the filesystem, not from a git observation: `git diff` lists
 *  only tracked-and-dirty files, so an entrypoint that is gitignored would be
 *  absent from BOTH sides of a git-based comparison and a script created this
 *  round would read as "unchanged". Absent candidates are recorded as
 *  `"missing"` rather than dropped — that absence is exactly what makes
 *  "created during this round" detectable.
 *
 *  Captured when a round is PREPARED, never when tampering is detected: a
 *  baseline written at detection time could never catch its own first
 *  occurrence. */
export function captureEntrypointTrust(
  policy: LoopPolicy,
  workspace = process.cwd(),
): Record<string, string> {
  const trust: Record<string, string> = {};
  for (const command of policy.evidence.commands ?? []) {
    if (command.enabled !== true) continue;
    if (command.phase !== "after" && command.phase !== "both") continue;
    if (!command.executable) continue;
    const cwd = command.cwd ?? workspace;
    for (const candidate of entrypointCandidates(command.executable, command.args ?? [])) {
      try {
        const actual = containInWorkspace(workspace, resolve(cwd, candidate));
        const rel = relative(realpathSync(workspace), actual).split(sep).join("/");
        if (trust[rel] === undefined) trust[rel] = fileFingerprint(actual);
      } catch {
        // Outside the workspace or unresolvable — not an entrypoint fact.
      }
    }
  }
  return trust;
}

/** v3.8.3: One entrypoint file that no longer matches its round-start state,
 *  with the state it must return to for the round to be verifiable.
 *
 *  `absent` is the case the old delta rule could not describe: the file did
 *  not exist when the round started, so it was CREATED by this round and
 *  cannot back a claim in it. There is nothing to restore — "keep it stable"
 *  is not an instruction the agent can carry out — which is why the recovery
 *  message must distinguish the two. */
export interface EntrypointDrift {
  file: string;
  roundStart: "present" | "absent";
}

/** v3.8.3: The entrypoint files whose content no longer matches the trusted
 *  round-start baseline — the ONE derivation of "this command's script was
 *  changed during the round". The delta rule (does the file appear in the
 *  round's git change set?) cannot answer this on its own: a gitignored
 *  entrypoint is invisible to it, and a baseline re-derived from the current
 *  tree would launder the change. This comparison does not read git at all. */
export function driftedEntrypoints(
  trust: Record<string, string> | undefined,
  workspace = process.cwd(),
): EntrypointDrift[] {
  if (!trust) return [];
  const drifted: EntrypointDrift[] = [];
  for (const [file, trusted] of Object.entries(trust)) {
    let current: string;
    try {
      current = fileFingerprint(containInWorkspace(workspace, resolve(workspace, file)));
    } catch {
      current = "missing";
    }
    if (current !== trusted) {
      drifted.push({ file, roundStart: trusted === "missing" ? "absent" : "present" });
    }
  }
  return drifted.sort((a, b) => a.file.localeCompare(b.file));
}

/** The workspace files a command's execution depends on, resolved
 *  statically: the script it names on its own command line, plus package.json
 *  when a package manager is what runs it. Exported for the pure-function
 *  test — spawning a real package manager is not portable (a bare `npm`
 *  cannot be spawned without a shell, and the runtime uses `shell: false`). */
export function resolveEntrypointFiles(
  executable: string,
  args: string[],
  cwd: string,
): string[] {
  // v3.3.1: entrypoint containment uses the shared workspace check.
  const workspace = process.cwd();
  const found: string[] = [];
  for (const candidate of entrypointCandidates(executable, args)) {
    try {
      const actual = containInWorkspace(workspace, resolve(cwd, candidate));
      if (statSync(actual).isDirectory()) continue;
      const rel = relative(realpathSync(workspace), actual).split(sep).join("/");
      if (!found.includes(rel)) found.push(rel);
    } catch {
      // Not a resolvable workspace file (absent or outside) — not an
      // entrypoint candidate.
    }
  }
  return found;
}

/** Explicit, shell-free verification command. Disabled unless configured. */
export class CommandEvidenceProvider implements EvidenceProvider {
  readonly name: string;
  readonly kind = "command" as const;
  private readonly config: CommandEvidencePolicy;
  private readonly configHash: string;

  constructor(config: CommandEvidencePolicy) {
    const name = typeof config.name === "string" && config.name.trim()
      ? config.name.trim()
      : "invalid-config";
    const executable = typeof config.executable === "string"
      ? config.executable.trim()
      : "";
    const args = Array.isArray(config.args)
      ? config.args.filter((arg): arg is string => typeof arg === "string")
      : [];
    const successExitCodes = Array.isArray(config.success_exit_codes)
      ? config.success_exit_codes.filter((code) => Number.isInteger(code))
      : [0];
    this.config = {
      ...config,
      name,
      executable,
      args,
      phase: config.phase === "both" ? "both" : "after",
      required: config.required === true,
      timeout_ms: Number.isFinite(config.timeout_ms) ? config.timeout_ms : 120_000,
      max_output_chars: Number.isFinite(config.max_output_chars)
        ? config.max_output_chars
        : 20_000,
      success_exit_codes: successExitCodes,
    };
    this.configHash = commandConfigHash(this.config);
    this.name = `command:${name}`;
  }

  capture(context?: EvidenceCaptureContext): Promise<CommandObservation | null> {
    const phase = context?.phase ?? "after";
    if (phase === "before" && this.config.phase === "after") {
      return Promise.resolve(null);
    }
    const startedAt = Date.now();
    const cap = Math.max(0, this.config.max_output_chars);
    const timeoutMs = Math.max(
      1,
      Math.min(this.config.timeout_ms, context?.timeoutMs || this.config.timeout_ms),
    );
    let cwd: string;
    if (!this.config.executable) {
      return Promise.resolve(this.observation(
        phase, "error", null, null, "", "", false, 0, [], "command executable is empty",
      ));
    }
    try {
      cwd = commandCwd(this.config.cwd);
    } catch (error) {
      return Promise.resolve(this.observation(
        phase, "error", null, null, "", "", false, Date.now() - startedAt, [], String(error),
      ));
    }
    // v3.3: Workspace entrypoint files for tamper detection at the gate.
    const entrypointFiles = resolveEntrypointFiles(
      this.config.executable,
      this.config.args,
      cwd,
    );

    return new Promise((resolveCapture) => {
      // v3.8: the FULL streams are hashed; the retained excerpt is capped.
      const stdoutHash = createHash("sha256");
      const stderrHash = createHash("sha256");
      let stdout = "";
      let stderr = "";
      let truncated = false;
      let retained = 0;
      let settled = false;
      const append = (current: string, chunk: unknown): string => {
        const text = String(chunk);
        if (text.length === 0) return current;
        if (retained >= cap) {
          truncated = true;
          return current;
        }
        const remaining = cap - retained;
        if (text.length > remaining) truncated = true;
        const accepted = text.slice(0, remaining);
        retained += accepted.length;
        return current + accepted;
      };
      const child = spawn(this.config.executable, this.config.args, {
        cwd,
        shell: false,
        windowsHide: true,
        stdio: ["ignore", "pipe", "pipe"],
      });
      let timer: ReturnType<typeof setTimeout> | undefined;
      const finish = (
        status: ObservationStatus,
        exitCode: number | null,
        signal: string | null,
        failureDetail?: string,
      ): void => {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        context?.signal.removeEventListener("abort", abort);
        resolveCapture(this.observation(
          phase,
          status,
          exitCode,
          signal,
          stdout,
          stderr,
          truncated,
          Date.now() - startedAt,
          entrypointFiles,
          failureDetail,
          stdoutHash.digest("hex"),
          stderrHash.digest("hex"),
        ));
      };
      const abort = (): void => {
        child.kill();
        finish("aborted", null, null, "aborted by the collector deadline");
      };
      child.stdout.on("data", (chunk) => {
        stdoutHash.update(String(chunk));
        stdout = append(stdout, chunk);
      });
      child.stderr.on("data", (chunk) => {
        stderrHash.update(String(chunk));
        stderr = append(stderr, chunk);
      });
      child.once("error", (error: NodeJS.ErrnoException) => {
        stderrHash.update(error.message);
        stderr = append(stderr, error.message);
        finish(
          error.code === "ENOENT" ? "unavailable" : "error",
          null,
          null,
          error.code ?? error.message,
        );
      });
      child.once("close", (code, signal) => {
        const passed = code !== null && this.config.success_exit_codes.includes(code);
        finish(passed ? "passed" : "failed", code, signal);
      });
      timer = setTimeout(() => {
        child.kill();
        finish("timeout", null, null, `command exceeded ${timeoutMs}ms`);
      }, timeoutMs);
      timer.unref?.();
      if (context?.signal.aborted) abort();
      else context?.signal.addEventListener("abort", abort, { once: true });
    });
  }

  private observation(
    phase: "before" | "after",
    status: ObservationStatus,
    exitCode: number | null,
    signal: string | null,
    stdout: string,
    stderr: string,
    truncated: boolean,
    durationMs: number,
    entrypointFiles: string[],
    failureDetail?: string,
    stdoutSha256?: string,
    stderrSha256?: string,
  ): CommandObservation {
    const finishedAt = Date.now();
    return {
      schemaVersion: expectedObservationSchemaVersion("command"),
      providerId: this.name,
      kind: "command",
      phase,
      startedAt: finishedAt - durationMs,
      finishedAt,
      status,
      files: [],
      data: {
        commandId: this.config.name,
        argv: [this.config.executable, ...this.config.args],
        cwd: this.config.cwd ?? ".",
        configHash: this.configHash,
        required: this.config.required,
        exitCode,
        signal,
        durationMs,
        ...(failureDetail ? { failureDetail } : {}),
        stdoutSha256: stdoutSha256 ?? createHash("sha256").update(stdout).digest("hex"),
        stderrSha256: stderrSha256 ?? createHash("sha256").update(stderr).digest("hex"),
        stdoutExcerpt: stdout,
        stderrExcerpt: stderr,
        truncated,
        entrypointFiles,
      },
    };
  }
}

// The Git boundary capture/fingerprint implementation lives in
// git-boundary.ts (shared with workspace checkpoints).

// ── Built-in: GitEvidenceProvider ──────────────────────────────────────────

/** The runtime's resolved state directory, or null when it cannot be observed
 *  (configured outside the workspace, or an unresolvable path). */
function stateDirectory(workspace: string): string | null {
  try {
    return resolveStateDirectory(workspace, getPolicy().backend.root_dir);
  } catch {
    return null;
  }
}

/** True when a workspace-relative or absolute file path is the state directory
 *  or lives inside it. */
function isInsideDirectory(file: string, workspace: string, dir: string): boolean {
  const absolute = isAbsolute(file) ? file : resolve(workspace, file);
  const prefix = dir.endsWith(sep) ? dir : `${dir}${sep}`;
  return absolute === dir || absolute.startsWith(prefix);
}

export class GitEvidenceProvider implements EvidenceProvider {
  readonly name = "git";
  readonly kind = "git" as const;

  async capture(context?: EvidenceCaptureContext): Promise<MachineObservation | null> {
    const workspace = context?.cwd ?? process.cwd();
    const phase = context?.phase ?? "after";
    const startedAt = Date.now();
    // v3.8.1: the runtime's OWN state directory is not the agent's work. The
    // vault lives inside the workspace by default, so every round's
    // bookkeeping writes would otherwise read as machine-observed motion —
    // the very signal the stall evaluator and the restore checks consume. The
    // exclusion lives here, at the fact, and not in the workspace's
    // .gitignore (which the runtime does not own and a user may not have).
    const stateDir = stateDirectory(workspace);
    const isRuntimeState = (file: string): boolean =>
      stateDir !== null && isInsideDirectory(file, workspace, stateDir);

    // The collector already races providers, but a library caller has no
    // such guard. Enforce the same budget here: abort the child commands and
    // the hashing loop, and report a TIMEOUT rather than a partial boundary.
    const controller = new AbortController();
    const external = context?.signal;
    let timedOut = false;
    const onExternalAbort = (): void => controller.abort(external?.reason);
    if (external?.aborted) controller.abort(external.reason);
    else external?.addEventListener("abort", onExternalAbort, { once: true });
    const budget = context?.timeoutMs ?? 0;
    const timer = budget > 0
      ? setTimeout(() => {
          timedOut = true;
          controller.abort(new Error("boundary capture timed out"));
        }, budget)
      : undefined;

    try {
      const result = await captureBoundary({
        cwd: workspace,
        signal: controller.signal,
        ...(context?.timeoutMs !== undefined ? { timeoutMs: context.timeoutMs } : {}),
        exclude: isRuntimeState,
        ...(context?.materializer ? { materializer: context.materializer } : {}),
        ...(context?.maxPaths !== undefined ? { maxPaths: context.maxPaths } : {}),
      });
      if (timedOut) {
        return syntheticObservation(
          this.name,
          this.kind,
          phase,
          startedAt,
          "timeout",
          `boundary capture exceeded ${budget}ms`,
        );
      }
      if (!result.ok) {
        return syntheticObservation(
          this.name,
          this.kind,
          phase,
          startedAt,
          result.status,
          result.detail,
        );
      }
      const boundary = result.boundary;
      context?.boundarySink?.(boundary);
      return {
        schemaVersion: expectedObservationSchemaVersion("git"),
        providerId: "git",
        kind: "git",
        phase,
        startedAt,
        finishedAt: Date.now(),
        status: "observed",
        // `files` is the dirty display list; the complete boundary lives in
        // data.fingerprints and the round delta is derived from it.
        files: [...boundary.dirty],
        data: {
          dirty: [...boundary.dirty],
          fingerprints: boundary.fingerprints,
          ...(boundary.head ? { head: boundary.head } : {}),
          coverage: "tracked_and_non_ignored_untracked",
        },
      };
    } catch (error) {
      const status = timedOut
        ? "timeout" as const
        : error instanceof GitCaptureFailure
          ? error.status
          : "error";
      return syntheticObservation(
        this.name,
        this.kind,
        phase,
        startedAt,
        status,
        String(error instanceof Error ? error.message : error),
      );
    } finally {
      if (timer) clearTimeout(timer);
      external?.removeEventListener("abort", onExternalAbort);
    }
  }
}

registerEvidenceProvider("git", () => new GitEvidenceProvider());

// ── Utility ────────────────────────────────────────────────────────────────

/** v3.9.9: ONE provider's before→after progress FACT. It reports what the
 *  provider observed — never a vote and never a policy. `null` means the
 *  provider produced no progress fact at all (command observations, or a
 *  custom provider that declared no coverage). */
export interface ObservationProgress {
  kind: "git" | "custom";
  coverage: ProgressCoverage;
  /** The only authority. */
  state: "changed" | "unchanged" | "unknown";
  /** The provider's completeness assertion — display/diagnosis only. */
  complete: boolean;
  detail?: string;
}

/** v3.9.1: One provider's derived before→after view. `before`/`after` are
 *  references to the persisted observations — never copies, never mutated.
 *  Only `changedFiles` is a derived fact; it is null for every non-Git
 *  provider (command entrypoints are not a change set) and for any Git pair
 *  whose boundary cannot be compared. */
export interface ObservationDelta {
  providerId: string;
  kind: MachineObservation["kind"];
  before: MachineObservation | null;
  after: MachineObservation | null;
  /** Git only. [] = observed no change; null = unknown.
   *  command/custom always null (no file-change concept). */
  changedFiles: string[] | null;
  /** v3.9.9: this provider's before→after progress fact, or null when the
   *  provider reports no progress at all. Consumers select the facts they
   *  need by (kind, coverage) — nothing aggregates globally anymore. */
  progress: ObservationProgress | null;
}

function customProgressSnapshot(
  observation: MachineObservation | null,
): ProgressSnapshot | null {
  if (observation?.kind !== "custom") return null;
  const value = observation.data.progress;
  return isValidProgressSnapshot(value, observation.status) ? value : null;
}

/** The Git fact descriptor is derived from the PERSISTED observation, not from
 *  a code constant: the scope is the boundary coverage the observation
 *  declared and the version is its schema version, so a historical
 *  observation with different evidence semantics naturally stops matching the
 *  rule instead of being retroactively rewritten by future code. */
function gitProgressCoverage(
  observation: MachineObservation | null,
): ProgressCoverage {
  if (observation?.kind === "git") {
    const scope = typeof observation.data.coverage === "string" &&
        observation.data.coverage.length > 0
      ? observation.data.coverage
      : GIT_WORKSPACE_COVERAGE.scope;
    const version = Number.isInteger(observation.schemaVersion) &&
        observation.schemaVersion >= 1
      ? observation.schemaVersion
      : GIT_WORKSPACE_COVERAGE.version;
    return {
      domain: GIT_WORKSPACE_COVERAGE.domain,
      object: GIT_WORKSPACE_COVERAGE.object,
      scope,
      version,
    };
  }
  return { ...GIT_WORKSPACE_COVERAGE };
}

function deltaProgressFact(
  observation: MachineObservation,
  beforeObservation: MachineObservation | null,
  afterObservation: MachineObservation | null,
  changedFiles: string[] | null,
  ambiguous: boolean,
): ObservationProgress | null {
  if (observation.kind === "git") {
    const coverage = gitProgressCoverage(afterObservation ?? beforeObservation);
    const observable = !ambiguous &&
      beforeObservation?.kind === "git" &&
      afterObservation?.kind === "git" &&
      beforeObservation.status === "observed" &&
      afterObservation.status === "observed" &&
      changedFiles !== null;
    if (!observable) {
      return {
        kind: "git",
        coverage,
        state: "unknown",
        complete: false,
        detail: "the Git boundary pair is not comparable",
      };
    }
    const signal = gitMotionSignal({
      changedFiles,
      headBefore: observedGitHead(beforeObservation),
      headAfter: observedGitHead(afterObservation),
    });
    if (signal === null) {
      return {
        kind: "git",
        coverage,
        state: "unknown",
        complete: true,
        detail: "the Git change set is known but HEAD movement is not comparable",
      };
    }
    return {
      kind: "git",
      coverage,
      state: signal ? "changed" : "unchanged",
      complete: true,
    };
  }

  if (observation.kind !== "custom") return null;
  const beforeSnapshot = customProgressSnapshot(beforeObservation);
  const afterSnapshot = customProgressSnapshot(afterObservation);
  // No progress data on either side: this provider declared no coverage.
  if (!beforeSnapshot && !afterSnapshot) return null;
  const coverage = (afterSnapshot ?? beforeSnapshot)!.coverage;
  const complete = (afterSnapshot ?? beforeSnapshot)!.complete;
  if (ambiguous) {
    return {
      kind: "custom",
      coverage,
      state: "unknown",
      complete,
      detail: "duplicate observations make the progress fact ambiguous",
    };
  }
  if (!beforeSnapshot || !afterSnapshot) {
    return {
      kind: "custom",
      coverage,
      state: "unknown",
      complete: false,
      detail: "a progress snapshot is missing on one side of the round",
    };
  }
  if (beforeObservation?.status !== "observed" ||
      afterObservation?.status !== "observed") {
    return {
      kind: "custom",
      coverage,
      state: "unknown",
      complete,
      detail: "at least one side was not observed",
    };
  }
  if (!sameCoverage(beforeSnapshot.coverage, afterSnapshot.coverage)) {
    return {
      kind: "custom",
      coverage,
      state: "unknown",
      complete,
      detail:
        `coverage changed across the round (` +
        `${coverageKey(beforeSnapshot.coverage)} -> ${coverageKey(afterSnapshot.coverage)})`,
    };
  }
  if (beforeSnapshot.complete !== true || afterSnapshot.complete !== true ||
      beforeSnapshot.fingerprint === null || afterSnapshot.fingerprint === null) {
    return {
      kind: "custom",
      coverage,
      state: "unknown",
      complete: false,
      detail: "a progress snapshot is incomplete or has no fingerprint",
    };
  }
  return {
    kind: "custom",
    coverage,
    state: beforeSnapshot.fingerprint === afterSnapshot.fingerprint
      ? "unchanged"
      : "changed",
    complete: true,
  };
}

/** Stable display key for a coverage descriptor — derived only, never
 *  persisted, never used as an identity substitute for exact comparison. */
export function coverageKey(coverage: ProgressCoverage): string {
  return `${coverage.domain}/${coverage.object}/${coverage.scope}@${coverage.version}`;
}

/** The Git change set for a round, with applicability kept distinct from
 *  observability: no Git provider is `not_applicable`; a Git provider whose
 *  boundary cannot be compared is `unknown` (never an empty set). */
export type GitDeltaState =
  | { state: "not_applicable" }
  | { state: "unknown" }
  | { state: "observed"; changedFiles: ReadonlySet<string> };

const DELTA_KIND_ORDER: Record<MachineObservation["kind"], number> = {
  git: 0,
  command: 1,
  custom: 2,
};

function deltaKey(observation: MachineObservation): string {
  return `${observation.kind}\u0000${observation.providerId}`;
}

function snapshotFingerprints(
  observation: MachineObservation,
): Record<string, string> | null {
  if (observation.kind !== "git") return null;
  const value = observation.data.fingerprints;
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const entries = Object.entries(value);
  // A partial map cannot produce a sound diff: an unsupported value could be
  // the one real change. Unknown is null, never a filtered subset.
  if (!entries.every(([, fingerprint]) => typeof fingerprint === "string")) {
    return null;
  }
  return Object.fromEntries(entries) as Record<string, string>;
}

function diffFingerprints(
  before: Record<string, string>,
  after: Record<string, string>,
): string[] {
  const candidates = new Set([...Object.keys(before), ...Object.keys(after)]);
  return [...candidates]
    .filter((file) => before[file] !== after[file])
    .sort();
}

/** The ONE before→after derivation. Delta entries are one per
 *  kind+providerId in the union of both collections, in deterministic order.
 *  Missing sides and duplicate keys are explicit; they never masquerade as an
 *  observed no-change. */
export function deriveObservationDeltas(
  before: readonly MachineObservation[],
  after: readonly MachineObservation[],
): ObservationDelta[] {
  const beforeByKey = new Map<string, MachineObservation[]>();
  const afterByKey = new Map<string, MachineObservation[]>();
  for (const observation of before) {
    const key = deltaKey(observation);
    const bucket = beforeByKey.get(key);
    if (bucket) bucket.push(observation);
    else beforeByKey.set(key, [observation]);
  }
  for (const observation of after) {
    const key = deltaKey(observation);
    const bucket = afterByKey.get(key);
    if (bucket) bucket.push(observation);
    else afterByKey.set(key, [observation]);
  }

  const keys = [...new Set([...beforeByKey.keys(), ...afterByKey.keys()])];
  const deltas = keys.map((key): ObservationDelta => {
    const beforeList = beforeByKey.get(key) ?? [];
    const afterList = afterByKey.get(key) ?? [];
    const beforeObservation = beforeList[0] ?? null;
    const afterObservation = afterList[0] ?? null;
    const observation = afterObservation ?? beforeObservation!;
    const ambiguous = beforeList.length > 1 || afterList.length > 1;

    let changedFiles: string[] | null = null;
    if (!ambiguous &&
        observation.kind === "git" &&
        beforeObservation?.kind === "git" &&
        afterObservation?.kind === "git" &&
        beforeObservation.status === "observed" &&
        afterObservation.status === "observed") {
      const beforeFingerprints = snapshotFingerprints(beforeObservation);
      const afterFingerprints = snapshotFingerprints(afterObservation);
      if (beforeFingerprints && afterFingerprints) {
        changedFiles = diffFingerprints(beforeFingerprints, afterFingerprints);
      }
    }

    return {
      providerId: observation.providerId,
      kind: observation.kind,
      before: beforeObservation,
      after: afterObservation,
      changedFiles,
      progress: deltaProgressFact(
        observation,
        beforeObservation,
        afterObservation,
        changedFiles,
        ambiguous,
      ),
    };
  });

  return deltas.sort((left, right) =>
    DELTA_KIND_ORDER[left.kind] - DELTA_KIND_ORDER[right.kind] ||
    left.providerId.localeCompare(right.providerId));
}

/** Resolve the round's Git change state once. No Git provider =
 *  not_applicable; any Git delta with an unknown change set = unknown; else
 *  the union of every observed Git change set. */
export function gitDeltaState(
  deltas: readonly ObservationDelta[],
): GitDeltaState {
  const git = deltas.filter((delta) => delta.kind === "git");
  if (git.length === 0) return { state: "not_applicable" };
  if (git.some((delta) => delta.changedFiles === null)) return { state: "unknown" };
  const changedFiles = new Set<string>();
  for (const delta of git) {
    for (const file of delta.changedFiles!) changedFiles.add(file);
  }
  return { state: "observed", changedFiles };
}

/** The after-phase observations referenced by a delta collection. */
export function afterObservations(
  deltas: readonly ObservationDelta[],
): MachineObservation[] {
  return deltas
    .map((delta) => delta.after)
    .filter((observation): observation is MachineObservation => observation !== null);
}
