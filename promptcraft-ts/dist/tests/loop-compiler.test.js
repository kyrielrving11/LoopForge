/** Tests for loop compiler core: gates, advisories, L0/L1/L2 compilation. */
import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { decideLevel, compileLoop, computeGoalTextHash, deriveGoalId, alignTask, compileL2, } from "../loop-compiler.js";
import { makeLoopCompileRequest, makeLoopRoundResult, makeLoopObjective, } from "../protocol.js";
import { resetPolicy } from "../policy.js";
describe("Loop Compiler — Goal Identity", () => {
    it("computeGoalTextHash produces a 12-char hex string", () => {
        const hash = computeGoalTextHash("Audit ERC20 token");
        assert.equal(hash.length, 12);
        assert.ok(/^[a-f0-9]{12}$/.test(hash));
    });
    it("computeGoalTextHash is deterministic", () => {
        assert.equal(computeGoalTextHash("Audit ERC20 token"), computeGoalTextHash("Audit ERC20 token"));
    });
    it("computeGoalTextHash normalises whitespace", () => {
        const h1 = computeGoalTextHash("Audit  ERC20   token");
        const h2 = computeGoalTextHash("Audit ERC20 token");
        assert.equal(h1, h2);
    });
    it("deriveGoalId uses explicit goal_id when provided", () => {
        assert.equal(deriveGoalId("loop-1", "Audit ERC20", "audit-erc20"), "audit-erc20");
    });
    it("deriveGoalId falls back to derived id", () => {
        const id = deriveGoalId("loop-1", "Audit ERC20 token");
        assert.ok(id.startsWith("loop-1:"));
    });
});
describe("Loop Compiler — Decide Level (4-gate router)", () => {
    beforeEach(() => resetPolicy());
    it("returns l2 for round 1 (Gate 2: first call)", () => {
        const req = makeLoopCompileRequest({ round: 1, task: "Audit ERC20" });
        assert.equal(decideLevel(req, null), "l2");
    });
    it("returns l2 when plan_source is provided (Gate 2)", () => {
        const req = makeLoopCompileRequest({
            round: 5,
            task: "Audit ERC20",
            plan_source: "spec.md",
        });
        assert.equal(decideLevel(req, null), "l2");
    });
    it("returns l2 when no previous round found", () => {
        const req = makeLoopCompileRequest({ round: 3, task: "Audit ERC20" });
        assert.equal(decideLevel(req, null), "l2");
    });
    it("returns l2 when goal_id changed (Gate 3)", () => {
        const req = makeLoopCompileRequest({
            round: 2,
            loop_id: "test",
            goal_id: "new-audit",
            task: "Audit new contract",
        });
        const vaultContext = {
            results: [
                {
                    loop_lineage: {
                        loop_id: "test",
                        round: 1,
                        goal_id: "old-audit",
                    },
                },
            ],
        };
        // goal_id "new-audit" doesn't match prev "old-audit"
        // But wait: deriveGoalId uses explicit goal_id first, and prev.goal_id is "old-audit"
        // deriveGoalId("test", "Audit new contract", "new-audit") = "new-audit"
        // prev.goal_id = "old-audit" → mismatch → L2
        assert.equal(decideLevel(req, vaultContext), "l2");
    });
    it("returns l1 when new constraints added (Gate 4)", () => {
        const req = makeLoopCompileRequest({
            round: 2,
            loop_id: "test",
            goal_id: "audit",
            task: "Audit ERC20",
            constraints_from_plan: ["check flash loans"],
        });
        const vaultContext = {
            results: [
                {
                    loop_lineage: {
                        loop_id: "test",
                        round: 1,
                        goal_id: "audit",
                    },
                },
            ],
        };
        assert.equal(decideLevel(req, vaultContext), "l1");
    });
    it("returns l1 when last round failed (Gate 4)", () => {
        const req = makeLoopCompileRequest({
            round: 2,
            loop_id: "test",
            goal_id: "audit",
            task: "Audit ERC20",
            last_round_result: makeLoopRoundResult({ success: false }),
        });
        const vaultContext = {
            results: [
                {
                    loop_lineage: {
                        loop_id: "test",
                        round: 1,
                        goal_id: "audit",
                    },
                },
            ],
        };
        assert.equal(decideLevel(req, vaultContext), "l1");
    });
    it("returns l1 with repair signal (Gate 4)", () => {
        const req = makeLoopCompileRequest({
            round: 2,
            loop_id: "test",
            goal_id: "audit",
            task: "Audit ERC20",
            new_since_last_round: "fix the approve race condition bug",
        });
        const vaultContext = {
            results: [
                {
                    loop_lineage: {
                        loop_id: "test",
                        round: 1,
                        goal_id: "audit",
                    },
                },
            ],
        };
        assert.equal(decideLevel(req, vaultContext), "l1");
    });
    it("returns l0 when nothing triggered (Gate 4: fast path)", () => {
        const req = makeLoopCompileRequest({
            round: 2,
            loop_id: "test",
            goal_id: "audit",
            task: "Audit ERC20",
        });
        const vaultContext = {
            results: [
                {
                    loop_lineage: {
                        loop_id: "test",
                        round: 1,
                        goal_id: "audit",
                    },
                },
            ],
        };
        assert.equal(decideLevel(req, vaultContext), "l0");
    });
    it("respects force_level override (Gate 1)", () => {
        const req = makeLoopCompileRequest({
            round: 3,
            loop_id: "test",
            goal_id: "audit",
            task: "Audit ERC20",
            force_level: "l0",
        });
        const vaultContext = {
            results: [
                {
                    loop_lineage: {
                        loop_id: "test",
                        round: 2,
                        goal_id: "audit",
                    },
                },
            ],
        };
        assert.equal(decideLevel(req, vaultContext), "l0");
    });
    it("force_level never overrides round 1 (Gate 1 exception)", () => {
        const req = makeLoopCompileRequest({
            round: 1,
            task: "Audit ERC20",
            force_level: "l0",
        });
        assert.equal(decideLevel(req, null), "l2");
    });
    it("force_level never overrides plan_source (Gate 1 exception)", () => {
        const req = makeLoopCompileRequest({
            round: 3,
            task: "Audit ERC20",
            plan_source: "plan.md",
            force_level: "l0",
        });
        assert.equal(decideLevel(req, null), "l2");
    });
});
describe("Loop Compiler — L0 Fast Path", () => {
    it("reuses cached prompt from previous round", () => {
        const req = makeLoopCompileRequest({
            round: 2,
            loop_id: "test",
            goal_id: "audit",
            task: "Continue audit",
        });
        const vaultContext = {
            results: [
                {
                    loop_lineage: {
                        loop_id: "test",
                        round: 1,
                        goal_id: "audit",
                        constraints_active: ["check ownership"],
                    },
                    full_prompt: "## Round 1 Prompt\n\nAudit the contract.",
                },
            ],
        };
        const response = compileLoop(req, vaultContext);
        assert.equal(response.recompile_level, "l0");
        assert.ok(response.prompt.includes("Round 1 Prompt"));
        assert.equal(response.technique_used, "cached");
        assert.deepEqual(response.constraints_active, ["check ownership"]);
    });
});
describe("Loop Compiler — L1 Patch Path", () => {
    it("patches prompt with new constraints", () => {
        const req = makeLoopCompileRequest({
            round: 2,
            loop_id: "test",
            goal_id: "audit",
            task: "Check approve race condition",
            constraints_from_plan: ["check flash loans"],
            new_since_last_round: "fix the approve race",
        });
        const vaultContext = {
            results: [
                {
                    loop_lineage: {
                        loop_id: "test",
                        round: 1,
                        goal_id: "audit",
                        constraints_active: ["check ownership"],
                    },
                },
            ],
        };
        const response = compileLoop(req, vaultContext);
        assert.equal(response.recompile_level, "l1");
        assert.ok(response.prompt.includes("L1 Patch"));
        assert.ok(response.prompt.includes("check flash loans"));
        assert.ok(response.prompt.includes("check ownership"));
        assert.equal(response.technique_used, "patch");
    });
});
describe("Loop Compiler — L2 Full Recompile", () => {
    it("generates full meta-instruction prompt", () => {
        const req = makeLoopCompileRequest({
            round: 1,
            loop_id: "audit-erc20",
            goal_id: "audit-erc20",
            task: "Audit ERC20 token for security vulnerabilities",
            domain: "solidity-security",
        });
        const response = compileL2(req, null);
        assert.equal(response.recompile_level, "l2");
        assert.ok(response.prompt.includes("L2 Compile"));
        assert.ok(response.prompt.includes("Loop Identity"));
        assert.ok(response.prompt.includes("Generation Instructions"));
        assert.notEqual(response.technique_used, "");
        assert.notEqual(response.goal_text_hash, "");
        assert.equal(response.round, 1);
        assert.equal(response.loop_id, "audit-erc20");
    });
    it("includes loop objective at round 1", () => {
        const req = makeLoopCompileRequest({
            round: 1,
            loop_id: "test",
            task: "Audit ERC20 token",
            loop_objective: makeLoopObjective({
                objective: "Find all vulnerabilities",
                success_criteria: ["All tests pass"],
                hard_constraints: ["No external deps"],
                loop_id: "test",
            }),
        });
        const response = compileL2(req, null);
        assert.ok(response.prompt.includes("Loop Objective (Anchor)"));
        assert.ok(response.prompt.includes("Find all vulnerabilities"));
        assert.ok(response.loop_objective !== null);
    });
    it("auto-generates loop objective at round 1 when none provided", () => {
        const req = makeLoopCompileRequest({
            round: 1,
            loop_id: "test",
            task: "Test the API endpoints for security issues",
        });
        const response = compileL2(req, null);
        assert.ok(response.loop_objective !== null);
        assert.ok(response.loop_objective.objective.length > 0);
    });
});
describe("Loop Compiler — Task Alignment (advisory)", () => {
    it("returns default alignment when no loop objective", () => {
        const req = makeLoopCompileRequest({ loop_id: "test", task: "Audit" });
        const result = alignTask("Proposed task", req, null);
        assert.equal(result.is_aligned, true);
        assert.equal(result.escalation, "none");
    });
    it("warns when proposed task drifts from objective", () => {
        const req = makeLoopCompileRequest({
            loop_id: "test",
            task: "Audit ERC20",
            loop_objective: makeLoopObjective({
                objective: "Audit ERC20 token for all security vulnerabilities",
                success_criteria: ["Find all critical vulnerabilities"],
                hard_constraints: ["No external dependencies"],
            }),
        });
        const result = alignTask("Write a frontend UI for the token dashboard", req, null);
        assert.equal(result.escalation, "block");
        assert.equal(result.is_aligned, false);
    });
});
describe("Loop Compiler — Compile Loop (top-level)", () => {
    it("returns complete response with advisories", () => {
        const req = makeLoopCompileRequest({
            round: 1,
            loop_id: "test",
            task: "Test the API",
            next_task_proposal: "Test the database",
            loop_objective: makeLoopObjective({
                objective: "Test all APIs",
                success_criteria: ["All tests pass"],
                hard_constraints: [],
            }),
        });
        const response = compileLoop(req, null);
        assert.equal(response.status, "ok");
        assert.equal(response.recompile_level, "l2");
        assert.notEqual(response.goal_text_hash.length, 0);
        assert.ok(response.task_alignment !== null);
    });
});
describe("Loop Compiler — Cross-Round Scenarios", () => {
    it("L0→L1 escalation: goal_id stable, new constraints added", () => {
        const vaultContext = {
            results: [
                {
                    loop_lineage: {
                        loop_id: "audit",
                        round: 1,
                        goal_id: "audit",
                        constraints_active: ["check ownership"],
                    },
                },
            ],
        };
        // Round 2: same semantic task → deriveGoalId will match
        const req = makeLoopCompileRequest({
            round: 2,
            loop_id: "audit",
            goal_id: "audit",
            task: "Audit ERC20 token for security vulnerabilities",
            constraints_from_plan: ["check flash loans"],
        });
        const level = decideLevel(req, vaultContext);
        assert.equal(level, "l1");
    });
    it("L0 stability: multiple rounds with same goal_id, no failures", () => {
        const vaultContext = {
            results: [
                {
                    loop_lineage: {
                        loop_id: "audit",
                        round: 2,
                        goal_id: "audit",
                    },
                },
            ],
        };
        const req = makeLoopCompileRequest({
            round: 3,
            loop_id: "audit",
            goal_id: "audit",
            task: "Audit ERC20",
        });
        const level = decideLevel(req, vaultContext);
        assert.equal(level, "l0");
    });
});
//# sourceMappingURL=loop-compiler.test.js.map