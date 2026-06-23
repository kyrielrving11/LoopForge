# PromptCraft

[English README](README.md)

PromptCraft 是一个面向 AI 编程助手的**提示工程子Agent**
（Claude Code / Codex / CodeBuddy）。它管理提示词和技能的全生命周期：
生成、个性化、执行反馈、模式分析和进化建议——由持久化 vault 支撑，
跨会话、跨项目持续改进。

> **v2.8** — LLM 驱动提示词生成：Python 选择技术，LLM 子代理读取技术参考
> 文件并生成提示词。4 引擎工具系统，5 层执行边界，178 个测试。Python 标准库，零外部依赖。

---

## 架构

```
主Agent (Claude Code / Codex)
  │
  └─ PromptCraft 子Agent (LLM — 隔离上下文)
        │
        ├─ Python 层 (数据 + 安全)
        │   ├─ builder.py           ← 技术路由器 (关键词启发式)
        │   ├─ engine.py            ← 生命周期 + vault I/O + 熔断器
        │   ├─ boundary.py          ← 5层纵深防御
        │   └─ tools/               ← pattern_analysis / skill_advisor
        │
        └─ LLM 层 (生成)
            ├─ Read 技术参考 .md 文件
            ├─ 生成结构化提示词（按复杂度自适应）
            └─ 建议生成 Skill 叠加约束
```

**设计理念：** Python 负责分类 + 数据 + 安全。LLM 负责创意性提示词写作——
它读取技术参考文件，将技术规则应用到具体任务上。这种分工让 Python 保持精简
（无需字符串模板拼接提示词），让 LLM 发挥它最擅长的事。

## 六种模式

| 模式 | 触发条件 | 返回内容 |
|------|---------|---------|
| **build** | 无Skill + 高风险任务 | 技术选择 → LLM 读参考文件 → 生成结构化提示词 |
| **overlay** | 匹配Skill + vault有相关历史 | 领域约束 → LLM 为 Skill 生成叠加层 |
| **feedback** | 执行完成后 | 质量评分 + 改进建议 |
| **analyze** | Health Report 信号 `->analyze` | 累积数据的模式报告 |
| **advise** | Health Report 信号 `->advise` | Skill进化/创建建议 |
| **batch** | 批量任务 | BatchSummary + 逐项结果 |

**Build/Overlay 流程**：Python 预处理器选择技术 + 收集 vault 上下文 → LLM
子代理读取技术参考文件 → LLM 生成完整提示词/叠加层 → checkpoint 到 vault
→ 返回主 Agent。

**Feedback/Analyze/Advise 流程**：Python 全权处理（纯数据操作）。

每次响应附紧凑 **Health Report**：`[PC: 5 records | hint: similar→solidity-audit q=4.2, normal]`
——vault 提示即使在 10 条分析阈值以下也会显示。

## 快速开始

将 PromptCraft 部署为 Claude Code 子Agent：

```bash
# 1. 复制 3 个核心目录到你的项目
cp -r promptcraft-agent/ skills/ .claude/ <你的项目>/

# 2. 初始化 vault
cd <你的项目>
echo '{"task_id":"init","user_intent":"promptcraft 已初始化"}' \
  | python skills/prompt-memory/scripts/checkpoint.py

# 3. 验证 — 子Agent 通过 .claude/agents/promptcraft.md 自动注册
echo '{"task":"写一个 hello 函数","mode":"build"}' \
  | python promptcraft-agent/subagent_adapter.py
```

子Agent 现已作为 `promptcraft` 在 Claude Code 中可用。CLAUDE.md 中的
自动触发规则在遇到复杂任务时自动调用。

## 执行边界（5层纵深防御 + 熔断器）

借鉴 Claude Code 的7层权限系统，为子Agent的真实威胁模型
（**知识污染**而非Shell注入）重新设计：

| 层 | 防护对象 | 硬拒绝触发条件 |
|----|---------|--------------|
| 1 — 输入 | 注入检测、模式一致性 | 系统指令覆盖、模式-协议不匹配 |
| 2 — 工具 | 每工具安全属性 + `check_permissions()` | **MODIFIES_SKILLS**（bypass-immune，永不可绕过） |
| 3 — Vault | 大小上限(8KB)、速率限制(50/会话)、去重、GLOBAL质量≥4 | 超上限、低质量GLOBAL写入 |
| 3.5 — 根配置 | CLAUDE.md、agents/*.md、settings.json 写入门控 | 子Agent写入根配置 → WARN |
| 4 — 输出 | Schema强制、敏感信息扫描、大小限制 | Schema违规、载荷溢出 |
| 5 — 熔断 | 拒绝追踪、3态状态机(CLOSED/HALF_OPEN/OPEN) | 连续3次拒绝→OPEN(冷却5分钟) |

**核心规则：** 所有工具 `MODIFIES_SKILLS = False`。Skill修改是bypass-immune硬拒绝——
PromptCraft只建议，主Agent执行。

## 项目结构

```
PromptCraft/
├── promptcraft-agent/
│   ├── subagent_adapter.py    # 统一入口，6模式路由
│   ├── engine.py              # 生命周期管理 + vault I/O + 熔断器
│   ├── builder.py             # 技术路由器 (关键词启发式) + 质量评分
│   ├── protocol.py            # I/O schema，6个Mode值
│   ├── health_report.py       # HealthReport + 阈值门控
│   ├── boundary.py            # 5层执行边界 + 熔断器
│   ├── AGENT.md               # Claude Code子Agent定义
│   └── tools/                 # 4引擎工具系统
│       ├── base.py            # 工具基类 + 安全属性
│       ├── personalization.py # Skill叠加注入
│       ├── prompt_build.py    # 技术选择器 (为LLM准备上下文)
│       ├── pattern_analysis.py # 聚合模式发现
│       └── skill_advisor.py   # 进化/创建建议
├── skills/
│   ├── prompt-memory/         # 双存储vault I/O + 联邦
│   │   ├── scripts/           #   checkpoint.py + hydrate.py
│   │   └── references/        #   vault schema
│   ├── prompt-techniques/     # 7种技巧参考目录
│   │   └── references/        #   LLM 读取这些文件来生成提示词
├── tests/
│   ├── test_scripts.py        # checkpoint, hydrate, federation, freshness
│   ├── test_health_report.py  # 阈值, stall, consistency, proactive
│   ├── test_subagent_adapter.py # 路由, 解析, batch, E2E
│   ├── test_engine_modes.py   # 5个 invoke_* + silent analysis + batch
│   ├── test_integration.py    # 完整闭环工作流
│   └── test_boundary.py       # 5层守卫, 熔断器, 工具, batch输入
├── .claude/agents/            # 子Agent注册 + 系统提示词
├── CLAUDE.md                  # 项目约定 + 自动触发规则
└── README.md / README.zh-CN.md
```

## 核心特性

- **LLM 驱动提示词生成**：Python 通过关键词启发式选择技术；LLM 子代理读取
  技术参考文件并生成完整 8 节提示词。无硬编码字符串模板。
- **子Agent架构**：隔离上下文，vault持久化，跨会话改进——CLAUDE.md 自动触发规则 + vault-hydrate 预检
- **自动触发规则**：CLAUDE.md 内置 6 条行为触发条件（纠错螺旋、意图翻转、同错复现、
  需求累积、任务动词）——零成本模式匹配，误报代价极低
- **主动 Vault 提示**：Health Report 即使在 10 条分析阈值以下也能展示相似历史任务
  （`hint: similar→solidity-audit q=4.2`）
- **批处理**：单次调用处理多任务——hydrate一次，按Skill分组，并行执行（最多4线程）
- **5层执行边界**：根配置写入门控（Layer 3.5）——子Agent不能静默修改 CLAUDE.md 或 settings.json
- **熔断器**：3态状态机（CLOSED → OPEN → HALF_OPEN），拒绝追踪 + 自动冷却，已合并入 boundary.py
- **多项目联邦**：双层vault——全局(`~/.promptcraft/`) + 项目(`./.promptcraft/`)
- **查询扩展**：同义词查询扩展 + 跨语言（中文→英文）映射，Jaccard检索前自动展开（零依赖）
- **批量反馈持久化**：缓冲的vault写入——反馈记录在内存中累积，批量刷新到vault（NDJSON），降低子进程开销
- **引擎指标**：可观测的静默失败计数器（vault写入错误、子进程超时、分析异常），通过 HealthReport 暴露退化信号
- **Vault 清理**：`hydrate.py --prune --older-than N` 清理过期条目，GLOBAL条目永不删除，`.md` 文件完整保留
- **执行反馈闭环**：每次执行后结构化质量评分(1-5)写回vault
- **Health Report**：紧凑单行信号——`[PC: N records, action=...]`——告知主Agent何时运行分析
- **Skill-Advisor**：数据支撑的进化/创建建议——绝不自动修改Skill
- **追加式Vault**：完整版本历史，支持回滚，双存储（JSON索引 + Markdown提示词）
- **多文字分词器**：中日韩 + 日文假名 + 韩文 + 拉丁 + 西里尔

## 技术选型

- **仅Python标准库** — 无需pip install、无需venv
- **双存储** — JSON vault（元数据）+ `.md` 文件（完整提示词）
- **双层联邦** — 全局vault + 项目vault，自动合并
- **子Agent模型** — 隔离上下文，触发器式唤醒
- **Jaccard相似度** — 多文字分词器，零外部依赖
- **零外部API** — 无embedding服务，无专有API

## 设计原则

- **Python 分类，LLM 生成** — 技术选择用关键词启发式（快、零成本）；提示词写作由 LLM
  驱动（读参考文件、应用技术规则）
- **增强而非替代** — Skill拥有工作流，PromptCraft提供叠加
- **Fail-closed** — 守卫不确定就拒绝；MODIFIES_SKILLS是bypass-immune
- **仅Health Report** — 内部vault状态绝不暴露给主Agent
- **绝不自动修改Skill** — 仅建议，执行由主Agent负责
- **importance = blast radius** — GLOBAL影响所有项目，升级需数据支撑
- **追加不覆盖** — 完整版本历史保留
- **零外部依赖** — 纯文件系统，人类可读JSON/Markdown

## 许可证

MIT License。详见 [LICENSE](LICENSE)。
