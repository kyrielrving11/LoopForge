import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { execFileSync } from "node:child_process";
import type { StoreResolutionDiagnostic, WorkspaceBinding, WorkspaceRuntimeSummary } from "./protocol.js";
import { LOOPFORGE_VERSION } from "./version.js";

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

function canonical(path: string): string {
  const value = resolve(path);
  if (!existsSync(value)) throw new Error(`workspace/store path does not exist: ${value}`);
  return realpathSync(value);
}

function normalized(path: string): string {
  return canonical(path).replace(/[\\/]+$/, "").toLowerCase();
}

function isBroadRoot(path: string): boolean {
  const root = resolve(path);
  const home = resolve(homedir());
  const parsedRoot = resolve(root, sep);
  return normalized(root) === normalized(parsedRoot) || normalized(root) === normalized(home);
}

function gitValue(root: string, args: string[]): string {
  try {
    return execFileSync("git", ["-C", root, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch { return ""; }
}

export function resolveWorkspace(explicit?: string): WorkspaceResolution {
  const cwd = canonical(process.cwd());
  const candidate = explicit
    ? canonical(explicit)
    : (() => {
        const gitRoot = gitValue(cwd, ["rev-parse", "--show-toplevel"]);
        return gitRoot && existsSync(gitRoot) ? canonical(gitRoot) : cwd;
      })();
  if (!statSync(candidate).isDirectory()) throw new Error("workspaceRoot must be an existing directory");
  if (isBroadRoot(candidate)) throw new Error("workspaceRoot must not be a filesystem or user home root");
  const source = explicit ? "explicit" : (gitValue(cwd, ["rev-parse", "--show-toplevel"]) ? "git_root" : "cwd_legacy");
  return {
    root: candidate,
    source,
    warning: source === "cwd_legacy" ? "No Git root found; workspace resolved from process CWD and was not persisted as a locator." : undefined,
    id: createHash("sha256").update(normalized(candidate)).digest("hex").slice(0, 32),
    fingerprint: createHash("sha256").update(`${normalized(candidate)}\n${normalized(gitValue(candidate, ["rev-parse", "--show-toplevel"]) || candidate)}\n${gitValue(candidate, ["config", "--get", "remote.origin.url"])}`).digest("hex"),
  };
}

export function resolveStoreRoot(workspaceRoot: string, storeDir?: string): string {
  const root = canonical(workspaceRoot);
  const relativeStore = storeDir !== undefined && !isAbsolute(storeDir);
  const chosen = storeDir
    ? (isAbsolute(storeDir) ? resolve(storeDir) : resolve(root, storeDir))
    : resolve(root, ".loopforge");
  if (relativeStore) {
    const rel = relative(root, chosen);
    if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
      throw new Error("relative storeDir must stay within workspaceRoot; use an explicit absolute path for an external Store");
    }
  }
  if (existsSync(chosen) && !statSync(chosen).isDirectory()) throw new Error("storeDir must be a directory");
  if (!existsSync(chosen)) mkdirSync(chosen, { recursive: true });
  const actual = canonical(chosen);
  if (relativeStore) {
    const rel = relative(root, actual);
    if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
      throw new Error("relative storeDir resolves outside workspaceRoot; use an explicit absolute path for an external Store");
    }
  }
  return actual;
}

function configuredStoreDir(workspaceRoot: string): string {
  try {
    const raw = JSON.parse(readFileSync(resolve(workspaceRoot, "loop_policy.json"), "utf8"));
    const value = raw?.backend?.root_dir;
    return typeof value === "string" && value.trim() ? value : ".loopforge";
  } catch { return ".loopforge"; }
}

export function storeId(root: string): string {
  return createHash("sha256").update(normalized(root)).digest("hex").slice(0, 32);
}

interface LocatorEntry { workspaceId: string; workspaceRoot: string; workspaceFingerprint: string; storeId: string; storeRoot: string; lastSeenAt: string; }

export class StoreLocator {
  constructor(readonly path = resolve(homedir(), ".loopforge", "store-index.json")) {}
  private entries(): LocatorEntry[] {
    try { const raw = JSON.parse(readFileSync(this.path, "utf8")); return Array.isArray(raw?.entries) ? raw.entries.filter((x: unknown): x is LocatorEntry => Boolean(x && typeof x === "object")) : []; } catch { return []; }
  }
  remember(binding: WorkspaceBinding): string | undefined {
    const lock = `${this.path}.lock`;
    const owner = joinPath(lock, "owner.json");
    const token = randomUUID();
    try {
      mkdirSync(dirname(this.path), { recursive: true });
      try { mkdirSync(lock); }
      catch (error) {
        let stale = false;
        try {
          const prior = JSON.parse(readFileSync(owner, "utf8"));
          const age = Date.now() - statSync(lock).mtimeMs;
          if (age > 10_000 && typeof prior.pid === "number") {
            try { process.kill(prior.pid, 0); } catch { stale = true; }
          }
        } catch { stale = false; }
        if (!stale) throw error;
        rmSync(lock, { recursive: true });
        mkdirSync(lock);
      }
      writeFileSync(owner, JSON.stringify({ token, pid: process.pid, createdAt: Date.now() }), "utf8");
      const current = this.entries().filter((entry) => entry.storeId !== binding.storeId || entry.workspaceId !== binding.workspaceId);
      current.unshift({ workspaceId: binding.workspaceId, workspaceRoot: binding.workspaceRoot, workspaceFingerprint: binding.workspaceFingerprint, storeId: binding.storeId, storeRoot: binding.storeRoot, lastSeenAt: new Date().toISOString() });
      const tmp = `${this.path}.tmp-${process.pid}`;
      writeFileSync(tmp, JSON.stringify({ schemaVersion: 1, entries: current.slice(0, 64) }, null, 2), "utf8");
      renameSync(tmp, this.path);
    } catch (error) { return `Store locator unavailable: ${String(error)}`; }
    finally {
      try {
        const current = JSON.parse(readFileSync(owner, "utf8"));
        if (current.token === token) rmSync(lock, { recursive: true });
      } catch { /* never remove an unowned locator lock */ }
    }
    return undefined;
  }
  candidates(workspaceId: string): LocatorEntry[] { return this.entries().filter((entry) => entry.workspaceId === workspaceId); }
}

function joinPath(...parts: string[]): string {
  return resolve(...parts);
}

export class WorkspaceRuntime {
  private binding: WorkspaceBinding | null = null;
  private source: WorkspaceResolution["source"] | null = null;
  readonly locator: StoreLocator;
  private readonly runtimeWarnings: string[] = [];

  constructor(prebind?: { workspaceRoot?: string; storeDir?: string }, locator = new StoreLocator()) {
    this.locator = locator;
    if (prebind?.workspaceRoot) this.bind(prebind.workspaceRoot, prebind.storeDir);
  }

  get isBound(): boolean { return this.binding !== null; }
  get warnings(): string[] { return [...this.runtimeWarnings]; }
  warn(message: string): void {
    if (!this.runtimeWarnings.includes(message)) this.runtimeWarnings.push(message);
  }
  get currentBinding(): WorkspaceBinding | null { return this.binding ? { ...this.binding, previousStoreRoots: [...this.binding.previousStoreRoots] } : null; }
  summary(status?: WorkspaceRuntimeSummary["bindingStatus"]): WorkspaceRuntimeSummary {
    return { serverVersion: LOOPFORGE_VERSION, bindingStatus: status ?? (this.binding ? "bound" : "unbound"), workspaceId: this.binding?.workspaceId ?? null, workspaceRoot: this.binding?.workspaceRoot ?? null, workspaceFingerprint: this.binding?.workspaceFingerprint ?? null, storeId: this.binding?.storeId ?? null, storeRoot: this.binding?.storeRoot ?? null, bindingSource: this.source };
  }
  resolve(workspaceRoot?: string, storeDir?: string): ResolvedWorkspaceRuntime {
    const workspace = resolveWorkspace(workspaceRoot);
    return { workspace, storeRoot: resolveStoreRoot(workspace.root, storeDir ?? configuredStoreDir(workspace.root)) };
  }
  bind(workspaceRoot?: string, storeDir?: string): WorkspaceBinding {
    return this.bindResolved(this.resolve(workspaceRoot, storeDir));
  }
  bindResolved(resolved: ResolvedWorkspaceRuntime): WorkspaceBinding {
    const next: WorkspaceBinding = { schemaVersion: 1, workspaceId: resolved.workspace.id, workspaceRoot: resolved.workspace.root, workspaceFingerprint: resolved.workspace.fingerprint, storeId: storeId(resolved.storeRoot), storeRoot: resolved.storeRoot, previousStoreRoots: this.binding?.previousStoreRoots ?? [], boundAt: new Date().toISOString() };
    if (this.binding) {
      if (this.binding.workspaceId !== next.workspaceId) throw new Error("workspace_already_bound: workspace cannot be switched in a running MCP process");
      if (this.binding.storeId !== next.storeId) throw new Error("workspace_already_bound: store cannot be switched in a running MCP process; restart MCP with the requested storeDir");
    }
    this.binding = next;
    this.source = resolved.workspace.source;
    const warning = resolved.workspace.source === "cwd_legacy" ? resolved.workspace.warning : this.locator.remember(next);
    if (warning) {
      this.warn(warning);
      process.stderr.write(`[loopforge] WARN ${warning}\n`);
    }
    return next;
  }
  assertCompatible(binding: unknown): boolean {
    if (!binding || typeof binding !== "object") return false;
    const value = binding as Partial<WorkspaceBinding>;
    return value.workspaceId === this.binding?.workspaceId;
  }
  recordRelocation(previousStoreRoot: string): void {
    if (!this.binding || resolve(previousStoreRoot).toLowerCase() === resolve(this.binding.storeRoot).toLowerCase()) return;
    this.binding.previousStoreRoots = [resolve(previousStoreRoot), ...this.binding.previousStoreRoots]
      .filter((path, index, all) => all.indexOf(path) === index)
      .slice(0, 5);
  }
  diagnostic(code: StoreResolutionDiagnostic["code"], warnings: string[] = [], matches: StoreResolutionDiagnostic["matches"] = []): StoreResolutionDiagnostic {
    const current = this.summary(code === "workspace_mismatch" ? "mismatch" : undefined);
    const searchedStores = this.binding ? [{ storeRoot: this.binding.storeRoot, storeId: this.binding.storeId, exists: existsSync(this.binding.storeRoot) }] : [];
    return { code, current, searchedStores, matches, orphanMarkdownPaths: [], recommendation: null, warnings };
  }
}
