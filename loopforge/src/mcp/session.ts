/** LoopForge MCP — Session manager.
 *
 * Each McpSession = one complete multi-round loop.
 * SessionManager holds Map<sessionId, McpSession> and drives
 * the advance() cycle: extract → feedback → check stop → compile next.
 */

import { randomUUID } from "node:crypto";
import { LoopForgeEngine, extractSelfEvaluation, heuristicSelfEvaluation } from "../engine.js";
import { getPolicy } from "../policy.js";
import { Mode, makeVaultConfig } from "../protocol.js";
import { ReplayBackend } from "../replay.js";
import { FSBackend } from "../backends/fs.js";
import type { VaultBackend } from "../backends/interface.js";
import type { LoopForgeRequest, SelfEvaluation } from "../protocol.js";

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

function buildLoopRequest(session: McpSession, lastEval?: SelfEvaluation, lastQuality?: number): Record<string, unknown> {
  const req: Record<string, unknown> = {
    task: session.task,
    mode: Mode.LOOP_COMPILE,
    vault_config: makeVaultConfig(),
    feedback: null,
    skill_name: null,
    task_id: null,
    loop_id: session.loopId,
    round: session.currentRound,
  };

  if (lastEval && lastQuality !== undefined) {
    req.last_round_result = {
      round: session.currentRound - 1,
      success: lastEval.success,
      output_summary: lastEval.output_summary,
      constraint_violations: lastEval.constraint_violations,
      manual_fixes_needed: "",
      quality_score: lastQuality,
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
    return true;
  }

  list(): McpSessionSummary[] {
    return [...this.sessions.values()].map((s) => ({
      sessionId: s.sessionId,
      loopId: s.loopId,
      round: s.currentRound,
      status: s.status,
    }));
  }

  /** Core cycle: extract self-eval → record feedback → check stop → compile next. */
  advance(sessionId: string, output: string): AdvanceResult {
    const session = this.sessions.get(sessionId);
    if (!session) return { sessionId, round: 0, prompt: null, stopReason: "session_not_found" };
    if (session.status !== "running") {
      return { sessionId, round: session.currentRound, prompt: null, stopReason: session.status };
    }

    // 1. Extract self-evaluation
    const structured = extractSelfEvaluation(output);
    const extractionFailed = structured === null;
    const selfEval = structured ?? heuristicSelfEvaluation(output);

    // Guard: if both extraction methods returned null, stop
    if (!selfEval) {
      session.status = "stalled";
      return { sessionId, round: session.currentRound, prompt: null, stopReason: "stalled", quality: 0 };
    }

    // 2. Record feedback (flushes immediately so next compile sees scores)
    const quality = session.engine.autoFeedback(
      selfEval, session.loopId, session.currentRound, session.task,
    );
    session.qualityTrajectory.push(quality);

    // 3. Stop conditions (extraction-first order — see memory)
    if (extractionFailed) {
      session.status = "stalled";
      return { sessionId, round: session.currentRound, prompt: null, stopReason: "stalled", quality };
    }
    if (!selfEval.should_continue) {
      session.status = "stopped";
      return { sessionId, round: session.currentRound, prompt: null, stopReason: "task_complete", quality };
    }
    if (session.engine.shouldBreak()) {
      session.status = "stopped";
      return { sessionId, round: session.currentRound, prompt: null, stopReason: "circuit_breaker", quality };
    }
    if (session.currentRound >= session.maxRounds) {
      session.status = "stopped";
      return { sessionId, round: session.currentRound, prompt: null, stopReason: "max_rounds", quality };
    }

    // 4. Compile next round
    session.currentRound++;
    const request = buildLoopRequest(session, selfEval, quality);
    const result = session.engine.invokeLoopCompile(request as unknown as LoopForgeRequest);

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
