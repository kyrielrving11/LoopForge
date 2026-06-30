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

> **v1.7** — `npm install loopforge`。MCP 服务器（8 工具）+ Perception-Skill +
> 库 API + 验证门控 + 结构化评估 + 失败路径衰减。零运行时依赖。202 测试。Node.js ≥18。

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
  发现约束 → 深化理解 → 纠正错误 → 编译下一轮 prompt →
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
第 1 轮：
  LoopForge 编译 prompt，包含：
    - 任务描述（你的大致方向）
    - Loop Objective（结果 + 成功标准 + 硬约束）
    - 自评指令（结构化证据报告）
  → Agent 执行，发现未知问题，报告证据
  → LoopForge 计算真实进度，验证声称，合并发现

第 2 轮及以后：
  LoopForge 编译新的 prompt — 跟第 1 轮不同，因为：
    - 发现了新约束（P0）
    - 目标被深化了（P1）
    - 涌现了新的子问题（P2）
    - 进度被追踪到具体成功标准（P4）
    - 错误的假设被纠正了（P5）
    - 策略可能已切换（CoT → ToT → Step-Back），基于质量轨迹
  → Agent 在更丰富的上下文中执行
  → ... 循环直到所有标准满足、断路器触发、或任务完成
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
    "wrong_assumptions": []
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
| **V1.6 — 验证门控** | 每轮 Agent 自评在进入编译器之前，都会经过跨轮一致性验证。6 项自动检查（进度倒退、空变更声称成功、成功后仍有未达标标准、重复约束发现、连续三轮同一违规、刚发现就撤回的约束翻覆）。3 级判决：`trusted` → 正常流转；`suspect` → 警告注入下一轮 prompt 由 Agent 自行澄清；`contradicted` → 质量评分从趋势中排除，🚫 标记成为 Agent 必须回应的硬约束。质量评分永不被修改——仅跳过趋势写入。 |
| **P5 — 自我纠正** | `retracted_constraints` 从活跃集中移除；`revised_success_criteria` 更新 Loop Objective；`wrong_assumptions` 记录为关键教训 |
| **进度面板** | 注入每轮 prompt：文件变更、测试结果、剩余标准、趋势箭头 |

---

## MCP 工具（v1.7）

| 工具 | 用途 |
|------|------|
| `loopforge_start` | 启动循环 — 从任务 + 约束编译第 1 轮 prompt |
| `loopforge_next` | 提交结构化评估（+ 可选的输出文本）→ 获取下一轮 prompt（或 `null` + 停止原因）。`evaluation` 为必填的强类型对象——由 MCP 客户端 schema 校验。 |
| `loopforge_status` | 当前轮次、质量轨迹、使用中的技术 |
| `loopforge_stop` | 手动停止，最终轨迹被保留 |
| `loopforge_list` | 所有活跃会话（内存 + vault 持久化） |
| `loopforge_replay` | 完整时间线：轮次、技术、质量、决策 |
| `loopforge_resume` | 进程重启后从 vault 恢复循环 |
| `loopforge_health` | 目标对齐、约束完整性、漂移、策略稳定性 |

停止原因：`task_complete` | `circuit_breaker` | `max_rounds` | `stalled` | `stopped`

---

## 重编译级别

| 级别 | 触发条件 | 行为 |
|------|---------|------|
| **L0 快速路径** | 目标稳定，无新失败 | 复用缓存 prompt |
| **L1 补丁** | 新约束、失败、修复信号 | 基于上一轮 prompt 增量补丁 |
| **L2 完整重编译** | 首轮、目标变更、策略崩溃、进度停滞 | 完整 hydrate + 自适应技术路由 + 进度面板 |

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
- **3 级判决** — `trusted` → 正常流转。`suspect` → 警告注入下一轮 prompt 由 Agent 自行澄清。`contradicted` → 质量评分从趋势中排除；🚫 标记成为 Agent 必须回应的硬约束。
- **质量评分保全** — 门控永不修改质量评分。仅对 contradicted 轮次跳过趋势写入——原始评分保留在 vault 中供审计。

### 结构化评估（v1.7）
- **Evaluation 参数** — `loopforge_next` 接受有类型的 `evaluation` 对象，由 MCP 客户端 schema 强制校验。不再依赖正则从输出文本中提取 eval 块。`output` 文本可选（仅用于审计存档）。旧版 `---loopforge-eval` 降级路径仍支持。

### 可观测性（v1.7）
- **引擎指标** — `getMetrics()` 公开读取器暴露 8 项健康计数器：vault 写入错误/字节、feedback buffer 统计、缓存命中、分析错误。`loopforge_status` MCP 工具输出中同步返回。
- **结构化事件日志** — 设 `LOOPFORGE_LOG=1` 后 stderr 输出 JSON 行事件。6 种事件：`round_complete`、`circuit_breaker`、`gate_contradicted`、`strategy_rotated`、`vault_write_error`、`session_start` / `session_end`。默认静默，零开销。

### 基础能力（v1.0–v1.3）
- **MCP 服务器** — 8 个工具，JSON-RPC over stdio。零配置接入 Claude Code 和 Codex。
- **会话恢复** — Vault 持久化会话。`loopforge_resume` 在进程重启后继续。
- **L0/L1/L2 增量重编译** — 4 门控路由：force_level → 首轮 → goal_id 稳定性 → 失败信号。
- **Loop Objective 锚定** — 第 1 轮创建稳定的结果锚点，后续逐步深化。
- **约束退役** — 连续 3 轮无活跃信号的约束自动退役。
- **失败路径衰减** — 检测连续失败的同技术+同任务模式，在摘要中自动降权。失败路径的教训被推到末尾并标记 `[考虑更换策略]`。仅出现在失败轮次中的违规标记 `[可能是死胡同]`。编译 prompt 中显式添加 `### ⚠️ 失败模式` 警告段。
- **滚动摘要** — 近 5 轮跨轮知识蒸馏。
- **自适应技术路由** — Zero-shot → Few-shot → CoT → Step-Back → ToT，由质量轨迹驱动切换。
- **熔断器** — 连续 3 轮无改善 → 停止。独立的 executor 连续失败熔断。
- **Replay 引擎** — 时间旅行查询：`replay()`、`diff()`、`timeline()`。
- **策略外置** — 所有可调参数在 `loop_policy.json`。
- **Vault 文件锁** — 基于 mkdir 的互斥锁保护所有 JSON vault 写入。同进程可重入。并发安全——防止并行 session 的写入丢失。
- **零依赖** — 仅 Node.js 标准库。TypeScript strict mode。

---

## 项目结构

```
LoopForge/
├── loopforge/              # TypeScript 包
│   ├── src/                     # builder, engine, loop-compiler, observability, policy,
│   │                            #   protocol, replay, runtime, verification-gate, backends, mcp
│   ├── dist/                    # 编译产物 + 类型声明
│   ├── skills/
│   │   └── perception/          # Perception-Skill：Agent 的认知循环工作流指令
│   │       └── SKILL.md
│   └── tests/                   # 202 测试（Node.js 内置 runner）
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
| `loopforge` | `run()`、`handle()`、`createEngine()`、`LoopRuntime`、`McpServer`、`SessionManager`、全部类型 |
| `loopforge/compiler` | `compileLoop()`、`decideLevel()`、`compileL2()`、`buildSelfEvalBlock()` |
| `loopforge/replay` | `ReplayBackend` — `getRound()`、`replay()`、`timeline()`、`diff()` |
| `loopforge/mcp` | `McpServer`、`SessionManager` — JSON-RPC 传输 + session 生命周期 |

---

## 许可证

MIT。详见 [LICENSE](LICENSE)。
