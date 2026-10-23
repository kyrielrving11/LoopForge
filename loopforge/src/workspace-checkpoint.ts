/** Workspace checkpoints: content-addressed recovery material.
 *
 * A checkpoint is NOT history and NOT progress. It is the before-image of a
 * transaction (role `before`) or an Agent-created savepoint (role `mid`).
 * The manifest records the exact Git boundary; blobs hold only the content
 * HEAD cannot reproduce (dirty/untracked regular files and symlinks). The
 * transaction snapshot's `CheckpointRef` is the authority for visibility,
 * ownership and the redo round.
 */

import { createHash, randomUUID } from "node:crypto";
import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import type {
  CheckpointRef,
  CheckpointRole,
  WorkspaceCheckpointManifest,
} from "./protocol.js";
import { captureBoundary } from "./git-boundary.js";
import type {
  BoundaryCapture,
  BoundaryMaterializer,
} from "./git-boundary.js";
import { isRecord } from "./token-utils.js";

export const CHECKPOINT_SCHEMA_VERSION = 1 as const;
export const CHECKPOINT_ID_RE = /^ck-[a-f0-9]{24}$/;
export const CONTENT_HASH_RE = /^[a-f0-9]{64}$/;

/** Module constants, not policy knobs. A checkpoint that exceeds them is
 *  explicitly unavailable; the boundary is never truncated. */
export const CHECKPOINT_MAX_PATHS = 200_000;
export const CHECKPOINT_MAX_NEW_BYTES = 1024 * 1024 * 1024;

export class CheckpointError extends Error {
  constructor(
    readonly code:
      | "checkpoint_invalid"
      | "checkpoint_unavailable"
      | "checkpoint_failed"
      | "checkpoint_limit",
    readonly reasonCode: string,
    message: string,
  ) {
    super(message);
    this.name = "CheckpointError";
  }
}

function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

/** Deterministic JSON for the content hash. Only the restore-relevant fields
 *  are covered; `createdAt`/`dirty` are metadata and never authoritative.
 *  JSON encoding makes newline/NUL-containing Git paths unambiguous. */
export function checkpointContentHash(input: {
  head?: string;
  fingerprints: Record<string, string>;
  contents: string[];
  coverage: "tracked_and_non_ignored_untracked";
}): string {
  const fingerprintKeys = Object.keys(input.fingerprints).sort();
  const payload = JSON.stringify({
    schemaVersion: CHECKPOINT_SCHEMA_VERSION,
    head: input.head ?? null,
    coverage: input.coverage,
    fingerprints: fingerprintKeys.map((key) => [key, input.fingerprints[key]]),
    contents: [...input.contents].sort(),
  });
  return sha256(payload);
}

export function deriveCheckpointId(input: {
  loopId: string;
  round: number;
  role: CheckpointRole;
  contentHash: string;
}): string {
  return `ck-${sha256(
    `${input.loopId}\n${input.round}\n${input.role}\n${input.contentHash}`,
  ).slice(0, 24)}`;
}

/** Validate a persisted manifest without trusting arbitrary disk data. */
export function parseCheckpointManifest(value: unknown): WorkspaceCheckpointManifest | null {
  if (!isRecord(value)) return null;
  if (value.schemaVersion !== CHECKPOINT_SCHEMA_VERSION) return null;
  if (typeof value.checkpointId !== "string" ||
      !CHECKPOINT_ID_RE.test(value.checkpointId)) return null;
  if (typeof value.loopId !== "string" || value.loopId.length === 0) return null;
  if (!Number.isInteger(value.round) || (value.round as number) < 1) return null;
  if (value.role !== "before" && value.role !== "mid") return null;
  if (typeof value.createdAt !== "number") return null;
  if (value.head !== undefined && typeof value.head !== "string") return null;
  if (!Array.isArray(value.dirty) ||
      !value.dirty.every((item) => typeof item === "string")) return null;
  if (!isRecord(value.fingerprints) ||
      !Object.values(value.fingerprints).every((item) => typeof item === "string")) {
    return null;
  }
  if (!Array.isArray(value.contents) ||
      !value.contents.every((item) => typeof item === "string")) return null;
  if (value.coverage !== "tracked_and_non_ignored_untracked") return null;
  if (typeof value.contentHash !== "string" ||
      !CONTENT_HASH_RE.test(value.contentHash)) return null;
  const manifest = value as unknown as WorkspaceCheckpointManifest;
  const recomputedHash = checkpointContentHash({
    ...(manifest.head ? { head: manifest.head } : {}),
    fingerprints: manifest.fingerprints,
    contents: manifest.contents,
    coverage: manifest.coverage,
  });
  if (recomputedHash !== manifest.contentHash) return null;
  const recomputedId = deriveCheckpointId({
    loopId: manifest.loopId,
    round: manifest.round,
    role: manifest.role,
    contentHash: manifest.contentHash,
  });
  if (recomputedId !== manifest.checkpointId) return null;
  const paths = new Set(Object.keys(manifest.fingerprints));
  const seen = new Set<string>();
  for (const path of manifest.contents) {
    if (!paths.has(path) || seen.has(path)) return null;
    const fingerprint = manifest.fingerprints[path];
    if (!/^(link:[a-f0-9]{64}|[0-9]+:[a-f0-9]{64})$/.test(fingerprint)) return null;
    seen.add(path);
  }
  return manifest;
}

function atomicWriteFile(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true });
  const temp = `${path}.tmp.${randomUUID().slice(0, 12)}`;
  const fd = openSync(temp, "w", 0o600);
  try {
    writeFileSync(fd, content, "utf8");
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  try {
    renameSync(temp, path);
  } catch (error) {
    try { rmSync(temp, { force: true }); } catch { /* best effort */ }
    throw error;
  }
}

/** Per-loop content-addressed checkpoint store.
 *
 *  Layout (under the loop's runtime directory):
 *    checkpoints/<checkpointId>/manifest.json
 *    objects/<sha256>
 *
 *  The store must live under the runtime state directory (or outside the
 *  workspace), so its writes never enter the Git boundary. */
export class FileWorkspaceCheckpointStore implements BoundaryMaterializer {
  readonly checkpointsDir: string;
  readonly objectsDir: string;
  private newBytes = 0;

  constructor(
    readonly loopDir: string,
    readonly loopId: string,
  ) {
    this.checkpointsDir = join(loopDir, "checkpoints");
    this.objectsDir = join(loopDir, "objects");
  }

  hasBlob(hash: string): boolean {
    return existsSync(this.blobPath(hash));
  }

  tempPath(): string {
    mkdirSync(this.objectsDir, { recursive: true });
    return join(this.objectsDir, `.tmp-${randomUUID().replace(/-/g, "")}`);
  }

  commitBlob(hash: string, tempPath: string): void {
    if (!CONTENT_HASH_RE.test(hash)) {
      this.discardTemp(tempPath);
      throw new CheckpointError("checkpoint_failed", "invalid_blob_hash", `invalid blob hash ${hash}`);
    }
    const target = this.blobPath(hash);
    if (existsSync(target)) {
      this.discardTemp(tempPath);
      return;
    }
    // Durability: the content was streamed by the boundary capture; fsync the
    // temporary file before publishing the content-addressed name.
    const fd = openSync(tempPath, "r+");
    try {
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    const size = statSync(tempPath).size;
    this.newBytes += size;
    if (this.newBytes > CHECKPOINT_MAX_NEW_BYTES) {
      this.discardTemp(tempPath);
      throw new CheckpointError(
        "checkpoint_limit",
        "content_too_large",
        `checkpoint content exceeds ${CHECKPOINT_MAX_NEW_BYTES} bytes`,
      );
    }
    try {
      renameSync(tempPath, target);
    } catch (error) {
      // A concurrent capture may have published the same content first.
      if (existsSync(target)) {
        this.discardTemp(tempPath);
        return;
      }
      this.discardTemp(tempPath);
      throw error;
    }
  }

  discardTemp(tempPath: string): void {
    try { rmSync(tempPath, { force: true }); } catch { /* best effort */ }
  }

  blobPath(hash: string): string {
    return join(this.objectsDir, hash);
  }

  manifestPath(checkpointId: string): string {
    return join(this.checkpointsDir, checkpointId, "manifest.json");
  }

  readManifest(checkpointId: string): WorkspaceCheckpointManifest | null {
    if (!CHECKPOINT_ID_RE.test(checkpointId)) return null;
    const path = this.manifestPath(checkpointId);
    if (!existsSync(path)) return null;
    let raw: unknown;
    try {
      raw = JSON.parse(readFileSync(path, "utf8"));
    } catch {
      return null;
    }
    const manifest = parseCheckpointManifest(raw);
    if (!manifest || manifest.checkpointId !== checkpointId ||
        manifest.loopId !== this.loopId) return null;
    return manifest;
  }

  writeManifest(manifest: WorkspaceCheckpointManifest): void {
    const path = this.manifestPath(manifest.checkpointId);
    if (existsSync(path)) {
      const existing = this.readManifest(manifest.checkpointId);
      if (!existing || existing.contentHash !== manifest.contentHash) {
        throw new CheckpointError(
          "checkpoint_failed",
          "manifest_conflict",
          `checkpoint ${manifest.checkpointId} exists with different content`,
        );
      }
      return;
    }
    atomicWriteFile(path, JSON.stringify(manifest, null, 2));
  }

  /** Capture a checkpoint using the shared Git boundary. The boundary's
   *  fingerprints are exactly the manifest's fingerprints. */
  async capture(input: {
    round: number;
    role: CheckpointRole;
    cwd: string;
    signal?: AbortSignal;
    timeoutMs?: number;
    exclude?: (path: string) => boolean;
    maxPaths?: number;
  }): Promise<WorkspaceCheckpointManifest> {
    this.newBytes = 0;
    const result = await captureBoundary({
      cwd: input.cwd,
      ...(input.signal ? { signal: input.signal } : {}),
      ...(input.timeoutMs !== undefined ? { timeoutMs: input.timeoutMs } : {}),
      ...(input.exclude ? { exclude: input.exclude } : {}),
      materializer: this,
      refreshIndex: true,
      maxPaths: input.maxPaths ?? CHECKPOINT_MAX_PATHS,
    });
    if (!result.ok) {
      throw new CheckpointError(
        result.status === "timeout" || result.status === "aborted"
          ? "checkpoint_failed"
          : "checkpoint_unavailable",
        result.status,
        result.detail,
      );
    }
    const boundary = result.boundary;
    if (boundary.materializationError) {
      throw new CheckpointError(
        boundary.materializationError.code === "too_many_paths"
          ? "checkpoint_limit"
          : "checkpoint_unavailable",
        boundary.materializationError.code,
        boundary.materializationError.detail,
      );
    }
    return this.persistManifest(input.round, input.role, boundary);
  }

  persistManifest(
    round: number,
    role: CheckpointRole,
    boundary: BoundaryCapture,
  ): WorkspaceCheckpointManifest {
    const contentHash = checkpointContentHash({
      ...(boundary.head ? { head: boundary.head } : {}),
      fingerprints: boundary.fingerprints,
      contents: boundary.contents,
      coverage: "tracked_and_non_ignored_untracked",
    });
    const checkpointId = deriveCheckpointId({
      loopId: this.loopId,
      round,
      role,
      contentHash,
    });
    const sortedFingerprints: Record<string, string> = {};
    for (const path of Object.keys(boundary.fingerprints).sort()) {
      sortedFingerprints[path] = boundary.fingerprints[path];
    }
    const manifest: WorkspaceCheckpointManifest = {
      schemaVersion: CHECKPOINT_SCHEMA_VERSION,
      checkpointId,
      loopId: this.loopId,
      round,
      role,
      createdAt: Date.now(),
      ...(boundary.head ? { head: boundary.head } : {}),
      dirty: [...boundary.dirty].sort(),
      fingerprints: sortedFingerprints,
      contents: [...boundary.contents].sort(),
      coverage: "tracked_and_non_ignored_untracked",
      contentHash,
    };
    this.writeManifest(manifest);
    return this.readManifest(checkpointId) ?? manifest;
  }
}

/** Build the transaction-snapshot reference for a manifest. */
export function buildCheckpointRef(
  manifest: WorkspaceCheckpointManifest,
  input: {
    transactionId: string;
    branchId: string;
    roundId?: string;
    createdAt?: number;
  },
): CheckpointRef {
  return {
    checkpointId: manifest.checkpointId,
    contentHash: manifest.contentHash,
    role: manifest.role,
    round: manifest.round,
    roundId: input.roundId ?? `loop:${manifest.loopId}:round:${manifest.round}`,
    transactionId: input.transactionId,
    branchId: input.branchId,
    redoRound: manifest.round,
    createdAt: input.createdAt ?? manifest.createdAt,
  };
}
