#!/usr/bin/env node
/** Generate JSON Schema (draft 2020-12) from protocol.ts TypeScript definitions.
 *
 * Uses the TypeScript Compiler API to parse type declarations and emit a
 * self-consistent JSON Schema. The generated schema is the single source of
 * truth for the wire protocol — it is regenerated on every build.
 *
 * Usage: node dist/generate-schema.js
 *   or:  npx tsx src/generate-schema.ts   (during development)
 */
export {};
//# sourceMappingURL=generate-schema.d.ts.map