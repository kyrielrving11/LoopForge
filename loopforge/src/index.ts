/** LoopForge — Loop-Time Intelligence Layer for AI coding agents.
 *
 * TypeScript reference implementation v1.3.
 *
 * Usage:
 *   import { handle, LoopForgeEngine, ReplayBackend, compileLoop } from "loopforge";
 *
 *   // As a sub-agent adapter
 *   const result = handle('{"mode":"loop_compile","loop_id":"test","round":1,"task":"Audit ERC20"}');
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
} from "./protocol.js";

// Policy
export {
  getPolicy,
  loadPolicy,
  resetPolicy,
  DEFAULT_POLICY,
} from "./policy.js";

export type {
  LoopPolicy,
  ConstraintsPolicy,
  SummaryPolicy,
  RecompileTriggersPolicy,
  TechniquePolicy,
  EnginePolicy,
  BackendPolicy,
} from "./policy.js";

// Backends
export type { VaultBackend, VaultEntry } from "./backends/interface.js";
export { FSBackend } from "./backends/fs.js";

// Builder
export {
  routeTechnique,
  routeTechniqueAdaptive,
  scoreQuality,
  extractGlobalConstraints,
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
} from "./loop-compiler.js";

// Replay
export { ReplayBackend } from "./replay.js";

// Engine
export {
  LoopForgeEngine,
  createEngine,
  extractSelfEvaluation,
  heuristicSelfEvaluation,
} from "./engine.js";

export type { EngineMetrics } from "./engine.js";

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

// Adapter
export { handle, main } from "./adapter.js";

// MCP (v1.3)
export { McpServer } from "./mcp/server.js";
export { SessionManager } from "./mcp/session.js";
export type { McpSession, McpSessionSummary } from "./mcp/session.js";
