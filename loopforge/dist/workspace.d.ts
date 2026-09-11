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
export declare function containInWorkspace(workspace: string, target: string): string;
/** v3.8.1: the Contract scope-entry check, in the module that owns workspace
 *  containment.
 *
 *  It lives here rather than in the MCP transport because it is a filesystem
 *  fact about the running process, not a property of the payload: the strict
 *  contract boundary injects it so a declared scope entry that escapes the
 *  workspace is rejected pre-advance. Returns the reason when the entry
 *  escapes, null when it is contained. */
export declare function scopeEntryDetail(entry: string): string | null;
//# sourceMappingURL=workspace.d.ts.map