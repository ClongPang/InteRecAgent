# 17-1 Harness工程全景与Globex组件映射

来源：钉钉文档 https://alidocs.dingtalk.com/i/nodes/yQod3RxJKGkMNXZ5hoZXeL5pJkb4Mw9r

本章系统阐述了 Harness Engineering 的定义、核心原则与控制分类学，通过 Globex 三个真实故障案例论证“Agent 出问题应优先修复运行时基础设施而非 Prompt”，并构建涵盖上下文管理、工具控制、安全防护等维度的完整 Harness 框架，揭示四大典型失败模式及其防御机制，强调 Harness 需持续演进且随模型能力变化动态调整。

本章课程目标：

- 理解 Harness Engineering 的行业定义——Agent = Model + Harness，Harness 是"模型之外的一切运行时基础设施"。
- 掌握核心原则："Agent 出问题先修 Harness 不是修 Prompt"——并通过 Globex 三个真实 bad case 佐证。
- 理解两大控制类型分类学：Feedforward（前馈：行动前引导）vs Feedback（反馈：行动后检测纠正），各自再分为 Computational（确定性）和 Inferential（语义级）。
- 拿到一张 Globex 完整 Harness 组件全景图——把第 1 到 16 章分散的能力统一映射到 Harness 框架。
- 理解四大失败模式（Context Exhaustion / Tool Sequencing Error / Silent Drift / Permission Breach）在 Globex 场景的具体表现。

学习建议： 这一章是"装配图"——前面 16+ 章你已经把零件都做好了，本章告诉你这些零件在一个叫 Harness 的工程框架里各自处于什么位置、为什么要放在那个位置。读完后你应该能画出一张图："我的 Agent 在哪些地方有 Harness 保护、哪些地方还裸奔着"。

对应代码分支： 无新增代码。本章是框架认知层。

---

## 1、什么是 Harness Engineering

### 1.1 一句话定义

> Agent = Model + Harness
>
> Harness 是"围绕 AI Agent 的运行时基础设施"——管理工具执行、记忆、安全、上下文、验证循环，把一个只会生成文本的 LLM 变成一个能在生产环境完成真实任务的 Agent。

### 1.2 Harness 不是 Framework

| 概念 | 是什么 | 类比 |
| --- | --- | --- |
| Framework | 组件库——提供 tool 定义、prompt 模板、chain 抽象 | 工具箱里的扳手和螺丝 |
| Harness | 运行时环境——提供沙箱、状态管理、生命周期 Hook、验证循环 | 发动机运转的整台车 |

类比：Model 是 CPU，Context Window 是 RAM，Harness 是操作系统，Agent 是应用。你可以不用操作系统写程序，但你会重新发明进程调度、内存管理和 I/O 处理。

### 1.3 为什么 2025-2026 年 Harness 成了一个独立学科

三个推动因素：

| 因素 | 具体表现 |
| --- | --- |
| Agent 长度变长 | 从 1 轮问答 → 5-15 轮工具调用 → 跨会话长任务，裸 LLM 撑不住 |
| 失败模式从模型转到环境 | 大部分线上 bad case 不是"模型笨"，是"工具超时 / 上下文爆 / 权限越界" |
| 可复现性要求 | 评测分跨环境不一致 = Harness 没锁好 |

OpenAI（Codex）、Anthropic（Claude Code）、Google（ADK）都在 2025-2026 年正式提出 Harness Engineering 作为独立工程实践。

## 2、核心原则："修 Harness 不是修 Prompt"

### 2.1 原则表述

> When an agent fails in production, the instinct is to fix the prompt. That instinct is almost always wrong.
>
> 如果一个 Agent 持续在某类任务上表现不好，问题几乎总是在它周围的系统，而不是给它的指令。

### 2.2 Globex 三个真实 bad case 佐证

Case A：改了 3 天 prompt，最后发现是工具返回太大

```text
症状：Agent 在 10 轮后开始推荐和 query 完全无关的商品
直觉修法：改 system prompt，加更强的"必须紧扣用户需求"规则
实际根因：第 4 轮 ItemSearch 返回了 80 件商品（~12000 token），
挤压了 system prompt 在上下文里的权重 → 模型"忘了"用户需求
真正的修法：在 Harness 的 post_tool_call Hook 加工具返回截断（truncate_long_tool_result）
```

Case B：加了 Few-Shot 示例，结果格式正确率反降

```text
症状：Agent 有时候不调 ShoppingSummary 就直接回答用户
直觉修法：在 system prompt 里加 3 条 Few-Shot 示范"最后一定要调 ShoppingSummary"
实际根因：Few-Shot 示例占了 2000 token → Cache Breakpoint 位置移动 → Prompt Cache 命中率崩
真正的修法：把"必须调 ShoppingSummary"写成 Harness 的 post_reflect Hook assertion
```

Case C：反复调参 temperature，解决不了跨平台 fork 时的混乱

```text
症状：4 路并行 fork 的子 Agent 有时候互相覆盖结果
直觉修法：降 temperature，让模型更"确定性"
实际根因：ContextVar 没有正确 copy 到子 Task → 子 Agent 读到了主 loop 的 session_dir
真正的修法：在 Harness 的 pre_fork Hook 显式复制并隔离 ContextVar
```

三个 case 的共同规律：问题看起来是模型行为，实际是 Harness 层（上下文管理 / 缓存策略 / 并发隔离）的 bug。修 prompt 不但解决不了，还可能引入新问题。

## 3、两大控制类型分类学

### 3.1 Feedforward vs Feedback

```text
┌─────────────────────────┐
│ Agent 执行一步 Act │
└─────────────────────────┘
↑ ↓
┌───────────────┘ └───────────────┐
│ Feedforward Controls │ Feedback Controls
│ （行动前引导） │ （行动后检测纠正）
│ │
│ - System Prompt 边界声明 │ - LoopDetector 循环检测
│ - Tool Allowlist 工具白名单 │ - Schema Assertion 格式校验
│ - Context Curation 上下文裁剪 │ - Drift Detection 漂移检测
│ - Phase State Machine 阶段工具限制 │ - LLM-as-Judge 语义评估
│ - Token Budget Hint 降级提示 │ - Output Guard 输出审核
└────────────────────────────────────────────┘
```

### 3.2 每种控制再分两档

| 控制类型 | Computational（确定性、快、便宜） | Inferential（语义级、非确定性、贵） |
| --- | --- | --- |
| Feedforward | 工具白名单 / 参数 schema 校验 / 阶段状态机 | System Prompt 规则 / Token 预算 hint 注入 |
| Feedback | JSON parse 检查 / LoopDetector / 结果截断 | LLM-as-Judge / 漂移检测 / Rubric 评测 |

工程原则：先用 Computational 控制覆盖能覆盖的，Inferential 只用在 Computational 覆盖不了的地方——因为 Inferential 本身不确定，依赖另一次 LLM 调用。

### 3.3 分类的实战价值

面试时被问"你们的 Harness 怎么设计的"，可以按这个框架回答：

```text
"我们的 Harness 分 Feedforward 和 Feedback 两大类。
Feedforward 用工具白名单 + 阶段状态机 + Token 预算 hint 引导 Agent 行为。
Feedback 用 LoopDetector + 工具返回 assertion + 每 3 轮一次漂移检测来纠正。
优先用确定性检查，只有确定性覆盖不了的地方才上 LLM-as-Judge。"
```

## 4、Globex 完整 Harness 组件全景图

### 4.1 按 Harness 框架重新组织已有能力

| Harness 维度 | Globex 已实现的组件 | 所在章节 | 控制类型 |
| --- | --- | --- | --- |
| Agent Loop | AgentLoop Think→Act→Observe→Reflect | 1-3 章 | 骨架 |
| Context Engineering | Cache Breakpoint 上下文压缩 | 5 章 | Feedforward/Comp |
| 长期偏好注入 system prompt | 6 章 | Feedforward/Inf |  |
| Memory & State | 长期记忆 Store（Redis + 软衰减） | 6 章 | 状态管理 |
| Checkpoint（LangGraph 断点恢复） | 14/15 章 | 状态管理 |  |
| Tool Control | 工具白名单 | 16-6 章 | Feedforward/Comp |
| 工具参数 Pydantic schema | 11-13 章 | Feedforward/Comp |  |
| 单工具结果截断 | 14 章 | Feedback/Comp |  |
| 工具熔断三态 | 16-5 章 | Feedback/Comp |  |
| Loop Safety | LoopDetector 滑动窗口 | 14 章 | Feedback/Comp |
| Fork 深度上限 | 14 章 | Feedforward/Comp |  |
| 主 loop / 子 Agent 超时 | 14 章 | Feedback/Comp |  |
| Cost Control | Token 预算四档降级 | 16-4 章 | Feedforward/Inf |
| 模型路由降级 | 16-4 章 | Feedforward/Comp |  |
| Security | Prompt Injection 四层防御 | 16-6 章 | Feedforward+Feedback |
| 输出审核（item_id / API Key 脱敏） | 16-6 章 | Feedback/Comp |  |
| Observability | LangFuse 全链路 Trace | 16-3 章 | 观测层 |
| Observability | 工具 RT 告警 | 16-3 章 | 观测层 |
| AGUI | 事件协议 + WebSocket 实时推送 | 7/15 章 | 用户体验层 |
| Eval | Rubric as Rewards 端到端评测 | 8 章 | Feedback/Inf |
| Training Loop | SFT + Agentic RL 训练闭环 | 8-1/8-2 章 | 持续进化层 |
| Deployment | Docker Compose / vLLM / K8s | 16-1/16-2/16-6 | 运行环境层 |

### 4.2 还没有的

| Harness 维度 | 缺什么 | 将在哪里补 |
| --- | --- | --- |
| Hook Pipeline | 分散的 pre/post 检查没有统一注册入口 | 17-2 章 |
| Step Verification | 单步级 assertion（不是 Rubric 端到端） | 17-3 章 |
| Drift Detection | Silent Drift 漂移检测（不同于 LoopDetector） | 17-3 章 |
| Dynamic Tooling | 对话阶段状态机动态收缩工具子集 | 17-4 章 |

## 5、四大失败模式在 Globex 的对应

### 5.1 Context Window Exhaustion

| 失败表现 | Globex 场景 | Harness 防御 |
| --- | --- | --- |
| 推理质量断崖式下降 | 4 路 ItemSearch 合流后上下文 > 40K token → 模型开始"忘事" | Cache Breakpoint + Token 预算 + 工具截断 |
| 触发 InputContentTooLong | 15 轮对话未压缩 | post_step_compress Hook |

### 5.2 Tool Call Sequencing Error

| 失败表现 | Globex 场景 | Harness 防御 |
| --- | --- | --- |
| ShoppingSummary 空输出 | Agent 在没有 ItemPicker 结果时就调了 ShoppingSummary | 阶段状态机（17-4） |
| fork 在不该 fork 时触发 | 单平台 query 也 fork 出 4 路 | Fork 三件事判断 + 深度限制 |

### 5.3 Silent Drift

| 失败表现 | Globex 场景 | Harness 防御 |
| --- | --- | --- |
| 推荐和 query 无关 | 跑了 8 轮后推荐的商品和原始需求完全不搭 | 漂移检测（17-3） |
| 偏好丢失 | 用户说"不要塑料"，最终推荐里有塑料 | 长期偏好 assertion（17-3） |

### 5.4 Permission Breach

| 失败表现 | Globex 场景 | Harness 防御 |
| --- | --- | --- |
| 泄露 item_id | Agent 输出里包含内部商品 ID | 输出审核 L4 |
| 工具越权 | 外部注入让 Agent 尝试调不存在的工具 | 工具白名单 L1 |

## 6、Harness 的持续演进心态

### 6.1 Harness 不是一次性搭建，是持续演进

```text
线上 bad case 出现
→ 追溯到 Harness 的哪一层漏了
→ 在那一层加或改一个 Hook / assertion
→ 回测确认修复
→ 上线
```

这就是第 8 章"数据飞轮"在 Harness 维度的对应——Harness 也有自己的飞轮：每个 bad case 都让 Harness 变厚一点，但只厚在该厚的地方。

### 6.2 Harness 组件的"过期性"

行业一个重要认知：Harness 的每个组件都假设"模型做不到某件事"——当模型进步后，这个假设可能过期。

| Harness 组件 | 当前假设 | 什么时候可以退 |
| --- | --- | --- |
| LoopDetector | 模型会陷入死循环 | 模型学会自己检测重复并收敛时 |
| 工具结果截断 | 模型无法处理超长工具返回 | Context Window 扩展到 1M+ 时 |
| 阶段状态机 | 模型会在错误阶段调错误工具 | 模型 100% 遵循工具调用顺序时 |
| 安全内容过滤 | 模型会被 injection 劫持 | 模型内建 injection 免疫能力时 |

但在 2025-2026 年，这些假设全部成立——所以 Harness 的每个组件现在都是必须的。

## 7、和已有章节的关系总结

| 关系类型 | 具体说明 |
| --- | --- |
| 统一命名 | 把 1-16 章零散组件统一到 "Harness" 这个行业标准框架下 |
| 提供地图 | 告诉读者"你已经做了什么、还缺什么、接下来 17-2/3/4 补什么" |
| 面试支撑 | Q7（LoopDetector）/ Q31（安全）/ Q32（熔断）的回答现在有一个统一框架 |
| 架构判断 | "先 Computational 后 Inferential" 的原则让 Harness 设计不至于过度 |

本章小结：

到这里，你应该对 Harness Engineering 有了系统性认知：

1. Agent = Model + Harness：Harness 是围绕 Agent 的运行时基础设施，不是 Framework。
2. "修 Harness 不是修 Prompt"：三个真实 bad case 证明了这个原则。
3. Feedforward + Feedback，Computational + Inferential 的 2×2 分类学，是 Harness 设计的基本思考框架。
4. Globex 已有 Harness 组件全景图：20+ 个组件分布在 16 章里，统一映射后一目了然。
5. 四大失败模式：Context Exhaustion / Tool Sequencing / Silent Drift / Permission Breach 各有对应防御。
6. Harness 持续演进：每个 bad case 让 Harness 变厚一层，但假设过期时也要敢退。

下一章「[Middleware Hook Pipeline 与工具调用生命周期](17-2 Middleware-Hook-Pipeline与工具调用生命周期.md)」会把这张地图上标记"还没有"的第一块能力补上——用 6 个 Hook 点把分散的 pre/post 检查系统化为统一的 Middleware Pipeline。
