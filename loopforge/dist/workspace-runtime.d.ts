import type { StoreResolutionDiagnostic, WorkspaceBinding, WorkspaceRuntimeSummary } from "./protocol.js";
export interface WorkspaceResolution {
    root: string;
    source: "explicit" | "git_root" | "cwd_legacy";
    warning?: string;
    id: string;
    fingerprint: string;
}
export interface ResolvedWorkspaceRuntime {
    workspace: WorkspaceResolution;
    storeRoot: string;
}
export declare function resolveWorkspace(explicit?: string): WorkspaceResolution;
export declare function resolveStoreRoot(workspaceRoot: string, storeDir?: string): string;
export declare function storeId(root: string): string;
interface LocatorEntry {
    workspaceId: string;
    workspaceRoot: string;
    workspaceFingerprint: string;
    storeId: string;
    storeRoot: string;
    lastSeenAt: string;
}
export declare class StoreLocator {
    readonly path: string;
    constructor(path?: string);
    private entries;
    remember(binding: WorkspaceBinding): string | undefined;
    candidates(workspaceId: string): LocatorEntry[];
}
export declare class WorkspaceRuntime {
    private binding;
    private source;
    readonly locator: StoreLocator;
    private readonly runtimeWarnings;
    constructor(prebind?: {
        workspaceRoot?: string;
        storeDir?: string;
    }, locator?: StoreLocator);
    get isBound(): boolean;
    get warnings(): string[];
    warn(message: string): void;
    get currentBinding(): WorkspaceBinding | null;
    summary(status?: WorkspaceRuntimeSummary["bindingStatus"]): WorkspaceRuntimeSummary;
    resolve(workspaceRoot?: string, storeDir?: string): ResolvedWorkspaceRuntime;
    bind(workspaceRoot?: string, storeDir?: string): WorkspaceBinding;
    bindResolved(resolved: ResolvedWorkspaceRuntime): WorkspaceBinding;
    assertCompatible(binding: unknown): boolean;
    recordRelocation(previousStoreRoot: string): void;
    diagnostic(code: StoreResolutionDiagnostic["code"], warnings?: string[], matches?: StoreResolutionDiagnostic["matches"]): StoreResolutionDiagnostic;
}
export {};
//# sourceMappingURL=workspace-runtime.d.ts.map