/** v4.0.2 — bounded Working Memory.
 *
 * The invariant under test: Working Memory is a pure projection of the current
 * branch's committed rounds and committed rollback directives. It is bounded,
 * deterministic, sanitized, never a second history, and never a normative or
 * gate input.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  deriveWorkingMemory,
  formatWorkingMemoryPrompt,
  formatWorkingMemoryState,
  hasWorkingMemoryContent,
  PROMPT_WORKING_MEMORY_DENSITY,
  WORKING_MEMORY_ASSUMPTION_LIMIT,
  WORKING_MEMORY_QUESTION_LIMIT,
  WORKING_MEMORY_REPORT_LIMIT,
  WORKING_MEMORY_WINDOW_ROUNDS,
  WORKING_MEMORY_TEXT_LIMITS,
} from "../working-memory.js";
import { buildCommittedHistory } from "../history.js";
import {
  createCanonicalLoopState,
  hashCanonicalState,
  renderCanonicalStateMarkdown,
} from "../canonical-state.js";
import { assemblePromptArtifact } from "../prompt-assembler.js";
import {
  makeLoopCompileRequest,
  makeLoopCompileResponse,
  makeSelfEvaluation,
} from "../protocol.js";
import { normalizeSelfEvaluation } from "../self-eval.js";
import { verifySelfEvaluation } from "../verification-gate.js";
import { deriveOpenQuestionId } from "../open-question.js";
import type { WorkingMemory } from "../working-memory.js";
import {
  committedBacktrackRound,
  committedFeedbackRound,
} from "./_helpers.js";

function historyOf(entries: ReturnType<typeof committedFeedbackRound>[]) {
  return buildCommittedHistory(entries);
}

function minimalState(workingMemory?: WorkingMemory) {
  const request = makeLoopCompileRequest({
    loop_id: "memory-loop",
    round: 6,
    task: "Continue",
  });
  const response = makeLoopCompileResponse({
    loop_id: "memory-loop",
    round: 6,
    goal_id: "memory-loop:continue",
    loop_objective: {
      objective: "Continue",
      success_criteria: [],
      hard_constraints: [],
      created_at_round: 1,
      loop_id: "memory-loop",
    },
  });
  return createCanonicalLoopState(request, response, "test.md", {
    ...(workingMemory ? { workingMemory } : {}),
  });
}

function populatedMemory(): WorkingMemory {
  return {
    reports: Array.from({ length: 5 }, (_, index) => ({
      roundId: `loop:populated:round:${5 - index}`,
      round: 5 - index,
      attempt: 1,
      agentSuccessClaim: true,
      agentOutcome: "success" as const,
      outputSummary: `report ${5 - index}`,
      sourceChars: `report ${5 - index}`.length,
    })),
    assumptions: Array.from({ length: 6 }, (_, index) => ({
      round: 5 - index,
      kind: "wrong_assumption" as const,
      text: `assumption ${index}`,
    })),
    openQuestions: Array.from({ length: 4 }, (_, index) => ({
      id: deriveOpenQuestionId(`question ${index}`),
      round: 5 - index,
      text: `question ${index}`,
    })),
    recoveries: Array.from({ length: 3 }, (_, index) => ({
      round: 5 - index,
      redoRound: 4 - index,
      origin: "agent" as const,
      reason: `reason ${index}`,
      abandonedRounds: [4 - index],
      failedRounds: [],
      observedSkippedFiles: [],
      reportedSkippedFiles: [],
      approaches: [`approach ${index}`],
      wrongAssumptions: [`recovery assumption ${index}`],
      preservedDiscoveries: [],
      detailSourceCounts: {
        observedSkippedFiles: 0, reportedSkippedFiles: 0, approaches: 1,
        wrongAssumptions: 1, preservedDiscoveries: 0,
      },
    })),
    redirects: Array.from({ length: 3 }, (_, index) => ({
      round: 5 - index,
      contractId: `rc-0000000${index}`,
      reason: `redirect ${index}`,
    })),
    sourceCounts: {
      windowRounds: 5,
      reports: 5,
      assumptions: 6,
      openQuestions: 4,
      recoveries: 3,
      redirects: 3,
    },
  };
}

describe("deriveWorkingMemory — committed branch only", () => {
  it("reports omitted recovery details in both prompt and state projections", () => {
    const loopId = "recovery-detail-omissions";
    const rollback = committedBacktrackRound(2, loopId, 1);
    const lineage = rollback.loop_lineage as Record<string, unknown>;
    const transaction = lineage.round_transaction as Record<string, unknown>;
    const snapshot = transaction.snapshot as Record<string, unknown>;
    const recovery = snapshot.recovery as Record<string, unknown>;
    for (const key of [
      "observed_skipped_files", "reported_skipped_files", "approaches",
      "wrong_assumptions", "skipped_discoveries",
    ]) {
      recovery[key] = Array.from({ length: 4 }, (_, index) => `${key}-${index + 1}`);
    }
    const memory = deriveWorkingMemory(historyOf([
      committedFeedbackRound(1, { loopId, outputSummary: "first" }),
      rollback,
      committedFeedbackRound(2, {
        loopId, branchId: snapshot.transactionId as string, outputSummary: "redo",
      }),
    ]), 3);
    assert.equal(memory.recoveries.length, 1);
    assert.equal(memory.recoveries[0]!.approaches.length, 3);
    for (const level of ["l0", "l1", "l2"] as const) {
      const rendered = formatWorkingMemoryPrompt(memory, level)!;
      assert.equal(rendered.projection.truncated, true);
      assert.match(rendered.body, /Working Memory is abbreviated/);
      if (level !== "l0") {
        assert.ok(rendered.body.includes("approaches 3/4 (omitted 1)"));
        assert.ok(rendered.body.includes("wrong assumptions 3/4 (omitted 1)"));
        assert.ok(rendered.body.includes("preserved discoveries 3/4 (omitted 1)"));
        assert.ok(rendered.body.includes("observed files 3/4 (omitted 1)"));
        assert.ok(rendered.body.includes("reported files 3/4 (omitted 1)"));
        assert.match(rendered.body, /approaches-3/);
        assert.doesNotMatch(rendered.body, /approaches-4/);
      }
    }
    const state = formatWorkingMemoryState(memory);
    assert.equal(state.truncated, true);
    assert.ok(state.lines.join("\n").includes("approaches 3/4 (omitted 1)"));
    assert.equal((recovery.approaches as string[]).length, 4,
      "bounded projection must leave committed recovery details intact");
  });

  it("keeps the last five committed reports, newest first", () => {
    const loopId = "window";
    const entries = Array.from({ length: 7 }, (_, index) =>
      committedFeedbackRound(index + 1, {
        loopId,
        outputSummary: `report ${index + 1}`,
      }));
    const memory = deriveWorkingMemory(historyOf(entries), 8);
    assert.deepEqual(memory.reports.map((report) => report.round), [7, 6, 5, 4, 3]);
    assert.equal(memory.reports.length, WORKING_MEMORY_REPORT_LIMIT);
  });

  it("excludes abandoned rounds and keeps the child branch", () => {
    const loopId = "branch";
    const child = "tx-branch-child";
    const entries = [
      committedFeedbackRound(1, { loopId, outputSummary: "root one" }),
      committedFeedbackRound(2, { loopId, outputSummary: "abandoned two" }),
      committedFeedbackRound(3, { loopId, outputSummary: "abandoned three" }),
      committedBacktrackRound(3, loopId, 1, { transactionId: child }),
      committedFeedbackRound(2, {
        loopId,
        branchId: child,
        outputSummary: "child two",
      }),
    ];
    const memory = deriveWorkingMemory(historyOf(entries), 3);
    assert.deepEqual(memory.reports.map((report) => report.round), [2, 1]);
    assert.deepEqual(
      memory.reports.map((report) => report.outputSummary),
      ["child two", "root one"],
    );
    assert.equal(memory.recoveries.length, 1);
    assert.equal(memory.recoveries[0]?.origin, "machine");
  });

  it("does not duplicate the pending rollback directive as recovery history", () => {
    const loopId = "pending";
    const entries = [
      committedFeedbackRound(1, { loopId, outputSummary: "before" }),
      committedBacktrackRound(2, loopId, 1),
    ];
    const memory = deriveWorkingMemory(historyOf(entries), 2);
    assert.deepEqual(memory.recoveries, []);
    assert.deepEqual(memory.reports.map((report) => report.round), [1]);
  });

  it("excludes recovery directives whose redo round is not yet in the past", () => {
    const loopId = "future-recovery";
    const child = "tx-future-recovery";
    const entries = [
      committedFeedbackRound(1, { loopId, outputSummary: "root one" }),
      committedBacktrackRound(5, loopId, 2, { transactionId: child }),
      committedFeedbackRound(3, {
        loopId,
        branchId: child,
        outputSummary: "redo three",
      }),
    ];
    const atRedo = deriveWorkingMemory(historyOf(entries), 3);
    const afterRedo = deriveWorkingMemory(historyOf(entries), 4);

    assert.deepEqual(atRedo.recoveries, []);
    assert.deepEqual(afterRedo.recoveries.map((entry) => entry.redoRound), [3]);
  });

  it("merges wrong assumptions and retractions with normalized-exact dedup", () => {
    const loopId = "dedup";
    const entries = [
      committedFeedbackRound(1, {
        loopId,
        wrongAssumptions: ["Alpha was synchronous", "Beta is gone"],
        retractedConstraints: ["Gamma no longer applies"],
        openQuestions: ["Does the migration preserve ids?"],
      }),
      committedFeedbackRound(2, {
        loopId,
        wrongAssumptions: ["alpha was synchronous"],
        openQuestions: ["does the migration preserve ids?"],
      }),
    ];
    const memory = deriveWorkingMemory(historyOf(entries), 3);
    assert.deepEqual(memory.assumptions.map((item) => item.text), [
      "alpha was synchronous",
      "Beta is gone",
      "Gamma no longer applies",
    ]);
    assert.deepEqual(memory.openQuestions.map((item) => item.text), [
      "does the migration preserve ids?",
    ]);
  });

  it("closes open questions by stable id and keeps them closed", () => {
    const loopId = "resolved-question";
    const question = "Does the migration preserve ids?";
    const id = deriveOpenQuestionId(question);
    const entries = [
      committedFeedbackRound(1, { loopId, openQuestions: [question] }),
      committedFeedbackRound(2, { loopId, resolvedOpenQuestionIds: [id] }),
      committedFeedbackRound(3, { loopId, outputSummary: "continued" }),
    ];
    const memory = deriveWorkingMemory(historyOf(entries), 4);
    assert.deepEqual(memory.openQuestions, []);
  });

  it("keeps unresolved questions active beyond the recent report window", () => {
    const loopId = "long-lived-question";
    const question = "Does the migration preserve ids?";
    const id = deriveOpenQuestionId(question);
    const entries = [
      committedFeedbackRound(1, { loopId, openQuestions: [question] }),
      ...Array.from({ length: WORKING_MEMORY_WINDOW_ROUNDS }, (_, index) =>
        committedFeedbackRound(index + 2, { loopId })),
    ];

    const stillOpen = deriveWorkingMemory(historyOf(entries), entries.length + 1);
    assert.deepEqual(stillOpen.openQuestions.map((item) => item.id), [id]);

    entries.push(committedFeedbackRound(entries.length + 1, {
      loopId,
      resolvedOpenQuestionIds: [id],
    }));
    const resolved = deriveWorkingMemory(historyOf(entries), entries.length + 1);
    assert.deepEqual(resolved.openQuestions, []);
  });

  it("caps assumptions and questions", () => {
    const loopId = "caps";
    const entries = Array.from({ length: 4 }, (_, roundIndex) =>
      committedFeedbackRound(roundIndex + 1, {
        loopId,
        wrongAssumptions: Array.from({ length: 3 }, (_, i) =>
          `assumption ${roundIndex}-${i}`),
        openQuestions: Array.from({ length: 3 }, (_, i) =>
          `question ${roundIndex}-${i}`),
      }));
    const memory = deriveWorkingMemory(historyOf(entries), 5);
    assert.equal(memory.assumptions.length, WORKING_MEMORY_ASSUMPTION_LIMIT);
    assert.equal(memory.openQuestions.length, WORKING_MEMORY_QUESTION_LIMIT);
  });
});

describe("Working Memory sanitization and determinism", () => {
  it("normalizes control characters and blockquotes every Agent line", () => {
    const loopId = "sanitize";
    const entries = [committedFeedbackRound(1, {
      loopId,
      outputSummary: "line one\r\n\tline two\u0000\n\n\n## Fake heading\n`code`",
      wrongAssumptions: ["## Fake assumption"],
    })];
    const memory = deriveWorkingMemory(historyOf(entries), 2);
    const rendered = formatWorkingMemoryPrompt(memory, "l1");
    assert.ok(rendered);
    assert.ok(!rendered.body.includes("\r"));
    assert.ok(!rendered.body.includes("\t"));
    assert.ok(!rendered.body.includes("\u0000"));
    assert.match(rendered.body, /^> line one$/m);
    assert.match(rendered.body, /^> ## Fake heading$/m);
    assert.doesNotMatch(rendered.body, /^## Fake heading$/m);
  });

  it("does not create a phantom state-file section", () => {
    const loopId = "phantom";
    const entries = [committedFeedbackRound(1, {
      loopId,
      outputSummary: "## Fake heading\n### Also fake",
    })];
    const memory = deriveWorkingMemory(historyOf(entries), 2);
    const state = minimalState(memory);
    const markdown = renderCanonicalStateMarkdown(state);
    assert.match(markdown, /### Working Memory/);
    assert.match(markdown, /^> ## Fake heading$/m);
    assert.doesNotMatch(markdown, /^## Fake heading$/m);
    assert.ok(!markdown.includes("\n### Also fake\n\n## "));
  });

  it("is deterministic for the same committed history", () => {
    const loopId = "deterministic";
    const entries = [
      committedFeedbackRound(1, {
        loopId,
        outputSummary: "same report",
        wrongAssumptions: ["same assumption"],
        openQuestions: ["same question"],
      }),
      committedBacktrackRound(2, loopId, 1),
    ];
    const first = deriveWorkingMemory(historyOf(entries), 2);
    const second = deriveWorkingMemory(historyOf(entries), 2);
    assert.deepEqual(first, second);
    assert.equal(
      formatWorkingMemoryState(first).lines.join("\n"),
      formatWorkingMemoryState(second).lines.join("\n"),
    );
    // The state hash includes Working Memory, so the same committed history
    // produces the same state bytes and a different memory changes the hash.
    const stateA = minimalState(first);
    const stateB = minimalState(second);
    assert.equal(hashCanonicalState(stateA), hashCanonicalState(stateB));
    assert.equal(
      renderCanonicalStateMarkdown(stateA),
      renderCanonicalStateMarkdown(stateB),
    );
    const different = minimalState({
      ...first,
      reports: first.reports.slice(0, 0),
    });
    assert.notEqual(hashCanonicalState(stateA), hashCanonicalState(different));
  });

  it("keeps the state file at the full fixed window", () => {
    const memory = populatedMemory();
    const lines = formatWorkingMemoryState(memory).lines;
    const text = lines.join("\n");
    assert.match(text, /Earlier Committed Reports \(Agent reports\)/);
    // Five reports total: the latest plus four earlier.
    assert.equal((text.match(/^- R\d+ \(agent_success_claim=/gm) ?? []).length, 4);
    assert.equal((text.match(/^- R\d+ assumption:/gm) ?? []).length +
      (text.match(/^- R\d+ retracted constraint:/gm) ?? []).length, 6);
  });
});

describe("Working Memory prompt density and protection", () => {
  it("counts a newly required abbreviation notice inside the L0 memory budget", () => {
    const memory = populatedMemory();
    memory.reports = [{ ...memory.reports[0]!, outputSummary: "r".repeat(850), sourceChars: 850 }];
    memory.assumptions = [{ round: 1, kind: "wrong_assumption", text: "a".repeat(200) }];
    memory.openQuestions = [
      { id: "oq-11111111", round: 1, text: "q".repeat(190) },
      { id: "oq-22222222", round: 1, text: "p".repeat(190) },
    ];
    memory.recoveries = [];
    memory.redirects = [];
    memory.sourceCounts = {
      windowRounds: 1, reports: 1, assumptions: 1,
      openQuestions: 2, recoveries: 0, redirects: 0,
    };
    const rendered = formatWorkingMemoryPrompt(memory, "l0")!;
    assert.equal(rendered.projection.truncated, true);
    assert.match(rendered.body, /Working Memory is abbreviated/);
    assert.ok(rendered.body.length <= PROMPT_WORKING_MEMORY_DENSITY.l0.totalChars,
      `complete memory body must fit, got ${rendered.body.length}`);
    assert.equal(rendered.projection.renderedChars, rendered.body.length);
  });

  it("renders the full bounded projection for fresh levels and keeps L0 dense", () => {
    const memory = populatedMemory();
    for (const level of ["l0", "l1", "l2"] as const) {
      const rendered = formatWorkingMemoryPrompt(memory, level);
      assert.ok(rendered);
      const density = PROMPT_WORKING_MEMORY_DENSITY[level];
      for (const key of [
        "reports", "assumptions", "openQuestions", "recoveries", "redirects",
      ] as const) {
        assert.ok(rendered.projection.counts[key] <= density[key]);
      }
      if (level !== "l0") {
        assert.deepEqual(rendered.projection.counts, {
          reports: memory.reports.length,
          assumptions: memory.assumptions.length,
          openQuestions: memory.openQuestions.length,
          recoveries: memory.recoveries.length,
          redirects: memory.redirects.length,
        });
      }
      if (Number.isFinite(density.totalChars)) {
        assert.ok(rendered.body.length <= density.totalChars,
          `${level} body ${rendered.body.length} <= ${density.totalChars}`);
      }
      // Fresh L1/L2 contexts receive the complete fixed working-memory window.
      // L0 is a DENSITY level, not a context boundary: it renders the compact
      // view whether the delivery is clean-context or an in-context retry.
      assert.equal(rendered.projection.truncated, level === "l0");
      assert.equal(rendered.projection.renderedChars, rendered.body.length);
    }
  });

  it("truncates the latest report at a line boundary with a marker", () => {
    const long = Array.from({ length: 40 }, (_, index) =>
      `line ${index} ${"x".repeat(100)}`).join("\n");
    const memory: WorkingMemory = {
      reports: [{
        roundId: "loop:sanitize:round:1",
        round: 1,
        attempt: 1,
        agentSuccessClaim: false,
        agentOutcome: "partial",
        outputSummary: long,
        sourceChars: long.length,
      }],
      assumptions: [],
      openQuestions: [],
      recoveries: [],
      redirects: [],
      sourceCounts: {
        windowRounds: 1, reports: 1, assumptions: 0,
        openQuestions: 0, recoveries: 0, redirects: 0,
      },
    };
    const rendered = formatWorkingMemoryPrompt(memory, "l0");
    assert.ok(rendered);
    assert.match(rendered.body, /source=agent_report/);
    assert.match(rendered.body, /ref=loop:sanitize:round:1/);
    assert.ok(rendered.projection.previousReport?.truncated);
    assert.ok((rendered.projection.previousReport?.renderedChars ?? 0) <=
      WORKING_MEMORY_TEXT_LIMITS.latestReport);
    assert.match(rendered.body, /… \[truncated\]/);
  });

  it("keeps the per-text truncation flag when the total budget still fits", () => {
    const long = "x".repeat(1300);
    const memory: WorkingMemory = {
      reports: [{
        roundId: "loop:report:round:1",
        round: 1,
        attempt: 1,
        agentSuccessClaim: false,
        agentOutcome: "partial",
        outputSummary: long,
        sourceChars: long.length,
      }],
      assumptions: [],
      openQuestions: [],
      recoveries: [],
      redirects: [],
      sourceCounts: {
        windowRounds: 1, reports: 1, assumptions: 0,
        openQuestions: 0, recoveries: 0, redirects: 0,
      },
    };
    const rendered = formatWorkingMemoryPrompt(memory, "l0");
    assert.ok(rendered);
    assert.equal(rendered.projection.previousReport?.truncated, true);
    assert.equal(rendered.projection.truncated, true);
  });

  it("does not change coverage: Working Memory declares no normative ids", () => {
    const memory = populatedMemory();
    const state = minimalState();
    const base = assemblePromptArtifact({
      state,
      level: "l2",
      attempt: 1,
      selfEvaluationBlock: "",
      contextMode: "fresh_invocation",
      contextReason: "next_round",
    });
    const withMemory = assemblePromptArtifact({
      state,
      level: "l2",
      attempt: 1,
      selfEvaluationBlock: "",
      contextMode: "fresh_invocation",
      contextReason: "next_round",
      workingMemory: memory,
    });
    assert.deepEqual(withMemory.coverage.active, base.coverage.active);
    assert.deepEqual(withMemory.coverage.omitted, base.coverage.omitted);
    assert.equal(withMemory.coverage.complete, base.coverage.complete);
    assert.ok(withMemory.sections.includes("working_memory"));
    assert.ok(withMemory.workingMemory);
  });

  it("renders no section when there is no committed memory", () => {
    const memory: WorkingMemory = {
      reports: [],
      assumptions: [],
      openQuestions: [],
      recoveries: [],
      redirects: [],
      sourceCounts: {
        windowRounds: 0, reports: 0, assumptions: 0,
        openQuestions: 0, recoveries: 0, redirects: 0,
      },
    };
    assert.equal(hasWorkingMemoryContent(memory), false);
    assert.equal(formatWorkingMemoryPrompt(memory, "l2"), null);
  });

  it("is budgeted before lower-priority optional anchors", () => {
    const state = minimalState();
    state.reportedIssues = ["a reported blocker"];
    const artifact = assemblePromptArtifact({
      state,
      level: "l2",
      attempt: 1,
      selfEvaluationBlock: "",
      contextMode: "fresh_invocation",
      contextReason: "next_round",
      workingMemory: populatedMemory(),
    });
    const memoryIndex = artifact.sections.indexOf("working_memory");
    const blockersIndex = artifact.sections.indexOf("blockers");
    assert.ok(memoryIndex >= 0, "Working Memory is a rendered section");
    assert.ok(blockersIndex >= 0, "the optional anchor also fits");
    assert.ok(memoryIndex < blockersIndex,
      "Working Memory outranks optional anchors");

    const base = assemblePromptArtifact({
      state,
      level: "l2",
      attempt: 1,
      selfEvaluationBlock: "",
      contextMode: "fresh_invocation",
      contextReason: "next_round",
    });
    const footerChars = base.renderedPrompt.length - base.renderedChars;
    const tight = assemblePromptArtifact({
      state,
      level: "l2",
      attempt: 1,
      selfEvaluationBlock: "",
      contextMode: "fresh_invocation",
      contextReason: "next_round",
      workingMemory: populatedMemory(),
      budgets: { l2: base.renderedChars + footerChars },
    });
    assert.ok(!tight.sections.includes("working_memory"),
      "Working Memory is dropped when the whole prompt budget has no room");
    assert.ok(tight.droppedSections.includes("working_memory"));
    assert.equal(tight.protectedOverflow, false,
      "optional memory does not create protected overflow");
    assert.ok(tight.renderedChars <= tight.budget,
      "the assembled prompt stays within its configured section budget");
    assert.ok(tight.renderedChars <= base.renderedChars);
  });
});

describe("open_questions — report-only normalization", () => {
  it("caps at 3 entries × 300 chars and diagnoses the loss", () => {
    const long = "x".repeat(400);
    const normalized = normalizeSelfEvaluation({
      success: true,
      output_summary: "done",
      constraint_violations: [],
      should_continue: true,
      open_questions: ["one", "two", "three", "four", long],
    });
    assert.equal(normalized.evaluation.open_questions?.length, 3);
    assert.ok(normalized.evaluation.open_questions?.every(
      (question) => question.length <= 300));
    assert.ok(normalized.diagnostics.some((diagnostic) =>
      diagnostic.path === "open_questions" &&
      diagnostic.handling === "truncated"));
  });

  it("keeps an empty array valid", () => {
    const normalized = normalizeSelfEvaluation({
      success: true,
      output_summary: "done",
      constraint_violations: [],
      should_continue: true,
      open_questions: [],
    });
    assert.deepEqual(normalized.evaluation.open_questions, []);
    assert.equal(normalized.submittedFields.includes("open_questions"), true);
  });

  it("never enters the verification gate", () => {
    const base = makeSelfEvaluation({
      success: false,
      output_summary: "made progress",
      constraint_violations: [],
      should_continue: true,
    });
    const withQuestions = makeSelfEvaluation({
      ...base,
      open_questions: ["does the migration preserve ids?"],
    });
    assert.deepEqual(
      verifySelfEvaluation(withQuestions, 2, []),
      verifySelfEvaluation(base, 2, []),
      "open_questions must not create or suppress a verification flag",
    );
  });
});
