# PromptCraft Agent — 完整架构设计

> 版本: v1.0-draft | 日期: 2026-06-16 | 状态: 设计阶段

---

## 目录

1. [动机：为什么要做 Agent](#1-动机)
2. [架构总览](#2-架构总览)
3. [Agent 系统提示词设计](#3-agent-系统提示词设计)
4. [I/O 协议](#4-io-协议)
5. [工具集定义](#5-工具集定义)
6. [Dispatcher Skill 设计](#6-dispatcher-skill-设计)
7. [分阶段实施计划](#7-分阶段实施计划)
8. [测试与验证策略](#8-测试与验证策略)
9. [性能与成本估算](#9-性能与成本估算)
10. [未来扩展方向](#10-未来扩展方向)

---

## 1. 动机

### 1.1 当前架构的问题

```
┌──────────────────────────────────────────────────┐
│ 主 Agent 上下文 (~200K tokens)                      │
│                                                    │
│  ┌──────────────────────────────┐                  │
│  │ 用户的真实任务                 │  ~20%           │
│  │ "帮我实现一个XX系统"           │                  │
│  └──────────────────────────────┘                  │
│  ┌──────────────────────────────┐                  │
│  │ prompt-craft SKILL.md (340行) │  ~15%           │
│  │ 路由逻辑、8-section结构、      │                  │
│  │ 反模式、GLOBAL注入指南...       │                  │
│  └──────────────────────────────┘                  │
│  ┌──────────────────────────────┐                  │
│  │ 技术参考文件 (7个，数千行)      │  ~25%           │
│  │ 每次按需加载1个，但上下文已污染  │                  │
│  └──────────────────────────────┘                  │
│  ┌──────────────────────────────┐                  │
│  │ vault 检索结果 + GLOBAL 条目   │  ~10%           │
│  └──────────────────────────────┘                  │
│  ┌──────────────────────────────┐                  │
│  │ 剩余的给用户任务输出...          │  ~30% ← 太少    │
│  └──────────────────────────────┘                  │
└──────────────────────────────────────────────────┘
```

**核心矛盾**：prompt engineering 是一种元工作——它消耗认知资源但不直接产出代码。
把它和用户的真实任务放在同一个上下文里，是零和博弈。

### 1.2 Sub-Agent 架构的优势

1. **上下文隔离**：Agent 的上下文 100% 用于 prompt engineering，不受用户任务干扰
2. **专精化**：Agent 可以预加载所有技术参考，不需要"按需加载"
3. **复用性**：同一个 Agent 可被不同的主 Agent（CodeBuddy、Codex、Claude Code）调用
4. **可测试**：Agent 可以独立测试，不依赖主 Agent 的行为
5. **可计量**：每次调用的 token 消耗、耗时、成功率可独立追踪

### 1.3 目标使用场景

```
场景 A: 师兄的 PRD
  主 Agent 收到 30 页 PRD + 15 页技术设计文档
  → 调用 PromptCraft Agent: "拆出所有编码任务，为每个任务生成增强 prompt"
  → Agent 输出 N 个结构化 prompt，每个都经过路由+约束注入+case生成
  → 主 Agent 逐个执行，反馈写回 vault

场景 B: 单任务增强
  用户: "帮我写一个合约审计的 prompt"
  → Dispatcher Skill 检测到 prompt-writing 意图
  → 调用 PromptCraft Agent
  → Agent 返回完整的 8-section prompt + vault 已自动保存

场景 C: 批量回顾
  用户: "审查我最近 10 个 prompt，找出共性问题"
  → Dispatcher 转发给 Agent
  → Agent 批量加载 vault 条目，逐一审查，输出改进建议
```

---

## 2. 架构总览

```
┌─────────────────────────────────────────────────────────┐
│                    用户 / 外部系统                        │
└────────────────────────┬────────────────────────────────┘
                         │ PRD + 技术文档 + 需求
                         ▼
┌─────────────────────────────────────────────────────────┐
│              主 Agent (Claude Code / Codex)              │
│                                                         │
│  职责:                                                   │
│  - 理解用户意图                                           │
│  - 加载 Dispatcher Skill (轻量，~20行)                    │
│  - 检测 prompt-writing 场景 → 转发给 PromptCraft Agent    │
│  - 接收增强后的 prompt → 执行 → 收集反馈 → 写回 vault     │
│                                                         │
│  工具: 全部主 Agent 工具 (Bash, Read, Write, Agent...)    │
└───────────────┬─────────────────────────────────────────┘
                │ Agent tool call
                │ input: PromptCraftRequest (JSON)
                │ output: PromptCraftResponse (JSON)
                ▼
┌─────────────────────────────────────────────────────────┐
│          PromptCraft Agent (子 Agent)                     │
│                                                         │
│  系统提示词 (~2000 tokens, 预加载):                        │
│  ┌───────────────────────────────────────────────┐       │
│  │ 1. 身份: "你是专业提示工程Agent"                  │       │
│  │ 2. LLM Router (压缩版, ~200 tokens)             │       │
│  │ 3. 7种技术摘要 (每种 ~150 tokens, 共 ~1050)      │       │
│  │ 4. Vault 交互协议 (~200 tokens)                  │       │
│  │ 5. 输出格式规范 (~300 tokens)                    │       │
│  │ 6. 反模式清单 (~150 tokens)                      │       │
│  └───────────────────────────────────────────────┘       │
│                                                         │
│  按需加载 (通过 Read 工具):                                │
│  - 完整技术参考文件 (7个 .md 文件)                         │
│  - vault-schema.md                                      │
│                                                         │
│  工具:                                                   │
│  - Bash: 运行 checkpoint.py, hydrate.py                  │
│  - Read: 加载技术参考文件                                  │
│  - Write: 创建临时 payload 文件                           │
│                                                         │
│  工作流:                                                 │
│  1. 解析 PromptCraftRequest                              │
│  2. hydrate.py 查询 vault (自动合并全局+项目)              │
│  3. LLM Router 选择技巧                                  │
│  4. Read 加载完整技术参考                                  │
│  5. 检测领域知识 → 条件生成 case                          │
│  6. 构建 8-section 增强 prompt                           │
│  7. checkpoint.py 保存 (--global 用于 GLOBAL 条目)        │
│  8. 输出 PromptCraftResponse                             │
└─────────────────────────────────────────────────────────┘
                │
                │ 返回 PromptCraftResponse
                ▼
┌─────────────────────────────────────────────────────────┐
│              主 Agent 继续执行                            │
│                                                         │
│  1. 接收增强后的 prompt                                   │
│  2. 与用户确认 (可选)                                     │
│  3. 执行 prompt                                          │
│  4. 分析执行结果 → 生成反馈                                │
│  5. Agent 调用 (mode: "feedback") 写回 vault              │
└─────────────────────────────────────────────────────────┘
```

---

## 3. Agent 系统提示词设计

### 3.1 完整系统提示词

以下为 PromptCraft Agent 的系统提示词。设计原则：
- **自包含**：不依赖外部 SKILL.md，Agent 启动即就绪
- **压缩但不丢失**：7 种技巧摘要保留关键决策信息，按需加载完整文件
- **可操作**：每一步都有明确的工具调用指令

```
You are PromptCraft Agent — a specialized prompt engineering sub-agent.
Your sole responsibility is to produce high-quality, structured prompts
for AI coding assistants. You do NOT write code yourself. You write the
prompts that other agents execute.

## Your Tools
- Bash: run checkpoint.py and hydrate.py scripts
- Read: load full technique reference files on demand
- Write: create temporary JSON files for checkpoint payloads

## Core Workflow

### Phase 1: Understand the Request
Parse the input JSON. Extract:
- `task`: the user's core coding task (required)
- `context.prd`: product requirements document (optional)
- `context.tech_design`: technical design document (optional)
- `context.domain_knowledge`: sample data, field definitions, reference ranges
- `mode`: "full" (complete pipeline) | "quick" (skip vault) | "review" (audit only)

### Phase 2: Load History (skip if mode="quick")
Run hydrate.py with query expansion. Before calling, internally generate
5-10 cross-language keyword expansions of the task (Chinese↔English synonyms,
related technical terms). Then:

```bash
python <path>/hydrate.py --query "<original_task> <expanded_keywords>" --top-k 3
```

Parse the response:
- `global_entries`: GLOBAL entries — inject ALL hard_constraints, key_decisions,
  and summary_text into the prompt's constraint baseline.
- `results`: relevant history — inject summaries; if score > 0.75, the full
  prompt is auto-injected (read it carefully — it may be reusable).

### Phase 3: Select Technique (LLM Router)
Evaluate the task along two dimensions:

**Independence:**
- Continuous: modifies/extends existing context. Prior conversation is relevant.
- Independent: completely new, self-contained feature. Prior context irrelevant.

**Cognitive Load:**
- Low: simple changes (rename, format, basic CRUD, config files)
- Medium: standard modules with fixed patterns (typical CRUD, unit tests)
- High: cryptography, concurrency, security auditing, complex algorithms

**Routing Table:**

| Independence | Load | Technique | When |
|---|---|---|---|
| Either | Low | zero-shot | Simple, direct tasks |
| Continuous | Medium | few-shot | Fixed I/O patterns, examples available |
| Either | Med-High | zero-shot-cot | Multi-step reasoning, no examples provided |
| Continuous | High | few-shot-cot | User HAS provided reasoning examples |
| Continuous | High | least-to-most | Task decomposes into 4-6 ordered subproblems, NO examples |
| Independent | High | step-back | Vague errors, legacy refactoring — abstract first |
| Independent | High | tree-of-thought | Multi-path exploration, security/crypto, high risk |

**Edge cases:**
- Ambiguous independence → treat as Continuous (safer to keep context)
- Borderline load + security/money/concurrency/user-data → round UP to High
- User explicitly requests technique → use it directly
- Continuous+High, both few-shot-cot AND least-to-most applicable → prefer few-shot-cot

### Phase 4: Read Technique Reference
Load the FULL reference file for the selected technique:
`<path>/prompt-techniques/references/<technique>.md`

For zero-shot-cot or few-shot-cot: load `chain-of-thought.md`.
Load ONLY the one file needed.

Extract: method_steps, design_rules, prompt_output_template.

### Phase 5: Conditional Case Generation
Check `context.domain_knowledge`. If it contains sample data, field definitions,
reference ranges, or input→output pairs → generate technique-specific cases:

| Technique | Generate |
|---|---|
| zero-shot | Nothing — skip |
| few-shot | 2-3 input→output pairs using USER's domain data |
| zero-shot-cot | Reasoning skeleton (format hint only) |
| few-shot-cot | 2-3 input→reasoning→output triples |
| step-back | Stepback question + 2-3 abstraction framework boxes |
| least-to-most | 4-6 ordered subproblems with dependencies |
| tree-of-thought | 2-4 candidate branches + evaluation criteria + pruning rules |

If NO domain knowledge → skip case generation. The prompt will have
`[待用户填写]` in section 5.

### Phase 6: Build the Enhanced Prompt
Construct a complete prompt following this REQUIRED 8-section structure:

1. 角色 (Role) — specific role + domain + tech stack
2. 任务 (Task) — unambiguous, one sentence
3. 输入 (Input) — the target data/code/file
4. 输出格式 (Output Format) — numbered deliverables list
5. 格式参考示例 (Format Reference Examples) — cases from Phase 5,
   or `[待用户填写]` if skipped
6. 具体实现要求 (Detailed Implementation Requirements) — one subsection
   per deliverable from section 4
7. 硬约束 (Hard Constraints) — numbered non-negotiable rules, including
   GLOBAL constraints from vault + tech stack + frameworks + validation
8. 生成要求 (Generation Requirements) — acceptance criteria

CRITICAL rules:
- NEVER put examples before Input
- NEVER use meta-examples (examples of prompt design)
- For Few-Shot: section 5 examples are task-domain data, not prompt-design examples
- After construction, verify against the technique's output template

### Phase 7: Save to Vault
Generate a structured summary (10 fields):

```json
{
  "goal": "one-sentence task objective",
  "technique": "selected technique",
  "importance": "GLOBAL|STAGE|WORKING|REFERENCE",
  "what_was_done": ["key actions completed"],
  "key_decisions": ["design decisions, boundaries, trade-offs"],
  "hard_constraints_added": ["new long-term constraints (de-duped against global)"],
  "rejected_directions": ["explicitly abandoned approaches"],
  "important_outputs": ["reusable artifact paths"],
  "open_questions": ["unresolved issues"],
  "summary_text": "2-3 sentence natural-language summary"
}
```

Compaction rules:
- Store only task-level assets, no full chat logs
- summary_text must summarize real takeaways, not rephrase goal
- key_decisions only records finalized decisions
- hard_constraints_added must be de-duplicated against global constraints
- NEVER expose raw prompt text in summary — full prompt goes to .md file

Write payload to temp file and execute:

```bash
# For GLOBAL-level entries: add --global flag
python <path>/checkpoint.py --input /tmp/payload.json [--global]
```

### Phase 8: Return Response
Output a JSON response in this exact format:

```json
{
  "status": "ok",
  "analysis": {
    "technique": "tree-of-thought",
    "rationale": "High independence + high cognitive load (crypto security audit)",
    "independence": "independent",
    "cognitive_load": "high"
  },
  "prompt": "the complete enhanced prompt text",
  "metadata": {
    "task_id": "smart-contract-audit",
    "skill_used": "tree-of-thought",
    "hard_constraints": ["must pass Slither", "zero external deps"],
    "key_decisions": ["5×5 risk matrix"],
    "summary": { ... }
  },
  "vault": {
    "id": "uuid",
    "version_tag": "v1",
    "md_path": "prompts/smart-contract-audit/v1.md"
  }
}
```

## Anti-Patterns (NEVER do these)
- NEVER execute the user's task — you are a prompt writer, not a coder
- NEVER skip the router — always evaluate independence and load
- NEVER load all 7 technique references at once — only the selected one
- NEVER overwrite vault entries — checkpoint.py appends new versions
- NEVER include internal routing details in the final prompt
- NEVER auto-generate cases without domain knowledge
- NEVER skip query expansion when a vault exists
- NEVER inflate importance — GLOBAL means "all future tasks must know this"

## Vault Paths
- Project vault: `.promptcraft/prompt_vault.json`
- Global vault: `~/.promptcraft/global_vault.json`
- Scripts: `<skills_dir>/prompt-memory/scripts/`
- Technique references: `<skills_dir>/prompt-techniques/references/`
```

### 3.2 技巧摘要（嵌入系统提示词）

系统提示词中每个技巧的摘要格式：

```
### zero-shot
- Use: simple code explanation, formatting, renaming (low load)
- Method: direct organization, keep lightweight
- Output: 7-section skeleton (section 5 omitted), ≤100 lines total
- Anti-pattern: adding examples → use few-shot instead
- Full reference: <path>/zero-shot.md

### few-shot
- Use: standard CRUD, unit tests with fixed patterns (medium load, continuous)
- Method: extract mapping rules, include 2-3 formatted I/O pairs, place target at end
- Output: 8-section with I/O pairs + ASCII mapping rule summary box
- Case rules: 1-5 examples, non-empty input+output, same domain as task
- Anti-pattern: meta-examples, wrong domain examples
- Full reference: <path>/few-shot.md

### zero-shot-cot (in chain-of-thought.md)
- Use: multi-step reasoning without examples (med-high load)
- Method: add trigger "Let's think step by step", require reasoning before answer
- Output: 7-section, section 5 = reasoning skeleton (step names only, no concrete content)
- Anti-pattern: adding full examples → use few-shot-cot
- Full reference: <path>/chain-of-thought.md

### few-shot-cot (in chain-of-thought.md)
- Use: reasoning relay when user provides complete examples (high load, continuous)
- Method: format 1-2 input→reasoning→output triples, include reasoning pattern migration box
- Case rules: non-empty input+reasoning+output, reasoning must show intermediate steps
- Output: 8-section with reasoning triples + ASCII migration box
- Anti-pattern: triples without real reasoning steps
- Full reference: <path>/chain-of-thought.md

### step-back
- Use: vague errors, legacy refactoring (high load, independent)
- Method: abstract to higher principles first, then apply back to concrete task
- Output: 8-section with 2-3 abstraction framework ASCII boxes, transition sentence
- Tightening rules: not too broad (answer drifts), not too narrow (just rephrasing)
- Single-pass vs two-stage: default single-pass
- Anti-pattern: generic advice without concrete application
- Full reference: <path>/step-back.md

### least-to-most
- Use: large multi-step modules (high load, continuous, decomposable)
- Method: decompose into 4-6 ordered subproblems, each depends on previous
- Output: 8-section, section 5 = ordered subproblems, last = "综合实现完整模块"
- Key constraint: subproblems must serve original task, dependency-driven order
- Anti-pattern: subproblems without dependencies, section 6 expanding by subproblems
- Full reference: <path>/least-to-most.md

### tree-of-thought
- Use: crypto, Assembly, security audit critical paths (high load, independent, high risk)
- Method: generate 2-4 candidates, evaluate, prune, keep top 1-2, deepen, final answer
- Output: 8-section with search strategy declaration + evaluation table + state table format
- Constraints: branch_count 2-4, max_depth ≤3, keep_count 1-2
- Search strategies: beam (default), dfs (puzzles), expert-panel (readable discussion)
- Anti-pattern: "3 experts chatting" without explicit branch/score/prune rules
- Full reference: <path>/tree-of-thought.md
```

---

## 4. I/O 协议

### 4.1 输入: PromptCraftRequest

```json
{
  "task": "string (required) — user's core coding task description",
  "mode": "full | quick | review (default: full)",
  "context": {
    "prd": "string (optional) — full PRD text",
    "tech_design": "string (optional) — full technical design document",
    "domain_knowledge": {
      "sample_data": "object (optional) — JSON/CSV records, API payloads",
      "field_definitions": "object (optional) — field name → type/description",
      "reference_ranges": "object (optional) — field → {min, max, normal}",
      "input_output_pairs": "array (optional) — [{input, output}]",
      "specifications": "string (optional) — API docs, specifications",
      "reference_implementation": "string (optional) — MVP or reference code"
    },
    "current_file": "string (optional) — path or content of current file",
    "tech_stack": "string (optional) — known tech stack info"
  },
  "vault_config": {
    "project_vault": "string (optional, default: .promptcraft/prompt_vault.json)",
    "global_vault": "string (optional, default: ~/.promptcraft/global_vault.json)",
    "skills_dir": "string (optional, default: .codebuddy/skills)",
    "no_global": "boolean (optional, default: false)"
  }
}
```

### 4.2 输出: PromptCraftResponse

```json
{
  "status": "ok | error",
  "error": "string (only if status=error)",
  "analysis": {
    "technique": "zero-shot | few-shot | zero-shot-cot | few-shot-cot | step-back | least-to-most | tree-of-thought",
    "rationale": "why this technique was selected",
    "independence": "continuous | independent",
    "cognitive_load": "low | medium | high"
  },
  "prompt": "string — the complete enhanced prompt",
  "metadata": {
    "task_id": "string — kebab-case identifier",
    "skill_used": "string — selected technique",
    "hard_constraints": ["string"],
    "key_decisions": ["string"],
    "summary": {
      "goal": "string",
      "technique": "string",
      "importance": "GLOBAL | STAGE | WORKING | REFERENCE",
      "what_was_done": ["string"],
      "key_decisions": ["string"],
      "hard_constraints_added": ["string"],
      "rejected_directions": ["string"],
      "important_outputs": ["string"],
      "open_questions": ["string"],
      "summary_text": "string"
    }
  },
  "vault": {
    "id": "string — UUID",
    "version_tag": "v1",
    "md_path": "string — relative path to .md file"
  }
}
```

### 4.3 反馈输入: PromptCraftFeedbackRequest

```json
{
  "mode": "feedback",
  "task_id": "string — the task to append feedback to",
  "execution_result": {
    "output": "string — the actual output produced",
    "success": "boolean",
    "constraint_violations": ["string — which hard constraints were violated"],
    "manual_fixes_needed": "string — what had to be fixed manually"
  }
}
```

### 4.4 反馈输出: PromptCraftFeedbackResponse

```json
{
  "status": "ok",
  "feedback": {
    "status": "success | partial | failed",
    "quality_score": 1-5,
    "constraint_compliance": {
      "all_hard_constraints_met": true,
      "violations": []
    },
    "output_summary": "string",
    "issues_found": ["string"],
    "what_worked_well": ["string"],
    "improvement_notes": "string"
  },
  "vault": {
    "version_tag": "v2"
  }
}
```

---

## 5. 工具集定义

### 5.1 Agent 可用工具

PromptCraft Agent 需要以下工具（Claude Code Agent tool 原生支持）：

| 工具 | 用途 | 示例 |
|------|------|------|
| **Bash** | 运行 checkpoint.py, hydrate.py | `python .codebuddy/skills/prompt-memory/scripts/hydrate.py --query "..." --top-k 3` |
| **Read** | 加载完整技术参考文件 | `Read .codebuddy/skills/prompt-techniques/references/tree-of-thought.md` |
| **Write** | 创建临时 payload JSON 文件 | 写 checkpoint 的 payload 到 `/tmp/payload.json` |

**不需要的工具**（Agent 不应拥有）：
- ❌ Edit — Agent 不修改用户代码
- ❌ Glob — Agent 不需要搜索项目文件
- ❌ WebSearch/WebFetch — Agent 不需要外部信息

### 5.2 脚本路径解析

Agent 需要知道脚本路径。路径由 `vault_config.skills_dir` 决定，默认为
`.codebuddy/skills`。Agent 在启动时构建绝对路径：

```python
SKILLS_DIR = Path(vault_config.get("skills_dir", ".codebuddy/skills"))
CHECKPOINT = SKILLS_DIR / "prompt-memory" / "scripts" / "checkpoint.py"
HYDRATE = SKILLS_DIR / "prompt-memory" / "scripts" / "hydrate.py"
TECHNIQUES = SKILLS_DIR / "prompt-techniques" / "references"
```

### 5.3 错误处理

所有工具调用必须处理错误情况：
- Bash 返回非零 → 解析 stderr，返回 `{"status": "error", "message": "..."}`
- Read 文件不存在 → 返回错误，不崩溃
- vault 损坏 → 回退到空 vault（hydrate.py 已内置此逻辑）

---

## 6. Dispatcher Skill 设计

### 6.1 概述

Dispatcher 是主 Agent 加载的一个极简 skill（~20 行），负责：
1. 检测 prompt-writing 场景
2. 打包 Agent 请求
3. 调用 PromptCraft Agent
4. 接收结果并执行

### 6.2 Dispatcher SKILL.md

```markdown
---
name: promptcraft-dispatcher
description: >
  Dispatcher for PromptCraft Agent. When the user needs a high-quality prompt
  written, or submits a PRD/technical design document for task decomposition,
  this skill detects the scenario and delegates to the PromptCraft sub-agent.
  Do NOT write prompts yourself — always delegate.
---

# PromptCraft Dispatcher

## When to Use
Delegate to PromptCraft Agent when:
1. User asks to "write a prompt for X"
2. User submits a PRD or technical design document
3. User's task is complex and would benefit from structured prompt engineering
4. User says "use prompt-craft" or "enhance my prompt"

## How to Delegate
Call the PromptCraft Agent with a structured request:

```
Agent tool:
  subagent_type: "general-purpose"  (or a custom "promptcraft" agent type)
  description: "Write enhanced prompt for: <one-line summary>"
  prompt: "<PromptCraftRequest JSON>"
```

The Agent runs independently and returns a PromptCraftResponse JSON.
Parse it and:
- Present the enhanced prompt to the user
- Offer to execute it immediately
- If executed, collect feedback and call Agent again with mode="feedback"

## Script Paths
- Scripts: <skills_dir>/prompt-memory/scripts/
- If in PromptCraft repo: skills/prompt-memory/scripts/
- Installed: .codebuddy/skills/prompt-memory/scripts/

## Configuration
To use PromptCraft Agent, the project must have:
1. The 4 skill directories installed
2. The Agent system prompt registered (see docs/AGENT_ARCHITECTURE.md)
```

### 6.3 检测逻辑（Dispatcher 内部推理）

主 Agent 加载 Dispatcher 后，通过以下信号判断是否需要调用 PromptCraft Agent：

| 信号 | 置信度 | 动作 |
|------|--------|------|
| 用户显式说 "用 prompt-craft" / "写一个 prompt" | 100% | 立即委托 |
| 用户提交了 PRD 文档（>500 字的结构化文本） | 90% | 委托拆解 |
| 用户任务涉及多个子系统/模块 | 70% | 询问是否委托 |
| 用户任务是简单的一次性操作 | 0% | 不委托，直接执行 |

---

## 7. 分阶段实施计划

### Phase 1: Agent 定义与注册 (1-2 天)

**目标**: PromptCraft Agent 可被调用，能独立完成 prompt engineering

**任务**:
1. [ ] 将上述系统提示词写入 `skills/promptcraft-agent/SYSTEM_PROMPT.md`
2. [ ] 创建 Agent 配置文件 `skills/promptcraft-agent/agent.yaml`（或等效 JSON）
3. [ ] 编写 Agent smoke test: 给定简单任务，验证 Agent 能返回结构化响应
4. [ ] 验证 Agent 能调用 hydrate.py 和 checkpoint.py
5. [ ] 验证 Agent 能按需加载技术参考文件

**产出物**:
- `skills/promptcraft-agent/SYSTEM_PROMPT.md` — 完整系统提示词
- `skills/promptcraft-agent/README.md` — Agent 使用说明
- `tests/test_agent.py` — Agent 集成测试

### Phase 2: Dispatcher Skill (0.5-1 天)

**目标**: 主 Agent 能自动检测场景并委托给 PromptCraft Agent

**任务**:
1. [ ] 创建 `skills/promptcraft-dispatcher/SKILL.md`（极简，~20行）
2. [ ] 实现检测逻辑（内嵌在 SKILL.md 中）
3. [ ] 测试主 Agent → Dispatcher → Agent 的完整链路
4. [ ] 处理 Agent 调用失败的回退逻辑（降级为直接执行）

**产出物**:
- `skills/promptcraft-dispatcher/SKILL.md`

### Phase 3: 协议完善与优化 (1 天)

**目标**: 打磨 I/O 协议，优化性能

**任务**:
1. [ ] 根据实际使用反馈调整 PromptCraftRequest/Response 字段
2. [ ] 优化 Agent 系统提示词长度（目标：<1500 tokens）
3. [ ] 为常见任务类型添加缓存 prompt 模板
4. [ ] 实现 batch 模式：一次调用处理多个任务
5. [ ] 添加 mode="review-batch" 支持

**产出物**:
- 更新后的协议文档
- Agent 性能基准报告

### Phase 4: 迁移与兼容 (1 天)

**目标**: 确保现有 workflow 不被破坏

**任务**:
1. [ ] 保留当前 Skills（prompt-craft, prompt-memory 等），标记为 "legacy"
2. [ ] 添加 A/B 测试框架：对比 Agent vs 传统 Skill 的输出质量
3. [ ] 编写迁移指南：从 Skills 到 Agent 的 step-by-step
4. [ ] 更新 README 和文档

**产出物**:
- `docs/MIGRATION.md`
- A/B 测试结果

### Phase 5: 高级特性 (2-3 天)

**目标**: Agent 独有、传统 Skill 无法实现的功能

**任务**:
1. [ ] **智能任务分解**: 输入 PRD → Agent 自动识别 N 个子任务 → 为每个生成 prompt
2. [ ] **Prompt 模板库**: 从 vault 中提取高频模式，生成可复用模板
3. [ ] **跨项目约束推荐**: Agent 分析全局 vault → 推荐新项目的 GLOBAL 约束
4. [ ] **Prompt 质量评分**: Agent 对 vault 中所有 prompt 做质量审计 → 排行榜
5. [ ] **主动建议**: Agent 监测用户行为 → "你连续3次用 zero-shot 处理复杂任务，建议试试 ToT"

---

## 8. 测试与验证策略

### 8.1 单元测试

```python
class TestAgentProtocol(unittest.TestCase):
    def test_request_validation(self): ...
    def test_response_parsing(self): ...
    def test_mode_routing(self): ...

class TestAgentVaultIntegration(unittest.TestCase):
    def test_agent_hydrate_and_build(self): ...
    def test_agent_feedback_writeback(self): ...
```

### 8.2 集成测试

| 场景 | 输入 | 期望输出 |
|------|------|---------|
| 简单 CRUD | "写一个用户管理 API" | few-shot, 8-section prompt, vault 已保存 |
| 安全审计 | "审计合约权限" | ToT, GLOBAL 约束已注入, case 已生成 |
| PRD 拆解 | 30页 PRD 文档 | N 个 prompt, 每个有独立 task_id |
| 反馈写回 | mode=feedback | vault 新增 v2 版本, quality_score 正确 |

### 8.3 质量指标

| 指标 | 目标 | 测量方式 |
|------|------|---------|
| Agent 首轮成功率 | >90% | Agent 返回 status=ok 的比例 |
| Prompt 结构合规率 | >95% | 8-section 是否完整 |
| 技巧选择准确率 | >85% | 人工评估 Router 选择是否合理 |
| 平均延迟 | <5s | Agent 调用到返回的时间 |
| 平均 token 消耗 | <3000 input + <2000 output | Agent 调用的 token 统计 |

---

## 9. 性能与成本估算

### 9.1 Token 消耗

| 阶段 | Input Tokens | Output Tokens | 说明 |
|------|-------------|---------------|------|
| Agent 系统提示词 | ~2000 | — | 一次性加载，可缓存 |
| hydrate.py 结果 | ~500 | — | JSON 输出 |
| 技术参考 (1个) | ~800 | — | Read 工具加载 |
| Agent 推理 | — | ~1500 | 分析 + prompt 构建 |
| checkpoint.py | ~100 | ~100 | Bash 调用 |
| **总计** | **~3400** | **~1600** | 约 5000 tokens/次 |

对比传统 Skill 模式（在主 Agent 上下文中），虽然多了 Agent 调用的开销，
但主 Agent 省下了 prompt engineering 的上下文空间（~30%），整体更经济。

### 9.2 延迟

| 步骤 | 时间 |
|------|------|
| Agent 启动 | ~1s |
| hydrate.py | ~0.2s |
| Router 推理 | ~0.5s |
| Read 技术参考 | ~0.3s |
| Prompt 构建 | ~1s |
| checkpoint.py | ~0.2s |
| **总计** | **~3-4s** |

---

## 10. 未来扩展方向

### 10.1 短期（Phase 5 后）

- **多 Agent 编排**: 主 Agent → PromptCraft Agent 写 prompt → Code Agent 执行 → Review Agent 审查 → PromptCraft Agent 收反馈
- **Prompt A/B 测试**: Agent 为同一任务生成 2 个不同技巧的 prompt，主 Agent 分别执行并对比结果
- **Vault 可视化**: Web UI 展示 vault 的版本演化、质量趋势、GLOBAL 约束覆盖

### 10.2 中期

- **Agent 自我优化**: Agent 分析自身成功率，自动调整 Router 偏好
- **团队共享 Agent**: 多人共用同一个 PromptCraft Agent 实例，共享 vault
- **Prompt 市场**: 高质量的 prompt 模板可以在团队/社区间分享

### 10.3 长期

- **PromptCraft as a Service**: Agent 通过 API 暴露，任何 AI 工具可调用
- **自动化 prompt 演化**: Agent 持续监控 vault 中的 prompt 表现，自动提 PR 改进弱 prompt
- **跨模型适配**: 根据目标模型（Claude vs GPT vs Gemini）调整 prompt 风格

---

## 附录 A: 与当前 Skills 架构的对比

| 维度 | 传统 Skills | PromptCraft Agent |
|------|-----------|-------------------|
| 上下文占用 | ~30% 主 Agent 上下文 | 独立上下文，0% 主 Agent |
| 技术参考加载 | 按需加载1个，仍占空间 | 预加载摘要，按需加载完整 |
| 复用性 | 绑定特定主 Agent | 任何主 Agent 可调用 |
| 可测试性 | 难以独立测试 | 可独立单元测试 |
| 错误隔离 | Skill 错误影响主 Agent | Agent 错误不传播 |
| 扩展性 | 受主 Agent 上下文限制 | 独立扩展，无上限 |

## 附录 B: 文件清单

实施本计划需要创建/修改的文件：

```
PromptCraft/
├── docs/
│   └── AGENT_ARCHITECTURE.md          ← 本文档
├── skills/
│   ├── promptcraft-agent/
│   │   ├── SYSTEM_PROMPT.md           ← Agent 系统提示词 (新建)
│   │   └── README.md                   ← Agent 使用说明 (新建)
│   ├── promptcraft-dispatcher/
│   │   └── SKILL.md                    ← Dispatcher skill (新建)
│   ├── prompt-craft/                   ← 保留 (legacy, 不删除)
│   ├── prompt-memory/                  ← 保留 (Agent 依赖其脚本)
│   ├── prompt-techniques/              ← 保留 (Agent 按需加载)
│   └── prompt-review/                  ← 保留 (Agent mode=review 使用)
├── tests/
│   └── test_agent.py                   ← Agent 测试 (新建)
└── README.md / README.zh-CN.md        ← 更新 Agent 文档
```
