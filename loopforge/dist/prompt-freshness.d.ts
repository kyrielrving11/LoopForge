/** Pure prompt-freshness derivation over one COMMITTED round.
 *
 *  "Did the previous round produce anything the next prompt must respect?"
 *  The answer is a fact about the committed round, never a caller's mutable
 *  projection:
 *
 *  - machine progress is the shared provider-neutral rule (`deriveRoundProgress`);
 *  - machine activity is an after-phase command with an attributable result;
 *  - declared evolution is a committed semantic declaration the compiler
 *    already consumes.
 *
 *  `observableNewInformation` is false ONLY when the machine PROVES no
 *  progress and the Agent declared no evolution. An unobservable/unknown
 *  progress signal is `unknown` and must never be read as "nothing changed":
 *  that is the epistemic error that created the L0 feedback loop.
 *
 *  Nothing here is persisted, and nothing here is a second history source.
 */
import type { PromptFreshness } from "./protocol.js";
import type { CommittedRoundView } from "./committed-round.js";
export type { PromptFreshness, PromptFreshnessReason } from "./protocol.js";
/** No committed previous round: freshness is unknown, never "stale". */
export declare const UNKNOWN_PROMPT_FRESHNESS: PromptFreshness;
export declare function derivePromptFreshness(previous: CommittedRoundView): PromptFreshness;
//# sourceMappingURL=prompt-freshness.d.ts.map