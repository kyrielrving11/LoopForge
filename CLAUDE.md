# LoopForge

**Loop-Time Intelligence Layer** for AI coding agents. Per-iteration prompt compiler
with structured memory, constraint inheritance, and drift correction — maintains
cognitive stability across long-horizon agent loops.

- Language: TypeScript only. No Python, Ruby, or other language files.
- Package: `loopforge/` — npm package `loopforge` v1.0.0, ESM, Node ≥18.
- Zero runtime dependencies — stdlib only.

## Commands

```bash
cd loopforge
npm run build    # tsc + generate JSON Schema
npm test         # tsc + schema gen + 127 tests (node:test)
npx tsc --noEmit # type-check only
```

## Architecture

```
loopforge/src/
  protocol.ts          # 14 interfaces + 3 enums — wire contract
  loop-compiler.ts     # L0/L1/L2 recompile + advisories + specialist compilers
  engine.ts            # Lifecycle, circuit breaker, session state
  builder.ts           # Technique routing (keyword + adaptive) + quality scoring
  adapter.ts           # Mode routing (loop_compile | feedback | review)
  cli.ts               # CLI entry point (7 commands)
  replay.ts            # Time-travel queries: getRound / replay / timeline / diff
  policy.ts            # loop_policy.json loader
  generate-schema.ts   # JSON Schema generator (runs during build)
  backends/
    interface.ts       # VaultBackend interface (9 methods)
    fs.ts              # FSBackend — JSON vault + Markdown lineage dual-write
```

## Key Rules

- Never add Python files. The Python reference implementation was deleted — TypeScript is the sole implementation.
- `loopforge-protocol.json` is auto-generated. Edit `protocol.ts` and run `npm run build`.
- Schema gen runs on every build; the test suite validates the generated schema.
- The project is the npm package. All commands run from `loopforge/`.
- Spec: `docs/loopforge-spec.md`.
