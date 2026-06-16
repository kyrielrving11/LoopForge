---
name: prompt-craft
description: >
  Core prompt engineering workflow. This skill should be used when the user
  wants to write, enhance, or iterate on a structured prompt for a complex
  task. It guides through LLM-based technique routing (independence ×
  cognitive load), history hydration, technique selection, prompt
  construction, vault checkpointing, and one-click execution or review.
  Use as the primary entry point for any prompt-crafting session.
---

# PromptCraft — Core Workflow

This skill is the main entry point for prompt engineering. It embeds an
LLM-as-a-Router that analyzes each task along two dimensions — independence
and cognitive load — to select the best prompt technique from a catalog of 7.
All state is persisted to `.promptcraft/prompt_vault.json` via the
`prompt-memory` skill's scripts.

## Prerequisites

Load `prompt-memory` alongside this skill. Load `prompt-techniques` references
on demand (Step 2). Do NOT pre-load all technique files.

### Script Paths

The paths below assume the standard install layout (`.codebuddy/skills/`).
If your skills are installed at a different location, adjust accordingly:
- **Installed**: `python .codebuddy/skills/prompt-memory/scripts/hydrate.py`
- **In this repo**: `python skills/prompt-memory/scripts/hydrate.py`
- **Custom**: use `--vault` and `--prompts-dir` flags on both scripts.

---

## Step 0: Boot Check — Load History

If `.promptcraft/prompt_vault.json` exists, execute:

```bash
python .codebuddy/skills/prompt-memory/scripts/hydrate.py --query "<user's current task description>" --top-k 3
```

The response contains two groups:

### `global_entries` — Always Inject (Unconditional)

Entries marked `summary.importance: "GLOBAL"` are **always returned** regardless of query
match. These represent cross-task long-term constraints — they MUST be injected into the
current session context unconditionally:

- **`hard_constraints`** — add to the base constraint set for every new prompt built in
  this session.
- **`summary.hard_constraints_added`** — merge into the global constraint baseline; these
  were explicitly vetted as long-term rules.
- **`summary.key_decisions`** — carry forward as established design boundaries.
- **`summary.summary_text`** — inject as background context so the LLM knows what prior
  sessions decided at the global level.
- **`summary.rejected_directions`** — avoid re-discussing these approaches.

### `results` — Top-K by Relevance

This returns compact results **with LLM-generated summaries** (no raw prompt text). Inject the
returned `summary` (goal, technique, key_decisions, hard_constraints_added, rejected_directions,
etc.), `hard_constraints`, and `execution_feedback` into the current context.

**When score > 0.75**, hydrate.py auto-injects the full `generated_prompt` alongside the summary.
This means a strongly related past task will have its complete prompt available without the user
needing to ask — but the raw text is protected for weakly related entries.

If the user explicitly asks to **reuse a previously saved prompt**, use `--full`:

```bash
python .codebuddy/skills/prompt-memory/scripts/hydrate.py --query "<task description>" --full --top-k 1
```

This returns the complete `generated_prompt` text alongside metadata and summary.

If no vault exists, skip to Step 1.

---

## Step 1: LLM Router — Pre-Intent Judgment

Before constructing any prompt, analyze the user's request. Use the embedded
router system prompt below as your internal reasoning guide. Do NOT output the
JSON — think through the dimensions internally and proceed to the next step
with your selected technique.

### Router System Prompt (internal reasoning)

```
You are a high-performance instruction dispatcher for a coding Agent.
Analyze the user's current technical request along two dimensions and select
the best technique from the skill library.

【Skill Library】
- zero-shot: Simple code explanation, formatting, rename variables (low load, high continuity).
- few-shot: Standard CRUD modules, routine unit tests (medium load, fixed patterns).
- zero-shot-cot: Multi-step reasoning without examples (medium-high load).
- few-shot-cot: Reasoning relay when user has provided complete reasoning examples — input→reasoning→output triples (high load, continuous).
- step-back: Vague errors, messy legacy refactoring — abstract principles first (high load, independent).
- least-to-most: Large multi-step modules that decompose into 4-6 ordered subproblems with clear dependencies — user has NOT provided reasoning examples (high load, continuous).
- tree-of-thought: Core algorithms, crypto/signature verification, Assembly ops (high risk, strong independence, high load).

【Reasoning Steps】
1. Independence analysis: Is this a modification of existing context (continuous) or a completely new, self-contained feature (independent)?
2. Cognitive load evaluation: Does this involve low-level EVM, concurrency, security auditing (high), standard CRUD (medium), or simple changes (low)?
3. For Continuous + High: check whether the user has provided reasoning examples from prior context. If yes → few-shot-cot. If the task naturally decomposes into ordered subproblems (e.g. compiler stages, data pipeline) → least-to-most. If both → prefer few-shot-cot. If neither → fall back to zero-shot-cot.
4. Select the best match. Read references/technique-routing-matrix.md for detailed decision table.

【If Independent + High Cognitive Load】
Actively ignore prior conversation content unrelated to the current task.
Keep only: vault hard_constraints, current file context, technical stack info.
```

---

## Step 2: Read Technique Details

Read the reference file for your selected technique from
`.codebuddy/skills/prompt-techniques/references/<technique>.md`.
For `zero-shot-cot` or `few-shot-cot`, read `chain-of-thought.md`.
Read only the ONE file needed — do not load all references.

Extract the `method_steps`, `purpose`, and `design_rules`. Use them to guide
prompt construction.

---

## Step 2.5: Case Generation (Conditional)

### Detection: Does the User Provide Domain Knowledge?

Before generating any cases, check whether the user has provided domain-specific
knowledge in the current session. Domain knowledge includes:

- Sample data with real field names and values (e.g., JSON/CSV records, API payloads)
- Reference ranges or validation rules (e.g., "heart rate normal range: 60-100 bpm")
- Field or entity definitions (e.g., "Patient has fields: name, age, gender, vitalSigns")
- Existing input→output example pairs
- Domain-specific documents, specifications, or API docs
- A minimal MVP or reference implementation file

**If domain knowledge IS present** → proceed to Case Generation below. Use the
user-provided fields, data types, and values as the basis for all generated
cases. Cases MUST stay in the SAME domain as the user's task — do NOT substitute
similar-domain proxies (e.g., nursing assessment for a vital signs task).

**If NO domain knowledge is present** → skip case generation entirely. Tell the user:

> 我没有你任务领域的可靠知识，无法为你生成准确的格式参考案例。我会直接进入 Step 3
> 构建提示词，届时你可以在 Section 5（格式参考示例）中自行填入你期望的输入→输出样例。

Then jump directly to Step 3.

### Case Generation by Technique (only when domain knowledge is available)

| Technique | What to Generate | How |
|-----------|-----------------|-----|
| **Zero-Shot** | Nothing needed | Skip directly to Step 3. |
| **Few-Shot** | 2-3 input→output pairs | Using the user-provided domain data (fields, types, values), generate 2-3 input→output pairs that match the exact same domain. Follow the Case Injection Pipeline in `few-shot.md`: detect → validate → format → inject. Do NOT invent fields or values from a different domain. |
| **Zero-Shot-CoT** | Reasoning skeleton | Generate the structure "先推理 → 再答案" as a format hint (not a full example). Show the model where to put reasoning and where to put the answer, without providing actual reasoning content. |
| **Few-Shot-CoT** | 2-3 input→reasoning→output triples | Using the user-provided domain data, generate complete triples where `reasoning` shows key intermediate steps for those specific domain fields. Follow the Case Rules in `chain-of-thought.md`. If unable to generate quality reasoning steps, fall back to Zero-Shot-CoT with notice. |
| **Step-Back** | A stepback question + abstraction principles | From the user's concrete task, abstract upward within the SAME domain to identify the relevant higher-level principle, framework, or generic question. Generate: (a) the stepback question, (b) the applicable principles/concepts/facts grounded in the user's domain context. Follow the tightening rules in `step-back.md`. |
| **Least-to-Most** | 2-5 ordered subproblems with dependencies | Decompose the user's task into ordered subproblems using the user's actual domain entities and fields — not generic placeholder names. Label dependencies (e.g., "子问题 B 依赖 A 的输出"). Ensure the last subproblem is equivalent to the original task. Follow the design rules in `least-to-most.md`. |
| **Tree-of-Thought** | 2-4 candidate branches + evaluation criteria + pruning rules | Generate candidate solution paths grounded in the user's domain, define evaluation criteria per branch (correctness, feasibility, constraints, risk), specify pruning rules, and decide the merge/selection method. Set branch_count, max_depth, keep_count conservatively. Choose a search strategy (beam/dfs/expert-panel) based on task type. Follow `tree-of-thought.md`. |

### Output Format (only when cases were generated)

Present the generated cases to the user in a clearly marked section **before**
the final prompt:

```
## Generated Cases

[technique-specific cases here]
```

Ask the user: **"Do these cases look correct? Verify they use your domain's
actual fields and data — not values from a different domain. You can adjust
them before I build the final prompt."** Wait for brief confirmation, then
proceed to Step 3 with the user-approved cases embedded.

If the user modifies the cases, incorporate their changes. If the user rejects
them entirely, regenerate with adjusted parameters.

---

## Step 3: Build the Enhanced Prompt

Construct a complete, enhanced prompt following the selected technique's
method steps. Embed the cases — either those generated from user-provided
domain knowledge in Step 2.5, or examples the user supplies now.

### REQUIRED Structure (this exact order)

The final prompt MUST follow this section order — verified against MCP-era
high-quality outputs:

1. **角色 (Role)** — A clear, specific role assignment. Include domain and tech stack.
2. **任务 (Task)** — The user's intent, stated unambiguously. One sentence.
3. **输入 (Input)** — The target data, code, file, or scenario the model will operate on.
4. **输出格式 (Output Format)** — Numbered list of concrete deliverables (e.g., "1. DDL, 2. API interface, 3. Core logic, 4. Validation, 5. Tests").
5. **格式参考示例 (Format Reference Examples)** — Cases from Step 2.5 (if generated from user domain knowledge) or user-provided examples. For Few-Shot: 2-3 input→output pairs with mapping rules. For CoT: input→reasoning→output triples. For Step-Back: stepback question + abstraction principles. For Least-to-Most: ordered subproblems with dependencies. For ToT: candidate branches + evaluation criteria. If neither source is available, leave this section as `[待用户填写]` and ask the user to provide examples.
6. **具体实现要求 (Detailed Implementation Requirements)** — Numbered subsections, one per deliverable from the Output Format. Each subsection specifies exactly what to implement: data models, API signatures, business logic flow, edge cases, code structure.
7. **硬约束 (Hard Constraints)** — Numbered, non-negotiable rules. Include tech stack, frameworks, validation ranges, code style, and constraints from the vault.
8. **生成要求 (Generation Requirements)** — Numbered final acceptance criteria: what "done" means, quality gates, format compliance rules.

### CRITICAL Rules

- **Never** put examples/cases before Input — the model needs to know what to operate on before seeing how others did it.
- **Never** use meta-examples (examples of prompt design). Cases in section 5 must be examples of the **desired output** — real input→output pairs that show what the generated code/result should look like.
- **For Few-Shot**: the examples in section 5 are task-domain examples (e.g., API request→response pairs), NOT examples of how to write a prompt.
- After construction, run through the checklist in `references/prompt-structure-checklist.md` before presenting to the user.

Present the enhanced prompt to the user in a clearly marked code block.

---

## Step 4: Save to Vault (Dual Storage)

The vault uses a **dual-storage** architecture:

```
.promptcraft/
├── prompt_vault.json              ← lightweight metadata index
│   (task_id, version_tag, skill_used, user_intent, hard_constraints,
│    key_decisions, generated_prompt_preview, md_path, ...)
└── prompts/
    └── <task_id>/
        └── v1.md                  ← complete prompt (Markdown, human-readable)
```

- **JSON vault**: metadata-only index — fast to search, tiny context footprint (~200 tokens)
- **MD files**: the complete generated prompt — readable, version-friendly, git-diffable

Execute checkpoint.py to persist. Write the payload to a temp JSON file (method 2, recommended for prompts with special characters), then:

```bash
python .codebuddy/skills/prompt-memory/scripts/checkpoint.py --input /path/to/temp_entry.json
```

### Step 4.0: Generate LLM Summary (before checkpoint)

**Before** calling checkpoint.py, you MUST generate a structured summary of the constructed
prompt. Read the complete `generated_prompt` and produce a summary JSON following the rules below.
The summary MUST NOT contain raw prompt text — it stores conclusions, not excerpts.

**Summary Schema (10 fields):**

```json
{
  "goal": "一句话任务目标",
  "technique": "使用的技法",
  "importance": "GLOBAL|STAGE|WORKING|REFERENCE",
  "what_was_done": ["已完成的关键动作"],
  "key_decisions": ["已确定的设计/边界/取舍"],
  "hard_constraints_added": ["新增的长期强约束（已和全局hard_constraints去重）"],
  "rejected_directions": ["明确否定的路线"],
  "important_outputs": ["可复用产物路径或名称"],
  "open_questions": ["仍需解决的问题"],
  "summary_text": "2-3句自然语言摘要，总结真实沉淀"
}
```

**Compaction Rules (9 rules — must follow):**

1. 只保存任务级资产，不保存完整聊天记录或临时寒暄。
2. `summary_text` 必须概括真实沉淀，不要简单复读 `goal`。
3. `key_decisions` 只记录已经确定的设计、边界、取舍或接口约定。
4. `important_outputs` 只记录可复用产物（文件路径、模块名、测试结论等）。
5. `hard_constraints_added` 只记录本次新增的长期强约束，必须与全局 `hard_constraints` 去重。若没有新增，使用空数组 `[]`。
6. `rejected_directions` 记录明确否定的路线，避免后续会话重复讨论。
7. `open_questions` 记录仍需用户或后续阶段解决的问题。
8. 如果没有关键决策，`key_decisions` 使用空数组 `[]`。
9. **任何字段都不能包含原始提示词文本** — summary 仅用于检索，完整提示词存在 `.md` 文件中。

**importance 分级参考：**

| 级别 | 含义 | 示例 |
|------|------|------|
| `GLOBAL` | 跨任务长期约束，后续所有任务都应知晓。**标记为 GLOBAL 的条目将在每次 hydrate.py 查询时无条件返回。** | "必须零外部依赖"、"所有合约须过 Slither" |
| `STAGE` | 当前任务范围内的关键决策 | "采用 5×5 风险矩阵作为统一评分标准" |
| `WORKING` | 施工中，仍有调整空间 | "先完成 Module A 再扩展 Module B" |
| `REFERENCE` | 可查阅但不注入上下文 | "参考了 OWASP 智能合约 Top 10" |

Include the summary in the checkpoint payload as the `summary` field. Example temp entry:

```json
{
  "task_id": "smart-contract-audit",
  "user_intent": "审计 ERC-20 合约的权限控制逻辑",
  "generated_prompt": "<complete enhanced prompt text>",
  "skill_used": "tree-of-thought",
  "hard_constraints": ["零外部依赖", "必须通过 Slither"],
  "key_decisions": ["采用 5×5 风险矩阵"],
  "summary": {
    "goal": "审计 ERC-20 合约的权限控制逻辑，检测增发/销毁/转移权漏洞",
    "technique": "tree-of-thought",
    "importance": "GLOBAL",
    "what_was_done": ["构造3个多签绕过攻击场景", "逐分支评分"],
    "key_decisions": ["采用5×5风险矩阵作为统一评分标准"],
    "hard_constraints_added": ["必须通过 Slither"],
    "rejected_directions": ["不采用模糊测试（Gas成本过高）"],
    "important_outputs": ["漏洞清单v1"],
    "open_questions": [],
    "summary_text": "通过ToT多分支分析，检出3个高危权限漏洞。核心决策是统一用5×5风险矩阵评分，否定了模糊测试方案因为Gas不可控。"
  }
}
```

The payload MUST include:
- `task_id` (required) — kebab-case identifier
- `user_intent` (required) — the user's original task goal
- `generated_prompt` (recommended) — the complete prompt text; will be written to `<md_path>` and NOT stored inline in JSON
- `skill_used` — the selected technique
- `hard_constraints` — non-negotiable rules
- `key_decisions` — key decisions made during construction
- `summary` (recommended) — LLM-generated structured summary from Step 4.0

checkpoint.py will:
1. Write `generated_prompt` → `.promptcraft/prompts/<task_id>/<version_tag>.md`
2. Store `md_path` + `generated_prompt_preview` (200 chars) + `summary` in the JSON index

**Version bump for existing task:**

```bash
echo '{"task_id":"<existing-task-id>","generated_prompt":"<updated full prompt>",...}' | \
  python .codebuddy/skills/prompt-memory/scripts/checkpoint.py --version-of <task_id>
```

Ask the user for a `task_id` if one was not provided. Generate a reasonable
kebab-case `task_id` as a suggestion.

**Retrieval**: later sessions can load:

- Compact metadata (for context injection): `hydrate.py --query "<description>"`
- Complete prompt (for reuse): `hydrate.py --query "<description>" --full --top-k 1`

CRITICAL: Step 4 runs BEFORE Step 5. Whether the user selects "Execute", "Save", or "Review", the prompt is already persisted. Never skip Step 4.

---

## Step 5: Action Selection

After saving, present three options to the user:

1. **"Execute this prompt now"** — Immediately use the enhanced prompt in the current
   session to complete the user's task. No copy-paste, no new session needed.

2. **"Save and use later"** — The complete prompt (not just a summary) has been saved
   to the vault (Step 4). It can be loaded in a future session with:
   `hydrate.py --query "<description>" --full`.

3. **"Review and improve"** — Load the `prompt-review` skill to check completeness,
   identify missing constraints, and suggest improvements. Improved versions are
   automatically appended as new versions to the vault.

---

## Anti-Patterns

- Do NOT execute the user's task before building the prompt — build the prompt first.
- Do NOT skip the router step and default to zero-shot — always evaluate independence and load.
- Do NOT load all technique references at once — only the selected one.
- Do NOT overwrite existing vault entries — checkpoint.py appends new versions.
- Do NOT include internal routing details or candidate pools in the final prompt — only the
  visible business context.
- Do NOT auto-generate cases when the user hasn't provided domain knowledge (sample data,
  field definitions, reference ranges, or input→output examples). Guessing domain values
  without domain context produces wrong cases that pollute the vault and mislead future
  retrieval. Instead, skip Step 2.5 and let the user fill Section 5 in Step 3.
