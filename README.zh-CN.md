# LoopForge

**为多轮编码 Agent 提供持久的工作连续性与机器证据。**

编码 Agent 可以快速推进工作。难的是让进展跨轮次保持可靠：对话可能被压缩、中断或重启，而已接受的工作、被拒绝的尝试、机器观察和后来放弃的修改容易混在一起。

LoopForge 为每轮工作设立持久边界。它记录哪些结果已经提交，将机器观察与对应记录保存在一起，并依据由此形成的状态准备下一次模型调用所需的 prompt。任务的含义和实现方式仍由 Agent 决定；LoopForge 让围绕工作的过程可追溯、可恢复。

[English](./README.md) · [安装与集成手册](./loopforge/README.md)

## 要解决的问题

一项长期编码任务不是一次连续操作，而是一系列工作切片、决策、检查，有时还包括方向调整。对话历史有参考价值，却不是可靠的过程记录：其中可能混有尚未提交的工作、被拒绝的尝试、未获检查支持的声明，以及后来已经放弃的修改。

LoopForge 将每个被接受的轮次作为类型化历史中的一笔事务。下一轮依据已提交状态准备，而不是从非正式摘要中推断。观察不确定时，这种不确定性会被保留，不会被误当成通过或没有变化。

## 一轮如何运作

```text
LoopForge 根据已提交状态准备 prompt
                       |
                       v
Agent 理解任务并完成一个工作切片
                       |
                       v
Agent 提交结构化结果或请求恢复
                       |
                       v
LoopForge 收集观察、校验，并提交或拒绝
                       |
                       v
根据新的已提交状态准备下一轮 prompt
```

一个轮次是具有前后证据边界的一段完整工作。Agent 判断这段工作是否完成，以及是否继续。被拒绝的尝试不会进入已提交轮次历史；无效提交不会推进轮次；被接受的结果与对应观察一起记录。

例如，Agent 分多个切片实现一项功能时，每个被接受的切片都会留下类型化记录，以及同一边界上的机器观察。下一次模型对话从已提交状态开始，而不是沿用旧 transcript。如果 Agent 决定放弃当前方案，可以请求恢复；LoopForge 会先验证目标工作区，再让工作继续。

## LoopForge 的设计特点

### 持久轮次，而非对话摘要

LoopForge 将已提交轮次保存为 Vault 中的类型化记录。这些记录是 prompt 和只读视图的事实来源。state file、receipt、replay、audit 和 explain 都是从历史派生的视图，不是并行账本。因此，已接受的工作可以与被拒绝或后来放弃的尝试区分开来。

### Agent 报告与机器证据分开

Agent 报告自己认为完成了什么；LoopForge 将这些内容作为声明保存。Git 工作区观察和明确配置的验证命令提供机器可见的证据。声明本身不能验证结果；观察不可用时，状态仍是未知。证据状态在提交时派生一次，之后由 prompt、receipt 和只读视图共同读取。

适合分片的工作可以使用 Round Contract：由 Agent 提出一个交付物、验收条件和用于检查的已配置命令。LoopForge 校验契约结构和命令绑定；交付物及检查方式在语义上是否合适，仍由 Agent 和操作者判断。

当有效的成功声明由 after 阶段通过、且入口与配置未被篡改的命令支持时，verification gate 会将 `machineBackedSuccess` 持久化在该轮的证据状态中。只读视图直接读取这一事实，不会重新推导。`completed` 只表示 Agent 的停止声明通过了已配置的 gate，并不普遍证明任务正确。

### 每个新轮次开启新的模型对话

在轮次边界，`fresh_invocation` 会开启新的模型对话；上一轮的 transcript、工具输出和未提交推理不会带入。LoopForge 从当前已提交治理事实、Machine Evidence、有界 Working Memory，以及适用的恢复或重试教训中，明确构建连续性。Agent 报告始终标注为报告，不会变成机器事实。

这是模型对话边界，不是宿主重启或工作区重置。同一个 loop 身份和当前已修改的工作区继续；宿主进程仍可保持 MCP 连接、工具和已安装的 skill 文件可用。`same_round_retry` 可以在原 invocation 中继续，进行同一轮的上下文内修复；上下文策略会明确返回，并且独立于 prompt 密度。只有 rollback 或 recovery 才会恢复检查点。

### 带有验证边界的恢复

当 Agent 判断当前方向应当放弃时，可以请求恢复到可用的工作区检查点。LoopForge 记录 rollback directive，还原文件和 Git 状态，并在发出 redo prompt 前验证完整的恢复边界。机器规则触发的 backtrack 使用同一恢复协议。

恢复不会伪造成功评估，也不会把还原当成进展。Redo 会在已验证的工作区状态上继续，并携带恢复教训；被放弃的路径仍与当前工作明确区分。

## 职责边界

Agent 负责理解任务、制定计划、使用工具、实现方案，以及决定是否请求恢复。LoopForge 负责保存已提交轮次、收集已配置的观察、确定性地检查轮次边界，并验证恢复过程。

LoopForge 不是编码 Agent 或规划器，也不保证任务必然正确。它不管理模型的私有记忆或 provider cache。它为外部 Agent 的工作提供持久的过程保障，同时把推理和决策留给 Agent。

## 安装

```bash
npm install -g loopforge
loopforge init --client claude
claude mcp add loopforge -- npx loopforge mcp
```

LoopForge 要求 Node.js 18 或更高版本，且没有运行时依赖。支持的客户端、CLI 参数、MCP 工具和 TypeScript API 见[安装与集成手册](./loopforge/README.md)。项目版本定义于 [`loopforge/package.json`](./loopforge/package.json)。

## 许可证

MIT
