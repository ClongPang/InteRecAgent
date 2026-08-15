# 19-3 缓存友好写法与元提示词

来源: https://alidocs.dingtalk.com/i/nodes/0eMKjyp813y4Yga9ue4dXAjPVxAZB1Gv

作者：会敲代码的泡  
创建时间：07-24 18:05

## AI 概览

本章系统阐述缓存友好的提示词设计原则与工程实践，旨在指导开发者如何编写高效、可缓存、易评估的 prompt。重点包括静态→动态分层排布、`cache_control` 断点策略、元提示词设计、system-reminder 注入模式及 prompt 质量验证方法。最终目标是实现高命中缓存、低成本推理与可持续优化的提示工程闭环。

## 本章课程目标

- 从“作者视角”掌握缓存友好的提示词写法：静态→动态分层排布、动态块放末尾、禁止在 system prompt 拼时间戳、prompt 变更走“改末尾不改开头”。（缓存机制本身在第 5 章已深讲，本章不重复推导）
- 理解 `cache_control` 落点是“作者判断”——哪几段该打标记、为什么。
- 掌握元提示词（meta-prompt）的设计：会话/工具结果摘要、Planner 结构化输出、Rubric 评分——这些“给模型用的模型指令”和主 system prompt 一样重要。
- 学会 `system-reminder` 注入模式：把动态约束/进度作为“提醒”注入，而不是改 system prompt，从而保住缓存前缀。
- 理解摘要类任务为什么该用轻量模型（Haiku 思路 → Globex lite 模型）。
- 建立 prompt 质量评估的方法：一次 prompt 改动到底变好没有，怎么验证。

学习建议：这一章是 Prompt 工程篇的收尾，把“怎么写 prompt”和“prompt 怎么和缓存/评测/自进化协同”接起来。缓存机制细节请配合第 5 章看，本章只讲“作为 prompt 作者，我该怎么下笔才不破坏缓存”。读完后你应该能审查任何一次 prompt 改动：“这次改动会不会打崩缓存前缀、要不要走 reminder 注入、改完怎么证明它更好”。

## 1、缓存友好写法：作者视角

### 1.1 先对齐第 5 章的结论

第 5 章已经讲透了 Prompt Cache 的机制：前缀完全匹配才命中、最多 4 个 `cache_control` 断点、默认 5 分钟 TTL（可延到 1 小时）、Sonnet 最低 1024 token 才写缓存。本章不重复这些机制，只回答一个问题：

> 作为写 prompt 的人，我该怎么下笔，才能让第 5 章那套缓存机制真正生效？

核心就一条：按易变性从静态到动态排布，动态的东西一律往后放。

### 1.2 静态→动态分层排布

回顾 19-1 给的 system prompt 骨架，把每一层按易变性排序：

```text
[ role ]                  ← 全天不变          ┐
[ constraints ]           ← 全天不变          │ 静态区
[ loop ]                  ← 全天不变          │ （进缓存前缀）
[ tool_policy ]           ← 全天不变          │
[ examples ]              ← 全天不变          ┘
--------- cache_control 打在这条线上 ---------
[ user_preferences ]      ← 每用户不同、会更新  ┐ 动态区
[ 当前对话历史 ]           ← 每轮增长           │ （不进/晚进缓存）
[ 当前用户消息 ]           ← 每轮都变           ┘
```

为什么动态块必须放最末尾：前缀匹配是从头比到尾，一旦中间某个字符变了，后面全部失效。如果把“每用户不同的偏好”放在 `<role>` 和 `<constraints>` 之间，那么 A 用户和 B 用户连 `<constraints>` 都无法共享缓存——因为它们前面的偏好块不一样。放到最末尾，前面整段静态区就能被所有用户、所有轮次共享。

这也解释了第 10 章为什么把 `{long_term_preferences}` 注入位放在 system prompt 的最后——不是随便放的，是为了缓存。

### 1.3 三条硬性写法纪律

| 纪律 | 为什么 | 违反后果 |
| --- | --- | --- |
| 禁止在 system prompt 拼时间戳/随机串 | 每次请求前缀都变 | 缓存 100% miss |
| 动态内容（偏好/汇率/平台状态）放末尾或走注入 | 保住前面静态区前缀 | 静态区跟着失效 |
| prompt 变更“改末尾不改开头” | 改开头 = 整段前缀失效 | 改一个字，全缓存重建 |

第三条特别值得强调：当你要给 system prompt 加一条新规则时，优先加在静态区的末尾（比如 `<constraints>` 最后一条），而不是插在 `<role>` 里。这样前面的前缀还能命中缓存。这一点在 18 篇讲 Prompt 自进化时会再用到——自动优化 prompt 也要遵守“改末尾”纪律。

### 1.4 `cache_control` 落点是作者判断

第 5 章讲了 `cache_control` 怎么写（API 语法），但“打在哪几段”是 prompt 作者要决策的。Globex 的建议落点（4 个断点预算怎么花）：

```text
断点 1：工具 schema 之后（工具定义全天不变，值得 1h TTL）
断点 2：system prompt 静态区末尾（examples 之后，user_preferences 之前）
断点 3：早期对话历史末尾（每轮往后挪，5 分钟 TTL）
断点 4：预留（给特别大的稳定工具结果，如一次 CategoryInsight 的知识块）
```

作者判断的原则：把断点花在“又大又稳”的内容边界上。又大（超过最低写入阈值才划算）、又稳（下次请求还长这样才可能命中）。小而多变的内容打断点是浪费。

## 2、元提示词：给模型用的模型指令

Globex 里不止一个 system prompt。凡是“用 LLM 去处理另一段内容”的地方，都需要一段提示词，我们叫它元提示词（meta-prompt）。它们往往被忽视，但质量直接影响主链路。

### 2.1 会话/工具结果摘要提示词

第 5 章讲了 Cache Breakpoint 之后要压缩历史，压缩手段之一是 LLM 摘要。这段摘要 prompt 怎么写，借鉴 Claude Code 两个经验：

经验一：先判断“要不要压”，再压（借鉴 bash 输出摘要的 should_summarize 决策）。

Claude Code 在摘要 bash 输出前，会先让模型判断这段输出“值不值得摘要”——如果是重复日志就压，如果是唯一信息/用户明确要看就不压。Globex 的工具结果摘要同理：

```text
# 工具结果摘要前的决策 prompt
判断这段工具返回是否需要精简：
- 若为大量重复/冗余字段（如 100 件商品的完整描述）→ 需要精简，只保留 名称/价格/评分/平台
- 若为已经很精简的结构化结果 → 不精简，原样保留
输出 <should_compress>true/false</should_compress> + <kept_fields>...</kept_fields>
```

经验二：会话级摘要用“结构化八段式”而非自由发挥（借鉴 compact）。

当整个会话逼近上下文上限，要做会话级摘要时，不要让模型“随便总结一下”，而是给固定结构，确保关键信息不丢：

```text
# 会话摘要 prompt（结构化）
把当前购物会话总结成以下固定结构：
1. 用户核心需求（品类/预算/平台）
2. 已确认的硬约束和软偏好
3. 已检索的平台和候选概况
4. 已排除的商品和原因
5. 当前进行到哪一步（对应 Think→Act→Observe→Reflect）
6. 下一步计划
只输出结构化摘要，不要寒暄。
```

这比一句“总结这段对话”稳健得多——它保证“用户约束”“已排除项”这些最容易在压缩中丢失的信息被显式保留（呼应第 5 章的“约束遗漏率”指标）。

### 2.2 Planner 结构化输出提示词

19-2 讲了什么时候调 Planner，这里讲 Planner 内部的 prompt 怎么写。核心是强制结构化输出：

```text
# Planner prompt
你是 Globex 的 Planner。把用户购物意图拆成严格的 JSON，字段固定：
{
  "budget": number | null,
  "category": string,
  "material_pref": {"exclude": string[], "prefer": string[]},
  "style_pref": string | null,
  "platforms": string[],
  "hard_constraints": string[],
  "soft_preferences": string[]
}
规则：
- 只输出 JSON，不要任何解释文字。
- 用户没提到的字段填 null 或空数组，NEVER 编造。
- 预算若为区间取上限。
```

两个要点：一是“只输出 JSON、不要解释”（否则后续解析会被寒暄污染）；二是“没提到就填空、不编造”（呼应 19-1 的 NEVER 约束，防止 Planner 幻觉出用户没说的约束）。

### 2.3 Rubric 评分提示词

第 8 章讲了 Rubric 评测体系（P0/P1/P2 三档评分）。judge 模型用的评分 prompt 也是元提示词，写法要点：

```text
# Rubric judge prompt（要点，完整体系见第 8 章）
你是 Globex 的评分员。根据下面动态生成的评分细则给 Agent 回答打分：
<rubric>
  P0（必须满足，否则判 0 分）：{p0_items}
  P1（重要）：{p1_items}
  P2（加分项）：{p2_items}
</rubric>
逐条判定，输出每条命中情况 + 总分 + 简短理由。
temperature=0，保证同一回答多次评分一致。
```

呼应第 10 章：judge 用更强的模型（`get_judge_llm()`）且 `temperature=0`——评分要的是稳定，不是创造力。

### 2.4 摘要类任务用轻量模型

Claude Code 的一个工程细节：会话摘要、bash 输出摘要这类任务用 Haiku（轻量模型），主任务才用 Sonnet。原因是摘要是“降维”任务，不需要顶级推理，用大模型是浪费。

Globex 落地：

| 任务 | 模型 | 理由 |
| --- | --- | --- |
| 主 / 子 AgentLoop 推理 | 主模型 | 需要完整推理和工具调用能力 |
| 工具结果 / 会话摘要 | lite 模型 | 降维任务，省钱省延迟 |
| Rubric 评分 | judge 强模型 | 评分质量是训练数据质量的上限（第 8 章） |

这套“模型分级”和第 16 篇的 Token 预算/模型路由降级是同一思路——把合适的任务交给合适档位的模型。

## 3、system-reminder 注入模式

### 3.1 问题：动态约束怎么加又不破坏缓存

有些约束是“这一轮特有”的，比如：

- “用户刚说了预算改成 500”；
- “amazon 平台这一轮超时了，别再派给它”（呼应 18 篇 fork 策略动态调整）；
- “当前已经 fork 了 3 个子 loop，注意收敛”。

如果把这些写进 system prompt，就违反了 1.3 的纪律——每轮都变，缓存全废。

### 3.2 解法：作为“提醒”注入到消息流

Claude Code 的做法是 `<system-reminder>` 标签——把动态提醒作为一条消息注入到对话流里，而不是改 system prompt。它明确告诉模型：“这些是提醒，不是用户输入，也不是工具结果”。

Globex 落地：

```text
# 动态约束不改 system prompt，而是作为 reminder 注入当前轮消息流
<system-reminder>
当前平台状态：amazon 本轮超时，请勿再派发给它；可用平台 [shopee, aliexpress, ebay]。
预算已更新为 500。
</system-reminder>
```

### 3.3 为什么这样能保住缓存

```text
system prompt（静态区）      ← 永远不变，缓存命中
早期对话历史               ← 缓存命中
<system-reminder>...</...>  ← 动态，放在靠后位置
当前用户消息               ← 动态
```

动态提醒放在消息流靠后的位置，前面的静态区和早期历史前缀依然完整，缓存照样命中。这是“动态内容放末尾”纪律在会话流层面的应用。它和 18 篇讲的 fork 策略动态调整、Prompt 自进化是配套的：真正高频变化的东西走 reminder 注入，真正稳定的规则才沉淀进 system prompt。

## 4、prompt 质量评估：改动到底变好没有

### 4.1 不能靠“感觉变好了”

改完一段 prompt，最忌讳的是“我觉得这样写更好”就上线。Agent 的 prompt 改动经常是“修了 A 又坏了 B”——加一条规则让某类 query 变好，但让另一类变差。

### 4.2 用 Rubric 做前后对比

复用第 8 章的 Rubric 评测体系，做 prompt 改动的 A/B 对比：

```text
1. 准备一个固定的评测集（覆盖各类 query：单干/Planner/fork/兜底）
2. 旧 prompt 跑一遍 → Rubric 均分 baseline
3. 新 prompt 跑一遍 → Rubric 均分 candidate
4. 判定：candidate >= baseline 且各分档没有明显回退 → 才上线
```

### 4.3 指向自进化篇

这套“改 prompt → 评测验证 → 决定上不上线”的闭环，正是第 18 篇 Prompt 自进化的基础。18 篇会把它升级为：

- prompt 版本化管理（git-like 版本号 + changelog + 回滚）；
- 按 `user_id` hash 分流的线上 A/B 测试；
- 让 LLM 自动分析 bad case 并生成 prompt 修改建议（Auto-Prompt-Optimization）。

本章打好“手动评估一次 prompt 改动”的地基，18 篇负责把它自动化。

## 5、反模式清单

| 反模式 | 后果 | 正确做法 |
| --- | --- | --- |
| system prompt 拼时间戳/随机串 | 缓存 100% miss | 时间等动态信息走 reminder 注入 |
| 用户偏好插在静态区中间 | 静态区无法跨用户共享缓存 | 偏好放最末尾（第 10 章注入位） |
| 改 prompt 从开头插新规则 | 整段前缀失效 | 新规则加在静态区末尾 |
| 摘要用主模型 | 贵、慢 | 降维任务用 lite 模型 |
| Planner 输出带解释文字 | 后续 JSON 解析被污染 | 强制“只输出 JSON” |
| 会话摘要“随便总结” | 用户约束/已排除项丢失 | 结构化八段式摘要 |
| 动态约束写进 system prompt | 破坏缓存前缀 | system-reminder 注入 |
| 改完 prompt 凭感觉上线 | 修 A 坏 B | Rubric 前后对比再上线 |

## 本章小结

到这里，Prompt 工程篇三章合起来，构成了 Globex 提示词工程的完整方法论：

1. 缓存友好写法：按易变性静态→动态排布，动态块一律放末尾；禁止拼时间戳；prompt 变更“改末尾不改开头”；`cache_control` 断点花在“又大又稳”的边界上（机制见第 5 章）。
2. 元提示词：会话/工具结果摘要（先判断要不要压 + 结构化八段式）、Planner 强制 JSON 输出、Rubric 评分——都是“给模型用的模型指令”，质量直接影响主链路。
3. 模型分级：摘要用 lite 模型、推理用主模型、评分用 judge 强模型，把合适的任务交给合适档位的模型。
4. `system-reminder` 注入：高频变化的动态约束/进度走 reminder，不改 system prompt，从而保住缓存前缀。
5. prompt 质量评估：改动用 Rubric 做前后对比再上线，杜绝“凭感觉”；这套闭环是第 18 篇 Prompt 自进化的基础。

回看前三章：19-1 搭系统提示词的架构（分层 + 分级强调 + few-shot + XML 分区）；19-2 填最关键的决策路由（单干 / Planner / fork / 兜底）和工具、子 Agent 提示词；本章 19-3 让这一切缓存友好，并补齐元提示词、reminder 注入和质量评估。三章的方法论大量借鉴了 Claude Code 这类工业级 Agent 的提示词设计，但每一条都落回了 Globex 的购物场景。

下一章「[19-4 Globex 系统提示词全文与逐层注解]」会把前三章的方法论和零件全部装配起来——给一份可以直接复制进 `prompts.yml` 的完整 system prompt 全文，逐层注解每段的来历，并附上一份上线前自检清单。
