# LoopForge

**面向长程 AI 编程任务的认知状态运行时。**

LoopForge 运行在编码 Agent 外部，负责轮次之间的边界：记录已提交事实，
采集独立的机器证据，决定本轮是否可以提交，并从持久化状态编译下一轮
prompt。

**版本：**以 [`loopforge/package.json`](./loopforge/package.json) 的 `version` 字段为唯一来源。Node.js >= 18。零运行时依赖。

> [English](./README.md)

## 为什么需要 LoopForge？

大多数 Coding Agent 在 5 轮以内的小任务中表现惊艳，但在超过 20 轮的真实大型软件工程中极易崩溃：

1. **摘要级联崩溃（Summary Cascade）**：长任务必然面临上下文截断。靠 LLM 自行总结历史就像“传话游戏”，越往后记忆越失真，核心约束与初始目标在 15 轮后往往被遗忘殆尽。
2. **假象成功与测试逃逸（Fake Success）**：当遇到攻坚难题时，概率模型存在篡改测试脚本、注释断言或仅在自述中声称“所有测试均已通过”的自欺欺人倾向。
3. **不可逆工作区污染（Workspace Pollution）**：缺乏版本控制的 Agent 一旦走入架构死胡同，就会在受污染的代码库中反复打补丁，陷入死锁直至上下文耗尽。
4. **范围战略游离（Scope Drift）**：缺乏轮次契约约束，模型极易在探索过程中发生注意力漂移，盲目重构与当前目标无关的底层模块。

**LoopForge 不做上层的 Prompt 技巧杂技，而是充当一层冰冷的外部系统内核：用不可变事件溯源保护记忆、用物理机器退出码核验声明、用结构化契约约束修改范围，让 Coding Agent 真正具备跨越数十轮长程任务的工程稳定性。**

## 核心理念

LoopForge 刻意分开两种来源：

- **已提交事实：** Vault 中的类型化轮次文档。被拒绝和进行中的尝试不属于历史。一个事实源。
- **Canonical State：** 从已提交事实编译出的认知状态。Prompt、状态查询和可选 state file 都是派生视图。一个认知源。

Agent 仍然负责规划、改代码、使用工具和选择推理方式。LoopForge 负责轮次边界以及边界周围的检查。

```text
Agent 执行工作
  -> 提交结构化 evaluation（声明）
  -> LoopForge 采集机器证据
  -> 验证门
  -> 执行门
  -> 接受 / 拒绝 / 回溯 / 终止
  -> 已提交事实
  -> Canonical State
  -> 下一轮 prompt
```

这和“摘要循环”的区别是：

```text
传统做法：prompt -> 摘要 -> 下一轮 prompt -> 再次摘要
LoopForge：已提交轮次 -> Canonical State -> 下一轮 prompt
```

## 契约心智模型

LoopForge 不会因为 Agent 的输出格式正确、语气自信，就把它当成事实。
evaluation 来自执行工作的参与者，因此首先只被视为声明（claim）。Round Contract
把声明变成一个三阶段过程：

```text
事前：声明下一轮契约
事中：在活动契约下执行
事后：用独立机器证据关闭条目
```

### 事前：Declaration

Agent 提交 `round_contract`，它是下一轮的契约提案。提交边界检查它的结构、条目
数量限制、证据绑定、工作区范围以及 criterion / sub-goal 引用。只有声明它的轮次
成功提交后，提案才会成为 active contract。活动契约未关闭时，不同的新提案会被忽略；
原样重申则表示继续当前契约。

### 事中：Execution

Agent 在 active contract 下工作。**验证门（verification gate）**检查声明一致性、
证据完整性、计划与契约符合性，以及进度与恢复状态；它会把 Agent 的声明与 Git 快照、
配置命令的观察结果和已提交轮次历史进行比较。实际变更超出 active contract 的声明
范围时，会产生 `round_scope_drift`，这是不能靠解释豁免的机器事实。

### 事后：Closure

Agent 可以声明某个条目已完成，但只有在关闭轮次的 after 阶段所有绑定命令都通过，且
命令配置和入口仍可信时，条目才会变成 `verified`。没有证据支持的声明是
`insufficient`；失败的观察是 `contradicted`。只有所有条目都 verified，或 Agent 报告
`outcome: "blocked"`，契约才会关闭。

**执行门（enforcement gate）**通过有序策略表执行这些检查的后果：接受、拒绝、回溯
或终止。同一个检查反复失败时会升级，而不会变成无限重试循环。Agent 的输出可以解释
意图、声明完成，但不能自行创造证据、把条目标为 `verified`、取消机器矛盾，或单独完成
契约。

子目标允许在执行过程中演化：`emerged_subtasks` 可以新增工作，`subgoal_updates`
显式改变已有子目标的状态。LoopForge 不使用模糊意图或相似度来判定子目标漂移。真正
受机器约束的是契约边界：如果新发现的工作需要修改 active scope 之外的文件，应先关闭
当前契约，再提交一个包含扩展范围的新契约提案。

## 它的特色

### 轮次处置

通过严格的载荷校验后，LoopForge 采集 before/after 观察，运行验证门，再由执行门
应用裁决策略。结果是明确的轮次处置：

- **接受：**提交本轮并继续。
- **拒绝：**不提交任何轮次，使用同一个逻辑 `roundId` 重试。
- **回溯：**记录回滚指令，恢复到最后一个干净点，并携带 Recovery Brief 重做该轮。
- **终止：**停止循环，不把被拒绝或不安全的尝试写成普通历史。

### 契约只有在机器背书后关闭

Round Contract 是一组绑定证据命令的条目。条目只有在 Agent 声明完成，且关闭
轮次中所有绑定命令都被观察到通过时，才会变成 `verified`。声明但没有机器背书
的工作会记录为 `insufficient`，形成有上限的验证欠债，而不是被静默放行。

### 恢复不会改写历史

被拒绝的尝试永远不会进入已提交历史。回溯会保留有效发现，记录失败方案和被证伪
假设，在下一次提交时检查工作区是否恢复；redo 成功提交后，回滚记录会被替换。

## 安装与连接

```bash
npm install -g loopforge
loopforge init --client claude
claude mcp add loopforge -- npx loopforge mcp
```

MCP 服务是主要集成方式，支持 Claude Code、Codex CLI 以及其他兼容 MCP 的客户端。
包也提供 TypeScript 库用于自定义集成，详见 [`loopforge/README.md`](./loopforge/README.md)。

## 一轮如何运行

1. 用户调用 `loopforge`，声明任务、成功标准以及硬约束。
2. LoopForge 返回 prompt 和稳定的 `roundId`。
3. Agent 修改工作区，并通过 `loopforge_next` 提交结构化 `evaluation`。
4. LoopForge 校验载荷、观察工作区、验证声明，并返回轮次处置结果。
5. 被接受的轮次进入历史；下一轮 prompt 从新的已提交状态编译。

四个核心 evaluation 字段严格校验：`success`、`output_summary`、
`constraint_violations` 和 `should_continue`。核心载荷格式错误会返回
`evaluation_invalid`，允许同一轮重试，且不会修改 session、Vault、门、拒绝计数或
指标。Round Contract 声明和 `contract_item_claims` 也属于严格结构边界。

## 架构

```text
外部 Agent
       |
       v
提交边界
  严格结构，同轮重试
       |
       v
轮次生命周期
  观察 -> 验证 -> 裁决
       |
       +--> 拒绝 / 终止：不提交轮次
       |
       +--> 接受 / 停止 / 回溯：提交交易决定
                                      |
                                      v
                           CommittedRoundView
                         唯一历史解码器与窗口
                         /          |          \
                    Replay       Audit      Canonical State
                  发生了什么     证据审计     认知事实
                                                   |
                                          prompt / status / state file
                                                   |
                                                   v
                                            Agent 下一轮
```

所有历史消费者都使用同一个 `CommittedRoundView` 和派生窗口。Replay 回答“发生了
什么”，Audit 检查事实完整性和证据，Explain 回答某轮为什么这样判定。它们都不是
第二套持久化真相。

## 边界

LoopForge 不是记忆数据库、RAG 系统、上下文压缩器，也不是无人值守 Agent。它不会
执行 Agent 的工作。可选 state file 是可以重新生成的面向人的视图，不是真实来源。

## 核心能力

- 结构化 MCP 轮次协议、稳定错误码和可重试语义。
- 从已提交类型化历史确定性重建状态。
- 通过 Git 和显式配置命令采集机器证据。
- 使用内容寻址的 `rc-` 与 `rci-` 身份管理 Round Contract。
- 验证欠债、范围漂移、进度停滞与恢复裁决。
- 持久 session、原子写入、锁、lease、暂停、恢复和 replay。
- L0/L1/L2 只控制 prompt 密度，不替 Agent 选择推理技术。

## License

MIT
