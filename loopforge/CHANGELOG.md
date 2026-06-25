# Changelog

## v1.0.0 (2026-06-25)

Initial TypeScript reference implementation of the LoopForge protocol v3.5.

### Core Compiler
- **4-gate hard router**: force_level → first-call/plan_source → goal_id stability → failure/constraint signals
- **L0 Fast Path**: reuses cached prompt from previous round, auto-escalates to L2 when no cache available
- **L1 Patch**: incremental constraint injection with rolling summary context
- **L2 Full Recompile**: technique routing, loop objective anchoring, meta-instruction generation

### Features
- **Constraint Retirement (v3.5)**: auto-retires stale constraints after 3 inactive rounds
- **Rolling Summary (v3.5)**: deterministic cross-round knowledge distillation from last 5 rounds
- **Adaptive Technique Routing (v3.5)**: quality-driven fallback from keyword heuristic
- **Loop Objective Anchoring**: auto-generated at round 1 from task/plan_source, checked every round
- **Task Alignment**: Jaccard-based advisory drift detection (aligned/warn/block)
- **Circuit Breaker**: stalls after 3 consecutive no-improvement iterations

### Storage
- **VaultBackend interface**: pluggable storage abstraction (9 methods)
- **FSBackend**: filesystem implementation with dual-write (JSON vault + Markdown lineage)
- **ReplayBackend**: time-travel queries — getRound, replay, timeline, diff

### CLI
- `loopforge init` — initialise vault
- `loopforge compile` — loop_compile mode (L0/L1/L2)
- `loopforge feedback` — execution recording with quality scoring
- `loopforge replay` — loop timeline with technique/quality history
- `loopforge diff` — field-level round comparison
- `loopforge review` — structural prompt audit
- `loopforge status` — vault health summary

### API
- Zero runtime dependencies — stdlib only (Node.js built-ins)
- Full TypeScript strict mode with declaration files
- Tree-shakeable exports: protocol, compiler, replay, policy, builder, engine, adapter
