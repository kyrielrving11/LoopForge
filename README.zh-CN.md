# LoopForge

[English README](README.md)

**认知循环治理层**（Cognitive Loop Governance Layer），面向 AI 编程助手。

大多数 AI Agent 循环，要么是基于时间的定时器（`/loop` — 每 N 分钟跑同一个东西），
要么是单轮推理模式（CoT、ToT、ReAct — 在一轮内更深度地思考）。两者都不是为真正
的问题设计的：**当一个任务太复杂、无法在执行前就完整拆解，而且你对任务的理解会
在执行过程中不断变化时，你需要的不是定时器，也不是更深的单轮推理——你需要的是
一个能治理"轮次之间"发生了什么的东西。**

LoopForge 治理的正是这个"轮次之间"的空间——Agent 完成一轮工作后，需要决定下一步
做什么。它不规划过程（你规划不了，因为你不知道会发现什么）。它规划**结果和约束**，
然后让 Agent 在约束内一步步探索。随着 Agent 执行，LoopForge 追踪真实进度、检测漂移、
合并新发现的约束、深化目标理解、纠正错误假设——在长周期循环中维持认知稳定性。

> **v1.15** — `npm install loopforge`。MCP 服务器（8 工具）+ Perception-Skill +
> 库 API + 验证门控 + 执法门控 + 瘦 Prompt + 胖文件 + 结构化评估 +
> 记忆系统集成（三阶段注入 + 回写）+ 多 Agent 委托支持（AgentTool / Coordinator）。
> **L2 Agent 自主技术选择** — Agent 通过阅读技术目录自由选择推理策略；
> 零运行时依赖。277 测试。Node.js ≥18。

---

## 核心理念

```
你从一个大致方向和一组护栏开始。
你走一步。你看看发现了什么。
你发现的东西改变了你对任务的理解。
所以下一步跟你最初规划的完全不同。
这不是 bug——这是所有复杂工作的本质特征。

LoopForge 将这个循环结构化：
  执行 → 自评（带证据）→ 对照 lineage 验证（v1.6）→
  轮次边界执法（v1.13）→ 发现约束 → 深化理解 →
  纠正错误 → 写入状态文件（v1.14）→ 编译下一轮 prompt →
  再次执行 —— 直到结果达成。
```

**这不是定时器循环。** 定时器问的是"N 分钟到了吗？"
认知循环问的是"我学到了什么？这如何改变我下一步应该做的事？"

---

## 快速开始

### MCP + Skill（推荐）

```bash
npm install -g loopforge
claude mcp add loopforge -- npx loopforge-mcp
# 安装 Perception-Skill — 教会 Agent 如何运行认知循环
mkdir -p ~/.claude/skills/perception
cp "$(npm root -g)/loopforge/skills/perception/SKILL.md" ~/.claude/skills/perception/
```

然后用自然语言描述你的任务：
- `/perception "审计 ERC20 代币的安全漏洞"`
- "逐个文件审查，直到全部通过"
- "一步一步来——我现在还不清楚完整范围"

Agent 激活 Perception-Skill，调用 `loopforge_start`，认知循环开始。
没有定时器，没有固定计划——只有结构化的探索。

### 库 API

```typescript
import { createEngine } from "loopforge";

const engine = createEngine();
const result = engine.invokeLoopCompile({
  mode: "loop_compile",
  task: "审计 ERC20 代币安全漏洞",
  loop_id: "audit",
  round: 1,
  goal_id: "audit",
});
```

```typescript
// 自主循环 — 2 个必填字段
import { run } from "loopforge";

const result = await run({
  task: "审计 ERC20 代币安全漏洞",
  execute: async (prompt) => await callAiApi(prompt),
});

console.log(`完成 ${result.roundsCompleted} 轮: ${result.stopReason}`);
```

---

## 工作原理

### 认知循环

```
第 1 轮（L2 — 重启）：
  LoopForge 编译策略 prompt，包含：
    - 技术选择区块 — Agent 阅读技术目录
      (skills/prompt-techniques/SKILL.md) 并自由选择最佳推理策略
    - 任务 + Loop Objective + 约束 + 跨轮摘要
    - 状态文件写入 .loopforge/state/{loopId}-state.md
  → Agent 阅读目录 → 选择技术 → 阅读参考文件 → 执行
  → LoopForge 计算真实进度，验证声称，合并发现

第 2 轮及以后（L1 — 继续）：
  LoopForge 编译瘦 prompt — 状态在状态文件中：
    - Agent 读取状态文件获取约束、进度、检查点
    - 技术由关键词路由从 Tier 1 中选择（4 种：zero-shot、few-shot、
      zero-shot-cot、few-shot-cot）
    - P0-P5 状态演化处理：发现约束、深化目标、涌现子问题、纠正错误假设
    - 状态文件每轮重写
  → Agent 在更丰富的上下文中执行
  → ... 循环直到所有标准满足、断路器触发、或任务完成

策略重启（L2 — 由检查点边界或 goal_id 变化触发）：
  Agent 声明子任务边界 → LoopForge 编译新的 L2 prompt
  → Agent 重新阅读技术目录并重新选择策略

失败但无新信息（L0 — 重试）：
  Agent 诚实失败但没有新发现 → 复用缓存的 prompt
  → 执法门控捕获虚假成功和重复违规（v1.13）
```

### 自评结构（Agent 每轮报告的内容）

v1.7 起，自评作为**结构化 MCP 工具参数**传递——由 MCP 客户端在到达服务器之前校验。
`loopforge_next` 工具要求必须传入 `evaluation` 对象；`output` 文本可选。

```json
loopforge_next({
  sessionId: "abc-123",
  evaluation: {
    "success": true,
    "output_summary": "修复了 3 个重入漏洞。24/24 测试通过。",
    "constraint_violations": [],
    "should_continue": true,

    "discovered_constraints": ["所有外部调用必须使用 SafeERC20"],
    "objective_refinement": "范围扩大：权限控制问题属于可升级代理模式的一部分",
    "emerged_subtasks": ["审计代理初始化流程", "验证 timelock 参数"],

    "execution_evidence": {
      "files_changed": ["contracts/Token.sol", "test/Token.test.ts"],
      "test_results": {"passed": 24, "failed": 0, "skipped": 0},
      "success_criteria_met": ["无重入向量残留"],
      "success_criteria_remaining": ["权限控制已验证", "溢出检查已完成"],
      "progress_estimate": 0.4
    },

    "retracted_constraints": [],
    "revised_success_criteria": [],
    "wrong_assumptions": [],

    "worker_results": [
      {
        "agentId": "w-001",
        "subAgentType": "explore",
        "subTask": "搜索安全漏洞",
        "resultSummary": "发现 3 个重入漏洞",
        "success": true,
        "discoveredConstraints": ["所有外部调用使用 nonReentrant"]
      }
    ]
  }
})
```

每个字段都有明确的下游消费者——没有装饰字段。
旧版 `---loopforge-eval` 文本块仍作为降级路径支持。

### 编译器如何处理这些证据

| 能力 | 行为 |
|------|------|
| **P0 — 约束发现** | `discovered_constraints` 自动合并为后续轮次的活跃护栏 |
| **P1 — 目标深化** | `objective_refinement` 追加到 Loop Objective；版本历史被追踪 |
| **P2 — 子问题涌现** | `emerged_subtasks` 注入下一轮任务建议 |
| **P4 — 进度追踪** | 客观进度（已满足标准 / 总标准）vs 主观估算；梯度预警 |
| **P4 — 一致性校验** | Agent 声称有改动但 `files_changed` 为空 → warning；声称成功但测试失败 → warning |
| **V1.6 — 验证门控** | 每轮 Agent 自评在进入编译器之前，都会经过跨轮一致性验证。6 项自动检查（进度倒退、空变更声称成功、成功后仍有未达标标准、重复约束发现、连续三轮同一违规、刚发现就撤回的约束翻覆）。3 级判决：`trusted` → 正常流转；`suspect` → 警告注入下一轮 prompt 由 Agent 自行澄清；`contradicted` → 成功标志从趋势中排除，🚫 标记成为 Agent 必须回应的硬约束。成功标志永不被修改——仅跳过趋势写入。 |
| **P5 — 自我纠正** | `retracted_constraints` 从活跃集中移除；`revised_success_criteria` 更新 Loop Objective；`wrong_assumptions` 记录为关键教训 |
| **进度面板** | 注入每轮 prompt：文件变更、测试结果、剩余标准、趋势箭头 |

---

## MCP 工具（v1.7）

| 工具 | 用途 |
|------|------|
| `loopforge_start` | 启动循环 — 从任务 + 约束编译第 1 轮 prompt |
| `loopforge_next` | 提交结构化评估（+ 可选的输出文本）→ 获取下一轮 prompt（或 `null` + 停止原因）。`evaluation` 为必填的强类型对象——由 MCP 客户端 schema 校验。 |
| `loopforge_status` | 当前轮次、成功轨迹、使用中的技术 |
| `loopforge_stop` | 手动停止，最终轨迹被保留 |
| `loopforge_list` | 所有活跃会话（内存 + vault 持久化） |
| `loopforge_replay` | 完整时间线：轮次、技术、成功、决策 |
| `loopforge_resume` | 进程重启后从 vault 恢复循环 |
| `loopforge_health` | 目标对齐、约束完整性、漂移、策略稳定性 |

停止原因：`task_complete` | `circuit_breaker` | `max_rounds` | `stalled` | `stopped`

---

## 重编译级别

| 级别 | 触发条件 | 行为 |
|------|---------|------|
| **L0 重试** | 上一轮失败且无新信息（无 P0-P5，无修复信号，无新约束） | 复用缓存 prompt — 相同轮次、相同任务 |
| **L1 继续** | 默认路径 — 所有正常执行轮次 | Tier 1 技术路由（4 种技术），P0-P5 状态演化，渲染状态文件，瘦 prompt |
| **L2 重启** | 第 1 轮、检查点边界、或 goal_id 变化 | Agent 阅读技术目录（SKILL.md），自由选择策略，重建状态文件。（v1.15：策略崩溃自动触发和技术骨架嵌入已移除。） |

---

## 多 Agent 支持（v1.9）

LoopForge 对所有 Agent 一视同仁——无论是单 Agent、通过 AgentTool 派生子 Agent 的主 Agent、
还是编排 Worker 的 Coordinator。核心循环（编译 → 执行 → 自评 → 编译）完全一致。

### 委托辅助函数（AgentTool 模式）

当主 Agent 派生子 Agent 时，三个可选辅助函数提升委托质量：

```typescript
import {
  filterConstraintsForSubTask,  // 过滤与子任务相关的约束
  formatDelegationPrompt,       // 生成自包含的子 Agent prompt
  recordDelegation,             // 写入委托日志到 vault
  buildDelegationSummary,       // 构建委托历史表格供 prompt 注入
} from "loopforge";
```

- **`filterConstraintsForSubTask(allConstraints, subTask, threshold?)`** — 基于 Jaccard 的约束过滤器。仅返回与子任务相关的约束（默认阈值 0.15）。
- **`formatDelegationPrompt(subTask, subAgentType, constraints, options?)`** — 为 Explore / General-purpose / Plan 子 Agent 生成自包含 prompt。不含"基于以上分析"等引用——子 Agent 看不到父对话。
- **`recordDelegation(loopId, round, entries)`** — 引擎方法。将委托日志写入 vault。
- **`buildDelegationSummary(vaultContext)`** — 从 vault 读取委托历史，生成摘要表格注入下一轮 prompt。

### Worker 结果（Coordinator / 多 Agent）

主 Agent 通过自评中的 `worker_results` 上报子 Agent 结果：

```json
{
  "success": true,
  "output_summary": "派生了 2 个 Worker。Worker A 发现 3 个重入漏洞。Worker B 修复了认证问题。",
  "constraint_violations": [],
  "should_continue": true,
  "worker_results": [
    {
      "agentId": "abc123",
      "subAgentType": "explore",
      "subTask": "搜索安全漏洞",
      "resultSummary": "在 withdraw()、deposit()、transfer() 中发现 3 个重入漏洞",
      "success": true,
      "discoveredConstraints": ["所有外部调用必须使用 nonReentrant 修饰符"]
    }
  ]
}
```

引擎自动检测 `worker_results` → 写入委托日志 → 下一轮编译 prompt 中注入委托历史。
Worker 发现的约束自动流入活跃约束集，在后续轮次的 prompt 中持续生效。

### 设计原则

LoopForge 不区分"单 Agent 模式"和"协调器模式"。主 Agent——无论扮演什么角色——
接收编译后的 prompt、执行、上报结果。LoopForge 负责记录、压缩、注入。Agent 负责决策。

---

## 核心特性

### 认知演化（v1.5）
- **约束发现（P0）** — Agent 在执行中发现新的护栏。自动合并到活跃约束集。
- **目标深化（P1）** — 理解随轮次加深。目标拥有版本链——追加，永不替换。
- **子问题涌现（P2）** — 子问题有机浮现。无需预先规划即可注入下一轮任务建议。
- **执行证据（P4）** — 结构化报告：文件变更、测试结果、标准满足/剩余、进度估算。给编译器装上眼睛。
- **进度追踪（P4）** — 客观 vs 主观进度双重度量 + 梯度检测。在断路器触发前提前预警停滞。
- **自我纠正（P5）** — 撤回错误约束、修正不合理成功标准、标记被推翻的假设。循环可以承认自己错了。

### 验证门控（v1.6）
- **跨轮自评验证** — 每轮 Agent 自评在进入编译器之前，都会经过循环 lineage 的交叉验证。
- **6 项自动检查** — 进度倒退、空变更声称成功、成功后仍有未达标标准、重复约束发现、连续三轮同一违规、刚发现就撤回的约束翻覆。
- **3 级判决** — `trusted` → 正常流转。`suspect` → 警告注入下一轮 prompt 由 Agent 自行澄清。`contradicted` → 成功标志从趋势中排除；🚫 标记成为 Agent 必须回应的硬约束。
- **成功标志保全** — 门控永不修改成功标志。仅对 contradicted 轮次跳过趋势写入——原始标志保留在 vault 中供审计。

### 结构化评估（v1.7）
- **Evaluation 参数** — `loopforge_next` 接受有类型的 `evaluation` 对象，由 MCP 客户端 schema 强制校验。不再依赖正则从输出文本中提取 eval 块。`output` 文本可选（仅用于审计存档）。旧版 `---loopforge-eval` 降级路径仍支持。

### 记忆系统集成（v1.8）

**LoopForge 不是记忆系统——它是提示词编译器。** 理解这个区别是理解它们互补关系的关键。

| | Agent 记忆（claude-mem、Mem0 等） | LoopForge |
|---|---|---|
| **回答的问题** | "你以前做了什么？" | "你接下来该做什么？怎么想？" |
| **作用范围** | 跨任务、跨会话（长期） | 单任务、跨轮次（工作记忆） |
| **运作方式** | 观察 → 提取 → 存储 → 检索 | 编译 L0/L1/L2 → 注入约束 → 验证 → 生成 |
| **决策权** | 无——原始上下文注入 | 完整——技术路由、策略旋转、约束生命周期 |
| **验证** | 信任 Agent 自报 | 6 项对抗性跨轮一致性检查 |
| **角色** | 被动图书管理员——取相关文件 | 主动编辑——写下一章 |

**它们不是竞争对手，而是同一技术栈的不同层级。**

Agent 记忆管理的是*跨会话你知道什么*——代码库模式、用户偏好、过去的决策。
LoopForge 管理的是*任务内你做什么*——哪些约束活跃、用什么策略、进度是否真实。

#### 集成方式：三阶段注入 + 回写

LoopForge v1.8 自动桥接这两个层级：

```
┌─────────────────────────────────────┐
│       Agent 记忆（长期）             │  ← 跨会话知识
│  "用户偏好简洁回复"                  │
│  "auth 模块使用 JWT"                │
└──────────────┬──────────────────────┘
               │ 三个战略节点注入
               ▼
┌─────────────────────────────────────┐
│       LoopForge（工作记忆）          │  ← 任务内执行控制
│  "第 3 轮：活跃约束为……"            │
│  "技术已升级：Tier 2 第 3 轮" │
│  "进度：2/5 标准已满足"              │
└──────────────┬──────────────────────┘
               │ 循环结束 → 精炼知识写回
               ▼
┌─────────────────────────────────────┐
│       Agent 记忆（已更新）           │
│  "ERC20 审计：连续 3 次失败后     │
│   应升级到 Tier 2 技术"              │
│  "关键发现：withdraw() 存在重入……"  │
└─────────────────────────────────────┘
```

**三阶段注入**（从记忆读取，仅 L2 完整重编译时）。
注入频率根据循环长度自适应缩放：

| maxRounds | 注入次数 | 阶段 | 原因 |
|-----------|---------|------|------|
| ≤10 | 1 | 第一阶段（第 1 轮） | 短循环——工作记忆足够新鲜，一次锚定即可 |
| 11–20 | 2 | 第一阶段 + 第三阶段（70% 进度） | 中等循环——初始上下文 + 收尾验证 |
| 21+ | 3 | 第一阶段 + 第二阶段（40% 进度）+ 第三阶段（70% 进度） | 长循环——全认知支持覆盖所有战略节点 |

L0 和 L1 轮次永不注入记忆——编译器的增量路径是确定性的，
注入外部上下文会产生不可预测的信号干扰。

**回写**（写入记忆，每循环一次）：
- **1 条 project 条目**——任务结果 + 关键发现（绝对日期）
- **≤5 条 feedback 条目**——战术经验（规则 + Why + How to apply，匹配 claude-mem 格式）
- **1 条 reference 条目**——指向 LoopForge vault，供未来深入查阅

回写遵循 claude-mem 的核心原则：**只存储不可从当前状态推导的信息。**
代码模式留在代码中。决策、发现和战术经验才写入记忆。

**自动检测**：无需配置。LoopForge 自动检测 claude-mem（通过本地文件系统）。
用户可通过显式的 `memoryProvider` / `memoryWriter` 回调覆盖。
如果 claude-mem 不可用，记忆集成静默降级——循环继续正常执行。

#### 如何安装 claude-mem

claude-mem 是第三方 Claude Code 插件（[github.com/thedotmack/claude-mem](https://github.com/thedotmack/claude-mem)），
提供跨会话持久记忆。LoopForge 自动检测——安装后无需额外配置即可使用。

| 平台 | 安装命令 | 说明 |
|------|---------|------|
| **Claude Code** | `claude plugin install claude-mem@thedotmack` | 插件市场一键安装，会话启动时自动运行。 |
| **Codex (OpenAI)** | `npx codex-mem-cli@latest codex setup` | Codex 专属移植版（[npm](https://www.npmjs.com/package/@iflow-mcp/keystonescience-codex-mem)）。 |
| **Cursor / MCP** | 手动添加到 MCP 配置： | 指向已安装插件或源码构建中的 `mcp-server.cjs`。详见 [claude-mem 文档](https://docs.claude-mem.ai/development)。 |

LoopForge 下次启动时自动检测。无需修改配置。

### 可观测性（v1.7）
- **引擎指标** — `getMetrics()` 公开读取器暴露 8 项健康计数器：vault 写入错误/字节、feedback buffer 统计、缓存命中、分析错误。`loopforge_status` MCP 工具输出中同步返回。
- **结构化事件日志** — 设 `LOOPFORGE_LOG=1` 后 stderr 输出 JSON 行事件。5 种事件：`round_complete`、`circuit_breaker`、`gate_contradicted`、`vault_write_error`、`session_start` / `session_end`。默认静默，零开销。

### Agent 自主技术选择（v1.15）
- **L2 Agent 驱动技术选择** — 在策略重启点（第 1 轮、检查点边界、goal_id 变化），LoopForge 不再通过关键词路由自动选择技术。Agent 阅读技术目录（`skills/prompt-techniques/SKILL.md`），基于循环状态自由选择最佳推理策略，阅读对应参考文件，直接应用技术。
- **技术骨架移除** — L2 prompt 不再嵌入 8 节技术骨架。Skill 参考文件是 Agent 的工作手册，而非被强制执行的模板。
- **策略崩溃移除** — "3 次连续失败 → 强制 Tier 2" 机制已移除。Agent 自行决定何时更换策略；LoopForge 通过验证门控和执行门控来保证诚实性和进度，不再微观管理推理策略。
- **简化技术路由器** — `routeTechniqueAdaptive()` 不再统计连续失败次数，不再进行层级升级。L1 使用 Tier 1 关键词路由，检查点边界提供全量访问。

### 基础能力（v1.0–v1.3）
- **MCP 服务器** — 8 个工具，JSON-RPC over stdio。零配置接入 Claude Code 和 Codex。
- **会话恢复** — Vault 持久化会话。`loopforge_resume` 在进程重启后继续。
- **L0/L1/L2 增量重编译** — 4 门控路由：force_level → 首轮 / plan_source → 检查点边界 → goal_id 稳定性 → L0 诚实失败 → L1 默认路径。（v1.15：策略崩溃门控移除。）
- **Loop Objective 锚定** — 第 1 轮创建稳定的结果锚点，后续逐步深化。
- **约束退役** — 连续 3 轮无活跃信号的约束自动退役。
- **失败路径衰减** — 检测连续失败的同技术+同任务模式，在摘要中自动降权。失败路径的教训被推到末尾并标记 `[考虑更换策略]`。仅出现在失败轮次中的违规标记 `[可能是死胡同]`。编译 prompt 中显式添加 `### ⚠️ 失败模式` 警告段。
- **滚动摘要** — 近 5 轮跨轮知识蒸馏。
- **分层门控技术路由** — L1 使用 Tier 1 关键词路由（zero-shot/few-shot/CoT），检查点边界提供全量 7 种技术访问。L2 让 Agent 通过阅读技术目录自由选择。（v1.15：连续失败升级 Tier 2 机制已移除。）
- **熔断器** — 连续 3 轮失败 → 停止。独立的 executor 连续失败熔断。
- **Replay 引擎** — 时间旅行查询：`replay()`、`diff()`、`timeline()`。
- **策略外置** — 所有可调参数在 `loop_policy.json`。
- **Vault 文件锁** — 基于 mkdir 的互斥锁保护所有 JSON vault 写入。同进程可重入。并发安全——防止并行 session 的写入丢失。
- **零依赖** — 仅 Node.js 标准库。TypeScript strict mode。

---

## 项目结构

```
LoopForge/
├── loopforge/              # TypeScript 包
│   ├── src/                     # builder, engine, loop-compiler, memory-bridge, observability,
│   │                            #   policy, protocol, replay, runtime, verification-gate, backends, mcp
│   ├── dist/                    # 编译产物 + 类型声明
│   ├── skills/
│   │   └── perception/          # Perception-Skill：Agent 的认知循环工作流指令
│   │       └── SKILL.md
│   └── tests/                   # 249 测试（Node.js 内置 runner）
├── skills/
│   └── prompt-techniques/       # 技巧参考文件（运行时读取）
│       └── references/          # zero-shot, few-shot, cot, step-back, least-to-most, tot
├── docs/
│   └── loopforge-spec.md       # 语义规范
├── loopforge-protocol.json     # JSON Schema (draft 2020-12)
└── README.md / README.zh-CN.md
```

---

## API 模块

| 导入路径 | 用途 |
|----------|------|
| `loopforge` | `run()`、`handle()`、`createEngine()`、`LoopRuntime`、`McpServer`、`SessionManager`、全部类型、委托辅助函数 |
| `loopforge/compiler` | `compileLoop()`、`decideLevel()`、`compileL2()`、`buildSelfEvalBlock()`、`buildDelegationSummary()` |
| `loopforge/replay` | `ReplayBackend` — `getRound()`、`replay()`、`timeline()`、`diff()` |
| `loopforge/mcp` | `McpServer`、`SessionManager` — JSON-RPC 传输 + session 生命周期 |

---

## 许可证

MIT。详见 [LICENSE](LICENSE)。
