/** LoopForge MCP — Session manager.
 *
 * Each McpSession = one complete multi-round loop.
 * SessionManager holds Map<sessionId, McpSession> and drives
 * the advance() cycle: extract → feedback → check stop → compile next.
 */

import { randomUUID } from "node:crypto";
import { LoopForgeEngine, extractSelfEvaluation, heuristicSelfEvaluation } from "../engine.js";
import { checkLoopHealth } from "../loop-compiler.js";
import { getPolicy } from "../policy.js";
import { Mode, makeLoopCompileRequest, makeVaultConfig } from "../protocol.js";
import { ReplayBackend } from "../replay.js";
import { FSBackend } from "../backends/fs.js";
import type { VaultBackend, VaultEntry } from "../backends/interface.js";
import type { LoopForgeRequest, SelfEvaluation, VerificationFlag } from "../protocol.js";
import { verifySelfEvaluation } from "../verification-gate.js";
import { logEvent } from "../observability.js";

// ── Types ──────────────────────────────────────────────────────────────────

export interface McpSession {
  sessionId: string;
  loopId: string;
  task: string;
  engine: LoopForgeEngine;
  currentRound: number;
  maxRounds: number;
  qualityTrajectory: number[];
  status: "running" | "stopped" | "stalled";
  createdAt: number;
  /** Previous round's validated SelfEvaluation — used by verification gate. */
  lastSelfEval?: SelfEvaluation;
}

export interface McpSessionSummary {
  sessionId: string;
  loopId: string;
  round: number;
  status: "running" | "stopped" | "stalled";
}

export interface StartInput {
  task: string;
  loopId?: string;
  maxRounds?: number;
  domain?: string;
  planSource?: string;
  constraints?: string[];
}

export interface AdvanceResult {
  sessionId: string;
  round: number;
  prompt: string | null;
  stopReason?: string;
  technique?: string;
  level?: string;
  quality?: number;
  warnings?: string[];
}

// ── Helpers ────────────────────────────────────────────────────────────────

function buildLoopRequest(
  session: McpSession,
  lastEval?: SelfEvaluation,
  lastQuality?: number,
  verificationFlags?: VerificationFlag[],
): Record<string, unknown> {
  const req: Record<string, unknown> = {
    task: session.task,
    mode: Mode.LOOP_COMPILE,
    vault_config: makeVaultConfig(),
    feedback: null,
    skill_name: null,
    task_id: null,
    loop_id: session.loopId,
    round: session.currentRound,
    verification_flags: verificationFlags ?? [],
  };

  if (lastEval && lastQuality !== undefined) {
    req.last_round_result = {
      round: session.currentRound - 1,
      success: lastEval.success,
      output_summary: lastEval.output_summary,
      constraint_violations: lastEval.constraint_violations,
      manual_fixes_needed: "",
      quality_score: lastQuality,
      // P0–P2: Forward evolution fields to next compile
      discovered_constraints: lastEval.discovered_constraints ?? [],
      objective_refinement: lastEval.objective_refinement ?? "",
      emerged_subtasks: lastEval.emerged_subtasks ?? [],
      // P4: Execution evidence
      execution_evidence: lastEval.execution_evidence ?? undefined,
      // P5: Self-correction
      retracted_constraints: lastEval.retracted_constraints ?? [],
      revised_success_criteria: lastEval.revised_success_criteria ?? [],
      wrong_assumptions: lastEval.wrong_assumptions ?? [],
    };
  }

  return req;
}

function parseLevel(rationale?: string): string {
  if (!rationale) return "l2";
  if (rationale.includes("l0")) return "l0";
  if (rationale.includes("l1")) return "l1";
  return "l2";
}

function parseWarnings(prompt: string | null): string[] {
  if (!prompt) return [];
  const warnings: string[] = [];
  const warnSection = prompt.match(/### Warnings\n([\s\S]*?)(?=\n###|\n\*\*|$)/);
  if (warnSection) {
    for (const line of warnSection[1].split("\n")) {
      const m = line.match(/- ⚠️\s*(.+)/);
      if (m) warnings.push(m[1]);
    }
  }
  return warnings;
}

// ── SessionManager ─────────────────────────────────────────────────────────

export class SessionManager {
  private sessions = new Map<string, McpSession>();
  private backend: VaultBackend | undefined;

  constructor(backend?: VaultBackend) {
    this.backend = backend;
  }

  create(input: StartInput): AdvanceResult {
    const sessionId = randomUUID();
    const loopId = input.loopId ?? randomUUID();
    const engine = new LoopForgeEngine("skills", this.backend);
    const maxRounds = input.maxRounds ?? getPolicy().runtime.max_rounds;

    // Populate extra fields for the first round
    const request = buildLoopRequest({
      sessionId, loopId, task: input.task, engine, currentRound: 1,
      maxRounds, qualityTrajectory: [], status: "running", createdAt: Date.now(),
    });
    request.domain = input.domain ?? "";
    request.plan_source = input.planSource ?? null;
    request.constraints_from_plan = input.constraints ?? [];

    const result = engine.invokeLoopCompile(request as unknown as LoopForgeRequest);

    const session: McpSession = {
      sessionId, loopId, task: input.task, engine,
      currentRound: 1, maxRounds, qualityTrajectory: [],
      status: "running", createdAt: Date.now(),
    };
    this.sessions.set(sessionId, session);

    // Persist to vault for cross-process recovery
    this.save(session);

    logEvent("session_start", {
      sessionId,
      loopId,
      task: input.task.slice(0, 80),
      maxRounds,
    });

    return {
      sessionId,
      round: 1,
      prompt: result.response?.prompt ?? null,
      technique: result.response?.analysis?.technique ?? "zero-shot",
      level: parseLevel(result.response?.analysis?.rationale),
      quality: 0,
      warnings: parseWarnings(result.response?.prompt ?? null),
    };
  }

  get(sessionId: string): McpSession | undefined {
    return this.sessions.get(sessionId);
  }

  delete(sessionId: string): boolean {
    const session = this.sessions.get(sessionId);
    if (!session) return false;
    session.status = "stopped";
    this.sessions.delete(sessionId);
    logEvent("session_end", {
      sessionId,
      loopId: session.loopId,
      stopReason: "stopped",
      roundsCompleted: session.currentRound,
    });
    return true;
  }

  /** Persist session state to vault for cross-process recovery.
   *  Uses upsert: removes any previous session_state entry for this loop,
   *  then appends a new one with current state.
   *  Entire read→filter→write→append is wrapped in a file lock to prevent
   *  lost updates from concurrent processes. */
  save(session: McpSession): void {
    if (!this.backend) return;

    const doSave = () => {
      // Upsert: remove old session_state entries for this loop
      const vault = this.backend!.readVault();
      const entries = (vault.entries as VaultEntry[]) || [];
      vault.entries = entries.filter(
        (e: VaultEntry) =>
          !(e.task_type === "session_state" && e.loop_id === session.loopId),
      );
      this.backend!.writeVault(vault);

      // Append fresh session state
      this.backend!.appendEntry({
        task_id: `loop:${session.loopId}:session`,
        task_type: "session_state",
        timestamp: new Date().toISOString(),
        loop_id: session.loopId,
        task: session.task,
        loop_lineage: {
          session_id: session.sessionId,
          current_round: session.currentRound,
          max_rounds: session.maxRounds,
          quality_trajectory: session.qualityTrajectory,
          status: session.status,
          created_at: session.createdAt,
        },
      });
    };

    // Use FSBackend's file lock if available (only FSBackend implements withLock)
    if (
      "withLock" in this.backend &&
      typeof (this.backend as FSBackend).withLock === "function"
    ) {
      (this.backend as FSBackend).withLock(doSave);
    } else {
      doSave();
    }
  }

  /** Resume a loop from vault state.
   *  Reconstructs the session and compiles the prompt for the next round.
   *  Returns null if no session_state entry exists for this loopId. */
  resume(loopId: string): AdvanceResult | null {
    if (!this.backend) return null;

    const entries = this.backend.queryEntries({
      prefix: `loop:${loopId}:session`,
    });
    const sessionEntry = entries.find(
      (e) => e.task_type === "session_state",
    );
    if (!sessionEntry) return null;

    const lineage = (sessionEntry.loop_lineage ?? {}) as Record<
      string,
      unknown
    >;
    const status = (lineage.status as string) ?? "running";
    const currentRound = (lineage.current_round as number) ?? 1;
    const qualityTrajectory =
      (lineage.quality_trajectory as number[]) ?? [];
    const task = (sessionEntry.task as string) ?? "";
    const maxRounds =
      (lineage.max_rounds as number) ?? getPolicy().runtime.max_rounds;

    // If the loop was already stopped or stalled, return immediately
    if (status !== "running") {
      return {
        sessionId: "",
        round: currentRound,
        prompt: null,
        stopReason: status,
      };
    }

    // Reconstruct session with a fresh engine
    const engine = new LoopForgeEngine("skills", this.backend);
    const sessionId = randomUUID();
    const session: McpSession = {
      sessionId,
      loopId,
      task,
      engine,
      currentRound,
      maxRounds,
      qualityTrajectory,
      status: "running",
      createdAt: (lineage.created_at as number) ?? Date.now(),
    };
    this.sessions.set(sessionId, session);

    // Compile the next round's prompt from vault lineage
    const request = buildLoopRequest(session);
    const result = engine.invokeLoopCompile(
      request as unknown as LoopForgeRequest,
    );

    return {
      sessionId,
      round: currentRound,
      prompt: result.response?.prompt ?? null,
      technique: result.response?.analysis?.technique ?? "zero-shot",
      level: parseLevel(result.response?.analysis?.rationale),
      quality: 0,
      warnings: parseWarnings(result.response?.prompt ?? null),
    };
  }

  list(): McpSessionSummary[] {
    const seen = new Set<string>();
    const result: McpSessionSummary[] = [];

    // In-memory sessions first (take priority)
    for (const s of this.sessions.values()) {
      seen.add(s.loopId);
      result.push({
        sessionId: s.sessionId,
        loopId: s.loopId,
        round: s.currentRound,
        status: s.status,
      });
    }

    // Merge vault-persisted sessions not already in memory
    if (this.backend) {
      const vault = this.backend.readVault();
      const entries = (vault.entries as VaultEntry[]) ?? [];
      for (const e of entries) {
        if (e.task_type !== "session_state") continue;
        const lid = e.loop_id ?? "";
        if (!lid || seen.has(lid)) continue;
        seen.add(lid);
        const lineage = (e.loop_lineage ?? {}) as Record<string, unknown>;
        result.push({
          sessionId: "",
          loopId: lid,
          round: (lineage.current_round as number) ?? 1,
          status: ((lineage.status as string) || "running") as McpSession["status"],
        });
      }
    }

    return result;
  }

  /** Get loop health for a loop (in-memory or vault).
   *  Computes goal alignment, constraint integrity, drift, strategy stability. */
  getHealth(loopId: string): Record<string, unknown> | null {
    // Find the task — check in-memory sessions first, then vault
    let task = "";
    let goalId = loopId;

    for (const s of this.sessions.values()) {
      if (s.loopId === loopId) {
        task = s.task;
        if (s.engine.state?.task_id) {
          goalId = s.engine.state.task_id;
        }
        break;
      }
    }

    // Fall back to vault for task
    if (!task && this.backend) {
      const entries = this.backend.queryEntries({
        prefix: `loop:${loopId}:session`,
      });
      const sessionEntry = entries.find(
        (e) => e.task_type === "session_state",
      );
      if (sessionEntry) {
        task = (sessionEntry.task as string) ?? "";
      }
    }

    if (!task) return null;

    // Hydrate vault context
    const engine = new LoopForgeEngine("skills", this.backend);
    const vaultContext = engine.hydrateLoopContext(loopId);

    // Build a minimal request for health check
    const request = makeLoopCompileRequest({
      task,
      loop_id: loopId,
      goal_id: goalId,
      round: 1, // round doesn't matter for health check
    });

    const health = checkLoopHealth(loopId, request, vaultContext);
    return {
      loopId,
      goal_alignment: health.goal_alignment,
      constraint_integrity: health.constraint_integrity,
      drift_detected: health.drift_detected,
      strategy_stability: health.strategy_stability,
      task_continuity: health.task_continuity,
    };
  }

  /** Core cycle: extract self-eval → record feedback → check stop → compile next.
   *  @param preExtractedEval Optional pre-built SelfEvaluation from MCP tool parameter.
   *    When provided (MCP path with evaluation parameter), skips regex extraction.
   *    When undefined (runtime/CLI path), falls back to regex extraction from output. */
  advance(sessionId: string, output: string, preExtractedEval?: SelfEvaluation): AdvanceResult {
    const session = this.sessions.get(sessionId);
    if (!session) return { sessionId, round: 0, prompt: null, stopReason: "session_not_found" };
    if (session.status !== "running") {
      return { sessionId, round: session.currentRound, prompt: null, stopReason: session.status };
    }

    // 1. Extract self-evaluation (structured param preferred → regex → heuristic)
    let extractionFailed = false;
    let selfEval: SelfEvaluation | null;
    if (preExtractedEval) {
      selfEval = preExtractedEval;
      extractionFailed = false;
    } else {
      const structured = extractSelfEvaluation(output);
      extractionFailed = structured === null;
      selfEval = structured ?? heuristicSelfEvaluation(output);
    }

    // Guard: if both extraction methods returned null, stop
    if (!selfEval) {
      session.status = "stalled";
      this.save(session);
      logEvent("session_end", { sessionId, loopId: session.loopId, stopReason: "stalled", round: session.currentRound });
      return { sessionId, round: session.currentRound, prompt: null, stopReason: "stalled", quality: 0 };
    }

    // 1.5. Verification gate — cross-round consistency check (v1.6)
    let verificationFlags: VerificationFlag[] = [];
    let gateVerdict: string = "trusted";
    {
      const vaultEntries = this.backend
        ? this.backend.queryEntries({ prefix: `loop:${session.loopId}:r` })
        : [];
      const verifyResult = verifySelfEvaluation(
        selfEval,
        session.currentRound,
        vaultEntries,
        session.lastSelfEval ?? null,
      );
      verificationFlags = verifyResult.flags;
      gateVerdict = verifyResult.verdict;
    }

    // 2. Record feedback (flushes immediately so next compile sees scores)
    const quality = session.engine.autoFeedback(
      selfEval, session.loopId, session.currentRound, session.task,
    );

    // Contradicted verdict: skip quality trend (quality score is unreliable)
    if (gateVerdict !== "contradicted") {
      session.qualityTrajectory.push(quality);
    }
    // Note: feedback vault entry is always persisted via autoFeedback above.
    // Only the in-memory trend is skipped — the raw data stays for audit.

    // Store selfEval for next round's verification gate.
    // NOTE: lastSelfEval is intentionally NOT persisted to vault (save()).
    // A resumed session starts with lastSelfEval=undefined, which means the
    // first round after resumption runs with degraded verification (most
    // checks skip without prevSelfEval). The gate recovers on the next round.
    session.lastSelfEval = selfEval;

    // 3. Stop conditions (extraction-first order — see memory)
    if (extractionFailed) {
      session.status = "stalled";
      this.save(session);
      logEvent("session_end", { sessionId, loopId: session.loopId, stopReason: "stalled", round: session.currentRound });
      return { sessionId, round: session.currentRound, prompt: null, stopReason: "stalled", quality };
    }
    if (!selfEval.should_continue) {
      session.status = "stopped";
      this.save(session);
      logEvent("session_end", { sessionId, loopId: session.loopId, stopReason: "task_complete", round: session.currentRound });
      return { sessionId, round: session.currentRound, prompt: null, stopReason: "task_complete", quality };
    }
    if (session.engine.shouldBreak()) {
      session.status = "stopped";
      this.save(session);
      logEvent("session_end", { sessionId, loopId: session.loopId, stopReason: "circuit_breaker", round: session.currentRound });
      return { sessionId, round: session.currentRound, prompt: null, stopReason: "circuit_breaker", quality };
    }
    if (session.currentRound >= session.maxRounds) {
      session.status = "stopped";
      this.save(session);
      logEvent("session_end", { sessionId, loopId: session.loopId, stopReason: "max_rounds", round: session.currentRound });
      return { sessionId, round: session.currentRound, prompt: null, stopReason: "max_rounds", quality };
    }

    // 4. Compile next round
    session.currentRound++;
    const request = buildLoopRequest(session, selfEval, quality, verificationFlags);
    const result = session.engine.invokeLoopCompile(request as unknown as LoopForgeRequest);

    this.save(session);

    return {
      sessionId,
      round: session.currentRound,
      prompt: result.response?.prompt ?? null,
      technique: result.response?.analysis?.technique ?? "zero-shot",
      level: parseLevel(result.response?.analysis?.rationale),
      quality,
      warnings: parseWarnings(result.response?.prompt ?? null),
    };
  }

  /** Replay timeline for a session — creates ReplayBackend from the stored backend. */
  replayTimeline(sessionId: string): Record<string, unknown>[] | null {
    const session = this.sessions.get(sessionId);
    if (!session) return null;

    const vaultBackend = this.backend ?? new FSBackend();
    const replay = new ReplayBackend(vaultBackend);
    return replay.timeline(session.loopId);
  }
}
