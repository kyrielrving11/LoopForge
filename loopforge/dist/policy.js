/** Externalized LoopForge runtime policy. */
import { createHash, randomUUID } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync, } from "node:fs";
import { resolve } from "node:path";
import { containInWorkspace } from "./workspace.js";
/** v3.8.1: the policy schema version. A policy file that does not declare
 *  exactly this version is REJECTED — see loadPolicy. */
export const POLICY_SCHEMA_VERSION = "4";
export const DEFAULT_POLICY = {
    version: POLICY_SCHEMA_VERSION,
    constraints: { retire_window: 3 },
    summary: { window: 5, milestone_interval: 20 },
    engine: { stall_lookback_rounds: 3, max_rounds: 200, enforcement_escalation_enabled: true, backtrack_enabled: true, backtrack_max_depth: 3, backtrack_preserve_discoveries: true, unverified_claim_streak_limit: 3 },
    prompt: {
        l0_max_chars: 3000,
        l1_max_chars: 7000,
        l2_max_chars: 18000,
        l2_pointer_enabled: true,
        max_emphasize_l2: 5,
        max_emphasize_l1: 3,
        max_confusion_points: 3,
    },
    backend: { root_dir: ".loopforge" },
    evolution: {
        max_discovered_constraints_per_round: 5,
        max_active_constraints: 15,
        max_objective_versions: 10,
        progress_stall_threshold: 0.05,
        max_active_subgoals: 12,
    },
    checkpoint: { outcome_max_chars: 200 },
    state_file: {
        enabled: true,
        directory: ".loopforge/state",
    },
    evidence: { providers: ["git"], timeout_ms: 120_000, commands: [] },
    mcp: {
        session_lease_ms: 30_000,
        session_lease_renew_interval_ms: 10_000,
    },
    gate: {
        enabled: false,
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
/** Element keys of the policy's array-of-object fields. An incoming array
 *  REPLACES the default wholesale (the default list is empty), so element keys
 *  are not otherwise checked: a typo inside a command ("enable" for "enabled")
 *  was accepted, and the command then never registered — the loop ran on a
 *  configuration the operator never chose, which is exactly the outcome the
 *  version boundary of v3.8.1 exists to prevent. */
const ARRAY_ELEMENT_KEYS = {
    commands: new Set([
        "name", "enabled", "executable", "args", "cwd", "phase", "required",
        "timeout_ms", "max_output_chars", "success_exit_codes",
    ]),
};
/** Merge a declared policy file over the defaults.
 *
 *  v3.8.1: an unknown key is an ERROR, not a warning. A typo used to be
 *  announced and then ignored, so the loop ran on a value the operator never
 *  set — the one outcome a configuration defect must never produce. */
function deepMerge(defaults, overrides) {
    const result = { ...defaults };
    for (const key of Object.keys(overrides)) {
        const current = result[key];
        const incoming = overrides[key];
        // `Object.hasOwn`, not `in`: the `in` operator also reports keys inherited
        // from Object.prototype, so "constructor" / "__proto__" / "toString" were
        // treated as known keys and merged (or, for "__proto__", replaced this
        // object's prototype) instead of being rejected.
        const known = Object.hasOwn(result, key);
        if (known && current !== null && incoming !== null &&
            typeof current === "object" && !Array.isArray(current) &&
            typeof incoming === "object" && !Array.isArray(incoming)) {
            result[key] = deepMerge(current, incoming);
        }
        else if (known) {
            const elementKeys = Array.isArray(incoming) ? ARRAY_ELEMENT_KEYS[key] : undefined;
            if (elementKeys) {
                for (const item of incoming) {
                    if (typeof item !== "object" || item === null || Array.isArray(item)) {
                        throw new Error(`policy "${key}" entries must be objects — one entry is ` +
                            `${Array.isArray(item) ? "an array" : typeof item}.`);
                    }
                    for (const itemKey of Object.keys(item)) {
                        if (!elementKeys.has(itemKey)) {
                            throw new Error(`unknown policy key "${key}[].${itemKey}" — remove it, or fix ` +
                                "the typo. This release carries no compatibility layer: a " +
                                "config written for an older schema is not a valid config for " +
                                "this one.");
                        }
                    }
                }
            }
            result[key] = incoming;
        }
        else {
            throw new Error(`unknown policy key "${key}" — remove it, or fix the typo. ` +
                "This release carries no compatibility layer: a config written for an " +
                "older schema is not a valid config for this one.");
        }
    }
    return result;
}
/** Load the runtime policy, or fall back to the defaults when no file
 *  declares one.
 *
 *  v3.8.1: the `version` field is load-bearing. Previously it was a
 *  declarative string that NOTHING read, so a policy written for an older
 *  schema was silently merged over the current defaults — options that no
 *  longer exist evaporated and options that changed meaning were applied
 *  under their old name. Now a file either declares the current schema
 *  version or the load fails, and the failure surfaces as `policy_invalid`
 *  rather than the loop running on a configuration nobody chose.
 *
 *  A MISSING or unparseable file still falls through to the defaults (running
 *  with no policy file is normal). A file that exists and parses is a
 *  declaration, so its defects propagate instead of being swallowed. */
export function loadPolicy(path) {
    const candidates = [path, "loop_policy.json"].filter(Boolean);
    for (const candidate of candidates) {
        let raw;
        try {
            raw = JSON.parse(readFileSync(resolve(candidate), "utf8"));
        }
        catch {
            continue; // absent or unreadable — try the next candidate
        }
        if (!raw || typeof raw !== "object" || Array.isArray(raw))
            continue;
        const version = raw.version;
        if (version !== POLICY_SCHEMA_VERSION) {
            throw new Error(`policy version ${JSON.stringify(version)} does not match the current ` +
                `schema version "${POLICY_SCHEMA_VERSION}". Update the file; there is ` +
                "no migration path.");
        }
        return deepMerge(DEFAULT_POLICY, raw);
    }
    return structuredClone(DEFAULT_POLICY);
}
let policy = null;
export function getPolicy(path) {
    // Explicit path: always (re)load from that file.
    // No path: cache the default lookup so loadPolicy only runs once.
    if (path)
        return loadPolicy(path);
    policy ??= loadPolicy();
    return policy;
}
export function resetPolicy() {
    policy = null;
}
/** v3.2: Test-only injection — mirrors resetPolicy so tests can exercise a
 *  specific policy configuration (e.g. state_file.enabled=false). */
export function setPolicyForTest(next) {
    policy = next;
}
/** v3.8: Deterministic hash of a command's verification configuration. Used
 *  to prove that a contract's bound command did not change under the agent
 *  between declaration and closure. `args` order is preserved (semantically
 *  meaningful); `success_exit_codes` is sorted (an equivalent set must hash
 *  equal). Pure — no I/O, no probing. */
export function commandConfigHash(config) {
    const normalized = {
        name: config.name,
        executable: config.executable,
        args: [...config.args],
        cwd: config.cwd ?? ".",
        phase: config.phase,
        required: config.required === true,
        timeout_ms: config.timeout_ms,
        max_output_chars: config.max_output_chars,
        success_exit_codes: [...config.success_exit_codes].sort((a, b) => a - b),
    };
    return createHash("sha256").update(stableStringifyPolicy(normalized)).digest("hex");
}
/** Stable JSON: object keys sorted recursively, so a key-order change never
 *  changes the hash. Arrays keep their order. */
function stableStringifyPolicy(value) {
    if (value === null || typeof value !== "object")
        return JSON.stringify(value) ?? "null";
    if (Array.isArray(value)) {
        return `[${value.map((item) => stableStringifyPolicy(item)).join(",")}]`;
    }
    const entries = Object.entries(value)
        .filter(([, item]) => item !== undefined)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${stableStringifyPolicy(item)}`).join(",")}}`;
}
/** v3.8: Static verification capability — a pure function of policy, so it is
 *  byte-identical across retries of the same round and reproducible by
 *  replay/audit from committed facts. It contains NO probing, no filesystem
 *  access, and no provider-registry state; readiness of the runtime
 *  environment is a `doctor` concern, not a hashed fact. */
export function deriveConfiguredCapability(policy) {
    const providers = (Array.isArray(policy.evidence?.providers) ? policy.evidence.providers : [])
        .filter((name) => typeof name === "string" && name.trim().length > 0)
        .map((providerId) => ({ providerId }));
    const commands = (Array.isArray(policy.evidence?.commands) ? policy.evidence.commands : [])
        .map((command) => ({
        commandId: command.name,
        enabled: command.enabled === true,
        phase: command.phase === "both" ? "both" : "after",
        required: command.required === true,
        configHash: commandConfigHash(command),
    }));
    return {
        schemaVersion: 1,
        providers,
        commands,
        observationConfigured: providers.length > 0,
        // Every configured command runs in the after phase ("after" or "both"),
        // so an enabled command is exactly what makes contract verification
        // possible.
        contractVerificationAvailable: commands.some((command) => command.enabled),
    };
}
/** v3.3/v3.8: Whether a command name may back a Round Contract item. A
 *  contract item is verified by an AFTER-phase observation, so the predicate
 *  requires configured AND enabled AND after-capable — `verify_with` may only
 *  reference a command the runtime can actually observe at closure time.
 *
 *  `CommandEvidencePolicy.phase` is `"after" | "both"` today, so the phase arm
 *  is currently self-satisfying; it is stated explicitly because it is the
 *  boundary the contract declaration is judged against, not an accident of
 *  the current phase enum. */
export function isConfiguredCommand(name) {
    const commands = getPolicy().evidence?.commands ?? [];
    return commands.some((c) => c.enabled && c.name === name && (c.phase === "after" || c.phase === "both"));
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
    // v3.3.1: delegated to the single shared containment check (workspace.ts).
    // Behavior note: an EXISTING configured directory now resolves through
    // symlinks to its real location (the old implementation returned the
    // lexical path) — writes can never land behind the workspace's back via a
    // symlinked alias. Absent first-run directories keep the lexical path.
    return containInWorkspace(workspaceRoot, configuredDirectory);
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
    // v3.3.1: the double resolveStateDirectory call was redundant — the
    // containment check is pure; one resolution serves mkdir, target, tmp.
    const target = resolve(directory, `${loopId}-state.md`);
    if (existsSync(target) && lstatSync(target).isSymbolicLink()) {
        throw new Error("State file target must not be a symbolic link");
    }
    const temporary = resolve(directory, `.${loopId}-state.${process.pid}.${randomUUID()}.tmp`);
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