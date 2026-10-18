#!/usr/bin/env node
/** Measure the v3.9.1 complete-boundary Git capture.
 *
 * Creates a small and a large temporary repository, captures before/after,
 * and reports latency + serialized observation size. It also asserts that
 * every enumerated path got a fingerprint (no silent omission) and that a
 * pathologically short deadline yields an explicit non-observed status
 * instead of a partial boundary.
 *
 * Usage (after `npm run build`):
 *   node scripts/measure-boundary.mjs [largeFileCount]
 */

import { execFileSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GitEvidenceProvider } from "../dist/evidence-provider.js";

const LARGE = Number(process.argv[2] ?? 5000);
const DEBUG = process.env.LOOPFORGE_MEASURE_DEBUG === "1";
const step = (message) => {
  if (DEBUG) console.error(`[measure] ${message}`);
};
const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: "loopforge-measure",
  GIT_AUTHOR_EMAIL: "loopforge@example.invalid",
  GIT_COMMITTER_NAME: "loopforge-measure",
  GIT_COMMITTER_EMAIL: "loopforge@example.invalid",
};

function git(dir, ...args) {
  return execFileSync("git", args, {
    cwd: dir,
    encoding: "utf8",
    env: GIT_ENV,
    stdio: ["ignore", "pipe", "pipe"],
  });
}

function makeRepo(label, count) {
  const dir = join(tmpdir(), `loopforge-measure-${label}-${Date.now()}`);
  mkdirSync(dir, { recursive: true });
  git(dir, "init", "-q");
  for (let index = 0; index < count; index++) {
    const sub = join(dir, "src", String(index % 20));
    mkdirSync(sub, { recursive: true });
    writeFileSync(join(sub, `file-${index}.ts`), `export const value${index} = ${index};\n`);
  }
  git(dir, "add", ".");
  git(dir, "commit", "-q", "-m", "baseline");
  return dir;
}

async function measure(label, count) {
  step(`${label}: creating ${count}-file repository`);
  const dir = makeRepo(label, count);
  const provider = new GitEvidenceProvider();
  step(`${label}: repository ready`);
  try {
    const beforeStart = Date.now();
    const before = await provider.capture({
      signal: new AbortController().signal,
      timeoutMs: 120_000,
      phase: "before",
      cwd: dir,
    });
    const beforeMs = Date.now() - beforeStart;
    step(`${label}: before capture ${beforeMs}ms`);
    if (!before || before.kind !== "git" || before.status !== "observed") {
      throw new Error(`${label}: before capture was not observed`);
    }
    const tracked = Number(git(dir, "ls-files").trim().split("\n").filter(Boolean).length);
    const fingerprinted = Object.keys(before.data.fingerprints).length;
    if (fingerprinted !== tracked) {
      throw new Error(`${label}: ${fingerprinted} fingerprints for ${tracked} tracked paths`);
    }

    // Change a few files and commit them: a committed change must still be
    // visible in the boundary delta.
    for (let index = 0; index < 5; index++) {
      writeFileSync(join(dir, "src", String(index % 20), `file-${index}.ts`),
        `export const value${index} = ${index + 1};\n`);
    }
    writeFileSync(join(dir, "src", "untracked.ts"), "export const untracked = true;\n");
    git(dir, "add", "src");
    git(dir, "commit", "-q", "-m", "change");

    const afterStart = Date.now();
    const after = await provider.capture({
      signal: new AbortController().signal,
      timeoutMs: 120_000,
      phase: "after",
      cwd: dir,
    });
    const afterMs = Date.now() - afterStart;
    step(`${label}: after capture ${afterMs}ms`);

    // Explicit timeout: a 1 ms deadline cannot hash the boundary.
    step(`${label}: timeout capture`);
    const timeout = await provider.capture({
      signal: new AbortController().signal,
      timeoutMs: 1,
      phase: "after",
      cwd: dir,
    });
    if (!timeout || timeout.status === "observed") {
      throw new Error(`${label}: a 1 ms deadline yielded an observed boundary`);
    }

    return {
      label,
      files: tracked,
      beforeMs,
      afterMs,
      beforeBytes: JSON.stringify(before).length,
      afterBytes: after ? JSON.stringify(after).length : 0,
      timeoutStatus: timeout.status,
    };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const results = [];
results.push(await measure("small", 200));
results.push(await measure("large", LARGE));
console.log(JSON.stringify(results, null, 2));
