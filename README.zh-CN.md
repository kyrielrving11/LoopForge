# LoopForge

**Agent 的上下文窗口不是记忆，记忆需要一个运行时。**

**版本以 `LoopForge/package.json` 为准** — `npm install -g loopforge`。Node.js ≥ 18。零运行时依赖。
> [English](./README.md)

---

## 超长程任务真正的问题

任何一个 AI 编码 Agent，只要任务足够长，都会撞上三堵墙。不是模型不够聪明，不是上下文窗口不够大。是**架构**问题。

### 问题一：摘要级联

上下文满了 → 压缩，再满 → 再压缩。第三次压缩的内容是第二次压缩的摘要的摘要。每一次压缩都在蒸发信息——关键约束被摘要器判定为"不再相关"而静默删除。研究者发现，3-4 轮摘要循环后，约束违反率从 0% 飙升到 59%。Agent 不知道自己忘了什么，因为忘了这件事本身也被压缩掉了。

**这就是把认知状态当上下文处理的必然结果。桶永远是漏的。**

### 问题二：自修正失败

Google DeepMind 的结论很明确：模型通过自省无法可靠改进自己。它会说服自己放弃正确答案。有效的修正需要**外部验证者**——一个不在同一上下文中、不参与推理过程、只看输入和输出的独立观察者。验证者永远不能和犯错者是同一个上下文。这是硬约束。

### 问题三：复合误差

如果每步成功率是 p，N 步后端到端成功率是 p^N。METR 的研究发现，前沿 Agent 在人类 4 分钟内能完成的任务上接近 100%，但在需要 4 小时以上的任务上暴跌到 10% 以下。这不是模型的问题——这是概率链。每一步的小错误繁殖到下一步，变成了下一步的正确输入。Agent 在错误上建造更多错误，每一步看起来都局部合理，但整条轨迹是虚构的。

**这三个问题互相放大。摘要级联丢失信息 → 丢失的信息成为下一步的错误输入 → Agent 无法自我修正因为这些错误在它自己的上下文里看起来是合理的。**

---

## LoopForge 的解法

LoopForge 在 Agent 外部运行，并负责轮次之间的边界。它接收结构化报告，采集证据，检查报告，决定轮次是否可以提交，再从已提交事实重新编译下一轮 prompt。

运行时刻意分开两份来源：

- **一份事实来源：** Vault 中已提交的类型化轮次文档。
- **一份认知来源：** 从这些已提交事实编译出的 Canonical State。

这样，展示视图、指标或模型叙述都不会悄悄变成第二套历史。

### 1. 一份事实来源

`loopforge_next` 接收结构化 `evaluation`。四个核心字段严格校验：`success`、`output_summary`、`constraint_violations` 和 `should_continue`。其余字段由运行时归一化，但有两个例外——Round Contract 声明与 `contract_item_claims` 是严格结构边界，会在轮次推进前以 `contract_invalid` 拒绝。核心字段缺失或类型错误时返回 `evaluation_invalid`，Agent 修正后可以用同一个 `roundId` 重试。这条路径不会保存 session、写入轮次、进入验证门或执行门，也不会改变拒绝计数和指标状态。

通过格式校验后，LoopForge 采集机器观察（Git 与已配置命令），运行验证门和执行门，只提交被允许的轮次。Agent 自己的报告只是声明、从来不是证据：它携带 `files_changed`、`tests_reported`、`criterion_claims`、`contract_item_claims` 和 `progress_estimate`，其中任何内容都无法创造已验证事实——只有观察可以。已提交轮次文档是持久记录。被拒绝和进行中的尝试不会进入记录，回溯指令也会从最终历史视图中排除。

所有历史读取都使用同一个内部 `CommittedRoundView`。它统一解码、排序、去重和过滤轮次文档，供 Replay、Audit、Metrics、契约、编译和门的历史判断使用。它是只读模型，不是新的持久化格式。

### 2. 一份认知来源

Compiler 从已提交事实演化 Canonical State。目标、约束、证据、Milestone、子目标、决策和进度都通过这份状态进入下一轮 prompt，而不是通过上一轮 prompt 的摘要进入。

`DerivedCognitiveFacts` 从 Canonical State 和已提交轮次派生 focus、todo、phase、delegation 和 handoff。prompt、可选 state file 与 status projection 使用同一份事实。删除 state file 不会丢失真相，因为它可以重新生成。

稳定 ID（`c-`、`cr-`、`sg-`、`rc-` 和 `rci-XXXXXXXX`）在 Agent 提供时用于精确引用；其余关系一律靠**规范化后完全相等**的文本比对——没有相似度回退：换个说法的条件、约束或强调目标就是**另一个**东西，不是模糊匹配。子目标是刻意相反的设计：`sg-` ID 绑定到声明事件，后续轮次重新声明同一文本会创建**新的**子目标。同一个声明轮次内，完全重复的条目只保留第一条，并以 `duplicate_declaration` 上报。子目标状态变更除外：`subgoal_updates` 必须精确引用**活动中的** `sg-` ID——未知、终态（done/canceled）或非法迁移会在轮次推进前以 `evaluation_invalid` 拒绝。

```
传统做法：prompt -> 摘要 -> 下一轮 prompt -> 再次摘要
LoopForge：已提交轮次 -> Canonical State -> 下一轮 prompt
```

### 3. 外部验证与执行

验证门将其 20 项检查组织为四个验证域——声明一致性、证据完整性、计划与契约、进度与恢复——针对 Git 快照、命令观察和显式配置的命令。执行门通过一张有序策略表把验证结果转为接受、拒绝、回溯或终止决策；每一行自带升级阶梯，同一检查被反复拒绝时会升级并最终终止，而不是无限循环。单一"成功证据"策略统一覆盖无机器背书的成功声明——机器背书指未经篡改、在 after 阶段通过的验证命令；声明的 `no_change_reason` 仅在**未配置任何验证命令**（机器验证结构上不可能）时才作为诚实逃逸。单一停滞评估器同时覆盖渐进停滞与完全平线窗口。机器证据观察到 Git 运动时，可以豁免进度停滞判定；Agent 自报的进度不能创造机器判定，也不能取消机器判定。

Provider 产出带类型的机器观察（`MachineObservation`），状态为 `observed | passed | failed | timeout | unavailable | error | aborted`。已配置的 provider 总会产出一条观察——不可用、超时、报错和中止都会被记录进本轮的事实记录，而不是被静默过滤。已提交交易只持久化 before/after 两个观察集合，轮次增量由它们派生（`deriveRoundObservationDelta`）、永不存储。旧的交易 schema 是硬性断裂：那些轮次不算历史，Audit 会显式列出它们。

Round Contract 是条目模型。提案声明 `items`，每个条目必须绑定至少一个已配置且启用的证据命令，并在声明轮次提交后成为 active contract。运行时纯按内容派生稳定的 `rci-` 条目 ID 和 `rc-` 契约 ID——原样重申契约会保留 Agent 已引用的身份。条目状态（`pending`、`insufficient`、`contradicted`、`verified`）由机器派生：`verified` 要求 Agent 声明 `met` **并且**每个绑定命令在关闭轮次都被观察到通过（after 阶段、入口文件未被篡改、命令配置与声明时一致）。Active Contract 始终从已提交历史派生，在重试和恢复期间保持一致，直到每个条目都 `verified` 或某轮报告 `outcome: "blocked"`。契约 open 期间，不同的提案会被忽略（`contract_premature`）——只有旧契约关闭后新契约才合法。

验证欠债有上限。已声明但无机器背书的条目是 `insufficient`：被记录、不被拒绝，轮次照常提交。但当欠债持续 `engine.unverified_claim_streak_limit` 个连续已提交轮次（默认 3）后，执行门会带指令拒绝，下一次同类拒绝即终止循环。连续计数由已提交轮次标志派生，Agent 自报无法推动它，Git 运动也不能豁免它。范围漂移同样是机器事实，不允许任何澄清豁免：越界 Git 变更会拒绝该轮，重复漂移则终止。

### 4. 不改写历史的恢复

被拒绝的提交保留逻辑 `roundId`，只增加 attempt，不提交轮次。Agent 会收到针对性的重试 prompt。

停滞评估器可以回溯到最后一个干净的已提交轮次——即最近一个没有 error 级验证标志的已提交轮次。回溯会提交一条**回滚指令**，并排除在最终历史之外：轮次计数器回到 `restorePoint + 1`，redo 提交复用该轮的 `roundId`；一旦 redo 提交，它会物理覆盖回滚记录——被回滚的路径永远不会出现在 Replay、Audit 或进度窗口里。

回滚指令携带一条派生的 **Recovery Brief**（恢复简报）：

- 触发原因（触发规则）与恢复点；
- redo 轮的 ID（`loop:<id>:round:<restorePoint + 1>`）；
- 失败的轮次及各自不可重复的失败方案；
- 被证伪的假设——不要再建立在它们之上；
- 跳过轮次中需要保留的有效发现；
- 必须还原的文件，以及工作区必须回到的 HEAD。

它的数据来源是恢复点之上**已提交**的轮次，外加触发回滚的**进行中**尝试。被拒绝的载荷不是持久历史，永远不会成为数据源。简报渲染在回溯 prompt 顶部，并在恢复窗口期间出现在 state file 的 Recent 层；redo 提交后按构造退出。

工作区恢复本身由 **Agent 执行**。回溯 prompt 只陈述恢复**事实**——目标 HEAD、必须还原的文件——从不规定具体命令；prompt 中的恢复事实加上验证门的恢复核查就是全部机制。验证门是**核查**：下一轮提交时用机器证据比对——git HEAD 必须已回到恢复点；任何被跳过文件若其 git 指纹与失败轮状态仍逐字节相同，即为"工作区从未恢复"的机器证明（`backtrack_workspace_not_restored` 会持续拒绝 redo，直到工作区真正干净）。redo 再次触碰同一批文件只是提示级信号——自报永不购买针对 Agent 的裁决——因此合法的多文件 redo 不会被误终止。停滞的 Round Contract 不是第三条回滚触发路径——回滚只来自停滞评估器或工作区未恢复。但当被回滚的轮次当时正执行在一份 **active Round Contract** 之下，redo 要走"契约路径"而不是普通重做：用 `outcome: "blocked"`（附 blocker）关闭停滞契约，并在同一次提交里声明修订后的契约——blocked 会关闭旧契约，新提案因此在下一轮生效；原样重申停滞契约只会让它继续 active。

持久 session、拥有者锁、可续租 lease 和幂等恢复支持进程中断后的继续执行，不跳过也不重复提交轮次。

---

## LoopForge 不是

- **不是记忆数据库。** State file 是派生视图。已提交轮次保存事实，Canonical State 提供运行时认知。LoopForge 不使用 RAG 或向量数据库。
- **不是上下文压缩器。** 它从类型化状态重新编译 prompt，而不是压缩上一轮 prompt。
- **不是约束跟踪器。** 约束只是外部验证与执行的一项输入，不是产品边界。
- **不是自报账本。** Agent 写下的关于自己工作的内容都是声明。只有已提交的机器观察才能把契约条目标为 `verified`，声明永远不会变成事实。
- **不是 Agent 或无人值守执行器。** Agent 负责读代码、改文件、跑工具和选择推理方式，LoopForge 负责轮次转换。

---

## 安装

```bash
npm install -g loopforge
loopforge init --client claude
claude mcp add loopforge -- npx loopforge mcp
```

支持 Claude Code、Codex CLI 以及任何兼容 MCP 的客户端。

MCP 服务路径（`loopforge mcp`）是主要集成方式，提供验证门、执行门、回溯、证据收集和崩溃恢复。引擎也可作为库用于自定义集成，详见 [API 参考](./loopforge/README.md)。

---

## 架构

```text
外部 Agent
  -> 提交结构化 evaluation（声明）
  -> 评估边界
       核心字段与契约/子目标结构严格，可选字段宽松归一化
       非法 -> 同一 roundId 重试，不改状态
  -> 轮次边界
       机器观察（before/after） -> 验证门 -> 执行门
            拒绝 / 终止：不提交轮次
            接受 / 停止 / 回溯：提交交易决定
  -> 已提交轮次文档                [事实来源]
       交易 schema 2：只持久化观察，增量派生
  -> CommittedRoundView             [共享只读模型]
       -> Replay                    [发生了什么]
       -> Audit / Metrics           [证据与诊断]
       -> Explain                   [为什么这样判定]
       -> Canonical State           [认知来源]
            -> DerivedCognitiveFacts
            -> prompt / state file / status
            -> 外部 Agent，下一轮
```

当前轮次的门还会检查提交的 evaluation 和新采集的观察。它们对历史的读取仍然通过共享的 committed-round view。

---

## 核心能力

### 结构化轮次协议

MCP 边界校验基础 JSON 参数和结构化工具输出。四个必填 evaluation 字段严格校验，其余字段宽松归一化并限制长度。另有两个可选结构同样严格——Round Contract 声明与 `contract_item_claims`——出错时返回 `contract_invalid`，同一 `roundId` 重试且零状态变更。格式错误可以重试，不会污染轮次状态。

### 确定性的状态重建

Compiler 从已提交轮次重建状态，跟踪五态子目标、发现约束、阶段 Milestone、机器观察和 Active Round Contract，不增加另一种持久化模型。诊断信息——进度面板、逐轮统计、重复事实的完整历史——住在 state file 与只读状态视图里，不进 prompt。L0、L1、L2 只选择 prompt 密度，不规定推理策略。

### 证据支持的决定

验证门从已采集观察派生声明来源和机器状态。执行门把结果转换为接受、拒绝、回溯或终止，并通过终止持续声明未验证条目的循环来给验证欠债设上限。Metrics 只用于诊断，不参与正确性、门结果、停止条件或契约推导。

### 分开的观察视图

Replay 通过已提交时间线和轮次 diff 回答“发生了什么”。Audit 回答最终事实是否完整、声明是否有证据支持——包括因旧交易 schema 被丢弃的轮次。Explain 回答某一轮为什么这样判定：它的契约与条目状态、观察和标志。Status 展示当前认知状态。四者回答的问题不同，但共享同一个 committed-round 解码器和过滤策略。

### 受控恢复

重试保留逻辑轮次身份。回溯恢复最后一个干净轮次，保留有效发现，检查工作区是否回到恢复目标，并把结构化 Recovery Brief（触发规则、恢复点、redo 轮 ID、失败方案与被证伪假设）放入回溯 prompt 与 state file 的 Recent 层，直到 redo 提交。Session 文档、单调序列、原子写入、锁和可续租 lease 保护重启与并发路径。

### Agent 负责执行

外部 Agent 负责规划和工具使用。它可以让 Compiler 强调已有状态（按稳定 ID 或完全相等文本）或暴露困惑点，但不能移除**受保护**的 prompt 段落或绕过预算：当受保护内容自身超出上限时，prompt 会记下 `protectedOverflow` 而不是把它们丢掉。LoopForge 不运行后台 Agent。

九个 MCP 工具：`start`、`next`、`status`、`stop`、`pause`、`resume`、`replay`、`gate_check` 和 `gate_resolve`。其中两个 gate 工具是 opt-in——`policy.gate.enabled` 为 true(默认 false)时才出现在 `tools/list`。

---

## License

MIT
