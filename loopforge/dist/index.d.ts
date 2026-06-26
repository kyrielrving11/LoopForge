/** LoopForge — Loop-Time Intelligence Layer for AI coding agents.
 *
 * TypeScript reference implementation v1.1.
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
 *   // v1.1: Autonomous loop
 *   import { runAutonomousLoop } from "loopforge";
 *   const result = await runAutonomousLoop(engine, config, async (prompt, round) => {
 *     return await callAiApi(prompt); // your AI executor
 *   });
 */
export { Mode, AgentStatus, Technique, makeAnalysis, makeVaultConfig, makeExecutionFeedback, makeSelfEvaluation, makeLoopObjective, makeLoopHealth, makeRollingSummary, makeTaskAlignment, makeLoopRoundResult, makeLoopCompileRequest, makeLoopCompileResponse, makeSessionState, makeTaskId, toDict, SELF_EVAL_REGEX, } from "./protocol.js";
export type { Analysis, VaultConfig, ExecutionFeedback, SelfEvaluation, LoopForgeRequest, LoopObjective, LoopHealth, RollingSummary, TaskAlignment, LoopRoundResult, LoopCompileRequest, LoopCompileResponse, LoopForgeResponse, SessionState, AgentLoopResult, } from "./protocol.js";
export { getPolicy, loadPolicy, resetPolicy, DEFAULT_POLICY, } from "./policy.js";
export type { LoopPolicy, ConstraintsPolicy, SummaryPolicy, RecompileTriggersPolicy, TechniquePolicy, EnginePolicy, BackendPolicy, } from "./policy.js";
export type { VaultBackend, VaultEntry } from "./backends/interface.js";
export { FSBackend } from "./backends/fs.js";
export { routeTechnique, routeTechniqueAdaptive, scoreQuality, extractGlobalConstraints, TECHNIQUE_REFERENCE, } from "./builder.js";
export { compileLoop, decideLevel, compileL2, alignTask, checkLoopHealth, computeAdvisories, computeGoalTextHash, deriveGoalId, getPreviousRound, buildSelfEvalBlock, } from "./loop-compiler.js";
export { ReplayBackend } from "./replay.js";
export { LoopForgeEngine, createEngine, extractSelfEvaluation, heuristicSelfEvaluation, } from "./engine.js";
export type { EngineMetrics } from "./engine.js";
export { runOneRound, runAutonomousLoop, } from "./autonomous.js";
export type { AutonomousConfig, RoundOutput, StopReason, AutonomousResult, AgentExecutor, RunOneRoundResult, } from "./autonomous.js";
export { handle, main } from "./adapter.js";
//# sourceMappingURL=index.d.ts.map