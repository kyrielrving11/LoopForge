/** PromptCraft — Loop-Time Intelligence Layer for AI coding agents.
 *
 * TypeScript reference implementation v1.0.
 *
 * Usage:
 *   import { handle, PromptCraftEngine, ReplayBackend, compileLoop } from "promptcraft";
 *
 *   // As a sub-agent adapter
 *   const result = handle('{"mode":"loop_compile","loop_id":"test","round":1,"task":"Audit ERC20"}');
 *
 *   // As a library
 *   const engine = createEngine();
 *   const response = engine.invokeLoopCompile(request);
 */
export { Mode, AgentStatus, Technique, makeAnalysis, makeVaultConfig, makeExecutionFeedback, makeLoopObjective, makeLoopHealth, makeRollingSummary, makeTaskAlignment, makeLoopRoundResult, makeLoopCompileRequest, makeLoopCompileResponse, makeSessionState, makeTaskId, toDict, } from "./protocol.js";
export type { Analysis, VaultConfig, ExecutionFeedback, PromptCraftRequest, LoopObjective, LoopHealth, RollingSummary, TaskAlignment, LoopRoundResult, LoopCompileRequest, LoopCompileResponse, PromptCraftResponse, SessionState, AgentLoopResult, } from "./protocol.js";
export { getPolicy, loadPolicy, resetPolicy, DEFAULT_POLICY, } from "./policy.js";
export type { LoopPolicy, ConstraintsPolicy, SummaryPolicy, RecompileTriggersPolicy, TechniquePolicy, EnginePolicy, BackendPolicy, } from "./policy.js";
export type { VaultBackend, VaultEntry } from "./backends/interface.js";
export { FSBackend } from "./backends/fs.js";
export { routeTechnique, routeTechniqueAdaptive, scoreQuality, extractGlobalConstraints, TECHNIQUE_REFERENCE, } from "./builder.js";
export { compileLoop, decideLevel, compileL2, alignTask, checkLoopHealth, computeAdvisories, computeGoalTextHash, deriveGoalId, getPreviousRound, } from "./loop-compiler.js";
export { ReplayBackend } from "./replay.js";
export { PromptCraftEngine, createEngine, } from "./engine.js";
export type { EngineMetrics } from "./engine.js";
export { handle, main } from "./adapter.js";
//# sourceMappingURL=index.d.ts.map