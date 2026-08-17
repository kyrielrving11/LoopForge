import { readFileSync } from "node:fs";
function readVersion() {
    const metadata = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
    if (typeof metadata.version !== "string" || !metadata.version) {
        throw new Error("loopforge package.json does not contain a valid version");
    }
    return metadata.version;
}
export const LOOPFORGE_VERSION = readVersion();
//# sourceMappingURL=version.js.map