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
export { AgentStatus, makeSelfEvaluation, makeLoopObjective, makeLoopRoundResult, makeLoopCompileRequest, makeLoopCompileResponse, makeEvidenceSnapshot, makeVerificationFlag, makeVerificationResult, makeEnforcementResult, makeSubGoal, makeConstraintMeta, } from "./protocol.js";
// Policy
export { getPolicy, loadPolicy, resetPolicy, DEFAULT_POLICY, writeStateFile, } from "./policy.js";
// Durable store
export { FileLoopStore, queryLoopEntries, LOOP_STORE_SCHEMA_VERSION, } from "./loop-store.js";
// Loop Compiler
export { compileLoop, decideLevel, computeGoalTextHash, deriveGoalId, getPreviousRound, buildSelfEvalBlock, } from "./loop-compiler.js";
// Submission channel (v3.9.1)
export { allFieldGuidePaths, deriveSubmissionGuidance, fieldGuide, fieldGuideDescription, renderSelfEvalBlock, } from "./submission-guidance.js";
export { deriveCommittedSubmissionView, deriveSubmissionReceipt, } from "./submission-receipt.js";
// Replay
export { ReplayBackend } from "./replay.js";
// Engine
export { LoopForgeEngine, createEngine, } from "./engine.js";
export { buildSelfEvaluation, parseExecutionReport, parseWorkerResults, } from "./self-eval.js";
// MCP (v1.3)
export { McpServer } from "./mcp/server.js";
export { SessionManager } from "./mcp/session.js";
// EvidenceProvider (v1.18 / v3.8: machine observations)
export { EvidenceCollector, GitEvidenceProvider, CommandEvidenceProvider, registerEvidenceProvider, unregisterEvidenceProvider, isProviderRegistered, isPassedAfterObservation, deriveObservationDeltas, gitDeltaState, observationVersionIssue, expectedObservationSchemaVersion, coverageKey, } from "./evidence-provider.js";
export { deriveProgressWindow, deriveRoundProgress, GIT_WORKSPACE_COVERAGE, } from "./progress.js";
// Structured tracing and policy effectiveness metrics (v1.20)
export { logEvent, } from "./observability.js";
export { PolicyMetricsCollector, policyMetrics, getPolicyMetrics, resetPolicyMetrics, } from "./policy-metrics.js";
// Unified round transaction (v1.19)
export { ROUND_TRANSACTION_SCHEMA_VERSION, RoundTransactionCoordinator, makeRoundId, prepareRoundTransaction, parseRoundTransactionSnapshot, } from "./round-transaction.js";
// Workspace checkpoints and restore (v3.9.8)
export { FileWorkspaceCheckpointStore, buildCheckpointRef, checkpointContentHash, deriveCheckpointId, parseCheckpointManifest, CHECKPOINT_SCHEMA_VERSION, } from "./workspace-checkpoint.js";
export { executeRestore, preflightRestore, } from "./workspace-restore.js";
export { captureBoundary } from "./git-boundary.js";
//# sourceMappingURL=index.js.map