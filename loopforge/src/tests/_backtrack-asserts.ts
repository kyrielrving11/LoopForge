/** Structured backtrack prompt assertions (v3.9.7 checkpoint model).
 *
 * The prompt no longer asks the Agent to restore the workspace: LoopForge
 * commits the directive, restores, verifies, and only then compiles the redo.
 * The assertions therefore check the verified-recovery facts and ensure no
 * manual restore recipe leaks into the prompt.
 */

import assert from "node:assert/strict";

/** Git subcommands that must NEVER appear in a backtrack prompt. */
const FORBIDDEN_RESTORE_COMMANDS = ["git stash", "git reset", "git checkout", "git clean"];

export function verifyBacktrackPrompt(
  prompt: string,
  redoRound: number,
  expectedSubstrings: string[] = [],
): void {
  assert.ok(prompt.includes("Recovery Brief"),
    "prompt must carry the protected Recovery Brief");
  assert.ok(prompt.includes("Restored checkpoint"),
    "prompt must name the checkpoint LoopForge restored");
  assert.ok(
    prompt.includes(`Redo round**: ${redoRound}`),
    `prompt must name the first redo round (${redoRound})`,
  );
  assert.ok(
    !prompt.includes("Restoring the workspace is **your** responsibility"),
    "the Agent is no longer asked to restore the workspace",
  );
  for (const command of FORBIDDEN_RESTORE_COMMANDS) {
    assert.ok(
      !prompt.includes(command),
      `prompt must NOT prescribe "${command}" — LoopForge performs the restore`,
    );
  }
  assert.ok(!prompt.includes("${"), "prompt must not contain un-interpolated literals");
  for (const sub of expectedSubstrings) {
    assert.ok(prompt.includes(sub), `prompt must contain "${sub}"`);
  }
}
