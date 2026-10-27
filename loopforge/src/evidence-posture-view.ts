/** v4.0.3: the ONE renderer of a persisted evidence posture.
 *
 *  The prompt's Machine Evidence section and the state file's Machine Evidence
 *  section read the same formatter, so a committed round cannot be described
 *  two different ways. `compact` only shortens the displayed arrays; it never
 *  changes the posture, its status or its counts.
 */

import type { EvidencePosture } from "./protocol.js";

export interface EvidencePostureViewOptions {
  /** Prompt/profile display: shorter arrays and no per-item reasons. */
  compact?: boolean;
}

const COMPACT_CAPS = {
  providers: 8,
  commands: 8,
  contractItems: 8,
  findings: 6,
} as const;

function moreLine(hidden: number): string {
  return hidden > 0 ? ` (+${hidden} more)` : "";
}

function workspaceText(posture: EvidencePosture): string {
  switch (posture.workspace.status) {
    case "observed":
      return `observed changes ${posture.workspace.changedPathCount}`;
    case "unknown":
      return "unknown";
    default:
      return "not applicable";
  }
}

function filesText(posture: EvidencePosture): string {
  if (!posture.files) return "not applicable";
  return `${posture.files.reported} (${posture.files.reconciliation})`;
}

/** Render the body lines of a Machine Evidence section. The caller owns the
 *  heading and the authority sentence. */
export function formatEvidencePostureLines(
  posture: EvidencePosture,
  options: EvidencePostureViewOptions = {},
): string[] {
  const compact = options.compact === true;
  const lines: string[] = compact
    ? [
        `- status: ${posture.status} (evidence coverage, not task success); ` +
        `machine_backed_success: ${posture.machineBackedSuccess}; ` +
        `verification_configured: ${posture.verificationConfigured}`,
        `- workspace: ${workspaceText(posture)}; agent-reported files: ${filesText(posture)}`,
      ]
    : [
        `- status: ${posture.status} (evidence coverage, not task success)`,
        `- machine_backed_success: ${posture.machineBackedSuccess}`,
        `- verification_configured: ${posture.verificationConfigured}`,
        `- workspace: ${workspaceText(posture)}`,
        `- agent-reported files: ${filesText(posture)}`,
      ];

  if (!posture.contract) {
    lines.push("- contract: none");
  } else {
    const contract = posture.contract;
    lines.push(
      `- contract \`${contract.id}\`: ${contract.closure}; ` +
      `verified ${contract.verifiedCount}, insufficient ${contract.insufficientCount}, ` +
      `contradicted ${contract.contradictedCount}, pending ${contract.pendingCount}`,
    );
    const shown = compact
      ? contract.items.slice(0, COMPACT_CAPS.contractItems)
      : contract.items;
    for (const item of shown) {
      const criteria = item.criterionRefs.length > 0
        ? ` (criteria: ${item.criterionRefs.join(", ")})`
        : "";
      const reason = !compact && item.reasons.length > 0
        ? ` — ${item.reasons[0]}`
        : "";
      lines.push(`  - \`${item.id}\`: ${item.status}${criteria}${reason}`);
    }
    const hidden = contract.items.length - shown.length +
      posture.omitted.contractItems;
    if (hidden > 0) lines.push(`  - contract items omitted (+${hidden} more)`);
  }

  if (posture.commands.length === 0) {
    lines.push("- commands: none");
  } else {
    const shown = compact
      ? posture.commands.slice(0, COMPACT_CAPS.commands)
      : posture.commands;
    lines.push(
      "- commands: " +
      shown.map((command) =>
        `${command.commandId}=${command.status}${command.required ? " (required)" : ""}`,
      ).join(", ") +
      moreLine(posture.commands.length - shown.length + posture.omitted.commands),
    );
  }

  if (posture.providers.length === 0) {
    lines.push("- providers: none");
  } else {
    const shown = compact
      ? posture.providers.slice(0, COMPACT_CAPS.providers)
      : posture.providers;
    lines.push(
      "- providers: " +
      shown.map((provider) =>
        `${provider.providerId} (${provider.kind})=${provider.status}`,
      ).join(", ") +
      moreLine(posture.providers.length - shown.length + posture.omitted.providers),
    );
  }

  if (posture.findings.length === 0) {
    lines.push("- findings: none");
  } else {
    const shown = compact
      ? posture.findings.slice(0, COMPACT_CAPS.findings)
      : posture.findings;
    lines.push(
      "- findings: " +
      shown.map((finding) =>
        `[\`${finding.id}\`] ${finding.check} (${finding.severity})` +
        (finding.ref ? ` [ref: \`${finding.ref}\`]` : ""),
      ).join(", ") +
      moreLine(posture.findings.length - shown.length + posture.omitted.findings),
    );
  }
  return lines;
}

/** The fixed sentence that keeps Machine Evidence distinct from a judgment of
 *  the Agent's work. */
export const MACHINE_EVIDENCE_AUTHORITY =
  "Machine Evidence records what the machine observed; it is not a judgment " +
  "of the Agent's work. Full observations are available through " +
  "`loopforge_status view=explain`.";
