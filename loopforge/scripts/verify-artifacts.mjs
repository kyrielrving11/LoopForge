#!/usr/bin/env node
/** Verify generated artifacts are in sync with src.
 *
 * Rebuilds from src into a temporary directory and compares against the
 * working-tree dist/ and loopforge-protocol.json, then checks that the
 * generated artifacts match the last commit (HEAD) so stale builds cannot
 * be committed silently.
 *
 * Exit 0 when everything is in sync; exit 1 with a file list otherwise.
 * No external dependencies — node built-ins only.
 */
import { execFileSync } from "node:child_process";
import {
  existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const pkgRoot = resolve(scriptDir, "..");
const repoRoot = resolve(pkgRoot, "..");
const distDir = join(pkgRoot, "dist");
const protocolPath = join(repoRoot, "loopforge-protocol.json");

let ok = true;
let built = false;

function fail(message) {
  console.error(`verify:artifacts ❌ ${message}`);
  ok = false;
}

/** Run a node command; report a readable error instead of a raw dump. */
function runNode(args, label) {
  try {
    execFileSync(process.execPath, args, {
      cwd: pkgRoot,
      stdio: ["ignore", "pipe", "pipe"],
    });
    return true;
  } catch (err) {
    const detail = err && typeof err === "object" && "stderr" in err
      ? String(err.stderr).slice(0, 1200)
      : String(err);
    fail(`${label} failed:\n${detail}`);
    return false;
  }
}

/** Recursively collect files under dir (relative paths, forward slashes). */
function collectFiles(dir) {
  const out = [];
  const walk = (current) => {
    for (const name of readdirSync(current)) {
      const full = join(current, name);
      if (statSync(full).isDirectory()) walk(full);
      else out.push(relative(dir, full).split("\\").join("/"));
    }
  };
  if (existsSync(dir)) walk(dir);
  return out.sort();
}

/** Compare line-ending-normalized file contents (git may store CRLF). */
function readNormalized(path) {
  return readFileSync(path, "utf-8").replace(/\r\n?/g, "\n");
}

/** Diff two directory trees. Returns a list of "<path> (<reason>)". */
function diffTrees(dirA, dirB) {
  const filesA = new Set(collectFiles(dirA));
  const filesB = new Set(collectFiles(dirB));
  const differences = [];
  for (const f of filesA) {
    if (!filesB.has(f)) {
      differences.push(`${f} (missing)`);
      continue;
    }
    if (readNormalized(join(dirA, f)) !== readNormalized(join(dirB, f))) {
      differences.push(`${f} (content differs)`);
    }
  }
  for (const f of filesB) {
    if (!filesA.has(f)) differences.push(`${f} (unexpected)`);
  }
  return differences;
}

// The temp build lives INSIDE the package tree at the SAME depth as dist/
// (one level below pkgRoot) so tsc emits byte-identical sourcemap source
// paths, and ESM resolution for `typescript` reaches pkgRoot/node_modules
// naturally. Cleaned up below; a crashed run's leftovers are removed first.
const tmpDist = join(pkgRoot, ".verify-artifacts-tmp");
rmSync(tmpDist, { recursive: true, force: true });
// The generated protocol schema goes to the OS temp dir (only written and
// compared — never imported from), keeping the compared tree clean.
const tmpProtocolDir = mkdtempSync(join(tmpdir(), "loopforge-verify-"));
const tmpProtocol = join(tmpProtocolDir, "loopforge-protocol.json");

try {
  mkdirSync(tmpDist, { recursive: true });

  // 1. Clean build into the temp dir (never touches the working tree).
  built = runNode([
    join(pkgRoot, "node_modules", "typescript", "bin", "tsc"),
    "-p", join(pkgRoot, "tsconfig.json"),
    "--outDir", tmpDist,
  ], "clean tsc build");

  // 1b. Match the production trim step (diff-clean generated artifacts).
  if (built) {
    runNode([join(pkgRoot, "scripts", "trim-dist.mjs"), tmpDist], "dist trim");
  }

  // 2. Generate the protocol schema into the temp dir.
  if (built) {
    built = runNode([
      join(tmpDist, "generate-schema.js"),
      "--out", tmpProtocol,
    ], "protocol schema generation");
  }

  if (built) {
    // 3. Compare against the working-tree artifacts.
    const distDiffs = diffTrees(tmpDist, distDir);
    if (distDiffs.length > 0) {
      fail(
        'dist/ is stale — rebuild with "npm run build" and commit:\n  ' +
        distDiffs.slice(0, 20).join("\n  "),
      );
    }
    if (readNormalized(protocolPath) !== readNormalized(tmpProtocol)) {
      fail('loopforge-protocol.json is stale — rebuild with "npm run build" and commit');
    }
  }

  // 4. The CLI must report exactly the package.json version (single source).
  if (built && existsSync(join(distDir, "cli.js"))) {
    try {
      const cliVersion = execFileSync(process.execPath, [
        join(distDir, "cli.js"), "--version",
      ], { cwd: pkgRoot, encoding: "utf-8" }).trim();
      const pkg = JSON.parse(readFileSync(join(pkgRoot, "package.json"), "utf-8"));
      if (cliVersion !== pkg.version) {
        fail(`CLI reports ${cliVersion} but package.json says ${pkg.version}`);
      }
    } catch (err) {
      fail(`CLI version probe failed: ${String(err).slice(0, 400)}`);
    }
  }

  // 5. Generated artifacts must match the last commit (HEAD).
  if (existsSync(join(repoRoot, ".git"))) {
    try {
      const dirty = execFileSync("git", [
        "-C", repoRoot, "diff", "--name-only", "HEAD", "--",
        "loopforge/dist", "loopforge-protocol.json",
      ], { encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"] });
      if (dirty.trim()) {
        fail(
          "generated artifacts differ from the last commit (HEAD). Rebuild and commit them:\n  " +
          dirty.trim().split(/\r?\n/).join("\n  "),
        );
      }
    } catch {
      // Not a git checkout or git unavailable — skip the HEAD check.
    }
  }
} finally {
  rmSync(tmpDist, { recursive: true, force: true });
  rmSync(tmpProtocolDir, { recursive: true, force: true });
}

if (!ok) {
  process.exit(1);
}
console.log("verify:artifacts ✓ dist/ and loopforge-protocol.json match a clean build from src");
