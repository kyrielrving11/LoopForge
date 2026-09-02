/** v2.12: Typed cognitive state projection — runtime-derived facts shipped
 *  with advance/status outputs. Pure function, zero persistence; every
 *  input already exists in compile outputs and vault entries.
 *
 *  Discipline: every field has a consumer (advance output for the main
 *  agent, status for human/tooling, resume handoff). No display-only
 *  decoration — the runtime provides facts, the agent decides actions.
 */
import type { VaultEntry } from "./loop-store.js";
import type { LoopForgeResponse, LoopProjection } from "./protocol.js";
export interface ProjectionInput {
    loopId: string;
    currentRound: number;
    /** Compiler output with v2.12 derived-state passthrough. */
    compileResponse: LoopForgeResponse | null;
    vaultEntries: VaultEntry[];
    /** cr-IDs backed by verified claims (P0 provenance layer). */
    verifiedClaims?: string[];
    /** Undecided user gate descriptions (recorded gate_opened without a
     *  matching gate_decision). */
    openGates?: string[];
}
/** Build the typed projection. Returns null only when nothing meaningful
 *  can be derived (fresh loop with no compile response). */
export declare function buildLoopProjection(input: ProjectionInput): LoopProjection | null;
//# sourceMappingURL=loop-projection.d.ts.map