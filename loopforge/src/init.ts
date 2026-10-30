/** Client-specific skill onboarding. */

import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export type InitClient = "claude" | "codex" | "generic";

export interface InitOptions {
  client: InitClient;
  force?: boolean;
  target?: string;
}

export interface InitResult {
  client: InitClient;
  /** The installed skill directory (`<target>/forge`). */
  skillDir: string;
  /** The core SKILL.md path inside that directory. */
  skillPath: string;
  installed: boolean;
  /** v4.0.4: the directory exists but at least one packaged skill file is
   *  missing or differs. Default init never overwrites it; `--force`
   *  refreshes it. Extra user files do not make a tree stale. */
  stale: boolean;
  /** Installed files, relative to `skillDir`, sorted for deterministic output. */
  files: string[];
  registration: string | Record<string, unknown>;
}

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const skillSourceDir = join(packageRoot, "skills", "forge");

function destination(options: InitOptions): string {
  if (options.target) return resolve(options.target, "forge");
  if (options.client === "claude") {
    return join(homedir(), ".claude", "skills", "forge");
  }
  if (options.client === "codex") {
    return join(homedir(), ".codex", "skills", "forge");
  }
  return resolve(".loopforge", "skills", "forge");
}

function registration(client: InitClient): string | Record<string, unknown> {
  if (client === "claude") {
    return "claude mcp add loopforge -- npx loopforge mcp";
  }
  if (client === "codex") {
    return "codex mcp add loopforge -- npx loopforge mcp";
  }
  return {
    mcpServers: {
      loopforge: { command: "npx", args: ["loopforge", "mcp"] },
    },
  };
}

/** Copy each entry into an already-created destination. Per-entry copying
 *  avoids `cpSync(srcDir, destDir)` nesting the source under an existing
 *  destination, and keeps the operation explicit about what it owns. */
function copySkillTree(sourceDir: string, destDir: string): void {
  mkdirSync(destDir, { recursive: true });
  for (const entry of readdirSync(sourceDir, { withFileTypes: true })) {
    cpSync(join(sourceDir, entry.name), join(destDir, entry.name), {
      recursive: true,
    });
  }
}

function listFiles(root: string, current = root): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(current, { withFileTypes: true })) {
    const full = join(current, entry.name);
    if (entry.isDirectory()) {
      out.push(...listFiles(root, full));
    } else {
      out.push(relative(root, full).split("\\").join("/"));
    }
  }
  return out.sort();
}

/** v4.0.4: does every packaged skill file exist in `destDir` with identical
 *  bytes? Extra files in the destination are user state and are ignored, so a
 *  local note never makes the package-owned tree look stale. */
export function installedSkillIsCurrent(destDir: string): boolean {
  if (!existsSync(destDir)) return false;
  try {
    for (const rel of listFiles(skillSourceDir)) {
      const installed = join(destDir, rel);
      if (!existsSync(installed)) return false;
      if (!readFileSync(join(skillSourceDir, rel)).equals(readFileSync(installed))) {
        return false;
      }
    }
    return true;
  } catch {
    // A path that is not a readable file (a directory named SKILL.md, a
    // permission error) is not a current install. init must still report it,
    // never throw while merely inspecting.
    return false;
  }
}

/** Read-only inspection for `doctor`. Returns null when no skill is installed
 *  at `destDir`; never copies or repairs anything. */
export function inspectInstalledSkill(destDir: string): "current" | "stale" | null {
  if (!existsSync(destDir)) return null;
  return installedSkillIsCurrent(destDir) ? "current" : "stale";
}

export function initializeClient(options: InitOptions): InitResult {
  const skillPath = join(skillSourceDir, "SKILL.md");
  if (!existsSync(skillPath)) {
    throw new Error(`Packaged Forge skill not found: ${skillPath}`);
  }
  const skillDir = destination(options);
  // Default install is a no-op when the skill directory exists. It never
  // repairs a partial install or overwrites user edits; `--force` replaces
  // the package-owned directory wholesale so stale references disappear.
  const installed = options.force === true || !existsSync(skillDir);
  if (installed) {
    if (options.force === true && existsSync(skillDir)) {
      rmSync(skillDir, { recursive: true, force: true });
    }
    copySkillTree(skillSourceDir, skillDir);
  }
  return {
    client: options.client,
    skillDir,
    skillPath: join(skillDir, "SKILL.md"),
    installed,
    // v4.0.4: an upgrade can leave an older installed copy behind. Report it
    // instead of silently keeping rules that may contradict the runtime.
    stale: !installed && !installedSkillIsCurrent(skillDir),
    files: installed ? listFiles(skillDir) : [],
    registration: registration(options.client),
  };
}
