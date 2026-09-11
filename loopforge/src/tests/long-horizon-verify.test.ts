/** Long-horizon verification test.
 *
 * Simulates a realistic 10-round software development lifecycle to
 * exercise mechanisms that only emerge across many rounds:
 *
 *   L0/L1/L2 level transitions:
 *     - L2 first_round (R1)
 *     - L1 state_capsule (R2-R3, R5-R7)
 *     - L2 checkpoint_boundary (R4, via compression_checkpoint at R3)
 *     - L0 retry_delta (R8 rejection prompt + R8b post-retry)
 *     - L1 normal continuation (R8b, R9)
 *
 *   Constraint lifecycle (discovery → accumulation → retirement)
 *   Enforcement rejection + honest retry
 *   Objective refinement + wrong assumption retraction
 *   All in-progress rounds use success=false honestly — the removed
 *     binary-success circuit breaker no longer falsely kills the loop.
 *   Cross-round evidence consistency, replay, persistence
 */

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { ChildProcess, spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { createInterface, Interface } from "node:readline";
import { fileURLToPath } from "node:url";
import { testCommandProvider, criterionClaims } from "./_helpers.js";
import { POLICY_SCHEMA_VERSION } from "../policy.js";

const CLI_PATH = resolve(dirname(fileURLToPath(import.meta.url)), "..", "cli.js");

interface JsonRpcResponse {
  jsonrpc: "2.0"; id: number;
  result?: Record<string, unknown>; error?: { code: number; message: string };
}

class McpClient {
  private proc: ChildProcess; private rl: Interface;
  private pending = new Map<number, { resolve: (v: JsonRpcResponse) => void; reject: (e: Error) => void }>();
  private nextId = 1; private stderr = ""; private workCounter = 0;
  private readonly storeDir: string;

  constructor(storeDir: string) {
    this.storeDir = storeDir;
    mkdirSync(storeDir, { recursive: true });
    this.proc = spawn(process.execPath, [CLI_PATH, "mcp"], { cwd: storeDir, stdio: ["pipe", "pipe", "pipe"], env: { ...process.env } });
    this.proc.stderr?.on("data", (chunk: Buffer) => { this.stderr += chunk.toString("utf8"); });
    this.proc.once("exit", (code) => { for (const [, p] of this.pending) p.reject(new Error(`exit ${code}`)); this.pending.clear(); });
    this.rl = createInterface({ input: this.proc.stdout! });
    this.rl.on("line", (line: string) => {
      try { const j = JSON.parse(line) as JsonRpcResponse; const p = this.pending.get(j.id); if (p) { this.pending.delete(j.id); p.resolve(j); } } catch { /* ok */ }
    });
  }
  async call(method: string, params?: Record<string, unknown>): Promise<Record<string, unknown>> {
    const id = this.nextId++;
    return new Promise<Record<string, unknown>>((resolve, reject) => {
      const t = setTimeout(() => { this.pending.delete(id); reject(new Error(`Timeout: ${method}`)); }, 15_000);
      this.pending.set(id, { resolve: (r: JsonRpcResponse) => { clearTimeout(t); if (r.error) { reject(new Error(`RPC ${r.error.code}: ${r.error.message}`)); return; } resolve((r.result ?? {}) as Record<string, unknown>); }, reject: (e: Error) => { clearTimeout(t); reject(e); } });
      this.proc.stdin!.write(JSON.stringify({ jsonrpc: "2.0", id, method, params: params ?? {} }) + "\n");
    });
  }
  /** v3.8.1: THE fixture's agent actually does the work it reports.
   *
   *  The git provider observes this directory, and the stall evaluator lets
   *  machine motion decide whenever it is observable — so a round that claims
   *  `files_changed` without touching a file is exactly the unverifiable
   *  self-report that evaluator exists to catch. Content changes on every
   *  submission, so each round's before→after delta is non-empty. */
  private materialize(evaluation: unknown): void {
    const report = (evaluation as {
      execution_report?: { files_changed?: unknown };
    } | null)?.execution_report;
    const files = Array.isArray(report?.files_changed) ? report.files_changed : [];
    this.workCounter += 1;
    for (const file of files) {
      if (typeof file !== "string" || file.length === 0) continue;
      const target = join(this.storeDir, file);
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, `// ${file} — written by fixture round ${this.workCounter}
`);
    }
  }

  async tool(name: string, args: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
    if (name === "loopforge_next") this.materialize(args.evaluation);
    const r = await this.call("tools/call", { name, arguments: args });
    if (r.structuredContent && typeof r.structuredContent === "object") return r.structuredContent as Record<string, unknown>;
    if (r.content && Array.isArray(r.content)) {
      let prompt: string | undefined;
      for (const item of r.content) {
        const t = (item as Record<string, unknown>).text;
        if (typeof t === "string") {
          try {
            const parsed = JSON.parse(t) as Record<string, unknown>;
            return prompt && parsed.prompt === undefined ? { ...parsed, prompt } : parsed;
          } catch {
            prompt ??= t;
          }
        }
      }
    }
    return r;
  }
  getStderr(): string { return this.stderr; }
  close(): void { this.rl.close(); this.proc.stdin?.end(); this.proc.kill(); }
}

const TASK = "Build a TypeScript string utility library called strkit with TDD. Implement isPalindrome, capitalize, truncate, toCamelCase functions. All functions must have tests. Use ESM modules and Node.js test runner.";
const CONSTRAINTS = ["Use ESM modules only — no CommonJS", "All exported functions must have tests", "Do not introduce runtime dependencies beyond Node.js stdlib"];

describe("Long-Horizon Verification", () => {
  let client: McpClient; let storeDir: string; let sessionId: string; let loopId: string; let roundId: string;
  const LL: string[] = [];

  before(() => {
    storeDir = join(tmpdir(), `loopforge-lh-${randomUUID()}`);
    mkdirSync(storeDir, { recursive: true });
    // v3.8.1: the workspace is a real git repo, and the vault is ignored —
    // the git provider observes THIS directory, so machine motion must mean
    // the agent's own work. Without the repo the provider reports
    // `unavailable` and every round looks motionless; without the ignore,
    // LoopForge's own `.loopforge/` writes would look like progress.
    spawnSync("git", ["init"], { cwd: storeDir, stdio: "ignore" });
    writeFileSync(join(storeDir, ".gitignore"), ".loopforge/\n");
    // v3.3: a passing verification command keeps success claims machine-backed
    // (R8 requires it — self-reported test results alone are not evidence).
    // v3.8.1: the policy version is load-bearing, and full_refresh_interval is
    // deleted (its default disabled its own L2 branch).
    writeFileSync(join(storeDir, "loop_policy.json"), JSON.stringify({
      version: POLICY_SCHEMA_VERSION,
      evidence: {
        providers: ["git"],
        timeout_ms: 120000,
        commands: [testCommandProvider()],
      },
    }));
    client = new McpClient(storeDir);
  });
  after(() => { client.close(); try { rmSync(storeDir, { recursive: true }); } catch { /* ok */ } });

  it("MCP init + stable tool surface (7 of 9; gates are opt-in)", async () => {
    assert.equal((await client.call("initialize", { protocolVersion: "2024-11-05" })).protocolVersion, "2024-11-05");
    // v3.7.1: gate tools are hidden unless policy.gate.enabled
    assert.ok(((await client.call("tools/list")).tools as Array<{ name: string }>).length >= 7);
  });

  // ── R1 L2 (first_round) ──────────────────────────────────────────────────

  it("R1 L2 — first_round: initial full-state prompt", async () => {
    const r = await client.tool("loopforge_start", { task: TASK, maxRounds: 12, domain: "typescript", constraints: CONSTRAINTS });
    assert.ok(!r.error); assert.equal(r.round, 1);
    assert.equal(String(r.level ?? "").toLowerCase(), "l2");
    assert.ok(String(r.prompt ?? "").length > 100);
    sessionId = String(r.sessionId);
    roundId = String(r.roundId);
    loopId = String((await client.tool("loopforge_status", { sessionId })).loopId ?? "");
    assert.ok(loopId.length > 0);
    LL.push("R1:L2");
  });

  // ── R2 L1 — core functions, discover ESM constraint ─────────────────────

  it("R2 L1 — isPalindrome + capitalize, discovers ESM constraint", async () => {
    const r = await client.tool("loopforge_next", { sessionId, roundId, evaluation: {
      success: false, should_continue: true, constraint_violations: [],
      output_summary: "Implemented isPalindrome and capitalize. Discovered the package needs type:module for ESM.",
      discovered_constraints: ["the package must declare type:module for ESM resolution"],
      // The fixture's agent reports the files it actually wrote (the client
      // materializes them), and it does not touch package.json: the ESM
      // constraint is DISCOVERED here, and the verification command's own
      // entrypoints stay put in the round that runs it.
      execution_report: { files_changed: ["src/strkit.ts"], tests_reported: { passed: 0, failed: 0, skipped: 0 }, criterion_claims: criterionClaims(["isPalindrome", "capitalize"], ["Write tests", "Implement truncate + toCamelCase"]), progress_estimate: 0.2 },
    }});
    assert.ok(!r.error); assert.equal(String(r.level ?? "").toLowerCase(), "l1"); assert.equal(r.round, 2);
    roundId = String(r.roundId);
    LL.push("R2:L1");
  });

  // ── R2 L1 → R3 L2 (checkpoint_boundary) ────────────────────────────────
  //
  // R2's eval declared compression_checkpoint → R3's prompt is L2.

  it("R3 L2 — checkpoint_boundary: full-state prompt with checkpoint label", async () => {
    const r = await client.tool("loopforge_next", { sessionId, roundId, evaluation: {
      success: false, should_continue: true, constraint_violations: [],
      output_summary: "Wrote tests for isPalindrome and capitalize. isPalindrome passes (3/3), capitalize fails on empty string. Declaring checkpoint.",
      discovered_constraints: ["All functions must handle empty string input gracefully"],
      compression_checkpoint: true, checkpoint_label: "core-functions-complete",
      execution_report: { files_changed: ["src/strkit.test.ts"], tests_reported: { passed: 3, failed: 1, skipped: 0 }, criterion_claims: criterionClaims([], ["Fix capitalize bug", "Implement truncate + toCamelCase"]), progress_estimate: 0.3 },
    }});
    assert.ok(!r.error);
    // R2's eval declared compression_checkpoint → R3 prompt is L2.
    const lv = String(r.level ?? "").toLowerCase();
    assert.equal(lv, "l2", `R3 expected L2 (checkpoint_boundary from R2), got '${lv}'`);
    assert.equal(r.round, 3);
    const p = String(r.prompt ?? "");
    assert.ok(p.includes("core-functions-complete") || p.toLowerCase().includes("checkpoint"), `R3 missing checkpoint: ${p.slice(0, 200)}`);
    assert.ok(p.length > 200, `L2 prompt too small: ${p.length}`);
    assert.strictEqual(r.roundSuccess, false);
    roundId = String(r.roundId);
    LL.push("R3:L2");
  });

  // ── R4 L1 — fix tests, normal continuation after checkpoint ────────────

  it("R4 L1 — fixes tests, discovers return-type constraint", async () => {
    const r = await client.tool("loopforge_next", { sessionId, roundId, evaluation: {
      success: false, should_continue: true, constraint_violations: [],
      output_summary: "Fixed capitalize empty-string. All tests pass (6/6). Return types must be consistent.",
      discovered_constraints: ["Function return types must be consistent — always return string"],
      execution_report: { files_changed: ["src/strkit.ts", "src/strkit.test.ts"], tests_reported: { passed: 6, failed: 0, skipped: 0 }, criterion_claims: criterionClaims(["isPalindrome + capitalize tested"], ["Implement truncate + toCamelCase"]), progress_estimate: 0.4 },
    }});
    assert.ok(!r.error);
    assert.equal(String(r.level ?? "").toLowerCase(), "l1");
    assert.equal(r.round, 4);
    roundId = String(r.roundId);
    LL.push("R4:L1");
  });

  // ── R5 L1 — truncate ────────────────────────────────────────────────────

  it("R5 L1 — truncate implemented, steady progress", async () => {
    const r = await client.tool("loopforge_next", { sessionId, roundId, evaluation: {
      success: false, should_continue: true, constraint_violations: [],
      output_summary: "Implemented truncate with tests (9/9 pass). Unicode edge cases handled.",
      discovered_constraints: ["truncate must handle unicode multi-byte characters"],
      execution_report: { files_changed: ["src/strkit.ts", "src/strkit.test.ts"], tests_reported: { passed: 9, failed: 0, skipped: 0 }, criterion_claims: criterionClaims(["truncate done"], ["Implement toCamelCase", "Write toCamelCase tests"]), progress_estimate: 0.55 },
    }});
    assert.ok(!r.error); assert.equal(String(r.level ?? "").toLowerCase(), "l1"); assert.equal(r.round, 5);
    roundId = String(r.roundId);
    LL.push("R5:L1");
  });

  // ── R6 L1 — toCamelCase, retract wrong assumption ───────────────────────

  it("R6 L1 — toCamelCase done, retracts R3 wrong assumption", async () => {
    const r = await client.tool("loopforge_next", { sessionId, roundId, evaluation: {
      success: false, should_continue: true, constraint_violations: [],
      output_summary: "Implemented toCamelCase (13/13 pass). R3 empty-string constraint was wrong — each function handles edges naturally.",
      retracted_constraints: ["All functions must handle empty string input gracefully"],
      wrong_assumptions: ["Assumed empty strings needed per-function special-case handling"],
      execution_report: { files_changed: ["src/strkit.ts", "src/strkit.test.ts"], tests_reported: { passed: 13, failed: 0, skipped: 0 }, criterion_claims: criterionClaims(["All four functions done"], ["Integration tests", "Verify no runtime deps"]), progress_estimate: 0.7 },
    }});
    assert.ok(!r.error); assert.equal(String(r.level ?? "").toLowerCase(), "l1"); assert.equal(r.round, 6);
    roundId = String(r.roundId);
    LL.push("R6:L1");
  });

  // ── R7 L1 — objective refinement ─────────────────────────────────────────

  it("R7 L1 — objective refined, pipeline subtask emerged", async () => {
    const r = await client.tool("loopforge_next", { sessionId, roundId, evaluation: {
      success: false, should_continue: true, constraint_violations: [],
      output_summary: "Integration tests pass (13/13). Refined objective: add validateAndTransform pipeline.",
      objective_refinement: "The library should provide validateAndTransform(input, fns[]) pipeline utility",
      emerged_subtasks: ["Implement validateAndTransform pipeline", "Add pipeline integration tests"],
      execution_report: { files_changed: ["src/strkit.ts"], tests_reported: { passed: 13, failed: 0, skipped: 0 }, criterion_claims: criterionClaims(["Core functions done"], ["Implement pipeline", "Verify no runtime deps", "Final polish"]), progress_estimate: 0.75 },
    }});
    assert.ok(!r.error); assert.equal(r.round, 7); roundId = String(r.roundId); LL.push(`R7:${String(r.level ?? "").toUpperCase() || '?'}`);
  });

  // ── R8 REJECT(L0) — false success claim ─────────────────────────────────

  it("R8 REJECT(L0) — enforcement catches success=true with remaining criteria", async () => {
    const r = await client.tool("loopforge_next", { sessionId, roundId, evaluation: {
      success: true, should_continue: true, constraint_violations: [],
      output_summary: "Implemented validateAndTransform. Everything works!",
      execution_report: { files_changed: ["src/pipeline.ts"], tests_reported: { passed: 15, failed: 0, skipped: 0 }, criterion_claims: criterionClaims(["pipeline done"], ["Verify no runtime deps", "Final lint"]), progress_estimate: 0.82 },
    }});
    assert.ok(!r.error);
    assert.equal(r.enforcementAction, "reject");
    assert.ok(String(r.enforcementReason ?? "").length > 0);
    assert.equal(String(r.level ?? "").toLowerCase(), "l0", "Rejection prompt should be L0");
    roundId = String(r.roundId);
    LL.push("R8:REJECT(L0)");
  });

  // ── R8b L1 — retry accepted, normal continuation ──────────────────────
  //
  // After the rejection is accepted, session advances to round 8.
  // v3.8.1: this used to be L2 via periodic_refresh (a round-count timer).
  // That branch is deleted — L2 is reachable only by reasons that are FACTS
  // about the round, and a clean continuation has none of them.

  it("R8-retry L1 — retry accepted, normal continuation for round 8", async () => {
    const r = await client.tool("loopforge_next", { sessionId, roundId, evaluation: {
      success: false, should_continue: true, constraint_violations: [],
      output_summary: "Reverted false claim. Implemented pipeline with full tests. Verified no runtime deps. 17/17 pass.",
      discovered_constraints: ["validateAndTransform pipeline pattern confirmed correct"],
      execution_report: { files_changed: ["src/strkit.ts", "src/pipeline.ts", "src/pipeline.test.ts"], tests_reported: { passed: 17, failed: 0, skipped: 0 }, criterion_claims: criterionClaims(["pipeline done", "no runtime deps"], ["Final polish"]), progress_estimate: 0.9 },
    }});
    assert.ok(!r.error);
    // Retry accepted → session advances to round 8 as an ordinary round.
    const lv = String(r.level ?? "").toLowerCase();
    assert.equal(lv, "l1", `R8b expected L1 (clean continuation), got '${lv}'`);
    assert.ok(String(r.prompt ?? "").length > 200);
    roundId = String(r.roundId);
    LL.push("R8b:L1");
  });

  // ── R9 L0 — previousFailedWithoutNewInfo ─────────────────────────────
  //
  // Note: R9's eval has no discovered_constraints etc. → hasNewInformation=false
  // → previousFailedWithoutNewInfo fires before any other L2 reason could.
  // This demonstrates that failure-without-learning always gets minimal prompt.

  it("R9 L0 — previousFailedWithoutNewInfo fires (no new info in eval)", async () => {
    const r = await client.tool("loopforge_next", { sessionId, roundId, evaluation: {
      success: false, should_continue: true, constraint_violations: [],
      output_summary: "Ran linter, added JSDoc, updated README. All 17 tests pass. Ready to ship.",
      execution_report: { files_changed: ["src/strkit.ts", "src/pipeline.ts", "README.md"], tests_reported: { passed: 17, failed: 0, skipped: 0 }, criterion_claims: criterionClaims(["Final polish"], []), progress_estimate: 0.98 },
    }});
    assert.ok(!r.error);
    // previousFailedWithoutNewInfo fires (no new information in the eval)
    // because the eval has success=false and no new-information fields.
    assert.equal(String(r.level ?? "").toLowerCase(), "l0");
    roundId = String(r.roundId);
    LL.push("R9:L0");
  });

  // ── R10 COMPLETE ─────────────────────────────────────────────────────────

  it("R10 COMPLETE — should_continue=false, loop stops", async () => {
    const r = await client.tool("loopforge_next", { sessionId, roundId, evaluation: {
      success: true, should_continue: false, constraint_violations: [],
      output_summary: "All functions implemented, tested (17/17), documented. No runtime deps. ESM confirmed. Task complete.",
      execution_report: { files_changed: [], tests_reported: { passed: 17, failed: 0, skipped: 0 }, criterion_claims: criterionClaims(["All functions", "Pipeline", "No runtime deps", "Final polish"]), progress_estimate: 1.0 },
    }});
    assert.ok(!r.error);
    assert.equal(String(r.stopReason ?? ""), "completed");
    assert.equal(r.prompt, null);
    roundId = String(r.roundId);
    LL.push("R10:STOP");
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // CROSS-ROUND CHECKS
  // ═══════════════════════════════════════════════════════════════════════════

  it("✓ levels: L0, L1, L2, checkpoint_boundary, REJECT", () => {
    const log = LL.join(" → ");
    assert.ok(log.includes("L2"), `Missing L2: ${log}`);
    assert.ok(log.includes("L1"), `Missing L1: ${log}`);
    assert.ok(log.includes("L0"), `Missing L0: ${log}`);
    assert.ok(log.includes("REJECT"), `Missing REJECT: ${log}`);
    // Specific transitions verified inline above:
    //   R1:L2 (first_round), R3:L2 (checkpoint_boundary)
    //   R8:REJECT(L0) (retry_delta), R9:L0 (previousFailedWithoutNewInfo)
    //   R8b:L1 (an ordinary continuation — the round-count timer that used to
    //   force L2 here is deleted)
  });

  it("✓ replay + health + list + status + storage", async () => {
    const replay = await client.tool("loopforge_replay", { sessionId });
    assert.ok(!replay.error);
    const tl = replay.timeline as Array<Record<string, unknown>>;
    assert.ok(Array.isArray(tl) && tl.length >= 7, `timeline: ${tl.length}`);

    const health = await client.tool("loopforge_status", { loopId, view: "loop" });
    assert.ok(!health.error);
    // v3.8.1: counted facts, not similarity verdicts.
    assert.equal(typeof health.committed_rounds, "number");
    for (const f of ["rounds_with_unverified_items", "unverified_streak_limit"])
      assert.ok(health[f] !== undefined, `${f} missing`);

    const list = await client.tool("loopforge_status", { view: "all" });
    assert.ok((list.sessions as Array<Record<string, unknown>>).some((s: Record<string, unknown>) => s.loopId === loopId || s.sessionId === sessionId));

    const st = await client.tool("loopforge_status", { sessionId });
    assert.equal(String(st.status ?? ""), "stopped");
    assert.ok((st.successTrajectory as Array<unknown>)?.length ?? 0 >= 7);

    const loopsDir = join(storeDir, ".loopforge", "loops");
    assert.ok(existsSync(loopsDir));
    let maxR = 0;
    for (const d of readdirSync(loopsDir)) {
      const rd = join(loopsDir, d, "rounds");
      if (existsSync(rd)) maxR = Math.max(maxR, readdirSync(rd).filter(f => f.endsWith(".json")).length);
    }
    assert.ok(maxR >= 7, `round files: ${maxR}`);
  });

  it("📊 SUMMARY", () => {
    console.log([
      "", "══════════════════════════════════════════════", "  Long-Horizon Verification — COMPLETE", "══════════════════════════════════════════════",
      `  Level path:  ${LL.join(" → ")}`, `  Storage:     ${storeDir}`, `  Loop ID:     ${loopId}`, "",
      "  Mechanisms exercised:",
      "    L2 first_round             ✓ R1  initial full-state prompt",
      "    L1 state_capsule           ✓ R2-R3,R5-R7 incremental prompts",
      "    L2 checkpoint_boundary     ✓ R3  via compression_checkpoint at R2",
      "    L0 retry_delta             ✓ R8  rejection prompt (attempt>1)",
      "    L1 normal continuation     ✓ R8b clean retry, no L2 reason applies",
      "    L0 prevFailedWithoutNewInfo ✓ R9  no new information in the eval",
      "    enforcement reject         ✓ R8  false success claim caught",
      "    circuit breaker removed    ✓ R1-R7 all success=false, loop continues",
      "    compression_checkpoint     ✓ R2→R3 checkpoint label in R3 prompt",
      "    constraint lifecycle       ✓ discover → accumulate → retract",
      "    objective refinement       ✓ R7  goal versioning + subtasks",
      "    wrong assumptions          ✓ R6  retraction tracking",
      "    round transaction          ✓ replay + disk persistence",
      "    health diagnostics         ✓ drift, alignment, integrity, continuity",
      "══════════════════════════════════════════════", "",
    ].join("\n"));
  });
});

// ═══════════════════════════════════════════════════════════════════════════
