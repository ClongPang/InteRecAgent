# 19-4 Globex 系统提示词全文与逐层注解

来源: https://alidocs.dingtalk.com/i/nodes/vNG4YZ7JnP9OlBYqtN9Z37q2W2LD0oRE

作者：会敲代码的泡  
创建时间：07-24 18:06

> 整理说明：本文档是对页面内容的结构化整理与转述，保留章节脉络、工程要点、落地方式和检查项，不是第三方页面的逐字转录。

## AI 概览

本章把 19-1 的分层提示词骨架、19-2 的工具路由策略、19-3 的缓存友好规则装配成一份可落地的 Globex system prompt 方案。重点不只是给出“该写什么”，而是解释每一层为什么放在这个位置、哪些内容稳定、哪些内容动态、哪些段落应该进入缓存前缀。

本章还把主 system prompt 之外的元提示词统一纳入提示词资产，包括 Planner、会话摘要、工具结果压缩、ShoppingSummary 和 Rubric judge。最后给出落地到 `prompts.yml` 时的注入位、`cache_control` 断点和上线前自检清单。

## 本章课程目标

- 获得一份能映射到 Globex 工程的完整 prompt 装配方案。
- 理解 `<role>`、`<constraints>`、`<loop>`、`<tool_policy>`、`<examples>`、`<user_preferences>` 每一层的职责和易变性。
- 掌握工具路由在完整 prompt 中的落点：兜底、Planner、fork、主 Agent 单干。
- 明确元提示词和主 system prompt 的协作关系，避免只优化主链路而忽略 Planner、摘要、评分等辅助模型调用。
- 知道 `prompts.yml` 中的动态注入位和缓存断点应该放在哪里。
- 用自检清单约束 prompt 改动，减少缓存失效、规则漂移和评测不可比。

## 1、为什么需要一份“全文”

前面三章分别拆解了 prompt 的零件：

- 19-1 讲分层骨架、分级强调、XML 区块和 few-shot。
- 19-2 讲工具策略、子 Agent 派发、fork 条件和兜底分支。
- 19-3 讲静态到动态的排布、缓存断点、元提示词和评测。

这些内容分开看有利于理解单个设计点，但工程落地时还需要一份装配图：各段的顺序、缩进、注入位和路由文案必须放在同一个上下文里才能真正跑起来。本章的价值就是把“零件”拼成“可用的提示词资产”，再逐层说明它们的来源和设计理由。

## 2、Globex System Prompt 的装配结构

完整 prompt 按稳定性从高到低排布。静态、跨用户共享的内容靠前，用户偏好和当前轮动态内容靠后。

```text
system_prompt:
  <role>
    定义 Globex 是跨平台购物 Agent，负责围绕用户购物需求做检索、比较、筛选和总结。
  </role>

  <constraints>
    放不可破坏的红线约束，例如不编造商品信息、不忽略预算/材质/平台等硬约束、不得用营销话术替代真实证据。
  </constraints>

  <loop>
    每轮遵循 Think -> Act -> Observe -> Reflect：
    先拆意图，再调用工具或派发子 Agent，随后阅读结构化结果，最后判断是否继续或收尾。
  </loop>

  <tool_policy>
    列出工具能力，并声明每轮路由顺序：
    兜底 -> Planner -> dispatch_tool fork -> 主 Agent 直接调用工具。
  </tool_policy>

  <examples>
    用 few-shot 覆盖直接单干、Planner、fork、兜底和最终输出等边界行为。
  </examples>

  <user_preferences>
    {long_term_preferences}
  </user_preferences>
```

### 工具清单

| 工具 | 职责 |
| --- | --- |
| `Planner` | 把复杂购物意图拆成预算、品类、材质、风格、平台、硬约束和软偏好等结构化字段。 |
| `ChatFallback` | 处理非购物意图或闲聊，避免为无关输入启动检索链路。 |
| `WebSearch` | 检索评测、博主推荐、价格趋势等外部信息。 |
| `CategoryInsight` | 基于商品知识库查询品类爆款、典型属性和选购知识。 |
| `ItemSearch` | 对单个平台执行商品检索。 |
| `ItemPicker` | 在候选商品集合中结合用户偏好做二次筛选。 |
| `PriceCompare` | 对跨平台候选商品做价格比较。 |
| `ShippingCalc` | 估算关税、运费和直邮相关成本。 |
| `ShoppingSummary` | 作为终结性工具输出最终清单和选购理由。 |
| `dispatch_tool` | 派发同质子 AgentLoop，处理可并行、需要隔离或链路较深的子任务。 |

### 路由顺序

1. 非购物输入先走 `ChatFallback`，不要启动 Planner、检索或 fork。
2. 复杂、多约束、组合品类或首轮信息量大的请求先走 `Planner`。
3. 当子任务可并行、输出需要隔离，或内部还要多轮 Think/Act 时，使用 `dispatch_tool` 派发子 AgentLoop。
4. 单步可完成、品类明确、候选已经合流、或已经满足收尾条件时，主 Agent 直接调用对应工具。

### 不该 fork 的情况

- 单个工具调用就能完成的原子任务。
- 只是临时换一个工具调用。
- 子任务输出很小，不需要上下文隔离。

fork 的收益来自并行、隔离和深链路拆分；如果只是为了“显得复杂”而 fork，会引入额外上下文和调度成本。

## 3、逐层注解

| 段落 | 职责 | 易变性 | 来源 |
| --- | --- | --- | --- |
| `<role>` | 锁定 Agent 身份、跨平台购物场景和最终职责。 | 全天不变 | 19-1 的角色层 |
| `<constraints>` | 放红线约束、重要约束和一般约束，约束模型行为边界。 | 全天不变 | 19-1 的分级强调 |
| `<loop>` | 规定 Think -> Act -> Observe -> Reflect 的工作范式。 | 全天不变 | 第 2 章与第 10 章 |
| `<tool_policy>` 工具清单 | 说明 9 个购物工具和 `dispatch_tool` 的能力。 | 工具集变更时才改 | 第 10 章与 19-2 |
| `<tool_policy>` 决策路由 | 固化兜底、Planner、fork、单干四分支。 | 全天不变 | 19-2 的路由设计 |
| `<tool_policy>` demands 写法 | 规定派发子 Agent 时任务说明、约束、产物格式和摘要要求。 | 全天不变 | 19-2 的子 Agent 派活模板 |
| `<examples>` | 用 few-shot 固化路由边界、输出格式和反例。 | 全天不变 | 19-1 与 19-2 |
| `<user_preferences>` | 注入用户长期偏好。 | 每个用户不同，可能更新 | 第 6 章与第 10 章 |

### 3.1 为什么按“兜底 -> Planner -> fork -> 单干”排序

这个顺序的核心是先排除最便宜、最确定的分支，再进入更重的推理和调度：

```text
非购物输入：直接兜底，最低成本。
复杂购物输入：先 Planner，保证后续字段干净。
可并行或需隔离的子任务：再判断是否 fork。
都不满足：默认由主 Agent 直接完成。
```

这样可以避免两类浪费：一是为闲聊或无关输入启动购物链路；二是为简单查询引入 Planner 或子 Agent 调度。

### 3.2 为什么 `<constraints>` 要早于 `<loop>`

约束描述的是“任何时候都不能破”的边界，循环范式描述的是“怎么工作”。先立边界，再给流程，符合越靠前优先级越高的 prompt 设计原则。否则模型可能把流程当成目标，把硬约束当成可协商的建议。

### 3.3 为什么 `<examples>` 要早于 `<user_preferences>`

few-shot 示例是静态内容，适合进入缓存前缀；用户偏好是动态内容，每个用户都可能不同。把 `<examples>` 放在 `<user_preferences>` 前面，可以让示例层被不同用户共享缓存，而不会因为偏好差异导致前缀失效。

## 4、配套元提示词

主 system prompt 之外，Globex 还需要一组给模型调用的“模型指令”。这些提示词同样应该被纳入 `prompts.yml` 管理，而不是散落在代码里。

### Planner Prompt

Planner 的任务是把用户意图转为固定 JSON。字段应覆盖：

- `budget`
- `category`
- `material_pref.exclude`
- `material_pref.prefer`
- `style_pref`
- `platforms`
- `hard_constraints`
- `soft_preferences`

规则重点是：只输出 JSON，不输出解释；用户没提到的字段保持空值或空数组；预算区间按上限处理；不要把模型推测当作用户约束。

### Session Summary Prompt

会话摘要要保留结构，而不是自由总结。建议固定包含：

- 用户核心需求：品类、预算、平台。
- 已确认的硬约束与软偏好。
- 已检索的平台和候选概况。
- 被排除的商品及原因。
- 当前链路所处步骤。
- 下一步计划。

这样做的目的不是压缩字数本身，而是避免上下文压缩时丢失预算、材质排除、已排除候选等关键约束。

### Tool Result Compress Prompt

工具结果压缩要先判断“是否值得压缩”。大量重复商品描述需要压缩，已经很短的结构化结果则应原样保留。真正压缩时，保留商品名称、价格、评分、平台等可继续推理的字段，丢弃长描述和重复噪声。

### ShoppingSummary Prompt

`ShoppingSummary` 是终结性输出工具。它应该基于候选商品和用户偏好，输出有限数量的最终推荐，并说明选购理由、价格是否包含运费/关税，以及是否支持直邮。它不负责继续扩展检索，而是负责把已收集证据整理成可交付结论。

### Rubric Judge Prompt

Rubric judge 使用 P0/P1/P2 三层评分：

- P0 是必须满足的红线，失败通常意味着整体判定失败。
- P1 是重要质量项。
- P2 是加分项。

judge 输出应包含逐项命中情况、总分和简短理由。为了保证同一回答的评分稳定，评分模型应使用强 judge 模型，并把温度设为 0。

### 模型分级

| 任务 | 推荐模型档位 | 原因 |
| --- | --- | --- |
| 主 AgentLoop / 子 AgentLoop | 主模型 | 需要完整推理和工具调用能力。 |
| Planner / 会话摘要 / 工具结果压缩 | lite 模型 | 主要是结构化和降维任务，成本与延迟优先。 |
| Rubric judge | judge 强模型 | 评分质量会影响评测和训练数据质量。 |

## 5、落地到 `prompts.yml`

### 5.1 动态注入位

`{long_term_preferences}` 应由第 10 章的 prompt 加载函数在请求入口填入。实现上可以概括为：

```python
def get_system_prompt(long_term_preferences: str = "") -> str:
    prompts = load_prompts()
    template = prompts["system_prompt"]
    return template.format(
        long_term_preferences=long_term_preferences or "（暂无沉淀偏好）"
    )
```

Rubric 中的 `{p0_items}`、`{p1_items}`、`{p2_items}` 也应由评测体系动态生成后填入，而不是硬编码到 judge prompt 里。

### 5.2 `cache_control` 断点

Globex 的 4 个断点可以这样分配：

| 断点 | 位置 | 目的 |
| --- | --- | --- |
| 1 | 工具 schema 之后 | 工具定义稳定且通常较大，适合长 TTL。 |
| 2 | `<examples>` 之后、`<user_preferences>` 之前 | 把 system prompt 静态区完整圈进缓存前缀。 |
| 3 | 早期对话历史末尾 | 随会话推进滚动，适合短 TTL。 |
| 4 | 预留给大的稳定工具结果 | 例如稳定的品类知识块或大段 RAG 结果。 |

断点 2 是本章最关键的工程落点：它必须落在静态示例和动态偏好之间。这样用户偏好变化不会破坏前面稳定 prompt 的缓存收益。

## 6、上线前 Prompt 自检清单

| # | 检查项 | 对应章节 |
| --- | --- | --- |
| 1 | `CRITICAL` 和 `IMPORTANT` 规则数量是否克制，避免强调词泛滥。 | 19-1 |
| 2 | 每条约束是否可判定，避免“尽量、合理、适当”这类模糊词。 | 19-1 |
| 3 | 是否使用清晰分区，例如 XML 风格标签，并避免深层嵌套。 | 19-1 |
| 4 | 四个路由分支是否完整：兜底、Planner、fork、单干。 | 19-2 |
| 5 | 是否明确写出不应该 fork 的边界。 | 19-2 |
| 6 | few-shot 是否覆盖主要路由分支和边界行为。 | 19-2 |
| 7 | `demands` 模板是否要求子 Agent 返回摘要，而不是大 payload。 | 19-2 |
| 8 | 动态块是否都放在末尾，或作为 reminder 注入。 | 19-3 |
| 9 | 是否没有在 system prompt 中拼接时间戳、随机串等高频变化内容。 | 19-3 |
| 10 | prompt 改动是否通过 Rubric 做过前后对比，而不是只靠主观感觉。 | 19-3 |

## 7、本章小结

本章把 Prompt 工程篇的前几章收束成一份工程化提示词资产。核心结论是：

- 主 system prompt 要按静态到动态排列。
- 工具路由要先省成本，再做规划，再判断并行/隔离，最后默认单干。
- 元提示词和主 prompt 同等重要，应该统一管理、统一评测。
- `user_preferences` 这种动态内容必须靠后，缓存断点要落在静态区尾部。
- 每次改 prompt 都要过自检表，并用 Rubric 做前后对比。

这套设计让 Globex 的 prompt 不只是“能回答”，而是能被缓存、能被评测、能被持续迭代。
