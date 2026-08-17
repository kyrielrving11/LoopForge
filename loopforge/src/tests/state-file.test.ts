import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  bindPolicyWorkspace,
  resetPolicy,
  resolveStateDirectory,
  writeStateFile,
  writeWorkflowStateFile,
} from "../policy.js";

describe("state file path boundary", () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    resetPolicy();
    for (const dir of tempDirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  function temp(prefix: string): string {
    const dir = mkdtempSync(join(tmpdir(), prefix));
    tempDirs.push(dir);
    return dir;
  }

  it("accepts a normal directory inside the workspace", () => {
    const workspace = temp("loopforge-state-root-");
    assert.equal(
      resolveStateDirectory(workspace, ".loopforge/state"),
      join(workspace, ".loopforge", "state"),
    );
  });

  it("rejects lexical traversal outside the workspace", () => {
    const workspace = temp("loopforge-state-root-");
    assert.throws(
      () => resolveStateDirectory(workspace, "../outside"),
      /within the workspace/,
    );
  });

  it("rejects a symlink or junction that resolves outside the workspace", () => {
    const workspace = temp("loopforge-state-root-");
    const outside = temp("loopforge-state-outside-");
    mkdirSync(join(workspace, ".loopforge"), { recursive: true });
    symlinkSync(outside, join(workspace, ".loopforge", "state"), "junction");

    assert.throws(
      () => resolveStateDirectory(workspace, ".loopforge/state"),
      /resolves outside the workspace/,
    );
  });

  it("replaces repeated projections and keeps workflow writes in the bound workspace", () => {
    const workspace = temp("loopforge-state-root-");
    bindPolicyWorkspace(workspace);

    for (let index = 0; index < 20; index += 1) {
      writeStateFile("repeated-state", `round ${index}`, workspace);
    }

    const target = join(workspace, ".loopforge", "state", "repeated-state-state.md");
    assert.equal(readFileSync(target, "utf8"), "round 19");

    writeWorkflowStateFile("repeated-state", {
      phase: "planning",
      approvalPolicy: "risk_only",
      planningProfile: "minimal",
      planVersion: null,
      plan: null,
      revisions: [],
      approvalId: null,
      approvalHistory: [],
      activeStepId: null,
      planningPrompt: null,
      planSource: null,
      baselineConstraints: [],
      pendingPlanChange: null,
      queuedPlanChange: null,
      auditVerifiedCriteria: [],
      blockingGate: null,
      advancementHistory: [],
    }, workspace);

    assert.match(readFileSync(target, "utf8"), /loopforge-workflow-v3/);
  });
});
