/** Externalized LoopForge runtime policy. */
import { randomUUID } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync, } from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";
export const DEFAULT_POLICY = {
    version: "2",
    constraints: { retire_window: 3 },
    summary: { window: 5, health_check_interval: 1 },
    engine: { feedback_flush_interval: 5, max_circuit_breaker: 3, max_rounds: 20 },
    prompt: {
        injection_mode: "adaptive",
        full_refresh_interval: 5,
        l0_max_chars: 3000,
        l1_max_chars: 7000,
        l2_max_chars: 18000,
        base_prompt_version: "2.0.0",
    },
    backend: { root_dir: ".loopforge" },
    evolution: {
        max_discovered_constraints_per_round: 5,
        max_active_constraints: 15,
        max_objective_versions: 10,
        progress_stall_threshold: 0.05,
        progress_stall_rounds: 2,
        progress_mismatch_threshold: 0.3,
    },
    checkpoint: { max_carried_constraints: 10, outcome_max_chars: 200 },
    state_file: {
        enabled: true,
        directory: ".loopforge/state",
        max_checkpoints: 5,
        max_summary_rounds: 5,
    },
    evidence: { providers: ["git"], timeout_ms: 120_000, commands: [] },
    mcp: {
        session_lease_ms: 30_000,
        session_lease_renew_interval_ms: 10_000,
    },
};
/** Write a full default `loop_policy.json` to the target directory.
 *
 *  The written file contains every configurable key and its default value
 *  so users can discover and tune the system without reading source code.
 *  Skip creation when the file already exists unless `force` is true.
 *
 * @returns The resolved file path and whether it was freshly created.
 */
export function writeDefaultPolicy(targetDir, force = false) {
    const target = resolve(targetDir, "loop_policy.json");
    if (existsSync(target) && !force) {
        return { path: target, created: false };
    }
    writeFileSync(target, JSON.stringify(DEFAULT_POLICY, null, 2) + "\n", "utf8");
    return { path: target, created: true };
}
function deepMerge(defaults, overrides) {
    const result = { ...defaults };
    for (const key of Object.keys(overrides)) {
        const current = result[key];
        const incoming = overrides[key];
        if (key in result && current !== null && incoming !== null &&
            typeof current === "object" && !Array.isArray(current) &&
            typeof incoming === "object" && !Array.isArray(incoming)) {
            result[key] = deepMerge(current, incoming);
        }
        else if (key in result) {
            // Unknown legacy keys are deliberately ignored at the 2.0 boundary.
            result[key] = incoming;
        }
    }
    return result;
}
export function loadPolicy(path) {
    const candidates = [path, "loop_policy.json"].filter(Boolean);
    for (const candidate of candidates) {
        try {
            const raw = JSON.parse(readFileSync(resolve(candidate), "utf8"));
            if (raw && typeof raw === "object" && !Array.isArray(raw)) {
                return deepMerge(DEFAULT_POLICY, raw);
            }
        }
        catch {
            // Try the next candidate.
        }
    }
    return structuredClone(DEFAULT_POLICY);
}
let policy = null;
export function getPolicy(path) {
    policy ??= loadPolicy(path);
    return policy;
}
export function resetPolicy() {
    policy = null;
}
const LOOP_ID_RE = /^[a-zA-Z0-9][-a-zA-Z0-9_:.]{0,127}$/;
export function validateLoopId(loopId) {
    if (typeof loopId !== "string" || !loopId) {
        throw new Error("Invalid loopId: must be a non-empty string");
    }
    if (loopId.includes(".."))
        throw new Error('Invalid loopId: ".." is not allowed');
    if (loopId.includes("/") || loopId.includes("\\")) {
        throw new Error("Invalid loopId: path separators are not allowed");
    }
    if (!LOOP_ID_RE.test(loopId)) {
        throw new Error("Invalid loopId: use at most 128 alphanumeric, hyphen, underscore, colon, or dot characters");
    }
}
export function resolveStateDirectory(workspaceRoot, configuredDirectory) {
    const lexicalRoot = resolve(workspaceRoot);
    const lexicalTarget = resolve(lexicalRoot, configuredDirectory);
    const lexicalRelative = relative(lexicalRoot, lexicalTarget);
    if (lexicalRelative === ".." || lexicalRelative.startsWith(`..${sep}`) ||
        isAbsolute(lexicalRelative)) {
        throw new Error("State file directory must stay within the workspace");
    }
    const realRoot = realpathSync(lexicalRoot);
    let ancestor = lexicalTarget;
    while (!existsSync(ancestor)) {
        const parent = resolve(ancestor, "..");
        if (parent === ancestor)
            break;
        ancestor = parent;
    }
    const projected = resolve(realpathSync(ancestor), relative(ancestor, lexicalTarget));
    const realRelative = relative(realRoot, projected);
    if (realRelative === ".." || realRelative.startsWith(`..${sep}`) ||
        isAbsolute(realRelative)) {
        throw new Error("State file directory resolves outside the workspace");
    }
    return lexicalTarget;
}
export function writeStateFile(loopId, content) {
    if (!content)
        return;
    validateLoopId(loopId);
    const config = getPolicy().state_file;
    if (!config.enabled)
        return;
    const directory = resolveStateDirectory(process.cwd(), config.directory);
    mkdirSync(directory, { recursive: true });
    const verifiedDirectory = resolveStateDirectory(process.cwd(), config.directory);
    const target = resolve(verifiedDirectory, `${loopId}-state.md`);
    if (existsSync(target) && lstatSync(target).isSymbolicLink()) {
        throw new Error("State file target must not be a symbolic link");
    }
    const temporary = resolve(verifiedDirectory, `.${loopId}-state.${process.pid}.${randomUUID()}.tmp`);
    try {
        writeFileSync(temporary, content, "utf8");
        renameSync(temporary, target);
    }
    finally {
        try {
            rmSync(temporary, { force: true });
        }
        catch { /* best effort */ }
    }
}
//# sourceMappingURL=policy.js.map