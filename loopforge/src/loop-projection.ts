/** Typed adapter over cognitive facts. It performs no vault traversal or
 * independent state derivation. */

import type { DerivedCognitiveFacts } from "./cognitive-facts.js";
import type { LoopProjection } from "./protocol.js";
import { makeLoopProjection } from "./protocol.js";

export function buildLoopProjection(
  facts: DerivedCognitiveFacts,
): LoopProjection | null {
  const projection = makeLoopProjection({
    focus: facts.focus,
    todo: [...facts.todo],
    phase: facts.phase,
    delegation: {
      pending: facts.delegation.pending,
      last_results: [...facts.delegation.last_results],
    },
    handoff: {
      summary: facts.handoff.summary,
      verified: [...facts.handoff.verified],
      open_risks: [...facts.handoff.open_risks],
    },
  });
  const empty = projection.focus === null && projection.todo.length === 0 &&
    projection.phase === null && projection.delegation.last_results.length === 0 &&
    projection.handoff.summary.length === 0 &&
    projection.handoff.verified.length === 0 &&
    projection.handoff.open_risks.length === 0;
  return empty ? null : projection;
}
