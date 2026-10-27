/** v4.0.3: the ONE evidence-posture derivation.
 *
 *  `deriveEvidencePosture` is a PURE function over the facts of a single round
 *  transaction: the submitted evaluation, the after observations, their
 *  derived deltas, the verification flags, the contract binding and the
 *  machine-backed-success fact the verification gate already computed.
 *
 *  It reads no policy, no filesystem, no Vault and no live workspace. The
 *  coordinator calls it exactly once per round (before the transaction is
 *  committed), persists the result inside that transaction, and every read
 *  surface consumes the persisted copy. Re-deriving the posture elsewhere
 *  would create a second interpretation of the same round, which is exactly
 *  what this module exists to prevent.
 *
 *  Status priority (fixed; see the release plan):
 *    1. rollback                              → not_applicable
 *    2. contradicted  (error flag, contradicted item, failed command)
 *    3. unknown       (indeterminate observation, unobservable workspace with
 *                      verification in play, configured verification with no
 *                      after command observation)
 *    4. not_applicable (no success claim and no active contract)
 *    5. verified      (no contract or contract verified; no claim or the
 *                      machine backed the claim)
 *    6. insufficient  (everything else)
 *
 *  `unknown` never degrades to `verified` or to an empty result. `status` is
 *  computed from the COMPLETE data, before any display cap is applied.
 */
import type { EvidencePosture, FilesReconciliation, MachineObservation, SelfEvaluation, VerificationFlag } from "./protocol.js";
import type { ObservationDelta } from "./evidence-provider.js";
import type { ActiveContractView } from "./round-contract.js";
import type { ContractItemStatusView } from "./contract-items.js";
/** Fixed, code-level display caps. They are never policy: a policy knob must
 *  not be able to change which machine evidence a round carries. `omitted`
 *  records what the cap hid; the status decision always sees everything. */
export declare const EVIDENCE_POSTURE_CAPS: {
    readonly providers: 16;
    readonly commands: 16;
    readonly contractItems: 24;
    readonly findings: 12;
};
/** Per-item reason cap: a few short sentences of historical explanation. */
export declare const EVIDENCE_POSTURE_REASON_CAP = 2;
export declare const EVIDENCE_POSTURE_REASON_CHARS = 200;
/** The empty posture of a rollback directive: abandoning a branch makes no
 *  success claim and produces no evidence, so nothing is fabricated. */
export declare function rollbackEvidencePosture(round: number): EvidencePosture;
export interface EvidencePostureInput {
    round: number;
    kind: "evaluation" | "rollback";
    /** The submitted evaluation; null only for callers with no evaluation. */
    selfEval: SelfEvaluation | null;
    afterEvidence: ReadonlyArray<MachineObservation>;
    evidenceDeltas: ReadonlyArray<ObservationDelta>;
    verificationFlags: ReadonlyArray<VerificationFlag>;
    /** ONLY `VerificationResult.machineBackedSuccess`. This function never
     *  re-derives it from observations, flags or claims. */
    machineBackedSuccess: boolean;
    activeContract: ActiveContractView | null;
    contractStatuses: ContractItemStatusView;
    /** Policy fact at commit time: at least one enabled, after-capable command. */
    verificationConfigured: boolean;
    filesReconciliation: Pick<FilesReconciliation, "status" | "reported" | "observed"> | null;
}
/** Derive the ONE evidence posture of a round.
 *
 *  All inputs belong to the same round transaction. The function is pure,
 *  deterministic and independent of any current policy: the caller passes the
 *  policy-derived `verificationConfigured` fact and the already-computed
 *  `machineBackedSuccess`.
 */
export declare function deriveEvidencePosture(input: EvidencePostureInput): EvidencePosture;
//# sourceMappingURL=evidence-posture.d.ts.map