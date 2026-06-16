# PromptCraft

[English README](README.md)

PromptCraft 是一套面向 AI 编程助手（CodeBuddy / Codex / Claude Code）的
**提示工程 Skills 套件**。核心理念：在让模型"更努力思考"之前，先把交给
模型的任务说明整理好。然后**记住**什么有效、什么失败、发现了什么约束——
跨会话、跨项目地积累。

> **任务增强** — 提升输入质量，然后持久化推理决策。

---

## 核心创新

| 创新 | 说明 |
|------|------|
| **LLM-as-a-Router** | 零代码路由——宿主模型根据*独立性 × 认知复杂度*从 7 种技巧中自行选择最佳方案。无外部 API 调用。 |
| **工作区锚定记忆** | 提示词历史写入人类可读的 JSON + Markdown 文件，利用宿主文件系统实现索引、可移植性和 git diff。无数据库，无私有 API。 |
| **Git 式版本控制** | 同一任务多次改进追加不覆盖，`is_active` 指针标记活跃版本，`hydrate.py --rollback-to v1` 一键回退。 |
| **多项目联邦** | 双层 vault：`~/.promptcraft/global_vault.json` 存跨项目约束，`.promptcraft/prompt_vault.json` 存项目特定历史。hydrate.py 自动合并检索。 |
| **查询扩展** | 检索前由 LLM 生成跨语言关键词扩展（如中文→英文同义词），突破 Jaccard 对同义词的盲区。零外部依赖。 |
| **执行反馈闭环** | prompt-craft 执行 prompt 后自动对照硬约束分析输出质量，结构化反馈写回 vault。未来会话从历史结果中学习。 |

---

## 项目结构

```
PromptCraft/
├── skills/
│   ├── prompt-craft/          # 核心工作流：路由→构建→保存→执行+反馈
│   │   ├── SKILL.md           #   6步工作流 + LLM路由 + 查询扩展 + 反馈闭环
│   │   └── references/        #   路由决策表 + 构建检查清单
│   ├── prompt-memory/         # 工作区锚定记忆 + 联邦
│   │   ├── SKILL.md
│   │   ├── scripts/           #   checkpoint.py + hydrate.py
│   │   └── references/        #   vault schema（含联邦与反馈子模式）
│   ├── prompt-techniques/     # 7种技巧参考目录
│   │   ├── SKILL.md
│   │   └── references/        #   zero-shot, few-shot, cot, step-back, least-to-most, tot
│   └── prompt-review/         # 提示词质量审查（含技巧特定检查）
│       ├── SKILL.md
│       └── references/        #   审查检查清单
├── tests/
│   └── test_scripts.py        # 42 个单元测试（checkpoint + hydrate + federation）
├── CLAUDE.md                  # Claude Code 项目约定
├── .promptcraft/              # 运行时存储（首次使用自动创建）
│   ├── prompt_vault.json      #   轻量元数据索引（～200 token/条）
│   └── prompts/               #   完整 Prompt 存档（.md 文件）
├── LICENSE
└── README.md / README.zh-CN.md
```

全局 vault（跨项目）：`~/.promptcraft/global_vault.json`

---

## 4 个 Skill

| Skill | 职责 | 使用场景 |
|-------|------|---------|
| `prompt-craft` | 核心入口：查询扩展 → vault 加载 → LLM 路由 → 技巧选择 → 条件案例生成 → 构建 Prompt → 保存 → 执行+反馈写回 | 需要写或改进高质量提示词 |
| `prompt-memory` | 双存储 I/O + 联邦：`checkpoint.py`（保存，`--global` 写全局 vault），`hydrate.py`（自动合并全局+项目 vault，`--no-global` 跳过全局） | 保存/加载/版本管理提示词历史 |
| `prompt-techniques` | 7 种技巧参考目录，含 JSON 输入模板、设计规则、案例生成规则、搜索策略和输出模板 | 被其他 Skill 按需引用 |
| `prompt-review` | 质量门 + 技巧特定检查：完整性→约束→技巧匹配→上下文质量→反模式→边界情况。严重性标记（BLOCKER/MAJOR/MINOR） | 审查已有提示词 |

---

## 工作流（更新版）

加载 `prompt-craft` 后自动执行：

```
Step 0a: 查询扩展 → LLM 生成跨语言关键词，提升 Jaccard 与 vault 的重叠度
         （零代码、零 API 调用）
Step 0b: hydrate.py → 自动合并全局 + 项目 vault；
         GLOBAL 条目（两个 vault 均含）无条件注入上下文；
         按 Jaccard 评分返回 top-k 相关条目
Step 1: LLM Router → 独立性×认知复杂度 → 选择技巧
Step 2: 读取技巧详情 → 获取 method_steps + design_rules
Step 2.5: 条件案例生成 → 仅当用户提供领域知识时生成
Step 3: 构建增强提示词 → 8 节结构 + 已确认案例
Step 4: checkpoint.py → 保存到项目 vault（或 --global 写全局）
Step 5: 行动选择
        ├── 🚀 立即执行 → 执行 → 分析输出 → 结构化反馈写回 vault
        │                （status + quality_score + violations）
        ├── 💾 保存并稍后 → 已持久化；hydrate.py --full 可取出
        └── 🔍 审查改进 → 加载 prompt-review，新版本自动追加
```

---

## 多项目联邦

PromptCraft 支持双层 vault：

| 层级 | 路径 | 用途 |
|------|------|------|
| **全局** | `~/.promptcraft/global_vault.json` | 组织级标准（"所有 SQL 必须有回滚脚本"）、共享模板 |
| **项目** | `.promptcraft/prompt_vault.json` | 项目特定决策、Bug 相关 prompt |

**hydrate.py** 每次查询自动合并两个 vault。同一 task_id 在两个 vault 中
都存在时，项目条目优先。使用 `--no-global` 仅搜索项目 vault。

**checkpoint.py** 默认保存到项目 vault。使用 `--global` 保存到全局 vault。

```bash
# 保存组织级约束到全局 vault
echo '{"task_id":"org-security","user_intent":"所有合约必须通过 Certora 验证"}' | \
  python checkpoint.py --global

# 搜索（自动合并两个 vault）
python hydrate.py --query "审计合约安全"

# 仅搜索项目 vault
python hydrate.py --query "审计合约" --no-global
```

---

## 安装使用

将 `skills/` 下的 4 个 Skill 目录复制到你的项目或用户 Skills 目录
（如 CodeBuddy 的 `.codebuddy/skills/`）：

```
your-project/.codebuddy/skills/prompt-craft/
your-project/.codebuddy/skills/prompt-memory/
your-project/.codebuddy/skills/prompt-techniques/
your-project/.codebuddy/skills/prompt-review/
```

脚本默认以 `.promptcraft/` 为 vault 根目录，`.codebuddy/skills/prompt-memory/scripts/`
为脚本路径。可通过 `--vault` / `--prompts-dir` 覆盖。

在 CodeBuddy / Codex / Claude Code 对话中：

> 加载 prompt-craft，帮我写一个高质量的提示词

AI 自动执行完整工作流。

---

## 技术选型

- **仅 Python 标准库**：零外部依赖
- **双存储架构**：JSON vault = 轻量索引；`.md` 文件 = 完整 Prompt
- **双层联邦**：全局 vault（`~/`）+ 项目 vault（`./`）
- **零代码路由**：LLM-as-a-Router 嵌入在 SKILL.md 中
- **查询扩展**：LLM 生成跨语言关键词（无 embedding、无外部 API）
- **语义搜索**：Jaccard 相似度，多文字分词（CJK + 拉丁 + 西里尔）
- **上下文经济**：紧凑模式约 200 token；`--full` 按需读取 `.md`
- **反馈闭环**：结构化执行反馈自动写回 vault

## 设计原则

- 增强输入质量——不替代模型推理
- 零外部模型调用——无 API 费用，无 embedding 服务
- 无私有记忆 API——纯文件系统，人类可读可编辑
- 不做封闭数据库——vault 可编辑、可 diff、可版本控制
- 追加不覆盖——版本历史完整保留
- 双存储：JSON 快速检索元数据，`.md` 保存完整可读 Prompt
- 联邦：全局 vault 跨项目约束，项目 vault 本地决策
- 丰富的技术参考——含设计规则、JSON 模板、案例生成规则

## 版本

**v2.1** — v2.0 Skills Edition + 多项目联邦 + 查询扩展 + 执行反馈闭环。
42 个单元测试。详见 git 提交历史。

## 许可证

MIT License。详见 [LICENSE](LICENSE)。
