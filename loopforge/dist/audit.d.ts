/** v2.12: Read-only, replayable end-of-loop audit — the verification view.
 *
 *  Positioning vs loopforge_replay: replay is the factual timeline (what
 *  happened per round); audit is the assessment layer (which claims are
 *  machine-verified, which gates were decided, is the sequence intact).
 *  Everything is derived from committed vault entries — audit never writes.
 */
import type { LoopStore } from "./loop-store.js";
import type { VaultEntry } from "./loop-store.js";
export interface AuditRound {
    round: number;
    outcome: string;
    claims: Array<{
        text: string;
        status: "verified" | "unverified" | "no_evidence";
    }>;
    checks: Array<{
        check: string;
        severity: string;
        verdict: "failed" | "warn" | "info";
    }>;
}
export interface AuditGate {
    gateId: string;
    kind: "user" | "agent";
    actionHash: string;
    approved: boolean;
    decidedAt: string;
    round: number;
}
export interface AuditResult {
    loopId: string;
    verdict: "passed" | "incomplete" | "contradicted";
    rounds: AuditRound[];
    gates: AuditGate[];
    unresolvedUserGates: string[];
    criteria: {
        declared: number;
        evidenced: number;
        missing: number;
    };
    sequenceComplete: boolean;
    /** False when no LoopStore was provided (sequence/provenance degraded). */
    provenanceAvailable: boolean;
}
/** Build the audit from committed vault entries. Pure, read-only.
 *  @param store Optional LoopStore — when provided, sequence integrity is
 *  checked and provenanceAvailable becomes true. */
export declare function buildAudit(loopId: string, entries: VaultEntry[], store?: LoopStore): AuditResult;
//# sourceMappingURL=audit.d.ts.map