/** Tests for protocol type factories and serialisation. */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { Mode, AgentStatus, Technique, makeAnalysis, makeVaultConfig, makeLoopCompileRequest, makeLoopCompileResponse, makeTaskId, } from "../protocol.js";
describe("Protocol — Enums", () => {
    it("Mode has 4 values", () => {
        assert.equal(Object.values(Mode).length, 4);
        assert.equal(Mode.LOOP_COMPILE, "loop_compile");
        assert.equal(Mode.FEEDBACK, "feedback");
        assert.equal(Mode.REVIEW, "review");
        assert.equal(Mode.BUILD, "build");
    });
    it("AgentStatus has 3 values", () => {
        assert.equal(AgentStatus.OK, "ok");
        assert.equal(AgentStatus.ERROR, "error");
        assert.equal(AgentStatus.STALLED, "stalled");
    });
    it("Technique has 7 values", () => {
        assert.equal(Technique.ZERO_SHOT, "zero-shot");
        assert.equal(Technique.TREE_OF_THOUGHT, "tree-of-thought");
    });
});
describe("Protocol — Factory functions", () => {
    it("makeAnalysis returns sensible defaults", () => {
        const a = makeAnalysis();
        assert.equal(a.technique, "zero-shot");
        assert.equal(a.was_rotated, false);
        assert.equal(a.independence, "independent");
        assert.equal(a.cognitive_load, "low");
    });
    it("makeAnalysis accepts overrides", () => {
        const a = makeAnalysis({ technique: "few-shot", was_rotated: true });
        assert.equal(a.technique, "few-shot");
        assert.equal(a.was_rotated, true);
    });
    it("makeVaultConfig returns sensible defaults", () => {
        const vc = makeVaultConfig();
        assert.equal(vc.project_vault, ".promptcraft/prompt_vault.json");
        assert.equal(vc.skills_dir, "skills");
        assert.equal(vc.no_global, false);
    });
    it("makeLoopCompileRequest returns sensible defaults", () => {
        const req = makeLoopCompileRequest();
        assert.equal(req.mode, "loop_compile");
        assert.equal(req.round, 1);
        assert.equal(req.force_level, "auto");
        assert.equal(req.health_check_interval, 1);
        assert.equal(req.loop_objective, null);
        assert.deepEqual(req.constraints_from_plan, []);
    });
    it("makeLoopCompileResponse returns sensible defaults", () => {
        const resp = makeLoopCompileResponse();
        assert.equal(resp.status, "ok");
        assert.equal(resp.recompile_level, "l2");
        assert.equal(resp.round, 0);
        assert.deepEqual(resp.warnings, []);
    });
    it("makeTaskId derives kebab-case from description", () => {
        assert.equal(makeTaskId("Audit ERC20 token"), "audit-erc20-token");
        assert.equal(makeTaskId(""), "unnamed-task");
    });
});
//# sourceMappingURL=protocol.test.js.map