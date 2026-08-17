import { makeVerificationFlag, makeVerificationResult } from "./protocol.js";
import { claimHasVerifiedEvidenceForEnvelope } from "./round-report.js";
export function entryRound(entry) {
    const candidate = entry.loop_lineage;
    const lineage = candidate && typeof candidate === "object" && !Array.isArray(candidate)
        ? candidate
        : null;
    if (lineage && typeof lineage.round === "number" && Number.isInteger(lineage.round))
        return lineage.round;
    return typeof entry.round === "number" && Number.isInteger(entry.round) ? entry.round : 0;
}
function reportFromEntry(entry) {
    return entry.round_report && typeof entry.round_report === "object" && !Array.isArray(entry.round_report)
        ? entry.round_report
        : null;
}
function recurringViolation(evaluation, currentRound, vaultEntries) {
    const violations = evaluation.report.violations ?? [];
    if (!violations.length)
        return null;
    const previous = vaultEntries
        .filter((entry) => entryRound(entry) > 0 && entryRound(entry) < currentRound)
        .sort((a, b) => entryRound(b) - entryRound(a))
        .slice(0, 2)
        .map((entry) => {
        const report = reportFromEntry(entry);
        return Array.isArray(report?.violations)
            ? report.violations.filter((item) => typeof item === "string")
            : [];
    });
    const repeated = violations.find((violation) => previous.length === 2 &&
        previous.every((items) => items.includes(violation)));
    return repeated
        ? makeVerificationFlag({
            severity: "error",
            field: "violations",
            check: "recurring_violation",
            detail: `Constraint violation repeated in three accepted rounds: ${repeated}`,
        })
        : null;
}
function evidenceIntegrity(evaluation) {
    const envelope = evaluation.evidenceEnvelope;
    const flags = [];
    if (envelope.contradictions.length) {
        flags.push(makeVerificationFlag({
            severity: "error",
            field: "evidence",
            check: "evidence_envelope_contradicted",
            detail: envelope.contradictions.join("; "),
        }));
    }
    if (evaluation.report.status !== "completed")
        return flags;
    const files = new Set(envelope.files.value);
    const checks = new Map(envelope.checks.value.map((check) => [check.name, check.status]));
    for (const claim of envelope.claims) {
        for (const ref of claim.evidenceRefs) {
            const valid = (ref.startsWith("file:") && files.has(ref.slice(5))) ||
                (ref.startsWith("check:") && checks.get(ref.slice(6)) === "passed") ||
                (ref.startsWith("provider:") && (envelope.providerClaims?.[ref.slice(9)] ?? []).includes(claim.targetId));
            if (!valid) {
                flags.push(makeVerificationFlag({
                    severity: "error",
                    field: "evidence.claims",
                    check: "claim_reference_invalid",
                    detail: `Claim ${claim.targetId} references unavailable or failing evidence: ${ref}`,
                }));
            }
        }
    }
    if (!envelope.claims.length) {
        flags.push(makeVerificationFlag({
            severity: "error",
            field: "evidence.claims",
            check: "evidence_envelope_missing",
            detail: "A completed report must include claim coverage.",
        }));
    }
    if (evaluation.phase === "auditing") {
        for (const claim of envelope.claims) {
            if (!claimHasVerifiedEvidenceForEnvelope(envelope, claim)) {
                flags.push(makeVerificationFlag({
                    severity: "error",
                    field: "evidence.claims",
                    check: "audit_claim_not_verified",
                    detail: `Final audit claim lacks runtime-verified evidence: ${claim.targetId}`,
                }));
            }
        }
    }
    for (const obligationId of evaluation.requiredRegressionObligationIds ?? []) {
        const claim = envelope.claims.find((item) => item.targetId === obligationId);
        if (!claim || !claimHasVerifiedEvidenceForEnvelope(envelope, claim)) {
            flags.push(makeVerificationFlag({
                severity: "error",
                field: "evidence.regression_obligations",
                check: "regression_obligation_not_verified",
                detail: `Regression obligation lacks runtime-verified evidence: ${obligationId}`,
            }));
        }
    }
    return flags;
}
export function verifiedClaimEvidenceMissing(evaluation, requiredClaimIds) {
    const byId = new Map(evaluation.evidenceEnvelope.claims.map((claim) => [claim.targetId, claim]));
    return requiredClaimIds.filter((id) => {
        const claim = byId.get(id);
        return !claim || !claimHasVerifiedEvidenceForEnvelope(evaluation.evidenceEnvelope, claim);
    });
}
function requiredCommandFailures(snapshots) {
    return snapshots.flatMap((snapshot) => {
        if (snapshot.data.kind !== "command" || snapshot.data.required !== true)
            return [];
        if (snapshot.data.status === "passed")
            return [];
        const name = typeof snapshot.data.commandName === "string" ? snapshot.data.commandName : snapshot.provider;
        return [makeVerificationFlag({
                severity: "error",
                field: "evidence.checks",
                check: "required_command_failed",
                detail: `Required command did not pass: ${name} (${String(snapshot.data.status)})`,
            })];
    });
}
function workspaceRestore(evaluation, skippedFiles) {
    if (!skippedFiles.length)
        return null;
    const overlap = evaluation.evidenceEnvelope.files.value.filter((file) => skippedFiles.includes(file));
    if (!overlap.length)
        return null;
    return makeVerificationFlag({
        severity: overlap.length >= 3 || overlap.length === evaluation.evidenceEnvelope.files.value.length ? "error" : "warn",
        field: "evidence.files",
        check: "backtrack_workspace_not_restored",
        detail: `Backtracked files still appear in round evidence: ${overlap.join(", ")}`,
    });
}
export function verifyRoundEvaluation(evaluation, currentRound, vaultEntries, _previous = null, evidenceSnapshots = [], skippedFiles = []) {
    const flags = [
        ...evidenceIntegrity(evaluation),
        ...requiredCommandFailures(evidenceSnapshots),
    ];
    const recurring = recurringViolation(evaluation, currentRound, vaultEntries);
    if (recurring)
        flags.push(recurring);
    const restore = workspaceRestore(evaluation, skippedFiles);
    if (restore)
        flags.push(restore);
    const verdict = flags.some((flag) => flag.severity === "error")
        ? "contradicted"
        : flags.some((flag) => flag.severity === "warn")
            ? "suspect"
            : "trusted";
    return makeVerificationResult({ verdict, flags });
}
export function parseTestOutput(stdout) {
    const text = stdout.slice(-2000);
    let match = text.match(/Tests:\s*(?:(\d+) failed,?\s*)?(?:(\d+) passed,?\s*)?(?:(\d+) skipped,?\s*)?(\d+) total/i);
    if (match)
        return { failed: Number(match[1] ?? 0), passed: Number(match[2] ?? 0), skipped: Number(match[3] ?? 0) };
    match = text.match(/(\d+) passing(?:[\s\S]*?(\d+) failing)?/i);
    if (match)
        return { passed: Number(match[1] ?? 0), failed: Number(match[2] ?? 0), skipped: 0 };
    const pytest = text.match(/(?:(\d+) passed)?(?:,?\s*(\d+) failed)?(?:,?\s*(\d+) skipped)?/i);
    if (pytest && (pytest[1] || pytest[2] || pytest[3]) && /passed|failed|skipped/i.test(pytest[0])) {
        return { passed: Number(pytest[1] ?? 0), failed: Number(pytest[2] ?? 0), skipped: Number(pytest[3] ?? 0) };
    }
    const php = text.match(/OK \((\d+) tests?,/i);
    if (php)
        return { passed: Number(php[1]), failed: 0, skipped: 0 };
    const goPass = (text.match(/^--- PASS:/gm) ?? []).length;
    const goFail = (text.match(/^--- FAIL:/gm) ?? []).length;
    return goPass || goFail ? { passed: goPass, failed: goFail, skipped: 0 } : null;
}
//# sourceMappingURL=verification-gate.js.map