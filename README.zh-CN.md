# PromptCraft

[English README](README.md)

PromptCraft 是一套面向 CodeBuddy / Codex 的**提示工程 Skills 套件**。核心理念：在让模型"更努力思考"之前，先把交给模型的任务说明整理好。

## 三大创新

| 创新 | 说明 |
|------|------|
| **工作区锚定记忆** | 提示词历史写入 `.promptcraft/prompt_vault.json`，人类可读可编辑，利用宿主原生文件索引，跨工具通用。 |
| **LLM-as-a-Router** | 零代码路由——宿主模型内嵌系统提示词，根据独立性×认知复杂度自行判定最佳提示词技术。 |
| **Git 式版本控制** | 同一任务多次改进保留完整 version_history，`is_active` 指针标记活跃版本，`hydrate.py --rollback-to v1` 一键回退。 |

## 项目结构

```
PromptCraft/
├── skills/
│   ├── prompt-craft/          # 核心工作流：路由→构建→保存→执行
│   │   ├── SKILL.md           #   6步工作流 + LLM路由系统提示词
│   │   └── references/        #   路由决策表 + 构建检查清单
│   ├── prompt-memory/         # 工作区锚定记忆管理
│   │   ├── SKILL.md
│   │   ├── scripts/           #   checkpoint.py + hydrate.py
│   │   └── references/        #   vault schema
│   ├── prompt-techniques/     # 7种技巧参考目录
│   │   ├── SKILL.md
│   │   └── references/        #   zero-shot, few-shot, cot, step-back, least-to-most, tot
│   └── prompt-review/         # 提示词质量审查
│       ├── SKILL.md
│       └── references/        #   审查检查清单
├── .promptcraft/              # 运行时存储（首次使用时自动创建，双存储架构）
│   ├── prompt_vault.json      #   轻量元数据索引（～200 token/条）
│   └── prompts/               #   完整 Prompt 存档
│       └── <task_id>/
│           └── v1.md          #   完整 Prompt（Markdown，人类可读）
├── LICENSE
└── README.md / README.zh-CN.md
```

## 4 个 Skill

| Skill | 职责 | 使用场景 |
|-------|------|---------|
| `prompt-craft` | 核心入口：LLM路由 → 技巧选择 → 条件案例生成 → 构建Prompt → 保存 → 一键执行 | 用户需要写或改进一个高质量提示词 |
| `prompt-memory` | 双存储I/O：checkpoint.py 写入（元数据→JSON索引，完整Prompt→.md文件），hydrate.py 检索（紧凑模式注入上下文，`--full` 从 .md 读取完整内容）。 | 保存/加载/版本管理提示词历史 |
| `prompt-techniques` | 7种技巧参考目录，含 JSON 输入模板、设计规则、案例生成规则、搜索策略和执行模式指南 | 被其他Skill按需引用 |
| `prompt-review` | 质量门：完整性审计+改进建议，新版本追加不覆盖 | 审查已有提示词 |

## 工作流：6 步管线

加载 `prompt-craft` Skill 后，AI 自动走 6 步管线：

```
Step 0: hydrate.py → 加载历史约束和成功模式
Step 1: LLM Router → 独立性×复杂度判定 → 选技术
Step 2: 读取技巧细节 → 获取 method_steps + design_rules
Step 2.5: 条件案例生成 → 仅当用户提供了领域知识（样例数据、字段定义、参考范围）
         时才生成示例；否则跳过，由用户在 Step 3 自行填写示例。
Step 3: 构建增强提示词 → 嵌入确认案例 + 角色+任务+格式+约束
Step 4: checkpoint.py → 完整 Prompt 写入 .md 文件，元数据写入 JSON 索引
        （总是在 Step 5 之前执行，无论用户选什么操作）
Step 5: 行动选择
        ├── 🚀 立即执行 → Prompt 已自动保存，同会话直接运行
        ├── 💾 保存并稍后 → 已持久化，hydrate.py --full 可取出
        └── 🔍 审查改进 → 加载 prompt-review
```

## 安装使用

将 `skills/` 下的 4 个 Skill 目录复制到你的项目或用户 Skills 目录（如 CodeBuddy 的 `.codebuddy/skills/`，或你所用工具的对应路径）：

```
your-project/.codebuddy/skills/prompt-craft/
your-project/.codebuddy/skills/prompt-memory/
your-project/.codebuddy/skills/prompt-techniques/
your-project/.codebuddy/skills/prompt-review/
```

脚本默认以 `.promptcraft/` 为 vault 根目录，以 `.codebuddy/skills/prompt-memory/scripts/` 为脚本路径。
如你的目录结构不同，可通过 `--vault` / `--prompts-dir` 参数覆盖。

然后在 CodeBuddy/Codex 对话中说：

> 加载 prompt-craft，帮我写一个高质量的提示词

AI 会自动执行完整的 6 步工作流。

## 技术选型

- **仅 Python 标准库**：checkpoint.py / hydrate.py 零外部依赖
- **双存储架构**：JSON vault = 轻量元数据索引；`.md` 文件 = 完整 Prompt
- **工作区文件锚定**：`.promptcraft/` — 全部基于文件系统，无数据库
- **零代码路由**：LLM-as-a-Router，路由逻辑在 SKILL.md 系统提示词里
- **语义过滤**：keyword overlap / Jaccard 相似度
- **上下文经济**：紧凑模式仅返回元数据（约200 token）；`--full` 按需读取 `.md` 文件

## 设计原则

- 不替代大模型推理 — 只增强输入质量
- 不调用外部模型 — 零 API 费用
- 不依赖私有记忆 API — 纯文件系统
- 不做封闭数据库 — vault 和 .md 文件人类可读可编辑
- 追加不覆盖 — 版本历史完整保留
- 双存储：JSON 快速检索元数据，`.md` 保存完整可读 Prompt
- 丰富的技术参考 — 含设计规则、JSON 模板、案例生成规则（基于领域知识），非精简版步骤

## 许可证

MIT License。详见 [LICENSE](LICENSE)。
