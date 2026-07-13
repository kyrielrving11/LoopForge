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
export { Mode, AgentStatus, makeExecutionFeedback, makeSelfEvaluation, makeLoopObjective, makeLoopHealth, makeRollingSummary, makeTaskAlignment, makeLoopRoundResult, makeLoopCompileRequest, makeLoopCompileResponse, makeSessionState, makeTaskId, toDict, SELF_EVAL_REGEX, makeEvidenceSnapshot, makeVerificationFlag, makeVerificationResult, makeEnforcementResult, makeCheckpointSummary, } from "./protocol.js";
export type { ExecutionFeedback, SelfEvaluation, LoopForgeRequest, LoopObjective, LoopHealth, RollingSummary, TaskAlignment, LoopRoundResult, LoopCompileRequest, LoopCompileResponse, LoopForgeResponse, SessionState, AgentLoopResult, WorkerResult, EvidenceSnapshot, VerificationFlag, VerificationResult, EnforcementResult, CriterionRevision, CheckpointSummary, PromptArtifact, } from "./protocol.js";
export { getPolicy, loadPolicy, resetPolicy, DEFAULT_POLICY, writeStateFile, } from "./policy.js";
export type { LoopPolicy, ConstraintsPolicy, SummaryPolicy, EnginePolicy, BackendPolicy, RuntimePolicy, PromptPolicy, StateFilePolicy, EvidencePolicy, CommandEvidencePolicy, McpPolicy, } from "./policy.js";
export { FileLoopStore, LOOP_STORE_SCHEMA_VERSION, } from "./loop-store.js";
export type { LoopStore, LoopSessionDocument, LoopRoundDocument, LoopStoreMigrationResult, } from "./loop-store.js";
export { compileLoop, decideLevel, alignTask, checkLoopHealth, computeGoalTextHash, deriveGoalId, getPreviousRound, buildSelfEvalBlock, buildRollingSummary, } from "./loop-compiler.js";
export { ReplayBackend } from "./replay.js";
export { LoopForgeEngine, createEngine, extractSelfEvaluation, heuristicSelfEvaluation, buildSelfEvaluation, parseExecutionEvidence, parseCriterionRevisions, parseWorkerResults, } from "./engine.js";
export type { EngineMetrics, DelegationEntry } from "./engine.js";
export { LoopRuntime, run } from "./runtime.js";
export { RuntimeStatus } from "./protocol.js";
export type { RoundContext, AgentExecutor, StopReason, RoundStartInfo, RoundCompleteInfo, HeartbeatInfo, TimeoutInfo, HealthWarning, RuntimeConfig, RunResult, } from "./protocol.js";
export { McpServer } from "./mcp/server.js";
export { SessionManager } from "./mcp/session.js";
export type { McpSession, McpSessionSummary } from "./mcp/session.js";
export { EvidenceCollector, GitEvidenceProvider, CommandEvidenceProvider, registerEvidenceProvider, unregisterEvidenceProvider, extractFilesFromSnapshots, diffSnapshots, diffSnapshotCollections, } from "./evidence-provider.js";
export type { ProviderSnapshot, EvidenceProvider, EvidenceCaptureContext, EvidenceCaptureResult, EvidenceCollectOptions, EvidenceProviderFactory, CommandEvidenceData, } from "./evidence-provider.js";
export { logEvent, startSpan, setTraceSink, getTraceSink, } from "./observability.js";
export type { LogEventData, TraceStatus, TraceRecord, TraceSink, TraceContext, TraceSpan, } from "./observability.js";
export { PolicyMetricsCollector, policyMetrics, getPolicyMetrics, resetPolicyMetrics, } from "./policy-metrics.js";
export type { PolicyMetricsSnapshot } from "./policy-metrics.js";
export { COGNITIVE_CHECKPOINT_SCHEMA_VERSION, createCognitiveCheckpoint, } from "./interop.js";
export type { CognitiveStateCheckpoint, CognitiveCheckpointSink, } from "./interop.js";
export { ROUND_TRANSACTION_SCHEMA_VERSION, RoundTransactionCoordinator, makeRoundId, prepareRoundTransaction, parseRoundTransactionSnapshot, } from "./round-transaction.js";
export type { RoundTransactionPhase, RoundTransactionSnapshot, RoundTransactionInput, RoundTransactionOutcome, } from "./round-transaction.js";
//# sourceMappingURL=index.d.ts.map