# LoopForge development guide

Read [`AGENTS.md`](./AGENTS.md) before changing this repository. It contains the
current 3.6.0 architecture, commands, invariants, storage layout, and required
regression coverage.

The most important boundary is simple: the external Agent executes the task;
LoopForge maintains durable cognitive state and an auditable round transaction.
Do not add a background Agent, MCP Tasks, prompt-technique routing, automatic
memory discovery, or a second persistence truth.

Keep work decomposition derived from committed round facts and Canonical State.
Use existing sub-goals, Round Contracts, criteria, and projection facts where
they fit, but do not introduce a second persistence truth or a parallel notion
of progress merely to support a new view.
