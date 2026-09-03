# LoopForge

**Agent 的上下文窗口不是记忆，记忆需要一个运行时。**

**v3.6.0** — `npm install -g loopforge`。Node.js ≥ 18。零运行时依赖。
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

LoopForge 在 Agent **外部**运行。它提供一个类型化 vault（survive 上下文压缩）、一个 Agent 无法自提供的外部验证与执行管线、以及一个无需人工干预就能从死胡同回退的恢复系统。

### 1. Vault → 编译，不是摘要 → 摘要

Agent 每轮的 self-evaluation 写入**类型化 JSON vault**。下一轮的 prompt 不是上一轮 prompt 的压缩版——是从 vault **重新编译**的。Milestone 从原始 vault entries 重新计算，不是摘要链的产物。约束、标准和子目标都有稳定的 hash 派生 ID（`c-` / `cr-` / `sg-XXXXXXXX`），跨轮精确匹配。删掉状态文件，可以从 vault 重建。

```
❌ 传统做法：prompt → 摘要 → 下一轮 prompt → 再摘要 → …
✅ LoopForge：prompt → vault entry → 下一轮 prompt（从 vault 重新编译）
```

### 2. 外部验证与执行

**验证门**（27 项交叉检查）将 Agent 的每条声明与独立证据比对——Git 快照、测试运行器输出、显式验证命令。**执行门**（14 条规则）决定怎么办。它的核心不是"Agent 违反了约束 X"，而是检测 Agent 无法自我诊断的问题：

- R1：声称成功但标准没满足 → **自欺**
- R3：声称成功但没有可验证证据 → **空口无凭**
- R4：连续 3 轮停滞 → **已经卡住了但自己不知道**
- R5：进度完全为零 → **假装在工作**
- R7：说要做 X 实际做了 Y → **意图和行动脱节**

**Agent 就是产生这些叙述的那个系统。它无法从内部检测这些模式。**

### 3. 恢复：拒绝、回溯、续接

**拒绝即零提交**——被拒绝的轮次不写入 vault。轮次 ID 不变，尝试计数递增，下一轮 prompt 包含诊断差距说明，精确指出哪里不匹配。

**自动回溯**——进度停滞（R4/R5）时，状态机回滚到上一个干净轮次而非直接终止。注入"为什么走不通"的诊断。回溯 prompt 包含工作区恢复指令和受影响的文件列表；下一轮提交如未恢复工作区将被拒绝。跳过的轮次中发现的有效知识会被保留。

**暂停 / 恢复 / 回放**——跨进程 session lease。中断后 idempotent resume。已提交轮次的时间旅行查询。

---

## LoopForge 不是

- ❌ **不是记忆系统**——状态文件是派生视图，vault 是真相。不搞 RAG、不搞向量数据库。
- ❌ **不是上下文压缩器**——不压缩 prompt，不搞智能摘要。从 vault 重新编译，不是从上一轮 prompt 摘要。
- ❌ **不是约束跟踪器**——约束只是验证门关注的信号之一。核心价值是外部裁判。
- ❌ **不替代 Agent**——Agent 仍然读代码、改文件、跑工具、决定如何推理。LoopForge 拥有**轮次边界**。

---

## 安装

```bash
npm install -g loopforge
loopforge init --client claude
claude mcp add loopforge -- npx loopforge mcp
```

支持 Claude Code、Codex CLI 以及任何兼容 MCP 的客户端。

MCP 服务路径（`loopforge mcp`）是主要集成方式，提供完整的认知基础设施：
验证门、执行门、回溯、证据收集和崩溃恢复。引擎也可作为
库用于自定义集成 — 详见 [API 参考](./loopforge/README.md)。

---

## 架构

```
┌─────────────────────────────────────────────────────┐
│                    Agent 执行轮次                      │
│  读代码 · 改文件 · 跑工具 · 决定如何推理                  │
└──────────────────────┬──────────────────────────────┘
                       │ Agent 提交 SelfEvaluation
                       ▼
┌─────────────────────────────────────────────────────┐
│                 LoopForge 轮次边界                     │
│                                                       │
│  证据采集 ──→ 验证门 ──→ 执行门 ──→ 状态提交 ──→ 编译   │
│  (Git/命令)  (27项检查)  (14条规则)  (vault写入)  (下一轮) │
│                                                       │
│  接受:   提交状态，编译下一轮                              │
│  拒绝:   同一轮重试，零状态变更                             │
│  回溯:   回退到干净轮次，恢复工作区，注入诊断                  │
│  终止:   持久化终态                                      │
└──────────────────────┬──────────────────────────────┘
                       │ 从 vault 重新编译 prompt
                       ▼
┌─────────────────────────────────────────────────────┐
│               Vault（类型化 JSON 持久化）                │
│  loops/<id>/rounds/<n>.json · session.json · 策略文件   │
│  真相来源。不是摘要链。状态文件是派生视图。                    │
└─────────────────────────────────────────────────────┘
```

---

## 核心能力

### 持久化认知状态

每一轮的自我评估写入 vault。下一轮 prompt 从 vault entries 重新编译——Milestone 不是"摘要的摘要"，子目标状态不是"压缩后的压缩"。稳定 ID（`c-` / `cr-` / `sg-XXXXXXXX`）实现约束、标准和子目标的跨轮精确匹配——消灭 Jaccard 假阳性。

编译器跟踪子目标的五态生命周期（pending → in_progress → done / blocked / canceled），管理约束衰减（已发现的约束长期未被违反则降级为 inactive，再次违反时自动重新激活），并构建带阶段边界 Milestone 的分层摘要——Milestone 不会随滚动窗口被驱逐。

### 外部验证与执行

验证门运行 27 项交叉检查：进度回退、空变更声称成功、成功但标准未满足、**成功无机器可验证证据**（claim 必须有测试/命令证据背书，`no_change_reason` 是诚实逃生口）、**声明 outcome 与旧布尔字段的一致性**（blocked 无 blocker 提示）、成功声明冲突、**retroactiveClaims 对错误轮次或旧轮次的 git 历史验证**、重复约束发现、反复违规、撤回刚发现的约束、证据完整性（Git）、必要命令失败、命令输出不一致、意图-行动漂移、子目标漂移、标准声称无机器背书、**回溯后工作区恢复检查（文件重叠 + git HEAD）**、自 v3.2 起、v3.6 并入 R8 的 **`success_without_verified_evidence`**（本轮无机器验证观察的成功声明，按运行时 providerStatus 判定；篡改入口的命令不算机器证据）、自 v3.3 起的**验证域完整性**（命令入口文件在同轮被改动、测试文件随通过的命令一起被改动）以及**四项 Round Contract 检查**（`round_underspecified`、`round_unverifiable`、`round_scope_drift`、`premature_boundary`）。

执行门的 14 条规则检测认知诚信失败：虚假成功（R1）、反复违规（R2）、空口成功（R3）、**证据矛盾（R-EVID）**、**验证命令入口被篡改（R-EVID-VERIFY）**、**合同边界被提前声称（R-C1）**、**无机器证据的成功（R8）**、**合同范围越界（R-C2）**、进度停滞（R4）、完全静止（R5）、最大拒绝次数（R6）、意图漂移（R7）、**回溯后工作区未恢复（R9）**。R7 只在澄清引用了具体 ID 或文件路径时才接受转向——连续三次无锚点的弱澄清直接终止；R8 先拒绝、重复后终止；R9 要求先恢复工作区再继续。

自 v3.3 起，停滞判定（R4/R5）在证据路径上要求机器一致：窗口内有 git 运动或新完成的 criteria 即豁免停滞判定（仅豁免，绝不新增惩罚）。每轮还可以声明可选的 **Round Contract**——`done_when`（criteria ID）、`verification_plan`（已配置的证据命令名）、`scope`。自 v3.4 起，声明的合同是**对下一轮的提案**：只有声明轮提交后它才成为 **active 契约**——渲染为 Current Task（原始目标仍在 Objective 段）——并一直保持 active，直到某个已提交 eval 把全部 done_when 项列入 `success_criteria_met`（完成）或声明 `outcome=blocked`（阻塞）；随后该 eval 自己的新提案接管，或 Current Task 退回原始任务。active 契约在**每条编译路径**上都从已提交轮派生（reject 重试、resume、backtrack 都持续显示它）。完成声明被绑定到 active 契约：声称 done_when 满足但无机器验证证据、或在声称成功时静默丢弃 done_when 项 → `premature_boundary`（R-C1）；改动超出 active scope → `round_scope_drift`（R-C2），只有带实质 `drift_clarification` 才被接受。自 v3.5 起，关闭契约本身也是成功级声明：若 verification_plan 命令没有全部在本轮被观察到通过 → `contract_completion_unverified`；active 契约未关闭时提出的不同提案不再静默——`contract_premature`（warn）会把它显性化（契约仍被忽略直到完成或阻塞）。回溯后若恢复的 Current Task 是导致停滞的契约，正确修法是 `outcome="blocked"` + blocker 关闭它，并在同一提交声明修订契约。无契约的 L2 prompt 会提示声明契约（`prompt.contract_nudge_on_l2`，默认开）；`loopforge_status` 与 `loopforge_replay` 现在暴露派生的 active 契约与每轮声明的提案。无合同 → 行为逐字节不变，R8 的机器证据要求仍然守护每一次成功声明。

### 恢复

被拒绝的轮次什么都不提交。停滞触发自动回溯，回退到上一个干净轮次并注入诊断。回溯 prompt 包含工作区恢复指令；下一轮提交会验证工作区是否确实恢复了。Session 通过可续租约跨进程存活——resume 精确接上中断的位置。

### Agent 自主权

L0（重试）/ L1（续行）/ L2（全量恢复）只控制状态密度——推理策略由 Agent 决定。每轮 Agent 可通过 `prompt_requests`（强调、展开、困惑点）表达信息需求。Compiler 在安全边界内重组 prompt——mandatory sections 永不被移除。

九个 MCP 工具（`start` · `next` · `status` · `stop` · `pause` · `resume` · `replay` + `gate_check` · `gate_resolve`），返回 JSON content 块。`status` 是统一查看工具：`view=session|loop|all|audit`（原 `list`/`health` 并入，另含只读验证审计——claims/gates/verdict/序列完整性）。零运行时依赖——Node.js 标准库 only。所有阈值、预算、间隔集中在 `loop_policy.json`。865 测试。

---

## License

MIT
