/** Tests for Memory Bridge (v1.8).
 *
 *  Covers: detection, computeProjectHash, createMemoryProvider (retrieval),
 *  createMemoryWriter (writeback), autoConfigureMemory, tryAutoConfigure,
 *  and edge cases (empty dirs, no matches, lock contention).
 */

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync, rmSync, readFileSync, existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";

import {
  computeProjectHash,
  findGitRoot,
  detectClaudeMem,
  createMemoryProvider,
  createMemoryWriter,
  autoConfigureMemory,
  tryAutoConfigure,
} from "../memory-bridge.js";
import type { MemoryProviderContext, LoopMemoryWriteback } from "../protocol.js";
import { SessionManager } from "../mcp/session.js";

// ═══════════════════════════════════════════════════════════════════════════
// Helpers
// ═══════════════════════════════════════════════════════════════════════════

function makeMemDir(): string {
  const dir = join(tmpdir(), `loopforge-mem-test-${randomUUID()}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

function seedMemoryFile(dir: string, name: string, body: string): void {
  const content = [
    "---",
    `name: ${name}`,
    `description: Test memory about ${name}`,
    "metadata:",
    "  type: project",
    "---",
    "",
    body,
  ].join("\n");
  writeFileSync(join(dir, `${name}.md`), content, "utf-8");
}

function makeProviderCtx(overrides?: Partial<MemoryProviderContext>): MemoryProviderContext {
  return {
    loopId: "test-loop",
    round: 1,
    task: "Audit ERC20 token for reentrancy vulnerabilities",
    domain: "solidity",
    phase: 1,
    progressEstimate: 0,
    accumulatedContext: {
      recurringIssues: [],
      failedPatterns: [],
      keyLessons: [],
      remainingCriteria: [],
    },
    ...overrides,
  };
}

function makeWritebackPayload(overrides?: Partial<LoopMemoryWriteback>): LoopMemoryWriteback {
  return {
    loopId: "test-wb",
    task: "Audit ERC20 token for reentrancy vulnerabilities",
    outcome: "completed",
    roundsCompleted: 5,
    projectEntry: {
      title: "ERC20 Audit — completed",
      objective: "Find and fix all reentrancy bugs in the ERC20 token contract",
      keyOutcome: "Completed successfully in 5 rounds.",
      keyDiscoveries: ["withdraw() has reentrancy via external call before state update"],
      date: "2026-07-01",
    },
    feedbackEntries: [
      {
        rule: "zero-shot failed consistently on Solidity audit — rotate to ToT after 2 low rounds",
        why: "Solidity audits need structured reasoning; zero-shot misses multi-step vulnerabilities",
        howToApply: "For security audit tasks, start with CoT; if quality <3 for 2 rounds, switch to ToT",
      },
    ],
    referenceEntry: {
      description: "LoopForge vault data for ERC20 audit",
      vaultLocation: ".promptcraft/prompt_vault.json → loop:test-wb:*",
    },
    ...overrides,
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// Detection
// ═══════════════════════════════════════════════════════════════════════════

describe("computeProjectHash", () => {
  it("replaces special chars with hyphens (Windows path)", () => {
    const hash = computeProjectHash("C:\\Users\\Dell\\Desktop\\LoopForge");
    assert.equal(hash, "C--Users-Dell-Desktop-LoopForge");
  });

  it("replaces special chars with hyphens (Unix path)", () => {
    const hash = computeProjectHash("/home/user/my-project");
    assert.equal(hash, "-home-user-my-project");
  });

  it("preserves alphanumeric characters", () => {
    const hash = computeProjectHash("simple");
    assert.equal(hash, "simple");
  });

  it("handles dots and hyphens in path", () => {
    const hash = computeProjectHash("/home/user/.claude-mem/projects");
    assert.ok(hash.includes("claude-mem"), `expected claude-mem in: ${hash}`);
  });
});

describe("findGitRoot", () => {
  it("returns a string when run inside a git repo", () => {
    const root = findGitRoot();
    assert.ok(root, "should find git root (test runs inside LoopForge repo)");
    assert.ok(root.endsWith("LoopForge") || root.endsWith("loopforge"),
      `expected path ending with LoopForge, got: ${root}`);
  });
});

describe("detectClaudeMem", () => {
  it("returns memory directory for this project (claude-mem is active)", () => {
    const detected = detectClaudeMem();
    // This test runs inside LoopForge repo where claude-mem IS active
    assert.ok(detected, "claude-mem should be detected for this project");
    assert.ok(detected!.memoryDir.endsWith("memory"), `expected memory dir, got: ${detected?.memoryDir}`);
    assert.ok(detected!.indexPath.endsWith("MEMORY.md"), `expected MEMORY.md, got: ${detected?.indexPath}`);
    assert.ok(existsSync(detected!.memoryDir));
    assert.ok(existsSync(detected!.indexPath));
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Retrieval
// ═══════════════════════════════════════════════════════════════════════════

describe("createMemoryProvider — retrieval", () => {
  let memDir: string;

  before(() => {
    memDir = makeMemDir();
    writeFileSync(join(memDir, "MEMORY.md"), "", "utf-8");
  });

  after(() => {
    rmSync(memDir, { recursive: true, force: true });
  });

  it("returns empty string for empty memory directory", async () => {
    const provider = createMemoryProvider(memDir);
    const result = await provider(makeProviderCtx());
    assert.equal(result, "");
  });

  it("returns empty string when no memories match the task", async () => {
    seedMemoryFile(memDir, "unrelated", "# Python async patterns\n\nUse asyncio for IO-bound tasks.");
    const provider = createMemoryProvider(memDir);
    const result = await provider(makeProviderCtx({
      task: "ERC20 token audit",
    }));
    assert.equal(result, "");
  });

  it("returns relevant memories when keywords match", async () => {
    seedMemoryFile(memDir, "erc20-reentrancy", "# ERC20 Reentrancy Pattern\n\nAlways update state before external calls. The withdraw() function is especially vulnerable.");
    const provider = createMemoryProvider(memDir);
    const result = await provider(makeProviderCtx({
      task: "Audit ERC20 token for reentrancy vulnerabilities",
    }));
    assert.ok(result.includes("Reentrancy"), `expected reentrancy context, got: "${result.slice(0, 100)}"`);
    assert.ok(result.includes("withdraw"), `expected withdraw mention, got: "${result.slice(0, 100)}"`);
  });

  it("ranks memories by keyword match count", async () => {
    // High-match file
    seedMemoryFile(memDir, "high-match", "# ERC20 Audit Guide\n\nCheck reentrancy in ERC20 token. Audit all external calls.");
    // Low-match file
    seedMemoryFile(memDir, "low-match", "# General Notes\n\nSolidity contracts sometimes have issues.");

    const provider = createMemoryProvider(memDir);
    const result = await provider(makeProviderCtx({
      task: "Audit ERC20 token for reentrancy vulnerabilities",
    }));

    // The high-match file should appear first (lower index) in the result
    const highIdx = result.indexOf("ERC20 Audit Guide");
    const lowIdx = result.indexOf("General Notes");
    assert.ok(highIdx >= 0, "high-match file should be present");
    assert.ok(lowIdx < 0 || highIdx < lowIdx,
      `high-match should appear before low-match, got high@${highIdx} low@${lowIdx}`);
  });

  it("Phase 2 query includes recurring issues and failed patterns", async () => {
    seedMemoryFile(memDir, "phase2-test", "# Gas Optimization\n\nUnchecked arithmetic can save gas in Solidity 0.8+.");
    const provider = createMemoryProvider(memDir);
    const result = await provider(makeProviderCtx({
      phase: 2,
      progressEstimate: 0.35,
      accumulatedContext: {
        recurringIssues: ["gas optimization needed for loops"],
        failedPatterns: ["unchecked arithmetic missing"],
        keyLessons: [],
        remainingCriteria: [],
      },
    }));
    // Should find gas-related content because "optimization" and "arithmetic" are in query
    assert.ok(result.length > 0, "Phase 2 query should match gas-related memory");
  });

  it("Phase 3 query includes remaining criteria and key lessons", async () => {
    seedMemoryFile(memDir, "phase3-test", "# Access Control\n\nUse Ownable and RBAC for permission management.");
    const provider = createMemoryProvider(memDir);
    const result = await provider(makeProviderCtx({
      phase: 3,
      progressEstimate: 0.65,
      task: "Audit smart contract",
      accumulatedContext: {
        recurringIssues: [],
        failedPatterns: [],
        keyLessons: ["access control is critical for upgradeable proxies"],
        remainingCriteria: ["verify role-based access control"],
      },
    }));
    assert.ok(result.length > 0, "Phase 3 query should match access control memory");
  });

  it("strips YAML frontmatter from returned content", async () => {
    seedMemoryFile(memDir, "frontmatter-test", "# Keep This Content\n\nThis should be in the output.");
    const provider = createMemoryProvider(memDir);
    const result = await provider(makeProviderCtx({
      task: "frontmatter Keep Content output",
    }));
    assert.ok(result.includes("Keep This Content"), "body content should be present");
    assert.ok(!result.includes("name:"), "YAML frontmatter should be stripped");
    assert.ok(!result.includes("metadata:"), "YAML metadata should be stripped");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Writeback
// ═══════════════════════════════════════════════════════════════════════════

describe("createMemoryWriter — writeback", () => {
  let memDir: string;
  let indexPath: string;

  before(() => {
    memDir = makeMemDir();
    indexPath = join(memDir, "MEMORY.md");
    writeFileSync(indexPath, "", "utf-8");
  });

  after(() => {
    rmSync(memDir, { recursive: true, force: true });
  });

  it("writes project entry file with correct frontmatter", async () => {
    const writer = createMemoryWriter(memDir, indexPath);
    const payload = makeWritebackPayload({ feedbackEntries: [], referenceEntry: undefined as unknown as LoopMemoryWriteback["referenceEntry"] });
    await writer(payload);

    const files = readdirSync(memDir).filter(f => f.endsWith(".md") && f !== "MEMORY.md");
    const projectFile = files.find(f => f.includes("outcome"));
    assert.ok(projectFile, `expected project file in: ${files.join(", ")}`);

    const content = readFileSync(join(memDir, projectFile!), "utf-8");
    assert.ok(content.includes("name: loopforge-test-wb-outcome"), "should have correct name in frontmatter");
    assert.ok(content.includes("type: project"), "should have project type");
    assert.ok(content.includes("ERC20 Audit"), "should contain task title");
    assert.ok(content.includes("reentrancy"), "should contain discovery content");
  });

  it("writes feedback entries with rule + Why + How to apply", async () => {
    const writer = createMemoryWriter(memDir, indexPath);
    const payload = makeWritebackPayload();
    await writer(payload);

    const files = readdirSync(memDir).filter(f => f.endsWith(".md") && f !== "MEMORY.md");
    const fbFile = files.find(f => f.includes("fb-1"));
    assert.ok(fbFile, `expected feedback file in: ${files.join(", ")}`);

    const content = readFileSync(join(memDir, fbFile!), "utf-8");
    assert.ok(content.includes("type: feedback"), "should have feedback type");
    assert.ok(content.includes("**Why:**"), "should have Why section");
    assert.ok(content.includes("**How to apply:**"), "should have How to apply section");
    assert.ok(content.includes("zero-shot failed"), "should contain feedback rule");
  });

  it("writes reference entry", async () => {
    const writer = createMemoryWriter(memDir, indexPath);
    const payload = makeWritebackPayload({ feedbackEntries: [] });
    await writer(payload);

    const files = readdirSync(memDir).filter(f => f.endsWith(".md") && f !== "MEMORY.md");
    const refFile = files.find(f => f.includes("-ref"));
    assert.ok(refFile, `expected reference file in: ${files.join(", ")}`);

    const content = readFileSync(join(memDir, refFile!), "utf-8");
    assert.ok(content.includes("type: reference"), "should have reference type");
    assert.ok(content.includes("Vault Location"), "should contain vault location");
  });

  it("appends entries to MEMORY.md index", async () => {
    const writer = createMemoryWriter(memDir, indexPath);
    const payload = makeWritebackPayload();
    await writer(payload);

    const index = readFileSync(indexPath, "utf-8");
    assert.ok(index.includes(`[LoopForge: ${payload.task.slice(0, 60)}]`), "index should link to project entry");
    assert.ok(index.includes("LoopForge Feedback"), "index should link to feedback entries");
    assert.ok(index.includes("LoopForge Reference"), "index should link to reference entry");
  });

  it("does not write duplicate project files (each write creates uniquely named files)", async () => {
    const writer = createMemoryWriter(memDir, indexPath);
    const payload1 = makeWritebackPayload({ loopId: "write-1" });
    const payload2 = makeWritebackPayload({ loopId: "write-2" });
    await writer(payload1);
    await writer(payload2);

    const files = readdirSync(memDir).filter(f => f !== "MEMORY.md");
    const outcomeFiles = files.filter(f => f.includes("-outcome.md") && (f.includes("write-1") || f.includes("write-2")));
    assert.equal(outcomeFiles.length, 2, "should have 2 distinct outcome files");
  });

  it("handles empty feedback entries gracefully", async () => {
    const writer = createMemoryWriter(memDir, indexPath);
    const payload = makeWritebackPayload({
      loopId: "no-fb",
      feedbackEntries: [],
    });
    await writer(payload);

    const files = readdirSync(memDir).filter(f => f !== "MEMORY.md");
    const fbFiles = files.filter(f => /-fb-\d+\.md$/.test(f) && f.includes("no-fb"));
    assert.equal(fbFiles.length, 0, "should not create feedback files when empty");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Integration entry points
// ═══════════════════════════════════════════════════════════════════════════

describe("autoConfigureMemory", () => {
  it("sets memoryProvider and memoryWriter on SessionManager when detected", () => {
    // In this test environment, claude-mem IS active (we're in LoopForge repo)
    const mgr = new SessionManager();
    assert.equal(mgr.memoryProvider, undefined, "should start with no provider");
    assert.equal(mgr.memoryWriter, undefined, "should start with no writer");

    autoConfigureMemory(mgr);

    // Since we're in a git repo with claude-mem active, it should detect
    const detected = detectClaudeMem();
    if (detected) {
      assert.ok(mgr.memoryProvider, "provider should be set when claude-mem detected");
      assert.ok(mgr.memoryWriter, "writer should be set when claude-mem detected");
    } else {
      // Outside git or claude-mem not active — still no provider (graceful degradation)
      assert.equal(mgr.memoryProvider, undefined);
      assert.equal(mgr.memoryWriter, undefined);
    }
  });
});

describe("tryAutoConfigure", () => {
  it("returns provider and writer when claude-mem is detected", () => {
    const result = tryAutoConfigure();
    const detected = detectClaudeMem();
    if (detected) {
      assert.ok(result.memoryProvider, "should return provider when detected");
      assert.ok(result.memoryWriter, "should return writer when detected");
    } else {
      assert.equal(result.memoryProvider, undefined);
      assert.equal(result.memoryWriter, undefined);
    }
  });

  it("returned provider works (integration smoke test)", async () => {
    const result = tryAutoConfigure();
    if (!result.memoryProvider) return; // skip if claude-mem not active

    const ctx = makeProviderCtx();
    const context = await result.memoryProvider(ctx);
    // May be empty if no matching memories, but should not throw
    assert.equal(typeof context, "string");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Edge cases
// ═══════════════════════════════════════════════════════════════════════════

describe("Memory bridge edge cases", () => {
  it("createMemoryProvider handles missing directory gracefully", async () => {
    const provider = createMemoryProvider("/nonexistent/path/memory");
    const result = await provider(makeProviderCtx());
    assert.equal(result, "");
  });

  it("createMemoryProvider handles files without frontmatter", async () => {
    const memDir = makeMemDir();
    try {
      writeFileSync(join(memDir, "MEMORY.md"), "", "utf-8");
      writeFileSync(join(memDir, "plain.md"), "# No Frontmatter\n\nJust plain markdown content.", "utf-8");
      const provider = createMemoryProvider(memDir);
      const result = await provider(makeProviderCtx({ task: "plain markdown content frontmatter" }));
      assert.ok(result.includes("No Frontmatter"), "should handle files without YAML frontmatter");
    } finally {
      rmSync(memDir, { recursive: true, force: true });
    }
  });

  it("createMemoryWriter handles concurrent lock gracefully (non-blocking)", async () => {
    const memDir = makeMemDir();
    const indexPath = join(memDir, "MEMORY.md");
    writeFileSync(indexPath, "", "utf-8");

    // Manually create the lock directory to simulate contention
    const lockDir = join(memDir, ".loopforge-wb.lock");
    mkdirSync(lockDir);

    try {
      const writer = createMemoryWriter(memDir, indexPath);
      const payload = makeWritebackPayload({ loopId: "locked-test" });
      // Should not throw — just skip quietly
      await writer(payload);

      // No files should be written since lock was held
      const mdFiles = readdirSync(memDir).filter(f => f.endsWith(".md") && f !== "MEMORY.md");
      assert.equal(mdFiles.length, 0, "should not write files when lock is held");
    } finally {
      rmSync(lockDir, { recursive: true, force: true });
      rmSync(memDir, { recursive: true, force: true });
    }
  });
});
