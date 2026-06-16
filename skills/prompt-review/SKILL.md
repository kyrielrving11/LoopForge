---
name: prompt-review
description: >
  Prompt quality review and improvement. This skill should be used when the
  user wants to check an existing prompt for completeness, identify missing
  constraints or anti-patterns, and produce an improved version. The improved
  version is saved as a new version to the vault — never overwriting the
  original.
---

# Prompt Review & Improvement

This skill audits an existing enhanced prompt for completeness,
anti-patterns, and missing elements. Improved versions are appended
as new entries to the vault via checkpoint.py — the original is preserved.

## Prerequisites

If `.promptcraft/prompt_vault.json` exists, load relevant history to inform
the review:

```bash
python .codebuddy/skills/prompt-memory/scripts/hydrate.py --query "<the prompt's task description>" --top-k 3
```

This surfaces prior versions of the same task (for diff comparison) and GLOBAL
constraints (to verify they were honored). Pay attention to `execution_feedback`
from prior versions — it tells you what actually went wrong when the prompt was
run.

---

## Workflow

### Step 1: Load the Prompt

Identify the prompt to review. This could be:
- A prompt just produced by `prompt-craft` in the current session.
- A prompt loaded from the vault via `hydrate.py --full`.
- A prompt the user pastes directly.

Always confirm with the user which prompt is being reviewed before starting.

### Step 2: Determine the Technique

Identify which technique was used to build the prompt (zero-shot, few-shot,
zero-shot-cot, few-shot-cot, step-back, least-to-most, tree-of-thought).
If the technique is unclear, ask the user.

Read the corresponding reference file from `prompt-techniques/references/` for
the technique's **Prompt Output Template** and **Design Rules**. The review
must verify alignment with the technique's specific section structure — not
just generic completeness.

### Step 3: Audit Against Checklist

Read `references/review-checklist.md`. Audit the prompt against each category:

1. **Completeness** — Role, Task, Input, Output Format present?
2. **Constraints** — Hard constraints explicit? Negative constraints listed? Scope bounded?
3. **Technique Fit** — Does the prompt's structure match the technique's method_steps and output template?
4. **Context Quality** — Self-contained? No irrelevant history? Vault constraints honored?
5. **Anti-Patterns** — Generic advice without concrete "how"? Mixed tasks? Implicit environment?
6. **Edge Cases & Safety** — Security boundaries? Error handling? Ambiguous terms?

### Step 4: Report Findings

Present findings as a structured report with four sections:

1. **✅ Passing** — Elements the prompt handles well. Be specific (e.g. "Section 5
   examples use real domain data correctly, not meta-examples").
2. **❌ Missing** — Required elements that are absent. Tag each with severity:
   - `[BLOCKER]` — Core element missing (no role, no task, no input, no output format)
   - `[MAJOR]` — Technique mismatch, critical constraint missing, hard constraint violated
   - `[MINOR]` — Style improvement, optional enhancement, wording clarity
3. **⚠️ Risky** — Anti-patterns or potential issues that could cause the prompt to
   produce wrong output. Include WHY it's risky.
4. **💡 Suggestions** — Concrete rewrites or additions. Quote the original text and
   show the suggested replacement side-by-side when helpful.

**Severity judgment examples:**

| Finding | Severity |
|---------|----------|
| No Role defined | BLOCKER |
| Output Format is "give me good code" (no structure) | BLOCKER |
| Prompt is zero-shot but contains 3 full examples → technique mismatch | MAJOR |
| GLOBAL hard constraint "zero external dependencies" not included | MAJOR |
| Section 6 (具体要求) expands by subproblem instead of output format item | MAJOR |
| "Be careful with edge cases" without listing which edge cases | MINOR |
| Section numbering is off by one | MINOR |

### Step 5: Offer Improvement

After the report, ask the user: **"Apply improvements and save as a new version?"**

If yes:
1. Produce the improved prompt with all BLOCKER and MAJOR findings addressed.
   MINOR findings are at the user's discretion — ask if they want them applied too.
2. **Generate a structured summary** following the same schema and 9 compaction
   rules as `prompt-craft` Step 4.0. Read the improved prompt and produce a
   summary JSON with `goal`, `technique`, `importance`, `what_was_done`,
   `key_decisions`, `hard_constraints_added`, `rejected_directions`,
   `important_outputs`, `open_questions`, and `summary_text`. Include the review
   findings in `what_was_done` (e.g. "基于 review checklist 审计后修复了3个缺失项").
   Set `importance` to the same level as the original (unless the review
   elevated it — e.g. a prompt that was WORKING but is now proven GLOBAL).
3. Run checkpoint.py with `--version-of <task_id>` to save as a new version,
   and include the `summary` field and the review report in `execution_feedback`.

```bash
echo '{"task_id":"...","skill_used":"...","user_intent":"...","execution_feedback":"<review findings>","summary":{...}}' | \
  python .codebuddy/skills/prompt-memory/scripts/checkpoint.py --version-of <task_id>
```

4. Report the new `version_tag` and confirm the original is intact.

If no:
- The review report itself is still valuable context. Ask if the user wants to
  save the report as a new version's `execution_feedback` for future sessions.

---

## Technique-Specific Review Guidance

Each technique has its own failure modes. When reviewing, verify:

### Zero-Shot
- [ ] Total length ≤ 100 lines
- [ ] No examples, no reasoning frames, no "示例" section
- [ ] Output format is a skeleton (field names), not concrete examples
- [ ] Exactly 7 sections (section 5 omitted)

### Few-Shot
- [ ] Section 5 has 2-3 input→output pairs with mapping rules
- [ ] Examples are task-domain real data, NOT meta-examples of prompt design
- [ ] Mapping rule summary box (ASCII) present after all examples
- [ ] Output format items match specific-requirements subsections 1:1

### Zero-Shot-CoT
- [ ] Section 5 is a reasoning skeleton (step names only, no concrete content)
- [ ] Trigger phrase present: "Let's think step by step" or equivalent
- [ ] Reasoning and final answer output positions clearly separated

### Few-Shot-CoT
- [ ] Section 5 has 1-2 input→reasoning→output triples
- [ ] Reasoning shows key intermediate steps, not "because obviously"
- [ ] Reasoning pattern migration box (ASCII) present
- [ ] Triples share the same domain as the target task

### Step-Back
- [ ] Section 5 has 2-3 abstraction framework ASCII boxes
- [ ] Frameworks are at the same abstraction level (not mixed concrete + abstract)
- [ ] Section 6 starts with transition sentence "基于上述抽象框架..."
- [ ] Stepback questions are tightened (not too broad, not too narrow)

### Least-to-Most
- [ ] Section 5 has 4-6 ordered subproblems
- [ ] Each subproblem declares its dependency on prior subproblems
- [ ] Last subproblem is "综合实现完整模块"
- [ ] Section 6 expands by output format items, NOT by subproblems
- [ ] Subproblem order is strictly dependency-driven (simple → complex)

### Tree-of-Thought
- [ ] Section 5 has search strategy declaration + evaluation criteria table + state table format
- [ ] Branch count 2-4, depth ≤ 3
- [ ] Evaluation criteria include correctness, feasibility, constraint-matching
- [ ] Hard constraints ranked first in evaluation criteria
- [ ] Not just "3 experts chatting" — has explicit branch/score/prune rules

---

## Anti-Patterns

- Do NOT review a prompt without first identifying which technique it uses.
- Do NOT suggest "add more examples" for a zero-shot prompt — that would
  change the technique.
- Do NOT overwrite the original — checkpoint.py always appends new versions.
- Do NOT apply MINOR fixes without user confirmation if they change the
  prompt's style or tone significantly.
- Do NOT mark a finding as BLOCKER just because you disagree with the
  technique choice — only if the prompt is actually broken.
- If the review uncovers that the WRONG technique was chosen, flag as MAJOR
  and suggest re-running prompt-craft with the correct technique.

## Notes

- The ORIGINAL version is NEVER overwritten. checkpoint.py always appends.
- This skill can be loaded independently (without prompt-craft) when reviewing
  an existing prompt from the vault or from the user.
- If the prompt was generated without domain knowledge (Step 2.5 skipped),
  pay extra attention to Section 5 — it may be `[待用户填写]` and that is
  expected, not a defect.
- Past `execution_feedback` from hydrate.py is gold — it tells you what
  actually broke at runtime, not just what looks wrong on paper.
