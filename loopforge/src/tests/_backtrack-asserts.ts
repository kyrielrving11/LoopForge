/** Structured backtrack prompt assertions.
 *
 * Replaces fragile prompt.includes("substring") checks with exact round-number
 * verification. Catches the ${fromRound} / ${toRound} literal regression that
 * substring-based tests miss.
 */

import assert from "node:assert/strict";

/** v3.8: git subcommands that must NEVER appear in a backtrack prompt.
 *  LoopForge does not restore the workspace, and it does not prescribe how the
 *  agent does either — the prompt states the restore FACTS (target HEAD, files
 *  to revert) and leaves the means to the agent. */
const FORBIDDEN_RESTORE_COMMANDS = ["git stash", "git reset", "git checkout", "git clean"];

/** Verify that a backtrack prompt contains actual round numbers (not un-interpolated
 *  template literals) and all caller-specified structural markers.
 *
 *  Phase 1: exact round numbers in key positions — these catch the bug where
 *           double-quoted strings were used instead of backtick template literals.
 *  Phase 2: no literal `${fromRound}` or `${toRound}` survives anywhere.
 *  Phase 3: no git restore command is prescribed anywhere.
 *  Phase 4: caller-specified markers (e.g. "Radically different", file paths). */
export function verifyBacktrackPrompt(
  prompt: string,
  fromRound: number,
  toRound: number,
  expectedSubstrings: string[] = [],
): void {
  // ── Phase 1: exact round numbers ──────────────────────────────────────────

  // Header line uses backticks (was correct pre-fix)
  assert.ok(
    prompt.includes(`Round ${fromRound} → Restored to Round ${toRound}`),
    `prompt must contain "Round ${fromRound} → Restored to Round ${toRound}"`,
  );

  // Progress stall range — only for non-terminal triggers.
  // progress_flatline uses different wording (no explicit range).

  // Non-git fallback instructions (were double-quoted — THE bug)
  assert.ok(
    prompt.includes(`to their state at Round ${toRound}`),
    `prompt must contain "to their state at Round ${toRound}"`,
  );

  // Restoring the workspace is the agent's action, and the prompt says so.
  assert.ok(
    prompt.includes("Restoring the workspace is **your** responsibility"),
    "prompt must state that the agent owns the restore",
  );

  // New round number in instructions (backtick — was correct pre-fix)
  assert.ok(
    prompt.includes(`You are now starting **Round ${toRound + 1}**`),
    `prompt must contain "Round ${toRound + 1}"`,
  );

  // ── Phase 2: no un-interpolated template literals ─────────────────────────
  assert.ok(
    !prompt.includes("${fromRound}"),
    "prompt must NOT contain literal ${fromRound}",
  );
  assert.ok(
    !prompt.includes("${toRound}"),
    "prompt must NOT contain literal ${toRound}",
  );

  // ── Phase 3: no prescribed git restore command ────────────────────────────
  for (const command of FORBIDDEN_RESTORE_COMMANDS) {
    assert.ok(
      !prompt.includes(command),
      `prompt must NOT prescribe "${command}" — the restore is the agent's action`,
    );
  }

  // ── Phase 4: caller-specified structural markers ──────────────────────────
  for (const sub of expectedSubstrings) {
    assert.ok(
      prompt.includes(sub),
      `prompt must contain "${sub}"`,
    );
  }
}
