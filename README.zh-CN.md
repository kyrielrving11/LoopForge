# LoopForge

[English README](README.md)

**循环时智能编译层**（Loop-Time Intelligence Layer），面向 AI 编程助手。
为长程 Agent Loop 编译每轮迭代的提示词 —— 具备结构化记忆、约束继承、
漂移纠正和增量重编译（L0/L1/L2）能力。

> **v1.3.1** — `npm install loopforge`。MCP 服务器（8 工具）+ Perception-Skill + CLI + 库 API。
> 零运行时依赖。92 测试。Node.js ≥18。

---

## 快速开始

### MCP + Skill（推荐）

```bash
npm install -g loopforge
claude mcp add loopforge -- npx loopforge-mcp
# 安装 Perception-Skill，获取多轮循环指令
mkdir -p ~/.claude/skills/perception
cp "$(npm root -g)/loopforge/skills/perception/SKILL.md" ~/.claude/skills/perception/
```

然后在 Claude Code / Codex 中：`/loop "审计 ERC20 代币"` — Perception-Skill
将通过 MCP 工具自动管理完整的循环生命周期。

### CLI

```bash
npm install loopforge

# 初始化 vault
npx loopforge init

# 编译提示词（loop_compile 模式）
npx loopforge compile '{"task":"审计 ERC20 代币","loop_id":"audit","round":1,"goal_id":"audit"}'

# v1.2: 自主循环 — 交互式模式（每轮粘贴 Agent 输出）
npx loopforge run '{"task":"审计 ERC20 代币","loop_id":"audit-erc20"}'

# 记录反馈（手动模式）
npx loopforge feedback '{"loop_id":"audit","round":1,"success":true,"score":4}'

# 回放时间线
npx loopforge replay audit

# 对比两轮
npx loopforge diff audit 1 3

# v1.3.1: 从 vault 恢复循环（进程重启后继续）
npx loopforge resume audit

# Vault 健康状态
npx loopforge status
```

### 库 API

```typescript
import { createEngine, ReplayBackend, FSBackend } from "loopforge";

const engine = createEngine();
const result = engine.invokeLoopCompile({
  mode: "loop_compile",
  task: "审计 ERC20 代币安全漏洞",
  loop_id: "audit",
  round: 1,
  goal_id: "audit",
});

console.log(result.response?.prompt);
console.log(result.status); // "ok" | "error" | "stalled"
```

```typescript
// v1.2: 自主循环 — 2 个必填字段，其他全自动
import { run } from "loopforge";

const result = await run({
  task: "审计 ERC20 代币安全漏洞",
  execute: async (prompt) => {
    // 你的 AI 执行器 — Claude API、CLI agent 等
    return await callAiApi(prompt);
  },
});

console.log(`完成 ${result.roundsCompleted} 轮: ${result.stopReason}`);
console.log(`质量轨迹: ${result.qualityTrajectory}`);
```

```typescript
// v1.3: MCP 服务器 — 嵌入任意 MCP-capable 宿主
import { McpServer, SessionManager } from "loopforge";

const server = new McpServer();
server.start(); // JSON-RPC over stdio
```

---

## 工作原理

LoopForge 闭合了 Agent 反馈环。
Agent 自主输出结构化自我评估：

```
LoopForge 编译提示词（嵌入自评指令）
  → Agent 执行 + 输出结构化自评
    → LoopForge 自动提取反馈 → vault
      → LoopForge 编译下一轮提示词（L0/L1/L2 自动决策）
        → ... 循环直到任务完成或熔断
```

**MCP 集成方式（v1.3）：**

```
AI 宿主（Claude Code / Codex）
  → Perception-Skill 在 /loop 时激活
  → loopforge_start → 编译后的第 1 轮 prompt
  → [Agent 执行 + 自评]
  → loopforge_next → 编译后的第 2 轮 prompt
  → ... 循环直到 prompt=null（task_complete / circuit_breaker / max_rounds / stalled）
  → 进程重启后：loopforge_resume → 从上次保存的轮次继续（v1.3.1）
```

每轮编译提示词末尾嵌入 4 字段自评 JSON：

```json
{
  "success": true,
  "output_summary": "发现 3 个漏洞：withdraw() 重入、transfer() 整数溢出、mint() 缺权限控制",
  "constraint_violations": [],
  "should_continue": true
}
```

每个字段都有明确的下游消费者——没有装饰字段。

---

## MCP 工具（v1.3）

| 工具 | 输入 | 输出 |
|------|------|------|
| `loopforge_start` | `task`、`maxRounds?`、`constraints?`、`domain?` | `sessionId`、第 1 轮 `prompt` |
| `loopforge_next` | `sessionId`、`output`（含自评块） | 下一轮 `prompt` 或 `null` + `stopReason` |
| `loopforge_status` | `sessionId` | `round`、`qualityTrajectory`、`status`、`technique` |
| `loopforge_stop` | `sessionId` | `roundsCompleted`、最终轨迹 |
| `loopforge_list` | — | `sessions[]`（内存 + vault 持久化会话） |
| `loopforge_replay` | `sessionId` | `timeline[]` |
| `loopforge_resume` | `loopId` | 下一轮 `prompt` 或 `null` + `stopReason`（v1.3.1） |
| `loopforge_health` | `loopId` | 目标对齐、约束完整性、漂移、策略稳定性（v1.3.1） |

停止原因：`task_complete` | `circuit_breaker` | `max_rounds` | `stalled` | `stopped`

---

## Perception-Skill

一个平台无关的 Agent Skill（`skills/perception/SKILL.md`），教会任意 AI Agent
如何使用 LoopForge MCP 工具进行自主多轮循环。复制到 Agent 的 skill 目录即可
— 兼容 Claude Code、Codex 及任何支持 MCP 的宿主。

---

## 3 种模式

| 模式 | 触发条件 | 返回内容 |
|------|---------|---------|
| **loop_compile** | 每轮 agent loop 迭代 | 编译后的提示词 + 重编译级别(L0/L1/L2) + loop_health + task_alignment |
| **feedback** | 执行完成后（手动或自动） | 质量评分 → vault 持久化 |
| **review** | 审计提示词质量 | 结构检查 + 约束合规报告 |

---

## 重编译级别

| 级别 | 触发条件 | 行为 |
|------|---------|------|
| **L0 快速路径** | goal_id 不变，无新失败/约束 | 复用上一轮缓存提示词 |
| **L1 补丁** | 新约束、新失败、修复信号 | 增量补丁；自动退役静默约束 |
| **L2 完整重编译** | 首轮、goal_id 变更、plan_source、策略崩溃 | 完整 hydrate + 自适应技术路由 + 滚动摘要 |

---

## CLI 命令

```bash
loopforge init                     # 初始化 .promptcraft vault
loopforge compile '<json>'         # 编译提示词（支持 stdin 管道）
loopforge feedback '<json>'        # 记录执行反馈
loopforge run '<json>'             # v1.2: 自主循环 — 心跳/超时/stall 检测
loopforge replay <loop-id>         # 循环时间线 — 轮次、质量、技术
loopforge diff <loop-id> <a> <b>   # 两轮逐字段对比
loopforge review <loop-id> <rN>    # 存储提示词结构审计
loopforge resume <loop-id>          # v1.3.1: 从 vault 恢复循环状态
loopforge status                   # Vault 健康摘要
```

---

## 核心特性

- **MCP 服务器（v1.3）** — 8 个工具，JSON-RPC over stdio：`start`、`next`、`status`、`stop`、`list`、`replay`、`resume`、`health`。零配置接入 Claude Code 和 Codex。
- **会话恢复（v1.3.1）** — 会话自动保存到 vault。`loopforge_resume` 在进程重启后恢复循环状态 — 不再从第 1 轮重新开始。
- **验收标准强制执行（v1.3.1）** — `loop_objective.success_criteria` 合并到活跃约束系统 — 像硬约束一样被追踪、退役、违规检查。
- **Perception-Skill（v1.3）** — 平台无关的 Agent Skill。复制粘贴即可在任意 MCP-capable 宿主中启用自主 `/loop` 工作流。
- **Loop Runtime（v1.2）** — 事件驱动自主循环，内置心跳监控、单轮超时、stall 检测、优雅退出。`run({ task, execute })` 函数——仅 2 个必填字段。
- **心跳 & 超时** — 每轮心跳（可配置间隔）+ 超时 + stall 检测。支持 interactive 模式用于人机协同。
- **自评提取** — 解析 Agent 输出中的 `---loopforge-eval` 块。结构化提取失败时降级为启发式推断。
- **L0/L1/L2 增量重编译** — 4 门控硬路由：force_level → 首轮/plan_source → goal_id 稳定性 → 失败/约束信号
- **Loop Objective 锚定** — 首轮自动生成稳定目标锚点，每轮校验
- **约束退役** — 连续 3 轮无活跃信号的约束自动退役，防止提示词膨胀
- **滚动摘要** — 确定性跨轮知识蒸馏（近 5 轮质量轨迹、有效做法、关键教训）
- **自适应技术路由** — 质量驱动 fallback：同技术连续 2+ 轮低分触发旋转
- **Replay 引擎** — 时间旅行查询：`replay()`、`diff()`、`timeline()`
- **策略外置** — 所有可调参数在 `loop_policy.json` — 约束窗口、技术链、触发条件
- **可插拔后端** — `VaultBackend` 接口；默认 `FSBackend`（JSON + Markdown 双写）
- **Task Alignment** — 校验下一轮任务 vs Loop Objective — 建议级漂移检测
- **熔断器** — 连续 3 轮无改善 → STALLED。独立的 executor 连续失败熔断。
- **零依赖** — 仅 Node.js 标准库，TypeScript strict mode

---

## 项目结构

```
LoopForge/
├── loopforge/              # TypeScript 包
│   ├── src/                     # adapter, builder, cli, engine, loop-compiler, policy, protocol, replay, runtime, backends, mcp
│   ├── dist/                    # 编译产物 + 类型声明
│   ├── skills/
│   │   └── perception/          # Perception-Skill：Agent 的 /loop 工作流指令
│   │       └── SKILL.md
│   └── tests/                   # 92 测试（Node.js 内置 runner）
├── skills/
│   └── prompt-techniques/       # 技巧参考文件（运行时读取）
│       └── references/          # zero-shot, few-shot, cot, step-back, least-to-most, tot
├── docs/
│   └── loopforge-spec.md      # 语义规范
├── loopforge-protocol.json    # JSON Schema (draft 2020-12)
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
