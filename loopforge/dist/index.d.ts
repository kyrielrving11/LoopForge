/** LoopForge — Cognitive State Runtime for AI coding agents.
 *
 * TypeScript reference implementation. Version is single-sourced from
 * package.json (see src/version.ts).
 *
 * Usage:
 *   import { LoopForgeEngine, ReplayBackend, compileLoop } from "loopforge";
 *
 *   // As a library
 *   const engine = createEngine();
 *   const response = engine.invokeLoopCompile(request);
 *
 *   // MCP server (primary integration path)
 *   import { McpServer, SessionManager } from "loopforge";
 *   const server = new McpServer();
 *   server.start();
 */
export { Mode, AgentStatus, makeExecutionFeedback, makeSelfEvaluation, makeLoopObjective, makeLoopHealth, makeRollingSummary, makeTaskAlignment, makeLoopRoundResult, makeLoopCompileRequest, makeLoopCompileResponse, makeSessionState, makeTaskId, makeEvidenceSnapshot, makeVerificationFlag, makeVerificationResult, makeEnforcementResult, makeMilestoneSummary, makeSubGoal, makeConstraintMeta, } from "./protocol.js";
export type { ExecutionFeedback, SelfEvaluation, LoopForgeRequest, LoopObjective, LoopHealth, RollingSummary, TaskAlignment, LoopRoundResult, LoopCompileRequest, LoopCompileResponse, LoopForgeResponse, SessionState, AgentLoopResult, WorkerResult, EvidenceSnapshot, VerificationFlag, VerificationResult, EnforcementResult, CriterionRevision, MilestoneSummary, SubGoal, ConstraintMeta, PromptArtifact, } from "./protocol.js";
export { getPolicy, loadPolicy, resetPolicy, DEFAULT_POLICY, writeStateFile, } from "./policy.js";
export type { LoopPolicy, ConstraintsPolicy, SummaryPolicy, EnginePolicy, BackendPolicy, PromptPolicy, StateFilePolicy, EvidencePolicy, CommandEvidencePolicy, McpPolicy, } from "./policy.js";
export { FileLoopStore, queryLoopEntries, LOOP_STORE_SCHEMA_VERSION, } from "./loop-store.js";
export type { LoopStore, LoopSessionDocument, LoopRoundDocument, VaultEntry, } from "./loop-store.js";
export { compileLoop, decideLevel, alignTask, checkLoopHealth, computeGoalTextHash, deriveGoalId, getPreviousRound, buildSelfEvalBlock, buildRollingSummary, } from "./loop-compiler.js";
export { ReplayBackend } from "./replay.js";
export { LoopForgeEngine, createEngine, buildSelfEvaluation, parseExecutionEvidence, parseCriterionRevisions, parseWorkerResults, } from "./engine.js";
export type { EngineMetrics, DelegationEntry } from "./engine.js";
export type { StopReason } from "./protocol.js";
export { McpServer } from "./mcp/server.js";
export { SessionManager } from "./mcp/session.js";
export type { McpSession, McpSessionSummary } from "./mcp/session.js";
export { EvidenceCollector, GitEvidenceProvider, CommandEvidenceProvider, registerEvidenceProvider, unregisterEvidenceProvider, extractFilesFromSnapshots, diffSnapshots, diffSnapshotCollections, } from "./evidence-provider.js";
export type { ProviderSnapshot, EvidenceProvider, EvidenceCaptureContext, EvidenceCaptureResult, EvidenceCollectOptions, EvidenceProviderFactory, CommandEvidenceData, } from "./evidence-provider.js";
export { logEvent, } from "./observability.js";
export type { LogEventData, } from "./observability.js";
export { PolicyMetricsCollector, policyMetrics, getPolicyMetrics, resetPolicyMetrics, } from "./policy-metrics.js";
export type { PolicyMetricsSnapshot } from "./policy-metrics.js";
export { ROUND_TRANSACTION_SCHEMA_VERSION, RoundTransactionCoordinator, makeRoundId, prepareRoundTransaction, parseRoundTransactionSnapshot, } from "./round-transaction.js";
export type { RoundTransactionPhase, RoundTransactionSnapshot, RoundTransactionInput, RoundTransactionOutcome, } from "./round-transaction.js";
//# sourceMappingURL=index.d.ts.map