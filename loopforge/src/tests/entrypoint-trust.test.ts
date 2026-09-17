/** v3.8.3 — the trusted entrypoint baseline.
 *
 *  The entrypoint check used to be relative only: "does this file appear in
 *  the round's git change set?". That misses two cases, and this suite pins
 *  both:
 *
 *  - an entrypoint git cannot see at all (gitignored) is in no git diff, so a
 *    script rewritten this round read as untouched;
 *  - a baseline re-derived from the current tree would compare the tampered
 *    state against itself.
 *
 *  The baseline is therefore taken from the filesystem when the round is
 *  PREPARED, and the comparison is absolute: current content vs round-start
 *  content.
 */

import { describe, it } from "node:test";
import { execFileSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import assert from "node:assert/strict";
import { captureEntrypointTrust, driftedEntrypoints } from "../evidence-provider.js";
import { getPolicy } from "../policy.js";

/** A policy whose one enabled command names `script` on its own command line.
 *  `node` is bare, so the script in `args` is the entrypoint candidate. */
function policyWithEntrypoint(script: string): ReturnType<typeof getPolicy> {
  const policy = getPolicy();
  policy.evidence.commands = [{
    name: "verify",
    enabled: true,
    executable: process.execPath,
    args: [script],
    cwd: undefined,
    phase: "after",
    required: false,
    timeout_ms: 5000,
    max_output_chars: 2000,
    success_exit_codes: [0],
  }];
  return policy;
}

function workspace(): string {
  const dir = join(tmpdir(), `lf-entry-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

describe("v3.8.3 — entrypoint trust baseline", () => {
  it("records a present entrypoint and marks an absent candidate as missing", () => {
    const dir = workspace();
    try {
      writeFileSync(join(dir, "verify.js"), "console.log('ok');\n");
      const trust = captureEntrypointTrust(
        policyWithEntrypoint("verify.js"), dir,
      );
      assert.match(trust["verify.js"] ?? "", /^[0-9]+:[0-9a-f]{64}$/);

      // The candidate did not exist at baseline: recorded as absent rather
      // than dropped, which is what makes "created during the round" visible.
      const absent = captureEntrypointTrust(
        policyWithEntrypoint("not-yet.js"), dir,
      );
      assert.equal(absent["not-yet.js"], "missing");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("reports a modified entrypoint as drifted, with its round-start state", () => {
    const dir = workspace();
    try {
      const script = join(dir, "verify.js");
      writeFileSync(script, "console.log('ok');\n");
      const trust = captureEntrypointTrust(policyWithEntrypoint("verify.js"), dir);
      assert.deepEqual(driftedEntrypoints(trust, dir), []);

      writeFileSync(script, "console.log('ok'); // rewritten\n");
      assert.deepEqual(driftedEntrypoints(trust, dir), [
        { file: "verify.js", roundStart: "present" },
      ]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("reports an entrypoint CREATED after the baseline as drifted/absent", () => {
    const dir = workspace();
    try {
      const trust = captureEntrypointTrust(policyWithEntrypoint("verify.js"), dir);
      assert.equal(trust["verify.js"], "missing");

      writeFileSync(join(dir, "verify.js"), "console.log('ok');\n");
      assert.deepEqual(driftedEntrypoints(trust, dir), [
        { file: "verify.js", roundStart: "absent" },
      ]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("sees an entrypoint change git cannot see at all", () => {
    // The claim this baseline exists for: a gitignored entrypoint appears in
    // no `git status` output, so a delta built on git is blind to it while
    // the filesystem baseline is not.
    const dir = workspace();
    const gitEnv = {
      ...process.env,
      GIT_AUTHOR_NAME: "lf-test", GIT_AUTHOR_EMAIL: "lf@test",
      GIT_COMMITTER_NAME: "lf-test", GIT_COMMITTER_EMAIL: "lf@test",
    };
    const git = (...args: string[]): string =>
      execFileSync("git", args, { cwd: dir, encoding: "utf8", env: gitEnv });
    try {
      git("init", "-q");
      writeFileSync(join(dir, ".gitignore"), "verify.js\n");
      writeFileSync(join(dir, "src.ts"), "export const a = 1;\n");
      git("add", ".gitignore", "src.ts");
      git("commit", "-q", "-m", "baseline");

      writeFileSync(join(dir, "verify.js"), "console.log('ok');\n");
      const trust = captureEntrypointTrust(policyWithEntrypoint("verify.js"), dir);

      writeFileSync(join(dir, "verify.js"), "process.exit(0); // always passes\n");

      // git reports nothing: verify.js is ignored, src.ts is untouched.
      assert.equal(git("status", "--porcelain").trim(), "");
      // The baseline reports the change anyway.
      assert.deepEqual(driftedEntrypoints(trust, dir), [
        { file: "verify.js", roundStart: "present" },
      ]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("treats a policy with no enabled after-capable command as an empty baseline", () => {
    const dir = workspace();
    const policy = getPolicy();
    try {
      writeFileSync(join(dir, "verify.js"), "console.log('ok');\n");
      policy.evidence.commands = [];
      assert.deepEqual(captureEntrypointTrust(policy, dir), {});
      // An absent baseline means "no absolute arm", never a false positive.
      assert.deepEqual(driftedEntrypoints(undefined, dir), []);
    } finally {
      policy.evidence.commands = [];
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
