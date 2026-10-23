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
export { Mode, AgentStatus, makeExecutionFeedback, makeSelfEvaluation, makeLoopObjective, makeLoopRoundResult, makeLoopCompileRequest, makeLoopCompileResponse, makeSessionState, makeTaskId, makeEvidenceSnapshot, makeVerificationFlag, makeVerificationResult, makeEnforcementResult, makeSubGoal, makeConstraintMeta, } from "./protocol.js";
export type { ExecutionFeedback, SelfEvaluation, LoopForgeRequest, LoopObjective, LoopRoundResult, LoopCompileRequest, LoopCompileResponse, LoopForgeResponse, SessionState, AgentLoopResult, WorkerResult, EvidenceSnapshot, VerificationFlag, VerificationResult, EnforcementResult, SubGoal, ConstraintMeta, PromptArtifact, PromptCoverage, PromptRequestEffect, SubmissionDiagnostic, SubmissionDiagnosticHandling, SubmissionGuidance, SubmissionReceipt, SubmissionReportHandling, CheckpointRef, CheckpointRole, WorkspaceCheckpointManifest, RecoveryTarget, } from "./protocol.js";
export { getPolicy, loadPolicy, resetPolicy, DEFAULT_POLICY, writeStateFile, } from "./policy.js";
export type { LoopPolicy, EnginePolicy, BackendPolicy, PromptPolicy, StateFilePolicy, EvidencePolicy, CommandEvidencePolicy, McpPolicy, } from "./policy.js";
export { FileLoopStore, queryLoopEntries, LOOP_STORE_SCHEMA_VERSION, } from "./loop-store.js";
export type { LoopStore, LoopSessionDocument, LoopRoundDocument, VaultEntry, } from "./loop-store.js";
export { compileLoop, decideLevel, computeGoalTextHash, deriveGoalId, getPreviousRound, buildSelfEvalBlock, } from "./loop-compiler.js";
export { allFieldGuidePaths, deriveSubmissionGuidance, fieldGuide, fieldGuideDescription, renderSelfEvalBlock, } from "./submission-guidance.js";
export type { FieldGuide, GuidanceOptions, GuidanceSessionView, SelfEvalPromptContext, } from "./submission-guidance.js";
export { deriveCommittedSubmissionView, deriveSubmissionReceipt, } from "./submission-receipt.js";
export type { ReceiptFacts, ReceiptInput, } from "./submission-receipt.js";
export { ReplayBackend } from "./replay.js";
export { LoopForgeEngine, createEngine, buildSelfEvaluation, parseExecutionReport, parseWorkerResults, } from "./engine.js";
export type { EngineMetrics, DelegationEntry } from "./engine.js";
export type { StopReason } from "./protocol.js";
export { McpServer } from "./mcp/server.js";
export { SessionManager } from "./mcp/session.js";
export type { McpSession, McpSessionSummary } from "./mcp/session.js";
export { EvidenceCollector, GitEvidenceProvider, CommandEvidenceProvider, registerEvidenceProvider, unregisterEvidenceProvider, isProviderRegistered, isPassedAfterObservation, deriveObservationDeltas, gitDeltaState, } from "./evidence-provider.js";
export type { EvidenceProvider, EvidenceCaptureContext, EvidenceCaptureResult, EvidenceCollectOptions, EvidenceProviderFactory, ObservationDelta, GitDeltaState, } from "./evidence-provider.js";
export { logEvent, } from "./observability.js";
export type { LogEventData, } from "./observability.js";
export { PolicyMetricsCollector, policyMetrics, getPolicyMetrics, resetPolicyMetrics, } from "./policy-metrics.js";
export type { PolicyMetricsSnapshot } from "./policy-metrics.js";
export { ROUND_TRANSACTION_SCHEMA_VERSION, RoundTransactionCoordinator, makeRoundId, prepareRoundTransaction, parseRoundTransactionSnapshot, } from "./round-transaction.js";
export type { RoundTransactionPhase, RoundTransactionSnapshot, RoundTransactionInput, RoundTransactionOutcome, } from "./round-transaction.js";
export { FileWorkspaceCheckpointStore, buildCheckpointRef, checkpointContentHash, deriveCheckpointId, parseCheckpointManifest, CHECKPOINT_SCHEMA_VERSION, } from "./workspace-checkpoint.js";
export { executeRestore, preflightRestore, } from "./workspace-restore.js";
export type { RestorePreflight, RestoreResult, } from "./workspace-restore.js";
export { captureBoundary } from "./git-boundary.js";
export type { BoundaryCapture, BoundaryMaterializer, GitCaptureResult, GitFileState, GitTrackedEntry, } from "./git-boundary.js";
//# sourceMappingURL=index.d.ts.map