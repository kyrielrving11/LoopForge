/** Client-specific skill onboarding. */
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
/** v4.0.4: does every packaged skill file exist in `destDir` with identical
 *  bytes? Extra files in the destination are user state and are ignored, so a
 *  local note never makes the package-owned tree look stale. */
export declare function installedSkillIsCurrent(destDir: string): boolean;
/** Read-only inspection for `doctor`. Returns null when no skill is installed
 *  at `destDir`; never copies or repairs anything. */
export declare function inspectInstalledSkill(destDir: string): "current" | "stale" | null;
export declare function initializeClient(options: InitOptions): InitResult;
//# sourceMappingURL=init.d.ts.map