import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { initializeClient, removeManagedLegacySkillFile } from "../init.js";

describe("client initialization", () => {
  it("installs $loopforge without registering and prints an absolute local command", () => {
    const root = mkdtempSync(join(tmpdir(), "loopforge-init-"));
    try {
      const result = initializeClient({ client: "generic", target: root });
      assert.equal(result.registered, false);
      assert.equal(result.registrationVerified, false);
      assert.match(result.skillPath, /loopforge[\\/]SKILL\.md$/);
      const config = result.registration as { mcpServers: { loopforge: { command: string; args: string[] } } };
      assert.equal(config.mcpServers.loopforge.command, process.execPath);
      assert.match(config.mcpServers.loopforge.args[0], /dist[\\/]cli\.js$/);
      assert.equal(config.mcpServers.loopforge.args[1], "mcp");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("preserves an unmanaged legacy perception skill and warns", () => {
    const root = mkdtempSync(join(tmpdir(), "loopforge-init-"));
    try {
      const legacy = join(root, "perception");
      mkdirSync(legacy, { recursive: true });
      writeFileSync(join(legacy, "SKILL.md"), "custom user skill\n", "utf8");
      const result = initializeClient({ client: "generic", target: root });
      assert.equal(existsSync(join(legacy, "SKILL.md")), true);
      assert.ok(result.warnings.some((warning) => warning.includes("Preserved non-managed")));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("removes only the managed legacy skill file and preserves sibling files", () => {
    const root = mkdtempSync(join(tmpdir(), "loopforge-init-"));
    try {
      const legacy = join(root, "perception");
      const skill = join(legacy, "SKILL.md");
      const sibling = join(legacy, "notes.txt");
      mkdirSync(legacy, { recursive: true });
      writeFileSync(skill, "managed legacy skill\n", "utf8");
      writeFileSync(sibling, "user data\n", "utf8");
      const digest = createHash("sha256").update("managed legacy skill\n").digest("hex");

      removeManagedLegacySkillFile(skill, [], new Set([digest]));

      assert.equal(existsSync(skill), false);
      assert.equal(existsSync(sibling), true);
      assert.equal(existsSync(legacy), true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
