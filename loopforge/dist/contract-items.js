/** Round Contract item status — the v3.8 verification skeleton.
 *
 *  A contract declares ITEMS; each item binds evidence commands. The agent
 *  may only CLAIM `met` / `remaining`; whether an item is `verified`,
 *  `contradicted`, or `insufficient` is derived here from committed
 *  observations and the in-flight round. Nothing in this module writes state:
 *  it is a pure function of the committed round views, the current report,
 *  the current observations, and policy.
 */
const EMPTY_VIEW = {
    contractId: "",
    closure: "open",
    closed_at_round: null,
    items: [],
    verifiedCount: 0,
    contradictedCount: 0,
    insufficientCount: 0,
};
function itemClaims(item, slices) {
    const claims = [];
    for (const slice of slices) {
        for (const claim of slice.report?.contract_item_claims ?? []) {
            if (claim.item_id === item.id)
                claims.push({ round: slice.round, outcome: claim.outcome });
        }
    }
    return claims;
}
/** The round in which the item was last claimed `met` (null when the latest
 *  claim is `remaining` or there is none). */
function metClaimRound(claims) {
    const last = claims[claims.length - 1];
    return last && last.outcome === "met" ? last.round : null;
}
function evaluateCommand(commandId, declaredHash, slices, fromRound, configured) {
    if (!configured) {
        return {
            verdict: "insufficient",
            reason: `command "${commandId}" is no longer configured/enabled — cannot observe it`,
        };
    }
    // v3.8.1: the LATEST observation at or after the claim decides, so the
    // closing round's evidence is the one consulted. Scanning forward let an
    // early pass outlive a later failure: the item stayed `verified`, its
    // contract closed, and a success stop could reach `completed` in a round
    // whose bound command the machine had just observed FAILING.
    for (const slice of [...slices].reverse()) {
        if (slice.round < fromRound)
            continue;
        const observation = slice.observations.find((item) => item.kind === "command" &&
            item.phase === "after" &&
            item.data.commandId === commandId);
        if (!observation || observation.kind !== "command")
            continue;
        const data = observation.data;
        if (declaredHash && data.configHash !== declaredHash) {
            return {
                verdict: "insufficient",
                reason: `command "${commandId}" was reconfigured after declaration (round ${slice.round})`,
            };
        }
        const changed = new Set(slice.observations
            .filter((item) => item.providerId === "git")
            .flatMap((item) => item.files));
        if (observation.status === "passed") {
            // A malformed observation must not crash the derivation the compile
            // path, the projection, the coordinator, explain and audit all share:
            // no entrypoint list means the tamper check simply has nothing to
            // compare, the same posture as a command with no entrypoint files.
            const entrypoints = Array.isArray(data.entrypointFiles) ? data.entrypointFiles : [];
            if (changed.size > 0 && entrypoints.some((file) => changed.has(file))) {
                return {
                    verdict: "contradicted",
                    reason: `command "${commandId}" passed but its entrypoint changed in round ${slice.round}`,
                };
            }
            return { verdict: "verified", reason: "" };
        }
        if (observation.status === "failed") {
            return {
                verdict: "contradicted",
                reason: `command "${commandId}" failed in round ${slice.round}` +
                    (typeof data.exitCode === "number" ? ` (exit ${data.exitCode})` : ""),
            };
        }
        return {
            verdict: "insufficient",
            reason: `command "${commandId}" observed ${observation.status} in round ${slice.round}`,
        };
    }
    return {
        verdict: "insufficient",
        reason: `command "${commandId}" produced no after-phase observation since round ${fromRound}`,
    };
}
/** v3.8: Derive every item's status plus the contract's closure. */
export function deriveContractItemStatuses(input) {
    const contract = input.contract;
    if (!contract)
        return EMPTY_VIEW;
    const slices = [
        ...input.rounds.map((round) => ({
            round: round.round,
            report: round.executionReport,
            observations: round.observationDelta,
            outcome: round.outcome,
        })),
        {
            round: input.currentRound,
            report: input.currentReport,
            observations: input.currentObservations,
            outcome: input.currentOutcome ?? null,
        },
    ].filter((slice) => slice.round < input.currentRound || slice.round === input.currentRound);
    const enabledCommands = new Set(input.commands.filter((command) => command.enabled).map((command) => command.name));
    const items = contract.items.map((item) => {
        const claims = itemClaims(item, slices);
        const metRound = metClaimRound(claims);
        if (metRound === null) {
            return {
                itemId: item.id,
                description: item.description,
                status: "pending",
                status_at_round: null,
                history: [],
                reasons: [],
            };
        }
        const verdicts = item.verify_with.map((commandId) => evaluateCommand(commandId, contract.config_hash_by_command[commandId], slices, metRound, enabledCommands.has(commandId)));
        const reasons = verdicts.map((verdict) => verdict.reason).filter(Boolean);
        let status;
        if (verdicts.some((verdict) => verdict.verdict === "contradicted")) {
            status = "contradicted";
        }
        else if (verdicts.length > 0 && verdicts.every((verdict) => verdict.verdict === "verified")) {
            status = "verified";
        }
        else {
            status = "insufficient";
        }
        return {
            itemId: item.id,
            description: item.description,
            status,
            status_at_round: metRound,
            history: [{ round: metRound, status, refs: item.verify_with }],
            reasons,
        };
    });
    const verifiedCount = items.filter((item) => item.status === "verified").length;
    const contradictedCount = items.filter((item) => item.status === "contradicted").length;
    const insufficientCount = items.filter((item) => item.status === "insufficient").length;
    const committingRound = slices[slices.length - 1];
    const blocked = committingRound?.outcome === "blocked";
    const allVerified = items.length > 0 && verifiedCount === items.length;
    const closure = allVerified ? "verified" : blocked ? "blocked" : "open";
    return {
        contractId: contract.id,
        closure,
        closed_at_round: closure === "open" ? null : committingRound?.round ?? null,
        items,
        verifiedCount,
        contradictedCount,
        insufficientCount,
    };
}
/** v3.8: The round-level verification posture. */
export function roundVerificationStatus(view, report) {
    if (view.contradictedCount > 0)
        return "contradicted";
    if (view.insufficientCount > 0)
        return "insufficient";
    // A success claim with no machine-backed item at all is insufficient too.
    const claims = report?.contract_item_claims ?? [];
    if (claims.some((claim) => claim.outcome === "met") && view.verifiedCount === 0) {
        return "insufficient";
    }
    return "trusted";
}
//# sourceMappingURL=contract-items.js.map