/** Client-specific skill onboarding. */
export type InitClient = "claude" | "codex" | "generic";
export interface InitOptions {
    client: InitClient;
    force?: boolean;
    target?: string;
    register?: boolean;
    workspaceRoot?: string;
    storeDir?: string;
}
export interface InitResult {
    client: InitClient;
    skillPath: string;
    installed: boolean;
    registration: string | Record<string, unknown>;
    registered: boolean;
    registrationVerified: boolean;
    warnings: string[];
}
export declare function removeManagedLegacySkillFile(pathInput: string, warnings: string[], managedDigests?: ReadonlySet<string>): void;
export declare function initializeClient(options: InitOptions): InitResult;
//# sourceMappingURL=init.d.ts.map