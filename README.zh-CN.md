# LoopForge

[English README](README.md)

**循环时智能编译层**（Loop-Time Intelligence Layer），面向 AI 编程助手。
为长程 Agent Loop 编译每轮迭代的提示词 —— 具备结构化记忆、约束继承、
漂移纠正和增量重编译（L0/L1/L2）能力。

> **v1.0** — `npm install loopforge`。CLI + 库 API。零运行时依赖。
> 103 测试。Node.js ≥18。

---

## 快速开始

```bash
npm install loopforge

# 初始化 vault
npx loopforge init

# 编译提示词（loop_compile 模式）
npx loopforge compile '{"task":"审计 ERC20 代币","loop_id":"audit","round":1,"goal_id":"audit"}'

# 记录反馈
npx loopforge feedback '{"loop_id":"audit","round":1,"success":true,"score":4}'

# 回放时间线
npx loopforge replay audit

# 对比两轮
npx loopforge diff audit 1 3

# Vault 健康状态
npx loopforge status
```

```typescript
// 库 API
import { createEngine, ReplayBackend, FSBackend } from "loopforge";

const engine = createEngine();
const result = engine.invokeLoopCompile({
  mode: "loop_compile",
  task: "审计 ERC20 代币安全漏洞",
  loop_id: "audit",
  round: 1,
  goal_id: "audit",
});

console.log(result.response?.full_prompt);
console.log(result.response?.health_line);
```

---

## 3 种模式

| 模式 | 触发条件 | 返回内容 |
|------|---------|---------|
| **loop_compile** | 每轮 agent loop 迭代 | 编译后的提示词 + 重编译级别(L0/L1/L2) + loop_health + task_alignment |
| **feedback** | 执行完成后 | 质量评分 → vault 持久化 |
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
loopforge replay <loop-id>         # 循环时间线 — 轮次、质量、技术
loopforge diff <loop-id> <a> <b>   # 两轮逐字段对比
loopforge review <loop-id> <rN>    # 存储提示词结构审计
loopforge status                   # Vault 健康摘要
```

---

## 核心特性

- **L0/L1/L2 增量重编译** — 4 门控硬路由：force_level → 首轮/plan_source → goal_id 稳定性 → 失败/约束信号
- **Loop Objective 锚定** — 首轮自动生成稳定目标锚点，每轮校验
- **约束退役** — 连续 3 轮无活跃信号的约束自动退役，防止提示词膨胀
- **滚动摘要** — 确定性跨轮知识蒸馏（近 5 轮质量轨迹、有效做法、关键教训）
- **自适应技术路由** — 质量驱动 fallback：同技术连续 2+ 轮低分触发旋转
- **Replay 引擎** — 时间旅行查询：`replay()`、`diff()`、`timeline()`
- **策略外置** — 所有可调参数在 `loop_policy.json` — 约束窗口、技术链、触发条件
- **可插拔后端** — `VaultBackend` 接口；默认 `FSBackend`（JSON + Markdown 双写）
- **Task Alignment** — 校验下一轮任务 vs Loop Objective — 建议级漂移检测
- **熔断器** — 连续 3 轮无改善 → STALLED
- **零依赖** — 仅 Node.js 标准库，TypeScript strict mode

---

## 项目结构

```
LoopForge/
├── loopforge/              # TypeScript 包
│   ├── src/                     # adapter, builder, cli, engine, loop-compiler, policy, protocol, replay, backends
│   ├── dist/                    # 编译产物 + 类型声明
│   └── tests/                   # 103 测试（Node.js 内置 runner）
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
| `loopforge` | `handle()`、`createEngine()`、全部类型 |
| `loopforge/compiler` | `compileLoop()`、`decideLevel()`、`compileL2()` |
| `loopforge/replay` | `ReplayBackend` — `getRound()`、`replay()`、`timeline()`、`diff()` |

---

## 许可证

MIT。详见 [LICENSE](LICENSE)。
