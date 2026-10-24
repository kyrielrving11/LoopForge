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
    /** Installed files, relative to `skillDir`, sorted for deterministic output. */
    files: string[];
    registration: string | Record<string, unknown>;
}
export declare function initializeClient(options: InitOptions): InitResult;
//# sourceMappingURL=init.d.ts.map