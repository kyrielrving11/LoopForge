import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import { LoopForgeEngine } from "../engine.js";
import { FileLoopStore } from "../loop-store.js";
import { SessionManager } from "../mcp/session.js";
import { TOOL_HANDLERS } from "../mcp/tools.js";
import { normalizeRoundReport, parseRoundReport } from "../round-report.js";
import {
  parseRoundTransactionSnapshot,
  prepareRejectedAttempt,
  prepareRoundTransaction,
  RoundTransactionCoordinator,
} from "../round-transaction.js";
import type { PromptArtifact, RoundReportV1 } from "../protocol.js";
import { MemoryBackend } from "./_helpers.js";

const temporaryRoots: string[] = [];

function temporaryRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "loopforge-v3-convergence-"));
  temporaryRoots.push(root);
  return root;
}

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function promptArtifact(roundId: string, attempt: number): PromptArtifact {
  return {
    schemaVersion: 1,
    roundId,
    attempt,
    level: attempt > 1 ? "l0" : "l2",
    levelReasons: [attempt > 1 ? "retry_delta" : "first_round"],
    renderedPrompt: `prompt-${attempt}`,
    promptHash: `prompt-hash-${attempt}`,
    stateHash: "state-hash",
    basePromptVersion: "3.0.0",
    includedSections: ["objective"],
    budgetChars: 1000,
    charCount: 8,
    budgetExceeded: false,
    generatedAt: Date.now(),
  };
}

function runtimeFiles(root: string): string[] {
  return readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
    const path = join(root, entry.name);
    if (entry.isDirectory()) return entry.name === "tests" ? [] : runtimeFiles(path);
    return entry.isFile() && path.endsWith(".ts") ? [path] : [];
  });
}

describe("v3 report contract convergence", () => {
  it("accepts only the current contextRequest names and strict nested fields", () => {
    const valid = parseRoundReport({
      status: "in_progress",
      summary: "Inspected the active step.",
      contextRequest: {
        emphasize: ["current evidence gap"],
        confusion_points: ["Which claim remains unverified?"],
      },
    });
    assert.deepEqual(valid?.contextRequest?.emphasize, ["current evidence gap"]);

    assert.equal(parseRoundReport({
      status: "in_progress",
      summary: "Uses a removed alias.",
      contextRequest: { focus: ["old alias"] },
    }), null);
    assert.equal(parseRoundReport({
      status: "in_progress",
      summary: "Uses removed expansion routing.",
      contextRequest: { expand: ["plan_progress"] },
    }), null);
    assert.equal(parseRoundReport({
      status: "completed",
      summary: "Contains an unknown nested field.",
      evidence: { claims: [], legacyEvidence: true },
    }), null);
    assert.equal(parseRoundReport({
      status: "in_progress",
      summary: "Contains a removed top-level contract.",
      evaluation: {},
    }), null);
  });
});

describe("v3 transaction convergence", () => {
  it("keeps schema 3 across reject, same-round retry, commit, and replay", () => {
    const backend = new MemoryBackend();
    const engine = new LoopForgeEngine(backend);
    const rejectedBase = prepareRoundTransaction("tx-reject", 1, []);
    const rejectedReport: RoundReportV1 = {
      status: "completed",
      summary: "Claims completion with an unavailable check.",
      evidence: {
        claims: [{ targetId: "ac-unavailable", evidenceRefs: ["check:missing"] }],
      },
    };
    const rejectedEvaluation = normalizeRoundReport(rejectedReport, "executing", "ps-change", []);
    const rejected = new RoundTransactionCoordinator(engine, backend).process({
      snapshot: rejectedBase,
      task: "Reject invalid evidence",
      maxRounds: 5,
      evaluation: rejectedEvaluation,
      consecutiveRejections: 0,
      successTrajectory: [],
      actualEvidence: [],
    });
    assert.equal(rejected.snapshot.schemaVersion, 3);
    assert.equal(rejected.snapshot.phase, "rejected");
    assert.equal(rejected.snapshot.roundEvaluation?.report.summary, rejectedReport.summary);

    const retry = prepareRejectedAttempt(
      rejected.snapshot,
      promptArtifact(rejected.snapshot.roundId, 2),
    );
    assert.equal(retry.roundId, rejected.snapshot.roundId);
    assert.equal(retry.attempt, 2);
    assert.equal(retry.roundEvaluation, undefined);

    const commitBase = prepareRoundTransaction("tx-commit", 1, []);
    const committedEvaluation = normalizeRoundReport({
      status: "in_progress",
      summary: "Established a new verified fact.",
      discoveries: { facts: ["The implementation uses schema 3."] },
    }, "executing", "ps-change", []);
    committedEvaluation.materialAdvancement = { material: true, signals: ["new_discovery"], stepId: "ps-change" };
    const coordinator = new RoundTransactionCoordinator(engine, backend);
    const input = {
      snapshot: commitBase,
      task: "Commit normalized report",
      maxRounds: 5,
      evaluation: committedEvaluation,
      consecutiveRejections: 0,
      successTrajectory: [],
      actualEvidence: [],
    };
    const committed = coordinator.process(input);
    assert.equal(committed.snapshot.phase, "committed");
    assert.equal(committed.replayed, false);
    const replayed = coordinator.process(input);
    assert.equal(replayed.replayed, true);
    assert.equal(replayed.snapshot.roundEvaluation?.report.summary, committedEvaluation.report.summary);
    assert.equal(parseRoundTransactionSnapshot({ ...committed.snapshot, schemaVersion: 1 }), null);
  });

  it("does not replay a committed round from an abandoned execution epoch", () => {
    const backend = new MemoryBackend();
    const engine = new LoopForgeEngine(backend);
    const coordinator = new RoundTransactionCoordinator(engine, backend);
    const first = normalizeRoundReport({
      status: "in_progress",
      summary: "old branch",
    }, "executing", "ps-old", []);
    const committed = coordinator.process({
      snapshot: prepareRoundTransaction("branch-loop", 2, []),
      task: "branch-aware replay",
      maxRounds: 10,
      evaluation: first,
      consecutiveRejections: 0,
      successTrajectory: [],
      actualEvidence: [],
    });
    assert.equal(committed.replayed, false);

    const second = normalizeRoundReport({
      status: "in_progress",
      summary: "new branch after backtrack",
    }, "executing", "ps-new", []);
    const branched = coordinator.process({
      snapshot: prepareRoundTransaction("branch-loop", 2, [], undefined, 1),
      task: "branch-aware replay",
      maxRounds: 10,
      evaluation: second,
      consecutiveRejections: 0,
      successTrajectory: [],
      actualEvidence: [],
    });
    assert.equal(branched.replayed, false);
    assert.equal(branched.snapshot.executionEpoch, 1);
    assert.equal(branched.snapshot.roundEvaluation?.report.summary, "new branch after backtrack");
  });
});

describe("unsupported session isolation", () => {
  it("lists schema 1 sessions as incompatible and never rewrites them", async () => {
    const root = temporaryRoot();
    const loopId = "schema-one-session";
    const hash = createHash("sha256").update(loopId).digest("hex");
    const loopRoot = join(root, "loops", hash);
    mkdirSync(loopRoot, { recursive: true });
    writeFileSync(join(loopRoot, "metadata.json"), JSON.stringify({ schemaVersion: 1, loopId }), "utf8");
    const sessionPath = join(loopRoot, "session.json");
    const original = JSON.stringify({
      schemaVersion: 1,
      loopId,
      updatedAt: "2026-01-01T00:00:00.000Z",
      entry: {
        task_id: `loop:${loopId}:session`,
        task_type: "session_state",
        loop_id: loopId,
        loop_lineage: { session_schema_version: 1, status: "paused" },
      },
    }, null, 2);
    writeFileSync(sessionPath, original, "utf8");

    const manager = new SessionManager(new FileLoopStore(root));
    const listed = await TOOL_HANDLERS.loopforge_list(manager, {});
    assert.deepEqual(listed.sessions, []);
    assert.deepEqual(listed.incompatibleSessions, [{
      loopId,
      foundSchemaVersion: 1,
      requiredSchemaVersion: 3,
    }]);
    assert.throws(() => manager.resume(loopId), /session_version_unsupported.*schema 1.*schema 3.*new loop/i);
    assert.equal(readFileSync(sessionPath, "utf8"), original);
    manager.close();
  });
});

describe("public surface and removed-symbol guard", () => {
  it("does not expose internal compiler or engine entry points", async () => {
    const packageJson = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8")) as {
      exports: Record<string, unknown>;
    };
    assert.equal(packageJson.exports["./compiler"], undefined);
    const publicApi = await import("../index.js");
    assert.equal("LoopForgeEngine" in publicApi, false);
    assert.equal("compileLoop" in publicApi, false);
    assert.equal("SessionManager" in publicApi, false);
    assert.equal("ReplayBackend" in publicApi, false);
  });

  it("keeps removed compatibility symbols out of runtime TypeScript", () => {
    const sourceRoot = new URL("..", import.meta.url);
    const files = runtimeFiles(sourceRoot.pathname.replace(/^\/(.:\/)/, "$1"));
    const text = files.map((file) => readFileSync(file, "utf8")).join("\n");
    for (const symbol of [
      "legacy_execution",
      "SelfEvaluation",
      "progress_estimate",
      "next_action",
      "drift_clarification",
      "completed_subtasks",
      "blocked_subtasks",
      "canceled_subtasks",
      "---loopforge-eval",
      "last_self_eval",
    ]) {
      assert.doesNotMatch(text, new RegExp(symbol));
    }
  });
});
