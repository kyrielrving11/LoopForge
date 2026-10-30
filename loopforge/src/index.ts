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

// Protocol types
export {
  AgentStatus,
  makeSelfEvaluation,
  makeLoopObjective,
  makeLoopRoundResult,
  makeLoopCompileRequest,
  makeLoopCompileResponse,
  makeVerificationFlag,
  makeVerificationResult,
  makeEnforcementResult,
  makeSubGoal,
  makeConstraintMeta,
} from "./protocol.js";

export type {
  SelfEvaluation,
  LoopObjective,
  LoopRoundResult,
  LoopCompileRequest,
  LoopCompileResponse,
  WorkerResult,
  VerificationFlag,
  VerificationResult,
  EnforcementResult,
  SubGoal,
  ConstraintMeta,
  PromptArtifact,
  PromptContextMode,
  PromptContextReason,
  PromptWorkingMemoryProjection,
  PromptCoverage,
  CompiledRoundFacts,
  ContractTransition,
  ProgressCoverage,
  SubmissionDiagnostic,
  SubmissionDiagnosticHandling,
  SubmissionGuidance,
  SubmissionHandle,
  SubmissionReceipt,
  SubmissionReportHandling,
  CheckpointRef,
  CheckpointRole,
  WorkspaceCheckpointManifest,
  RecoveryTarget,
  EvidencePosture,
  EvidencePostureStatus,
} from "./protocol.js";

// Evidence posture (v4.0.3)
export {
  deriveEvidencePosture,
  rollbackEvidencePosture,
  EVIDENCE_POSTURE_CAPS,
} from "./evidence-posture.js";
export type { EvidencePostureInput } from "./evidence-posture.js";

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
  queryLoopEntries,
  LOOP_STORE_SCHEMA_VERSION,
} from "./loop-store.js";
export type {
  LoopStore,
  LoopSessionDocument,
  LoopRoundDocument,
  VaultEntry,
} from "./loop-store.js";

// Loop Compiler
export {
  compileLoop,
  decideLevel,
  computeGoalTextHash,
  deriveGoalId,
  getPreviousRound,
  buildSelfEvalBlock,
} from "./loop-compiler.js";

// Submission channel (v3.9.1)
export {
  allFieldGuidePaths,
  deriveSubmissionGuidance,
  fieldGuide,
  fieldGuideDescription,
  renderSelfEvalBlock,
} from "./submission-guidance.js";
export type {
  FieldGuide,
  GuidanceOptions,
  GuidanceSessionView,
  SelfEvalPromptContext,
} from "./submission-guidance.js";
export {
  deriveCommittedSubmissionView,
  deriveSubmissionReceipt,
} from "./submission-receipt.js";
export type {
  ReceiptFacts,
  ReceiptInput,
} from "./submission-receipt.js";

// Replay
export { ReplayBackend } from "./replay.js";

// Engine
export {
  LoopForgeEngine,
  createEngine,
} from "./engine.js";
export {
  buildSelfEvaluation,
  parseExecutionReport,
  parseWorkerResults,
} from "./self-eval.js";


export type { StopReason } from "./protocol.js";

// MCP (v1.3)
export { McpServer } from "./mcp/server.js";
export { SessionManager } from "./mcp/session.js";
export type { McpSession, McpSessionSummary } from "./mcp/session.js";
export type {
  InvocationInputs,
  ResumeInputs,
  StartInput,
} from "./mcp/round-lifecycle.js";
// EvidenceProvider (v1.18 / v3.8: machine observations)
export {
  EvidenceCollector,
  GitEvidenceProvider,
  CommandEvidenceProvider,
  registerEvidenceProvider,
  unregisterEvidenceProvider,
  isProviderRegistered,
  isPassedAfterObservation,
  deriveObservationDeltas,
  gitDeltaState,
  observationVersionIssue,
  expectedObservationSchemaVersion,
  coverageKey,
} from "./evidence-provider.js";
export type {
  EvidenceProvider,
  EvidenceCaptureContext,
  EvidenceCaptureResult,
  EvidenceCollectOptions,
  EvidenceProviderFactory,
  ObservationDelta,
  ObservationProgress,
  ObservationVersionIssue,
  GitDeltaState,
} from "./evidence-provider.js";
export {
  deriveProgressWindow,
  deriveRoundProgress,
  GIT_WORKSPACE_COVERAGE,
} from "./progress.js";
export type {
  ProgressWindow,
  RoundProgress,
} from "./progress.js";

// Structured tracing and policy effectiveness metrics (v1.20)
export {
  logEvent,
} from "./observability.js";
export type {
  LogEventData,
} from "./observability.js";
export {
  PolicyMetricsCollector,
  policyMetrics,
  getPolicyMetrics,
  resetPolicyMetrics,
} from "./policy-metrics.js";
export type { PolicyMetricsSnapshot } from "./policy-metrics.js";

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
  RetryContext,
} from "./round-transaction.js";

// Workspace checkpoints and restore (v3.9.8)
export {
  FileWorkspaceCheckpointStore,
  buildCheckpointRef,
  checkpointContentHash,
  deriveCheckpointId,
  parseCheckpointManifest,
  CHECKPOINT_SCHEMA_VERSION,
} from "./workspace-checkpoint.js";
export {
  executeRestore,
  preflightRestore,
} from "./workspace-restore.js";
export type {
  RestorePreflight,
  RestoreResult,
} from "./workspace-restore.js";
export { captureBoundary } from "./git-boundary.js";
export type {
  BoundaryCapture,
  BoundaryMaterializer,
  GitCaptureResult,
  GitFileState,
  GitTrackedEntry,
} from "./git-boundary.js";
