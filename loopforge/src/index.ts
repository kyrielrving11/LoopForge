/** LoopForge — Loop-Time Intelligence Layer for AI coding agents.
 *
 * TypeScript reference implementation v1.3.
 *
 * Usage:
 *   import { LoopForgeEngine, ReplayBackend, compileLoop } from "loopforge";
 *
 *   // As a library
 *   const engine = createEngine();
 *   const response = engine.invokeLoopCompile(request);
 *
 *   // v1.2: Autonomous loop
 *   import { run } from "loopforge";
 *   const result = await run({
 *     task: "Audit ERC20 token",
 *     execute: async (prompt) => await callAiApi(prompt),
 *   });
 *
 *   // v1.3: MCP server
 *   import { McpServer, SessionManager } from "loopforge";
 *   const server = new McpServer();
 *   server.start();
 */

// Protocol types
export {
  Mode,
  AgentStatus,
  Technique,
  makeAnalysis,
  makeVaultConfig,
  makeExecutionFeedback,
  makeSelfEvaluation,
  makeLoopObjective,
  makeLoopHealth,
  makeRollingSummary,
  makeTaskAlignment,
  makeLoopRoundResult,
  makeLoopCompileRequest,
  makeLoopCompileResponse,
  makeSessionState,
  makeTaskId,
  toDict,
  SELF_EVAL_REGEX,
} from "./protocol.js";

export type {
  Analysis,
  VaultConfig,
  ExecutionFeedback,
  SelfEvaluation,
  LoopForgeRequest,
  LoopObjective,
  LoopHealth,
  RollingSummary,
  TaskAlignment,
  LoopRoundResult,
  LoopCompileRequest,
  LoopCompileResponse,
  LoopForgeResponse,
  SessionState,
  AgentLoopResult,
  WorkerResult,
} from "./protocol.js";

// Policy
export {
  getPolicy,
  loadPolicy,
  resetPolicy,
  DEFAULT_POLICY,
  resolveAllowedPhases,
} from "./policy.js";

export type {
  LoopPolicy,
  ConstraintsPolicy,
  SummaryPolicy,
  TechniquePolicy,
  EnginePolicy,
  BackendPolicy,
  MemoryInjectionPolicy,
  MemoryInjectionTier,
  MemoryWritebackPolicy,
} from "./policy.js";

// Backends
export type { VaultBackend, VaultEntry } from "./backends/interface.js";
export { FSBackend } from "./backends/fs.js";

// Builder
export {
  routeTechniqueAdaptive,
  TECHNIQUE_REFERENCE,
} from "./builder.js";

// Loop Compiler
export {
  compileLoop,
  decideLevel,
  compileL2,
  alignTask,
  checkLoopHealth,
  computeAdvisories,
  computeGoalTextHash,
  deriveGoalId,
  getPreviousRound,
  buildSelfEvalBlock,
  buildRollingSummary,
  formatRollingSummaryForPrompt,
  filterConstraintsForSubTask,
  formatDelegationPrompt,
  buildDelegationSummary,
} from "./loop-compiler.js";

// Replay
export { ReplayBackend } from "./replay.js";

// Engine
export {
  LoopForgeEngine,
  createEngine,
  extractSelfEvaluation,
  heuristicSelfEvaluation,
  buildSelfEvaluation,
} from "./engine.js";

export type { EngineMetrics, DelegationEntry } from "./engine.js";

// Runtime (v1.2)
export { LoopRuntime, run } from "./runtime.js";
export { RuntimeStatus } from "./protocol.js";
export type {
  RoundContext,
  AgentExecutor,
  StopReason,
  RoundStartInfo,
  RoundCompleteInfo,
  HeartbeatInfo,
  TimeoutInfo,
  HealthWarning,
  RuntimeConfig,
  RunResult,
} from "./protocol.js";

// MCP (v1.3)
export { McpServer } from "./mcp/server.js";
export { SessionManager } from "./mcp/session.js";
export type { McpSession, McpSessionSummary } from "./mcp/session.js";

// Memory Bridge (v1.8)
export {
  computeProjectHash,
  findGitRoot,
  detectClaudeMem,
  createMemoryProvider,
  createMemoryWriter,
  autoConfigureMemory,
  tryAutoConfigure,
} from "./memory-bridge.js";
