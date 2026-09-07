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
 *     - L2 periodic_refresh (R9, interval=5 since last L2 at R4)
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
import { ChildProcess, spawn } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { createInterface, Interface } from "node:readline";
import { fileURLToPath } from "node:url";
import { testCommandProvider } from "./_helpers.js";

const CLI_PATH = resolve(dirname(fileURLToPath(import.meta.url)), "..", "cli.js");

interface JsonRpcResponse {
  jsonrpc: "2.0"; id: number;
  result?: Record<string, unknown>; error?: { code: number; message: string };
}

class McpClient {
  private proc: ChildProcess; private rl: Interface;
  private pending = new Map<number, { resolve: (v: JsonRpcResponse) => void; reject: (e: Error) => void }>();
  private nextId = 1; private stderr = "";

  constructor(storeDir: string) {
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
  async tool(name: string, args: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
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
    // Write a policy with periodic_refresh enabled so the test exercises all L2 triggers.
    // v3.3: a passing verification command keeps success claims machine-backed
    // (R8 requires it — self-reported test results alone are not evidence).
    writeFileSync(join(storeDir, "loop_policy.json"), JSON.stringify({
      prompt: { full_refresh_interval: 5 },
      evidence: {
        providers: ["git"],
        timeout_ms: 120000,
        commands: [testCommandProvider()],
        machine_backed_success: "required",
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
      output_summary: "Implemented isPalindrome and capitalize. Discovered package.json needs type:module for ESM.",
      discovered_constraints: ["package.json must include type:module for ESM resolution"],
      execution_evidence: { files_changed: ["src/strkit.ts", "package.json"], test_results: { passed: 0, failed: 0, skipped: 0 }, success_criteria_met: ["isPalindrome", "capitalize"], success_criteria_remaining: ["Write tests", "Implement truncate + toCamelCase"], progress_estimate: 0.2 },
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
      execution_evidence: { files_changed: ["src/strkit.test.ts"], test_results: { passed: 3, failed: 1, skipped: 0 }, success_criteria_met: [], success_criteria_remaining: ["Fix capitalize bug", "Implement truncate + toCamelCase"], progress_estimate: 0.3 },
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
      execution_evidence: { files_changed: ["src/strkit.ts", "src/strkit.test.ts"], test_results: { passed: 6, failed: 0, skipped: 0 }, success_criteria_met: ["isPalindrome + capitalize tested"], success_criteria_remaining: ["Implement truncate + toCamelCase"], progress_estimate: 0.4 },
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
      execution_evidence: { files_changed: ["src/strkit.ts", "src/strkit.test.ts"], test_results: { passed: 9, failed: 0, skipped: 0 }, success_criteria_met: ["truncate done"], success_criteria_remaining: ["Implement toCamelCase", "Write toCamelCase tests"], progress_estimate: 0.55 },
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
      execution_evidence: { files_changed: ["src/strkit.ts", "src/strkit.test.ts"], test_results: { passed: 13, failed: 0, skipped: 0 }, success_criteria_met: ["All four functions done"], success_criteria_remaining: ["Integration tests", "Verify no runtime deps"], progress_estimate: 0.7 },
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
      execution_evidence: { files_changed: ["src/strkit.ts"], test_results: { passed: 13, failed: 0, skipped: 0 }, success_criteria_met: ["Core functions done"], success_criteria_remaining: ["Implement pipeline", "Verify no runtime deps", "Final polish"], progress_estimate: 0.75 },
    }});
    assert.ok(!r.error); assert.equal(r.round, 7); roundId = String(r.roundId); LL.push(`R7:${String(r.level ?? "").toUpperCase() || '?'}`);
  });

  // ── R8 REJECT(L0) — false success claim ─────────────────────────────────

  it("R8 REJECT(L0) — enforcement catches success=true with remaining criteria", async () => {
    const r = await client.tool("loopforge_next", { sessionId, roundId, evaluation: {
      success: true, should_continue: true, constraint_violations: [],
      output_summary: "Implemented validateAndTransform. Everything works!",
      execution_evidence: { files_changed: ["src/pipeline.ts"], test_results: { passed: 15, failed: 0, skipped: 0 }, success_criteria_met: ["pipeline done"], success_criteria_remaining: ["Verify no runtime deps", "Final lint"], progress_estimate: 0.82 },
    }});
    assert.ok(!r.error);
    assert.equal(r.enforcementAction, "reject");
    assert.ok(String(r.enforcementReason ?? "").length > 0);
    assert.equal(String(r.level ?? "").toLowerCase(), "l0", "Rejection prompt should be L0");
    roundId = String(r.roundId);
    LL.push("R8:REJECT(L0)");
  });

  // ── R8b L2 — retry accepted, periodic_refresh fires ───────────────────
  //
  // After the rejection is accepted, session advances to round 8.
  // R8 - lastL2(R3) = 5 >= full_refresh_interval(5) → L2 periodic_refresh.

  it("R8-retry L2 — retry accepted, L2 periodic_refresh for round 8", async () => {
    const r = await client.tool("loopforge_next", { sessionId, roundId, evaluation: {
      success: false, should_continue: true, constraint_violations: [],
      output_summary: "Reverted false claim. Implemented pipeline with full tests. Verified no runtime deps. 17/17 pass.",
      discovered_constraints: ["validateAndTransform pipeline pattern confirmed correct"],
      execution_evidence: { files_changed: ["src/strkit.ts", "src/pipeline.ts", "src/pipeline.test.ts"], test_results: { passed: 17, failed: 0, skipped: 0 }, success_criteria_met: ["pipeline done", "no runtime deps"], success_criteria_remaining: ["Final polish"], progress_estimate: 0.9 },
    }});
    assert.ok(!r.error);
    // Retry accepted → session advances to round 8.
    // R8 - lastL2(R3) = 5 >= interval(5) → L2 periodic_refresh.
    const lv = String(r.level ?? "").toLowerCase();
    assert.equal(lv, "l2", `R8b expected L2 (periodic_refresh: 8-3=5>=5), got '${lv}'`);
    assert.ok(String(r.prompt ?? "").length > 200);
    roundId = String(r.roundId);
    LL.push("R8b:L2");
  });

  // ── R9 L0 — previousFailedWithoutNewInfo preempts periodic_refresh ─────
  //
  // Note: R9's eval has no discovered_constraints etc. → hasNewInformation=false
  // → previousFailedWithoutNewInfo fires BEFORE periodic_refresh.
  // This demonstrates that failure-without-learning always gets minimal prompt.

  it("R9 L0 — previousFailedWithoutNewInfo fires (no new info in eval)", async () => {
    const r = await client.tool("loopforge_next", { sessionId, roundId, evaluation: {
      success: false, should_continue: true, constraint_violations: [],
      output_summary: "Ran linter, added JSDoc, updated README. All 17 tests pass. Ready to ship.",
      execution_evidence: { files_changed: ["src/strkit.ts", "src/pipeline.ts", "README.md"], test_results: { passed: 17, failed: 0, skipped: 0 }, success_criteria_met: ["Final polish"], success_criteria_remaining: [], progress_estimate: 0.98 },
    }});
    assert.ok(!r.error);
    // previousFailedWithoutNewInfo fires (priority before periodic_refresh)
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
      execution_evidence: { files_changed: [], test_results: { passed: 17, failed: 0, skipped: 0 }, success_criteria_met: ["All functions", "Pipeline", "No runtime deps", "Final polish"], success_criteria_remaining: [], progress_estimate: 1.0 },
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

  it("✓ levels: L0, L1, L2, checkpoint_boundary, periodic_refresh, REJECT", () => {
    const log = LL.join(" → ");
    assert.ok(log.includes("L2"), `Missing L2: ${log}`);
    assert.ok(log.includes("L1"), `Missing L1: ${log}`);
    assert.ok(log.includes("L0"), `Missing L0: ${log}`);
    assert.ok(log.includes("REJECT"), `Missing REJECT: ${log}`);
    // Specific transitions verified inline above:
    //   R1:L2 (first_round), R4:L2 (checkpoint_boundary), R9:L2 (periodic_refresh)
    //   R8:REJECT(L0) (retry_delta), R8b:L0 (previousFailedWithoutNewInfo)
  });

  it("✓ replay + health + list + status + storage", async () => {
    const replay = await client.tool("loopforge_replay", { sessionId });
    assert.ok(!replay.error);
    const tl = replay.timeline as Array<Record<string, unknown>>;
    assert.ok(Array.isArray(tl) && tl.length >= 7, `timeline: ${tl.length}`);

    const health = await client.tool("loopforge_status", { loopId, view: "loop" });
    assert.ok(!health.error);
    assert.equal(typeof health.drift_detected, "boolean");
    for (const f of ["goal_alignment", "constraint_integrity", "strategy_stability", "task_continuity"])
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
      "    L2 periodic_refresh        ✓ R8b interval=5 since last L2 at R3",
      "    L0 prevFailedWithoutNewInfo ✓ R9  fires before periodic_refresh",
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
// v3.5 — Round Contract arc through the real CLI (own loop, own store)
//
// declare → active → machine-backed completion → proposal transition →
// premature success rejected (retry keeps the ACTIVE contract) → terminal
// completion. machine_backed_success "required" + the passing "verify"
// command make completion claims machine-backed on every round.
// ═══════════════════════════════════════════════════════════════════════════

describe("Long-Horizon — Round Contract arc (v3.5)", () => {
  let client: McpClient;
  let storeDir: string;
  let sessionId: string;
  let roundId: string;

  const CONTRACT = (workItem: string, doneWhen: string): Record<string, unknown> => ({
    work_item: workItem,
    done_when: [doneWhen],
    verification_plan: ["verify"],
    scope: ["src"],
  });
  const A = CONTRACT("Implement arg parsing", "cr-parse-args");
  const B = CONTRACT("Implement output formatting", "cr-format-out");

  before(() => {
    storeDir = join(tmpdir(), `loopforge-contract-${randomUUID()}`);
    mkdirSync(storeDir, { recursive: true });
    writeFileSync(join(storeDir, "loop_policy.json"), JSON.stringify({
      evidence: {
        providers: ["git"],
        timeout_ms: 120000,
        commands: [testCommandProvider()],
        machine_backed_success: "required",
      },
    }));
    client = new McpClient(storeDir);
  });
  after(() => { client.close(); try { rmSync(storeDir, { recursive: true }); } catch { /* ok */ } });

  const evalRound = (overrides: Record<string, unknown>): Record<string, unknown> => ({
    success: false,
    should_continue: true,
    constraint_violations: [],
    output_summary: "Worked the round.",
    execution_evidence: {
      files_changed: ["src/cli.ts"],
      test_results: { passed: 1, failed: 0, skipped: 0 },
      success_criteria_met: [],
      success_criteria_remaining: ["cr-parse-args"],
      progress_estimate: 0.3,
    },
    ...overrides,
  });

  it("drives the full contract arc end-to-end", async () => {
    // R1 — declare A.
    const r1 = await client.tool("loopforge_start", {
      task: "Build the strkit CLI module",
      maxRounds: 8,
      domain: "typescript",
    });
    assert.ok(!r1.error);
    sessionId = String(r1.sessionId);
    roundId = String(r1.roundId);
    const r2p = await client.tool("loopforge_next", { sessionId, roundId, evaluation: evalRound({
      output_summary: "Scaffolded; declared the parsing contract.",
      round_contract: A,
    }) });
    assert.ok(!r2p.error);
    assert.equal(String(r2p.round), "2");
    assert.ok(String(r2p.prompt ?? "").includes("**Implement arg parsing**"),
      "round 2 must execute under the ACTIVE contract A");
    roundId = String(r2p.roundId);

    // R2 — partial restate under A.
    const r3p = await client.tool("loopforge_next", { sessionId, roundId, evaluation: evalRound({
      round_contract: A,
      execution_evidence: {
        files_changed: ["src/cli.ts"],
        test_results: { passed: 1, failed: 0, skipped: 0 },
        success_criteria_met: [],
        success_criteria_remaining: ["cr-parse-args"],
        progress_estimate: 0.4,
      },
    }) });
    assert.ok(!r3p.error);
    roundId = String(r3p.roundId);

    // R3 — complete A (machine-backed by the auto-run verify command) and
    // propose B.
    const r4p = await client.tool("loopforge_next", { sessionId, roundId, evaluation: evalRound({
      round_contract: B,
      execution_evidence: {
        files_changed: ["src/cli.ts"],
        test_results: { passed: 1, failed: 0, skipped: 0 },
        success_criteria_met: ["cr-parse-args"],
        success_criteria_remaining: [],
        progress_estimate: 0.6,
      },
    }) });
    assert.ok(!r4p.error);
    assert.ok(!String(r4p.prompt ?? "").includes("contract_completion_unverified"),
      "machine-backed completion must not be flagged");
    assert.ok(String(r4p.prompt ?? "").includes("**Implement output formatting**"),
      "B must become the ACTIVE contract");
    assert.ok(!String(r4p.prompt ?? "").includes("**Implement arg parsing**"),
      "A must be closed, not re-rendered");
    roundId = String(r4p.roundId);

    // R4 — premature success under B → rejected; the L0 retry keeps B.
    const rejected = await client.tool("loopforge_next", { sessionId, roundId, evaluation: evalRound({
      success: true,
      should_continue: true,
      execution_evidence: {
        files_changed: ["src/cli.ts"],
        test_results: { passed: 1, failed: 0, skipped: 0 },
        success_criteria_met: [],
        success_criteria_remaining: ["cr-format-out"],
        progress_estimate: 0.7,
      },
    }) });
    assert.ok(!rejected.error);
    assert.equal(String(rejected.enforcementAction ?? ""), "reject");
    assert.equal(String(rejected.level ?? "").toLowerCase(), "l0");
    assert.ok(String(rejected.prompt ?? "").includes("**Implement output formatting**"),
      "the retry must keep the ACTIVE contract as Current Task");
    assert.ok(!String(rejected.prompt ?? "").includes("round_contract"),
      "L0 retry stays template-lean");
    roundId = String(rejected.roundId);

    // R5 — complete B and end the loop.
    const done = await client.tool("loopforge_next", { sessionId, roundId, evaluation: evalRound({
      success: true,
      should_continue: false,
      execution_evidence: {
        files_changed: ["src/cli.ts"],
        test_results: { passed: 1, failed: 0, skipped: 0 },
        success_criteria_met: ["cr-format-out"],
        success_criteria_remaining: [],
        progress_estimate: 1.0,
      },
    }) });
    assert.ok(!done.error);
    assert.equal(String(done.stopReason ?? ""), "completed");
  });
});
