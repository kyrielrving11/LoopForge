/** Client-specific skill onboarding. */
export type InitClient = "claude" | "codex" | "generic";
export interface InitOptions {
    client: InitClient;
    force?: boolean;
    target?: string;
}
export interface InitResult {
    client: InitClient;
    skillPath: string;
    installed: boolean;
    registration: string | Record<string, unknown>;
}
export declare function initializeClient(options: InitOptions): InitResult;
//# sourceMappingURL=init.d.ts.map