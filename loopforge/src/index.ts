/** LoopForge — Cognitive State Runtime for AI coding agents.
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
  makeEvidenceSnapshot,
  makeVerificationFlag,
  makeVerificationResult,
  makeEnforcementResult,
  makeCheckpointSummary,
} from "./protocol.js";

export type {
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
  EvidenceSnapshot,
  VerificationFlag,
  VerificationResult,
  EnforcementResult,
  CriterionRevision,
  CheckpointSummary,
  PromptArtifact,
} from "./protocol.js";

// Policy
export {
  getPolicy,
  loadPolicy,
  resetPolicy,
  DEFAULT_POLICY,
  writeStateFile,
} from "./policy.js";

export type {
  LoopPolicy,
  ConstraintsPolicy,
  SummaryPolicy,
  EnginePolicy,
  BackendPolicy,
  PromptPolicy,
  StateFilePolicy,
  EvidencePolicy,
  CommandEvidencePolicy,
  McpPolicy,
} from "./policy.js";

// Durable store
export {
  FileLoopStore,
  LoopStoreBackend,
  VaultBackendLoopStore,
  LOOP_STORE_SCHEMA_VERSION,
} from "./loop-store.js";
export type {
  LoopStore,
  LoopSessionDocument,
  LoopRoundDocument,
  LoopStoreMigrationResult,
} from "./loop-store.js";

// Loop Compiler
export {
  compileLoop,
  decideLevel,
  alignTask,
  checkLoopHealth,
  computeGoalTextHash,
  deriveGoalId,
  getPreviousRound,
  buildSelfEvalBlock,
  buildRollingSummary,
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
  parseExecutionEvidence,
  parseCriterionRevisions,
  parseWorkerResults,
} from "./engine.js";

export type { EngineMetrics, DelegationEntry } from "./engine.js";

export type { StopReason } from "./protocol.js";

// MCP (v1.3)
export { McpServer } from "./mcp/server.js";
export { SessionManager } from "./mcp/session.js";
export type { McpSession, McpSessionSummary } from "./mcp/session.js";
// EvidenceProvider (v1.18)
export {
  EvidenceCollector,
  GitEvidenceProvider,
  CommandEvidenceProvider,
  registerEvidenceProvider,
  unregisterEvidenceProvider,
  extractFilesFromSnapshots,
  diffSnapshots,
  diffSnapshotCollections,
} from "./evidence-provider.js";
export type {
  ProviderSnapshot,
  EvidenceProvider,
  EvidenceCaptureContext,
  EvidenceCaptureResult,
  EvidenceCollectOptions,
  EvidenceProviderFactory,
  CommandEvidenceData,
} from "./evidence-provider.js";

// Structured tracing and policy effectiveness metrics (v1.20)
export {
  logEvent,
  startSpan,
  setTraceSink,
  getTraceSink,
} from "./observability.js";
export type {
  LogEventData,
  TraceStatus,
  TraceRecord,
  TraceSink,
  TraceContext,
  TraceSpan,
} from "./observability.js";
export {
  PolicyMetricsCollector,
  policyMetrics,
  getPolicyMetrics,
  resetPolicyMetrics,
} from "./policy-metrics.js";
export type { PolicyMetricsSnapshot } from "./policy-metrics.js";

// Neutral ecosystem checkpoint bridge (v1.20)
export {
  COGNITIVE_CHECKPOINT_SCHEMA_VERSION,
  createCognitiveCheckpoint,
} from "./interop.js";
export type {
  CognitiveStateCheckpoint,
  CognitiveCheckpointSink,
} from "./interop.js";

// Unified round transaction (v1.19)
export {
  ROUND_TRANSACTION_SCHEMA_VERSION,
  RoundTransactionCoordinator,
  makeRoundId,
  prepareRoundTransaction,
  parseRoundTransactionSnapshot,
} from "./round-transaction.js";
export type {
  RoundTransactionPhase,
  RoundTransactionSnapshot,
  RoundTransactionInput,
  RoundTransactionOutcome,
} from "./round-transaction.js";
