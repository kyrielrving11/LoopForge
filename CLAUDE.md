# LoopForge development guide

Read [`AGENTS.md`](./AGENTS.md) before changing this repository. It contains the
current 2.0 architecture, commands, invariants, storage layout, and required
regression coverage.

The most important boundary is simple: the external Agent executes the task;
LoopForge maintains durable cognitive state and an auditable round transaction.
Do not add a background Agent, MCP Tasks, prompt-technique routing, automatic
memory discovery, or a second persistence truth.
