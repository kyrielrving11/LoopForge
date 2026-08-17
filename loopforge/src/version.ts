import { readFileSync } from "node:fs";

interface PackageMetadata {
  version?: unknown;
}

function readVersion(): string {
  const metadata = JSON.parse(
    readFileSync(new URL("../package.json", import.meta.url), "utf8"),
  ) as PackageMetadata;
  if (typeof metadata.version !== "string" || !metadata.version) {
    throw new Error("loopforge package.json does not contain a valid version");
  }
  return metadata.version;
}

export const LOOPFORGE_VERSION = readVersion();
