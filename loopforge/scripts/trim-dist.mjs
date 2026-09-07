#!/usr/bin/env node
/** Strip trailing whitespace from generated dist/ output.
 *
 * The TypeScript printer emits a trailing space after the separator on
 * multi-line function signatures; generated files therefore carry lines
 * like `gitHead?: string, ` that fail `git diff --check`. Trimming keeps
 * the committed artifacts diff-clean. verify:artifacts applies the same
 * trim to its clean temp build so the comparison stays byte-identical.
 *
 * Usage: node scripts/trim-dist.mjs [dir]   (default: <pkg>/dist)
 */
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const pkgRoot = resolve(scriptDir, "..");
const root = resolve(process.argv[2] ?? join(pkgRoot, "dist"));
let changed = 0;

function walk(current) {
  for (const name of readdirSync(current)) {
    const full = join(current, name);
    if (statSync(full).isDirectory()) {
      walk(full);
      continue;
    }
    if (!/\.(js|d\.ts|mjs|cjs)$/.test(name)) continue;
    const text = readFileSync(full, "utf8");
    const trimmed = text.replace(/[ \t]+$/gm, "");
    if (trimmed !== text) {
      writeFileSync(full, trimmed, "utf8");
      changed++;
    }
  }
}

if (!existsSync(root)) process.exit(0);
walk(root);
console.log(`trim-dist ✓ ${changed} file(s) trimmed under ${root}`);
