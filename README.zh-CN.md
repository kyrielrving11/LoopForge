# LoopForge

**为编码 Agent 提供持久化的轮次运行保障。**

编码 Agent 能够推理并修改代码。跨越多轮的工作还需要持续性：哪些结果已经接受、配置的检查观察到了什么，以及工作可以从哪里可靠地继续。LoopForge 为 Agent 的工作提供这层连续性。

LoopForge 记录被接受的轮次，保存机器观察，并依据已提交状态准备下一轮 prompt。任务仍由 Agent 主导：它理解需求、选择方案、修改工作区，也决定何时请求恢复。LoopForge 让已提交结果持久可查，并检查轮次边界。

[English](./README.md) · [安装与集成手册](./loopforge/README.md)

## 为什么需要 LoopForge

Agent 的对话不是可靠的事务记录。里面可能混有尚未提交的工作、被拒绝的尝试，或后来已经放弃的修改。仅依赖对话摘要，容易模糊哪些工作已经提交、哪些仍不确定。

LoopForge 为每轮工作记录持久结果。被接受的工作成为类型化的已提交历史，被拒绝的尝试不会进入历史。机器观察与轮次一起保存，后续处理可以区分 Agent 的报告和配置检查实际观察到的内容。下一轮 prompt 从已提交事实派生，不需要在旁边再维护一套进度叙述。

## 它如何工作

```text
LoopForge 准备当前已提交上下文
              |
              v
Agent 选择并执行工作
              |
              v
Agent 提交结果，或请求恢复
              |
              v
LoopForge 记录观察并应用轮次规则
              |
       提交、拒绝或恢复
              |
              v
从新的已提交状态准备下一轮 prompt
```

Agent 报告描述它认为发生了什么，但报告本身不是证明。LoopForge 将报告与可用观察对照，例如 Git 工作区变化和明确配置的验证命令。观察不可用时，LoopForge 保留未知状态，不会将它当成通过或空变更。

对于适合有界分片的工作，Agent 可以提出 Round Contract：一个交付物、验收条件，以及用于检查这些条件的命令。LoopForge 校验契约结构和命令绑定。只有 Agent 声明条目满足，且关闭轮次中的绑定命令通过，条目才会标记为已验证。交付物或测试在语义上是否合适，仍由 Agent 和操作者判断。

## 由 Agent 主导的恢复

Agent 可能意识到当前方向不合适，并请求恢复到工作区检查点：轮次准备时自动采集的 before-image，或通过 `loopforge_checkpoint` 显式创建的中途保存点。LoopForge 不替它诊断错误，也不替它选择恢复目标。它通过当前分支的事务引用解析检查点，持久记录回滚事件，然后自己执行文件与 HEAD 还原，并按 manifest 的完整 Git 边界和记录的 HEAD 精确验证；验证通过后才发出 redo prompt。

如果机器规则要求回退，LoopForge 也可以触发 backtrack。两种路径使用同一套恢复协议，并都会保留在历史中。Redo 在子分支上继续，被放弃的工作仍可审计，但不会被当作当前工作。

## Agent 与 LoopForge 的职责边界

Agent 掌握语义和行动：理解任务、制定计划、使用工具、实现方案，以及决定是否请求恢复。LoopForge 负责连续性和流程保障：保存已提交轮次、记录机器观察、确定性地校验并处置提交，以及验证恢复点。

LoopForge 的作用是让 Agent 自己的推理和方向修正能够跨轮次延续，而不是用固定计划或由 harness 编写的进度叙事取代它们。

LoopForge 不执行编码任务，不保证任务正确或完成，也不管理 Agent 的私有对话记忆。它提供的 prompt 携带当前已提交的治理事实。可选 state file 是派生视图，不是另一套事实来源。

## 安装

```bash
npm install -g loopforge
loopforge init --client claude
claude mcp add loopforge -- npx loopforge mcp
```

LoopForge 要求 Node.js 18 或更高版本，且没有运行时依赖。支持的客户端、CLI 参数、MCP 工具和 TypeScript API 见[安装与集成手册](./loopforge/README.md)。项目版本定义于 [`loopforge/package.json`](./loopforge/package.json)。

## 许可证

MIT
