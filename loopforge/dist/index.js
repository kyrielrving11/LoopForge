/** LoopForge — Loop-Time Intelligence Layer for AI coding agents.
 *
 * TypeScript reference implementation v1.0.
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
 */
// Protocol types
export { Mode, AgentStatus, Technique, makeAnalysis, makeVaultConfig, makeExecutionFeedback, makeLoopObjective, makeLoopHealth, makeRollingSummary, makeTaskAlignment, makeLoopRoundResult, makeLoopCompileRequest, makeLoopCompileResponse, makeSessionState, makeTaskId, toDict, } from "./protocol.js";
// Policy
export { getPolicy, loadPolicy, resetPolicy, DEFAULT_POLICY, } from "./policy.js";
export { FSBackend } from "./backends/fs.js";
// Builder
export { routeTechnique, routeTechniqueAdaptive, scoreQuality, extractGlobalConstraints, TECHNIQUE_REFERENCE, } from "./builder.js";
// Loop Compiler
export { compileLoop, decideLevel, compileL2, alignTask, checkLoopHealth, computeAdvisories, computeGoalTextHash, deriveGoalId, getPreviousRound, } from "./loop-compiler.js";
// Replay
export { ReplayBackend } from "./replay.js";
// Engine
export { LoopForgeEngine, createEngine, } from "./engine.js";
// Adapter
export { handle, main } from "./adapter.js";
//# sourceMappingURL=index.js.map