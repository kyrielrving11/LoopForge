/** Workspace containment — the single lexical + realpath boundary check.
 *
 * Every path that must stay inside the loop workspace (the state-file
 * directory, evidence command cwds and entrypoint files, CLI targets)
 * used to carry its own copy of the double check — four implementations
 * whose semantics drifted (whether absent paths are allowed, whether the
 * symlink-resolved path is returned). Containment is a trust boundary
 * (it gates command execution and file writes), so drift there is a
 * vulnerability window, not a style issue. This module is the one copy.
 *
 * Zero internal dependencies — safe to import from policy, the evidence
 * providers, and the CLI alike.
 */

import { existsSync, realpathSync } from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";

/** Resolve `target` against the workspace with a double containment check:
 *  a lexical check first, then a realpath check. The realpath half walks up
 *  to the nearest EXISTING ancestor before resolving, so a not-yet-created
 *  child of a symlinked directory (a first-run state directory) is still
 *  checked for escape instead of silently trusting the symlink.
 *
 *  Returns the symlink-RESOLVED path when the target exists — writes
 *  through a symlinked alias land on the real location, never behind the
 *  workspace's back — and the lexical path when it does not exist yet.
 *
 *  Throws when either the lexical or the resolved path leaves the
 *  workspace. The workspace itself is realpath'd first, so callers may pass
 *  the process cwd without pre-resolving it.
 */
export function containInWorkspace(workspace: string, target: string): string {
  const realWorkspace = realpathSync(workspace);
  const lexical = resolve(realWorkspace, target);
  const lexicalRelative = relative(realWorkspace, lexical);
  if (
    lexicalRelative === ".." || lexicalRelative.startsWith(`..${sep}`) ||
    isAbsolute(lexicalRelative)
  ) {
    throw new Error("path leaves the workspace");
  }
  // Walk up to the nearest EXISTING ancestor whether or not the target
  // itself exists: an absent child of an escaping symlinked directory must
  // be caught just like the directory itself (the old early return for
  // absent paths skipped this half of the check entirely).
  let ancestor = lexical;
  while (!existsSync(ancestor)) {
    const parent = resolve(ancestor, "..");
    if (parent === ancestor) break;
    ancestor = parent;
  }
  if (ancestor === lexical && !existsSync(lexical)) {
    // The whole chain is absent — no symlink exists to resolve through.
    return lexical;
  }
  const projected = resolve(realpathSync(ancestor), relative(ancestor, lexical));
  const realRelative = relative(realWorkspace, projected);
  if (
    realRelative === ".." || realRelative.startsWith(`..${sep}`) ||
    isAbsolute(realRelative)
  ) {
    throw new Error("path resolves outside the workspace");
  }
  return projected;
}
