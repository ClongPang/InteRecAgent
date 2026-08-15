# 19-1 系统提示词架构与分级强调

来源：https://alidocs.dingtalk.com/i/nodes/7dx2rn0JbYBAo2X7fZ25bwQnVMGjLRb3

作者：会敲代码的泡  
创建时间：07-24 18:01

## AI 概览

Agent 的 system prompt 是贯穿整个任务生命周期的“系统级契约”，而非一次性指令。由于在 AgentLoop 中被复用数十次，其必须稳定、精确、分层清晰。本文以 Claude Code 为范本，提出 Globex 提示词应按角色、安全、语气、主动性、约定、任务管理、工具策略、环境信息八层结构化组织，结合分级强调、few-shot 示例与 XML 分区，确保可解析性与行为一致性。

## 本章课程目标

- 理解为什么 AgentLoop 项目的系统提示词是"多轮复用的系统级契约"，而不是"一次性的问法"——同一段 prompt 在一次任务里会被复用几十次，任何模糊都会被放大几十倍。
- 拆解一个工业级 Agent（Claude Code）的系统提示词分层结构：角色 → 安全边界 → 语气 → 主动性 → 约定 → 任务管理 → 工具策略 → 环境信息，并映射到 Globex 应有的分层。
- 掌握分级强调标记（IMPORTANT / NEVER / You MUST / CRITICAL）的语义梯度，以及"强调泛滥 = 全部失效"这个最常见的反模式。
- 学会在 system prompt 里内嵌 few-shot 示例（借鉴 Claude Code 的 <example> 写法）来锁定输出格式和边界行为。
- 理解 XML 标签/结构化分区为什么能提升长 prompt 的可解析性。
- 拿到一份 Globex system prompt 的目标分层骨架（在第 10 章 prompts.yml 基础上重构，每层标注职责与易变性）。

学习建议： 这一章是 Prompt 工程篇的"地基层"——回答"一段好的 Agent 系统提示词应该长什么样、分几层、每层放什么"。本章方法论大量参考了 Claude Code 逆向拆解出的系统提示词，但所有结论都落地到 Globex。读完后你应该能拿着现有的 prompts.yml，说清楚"哪一层缺了、哪一句强调是废的、哪里该加个示例"。

## 1、为什么 Agent 的 prompt 是"系统级契约"

### 1.1 一次性问法 vs 系统级契约

大多数人对"提示词工程"的理解还停留在"怎么把一个问题问好"——这是一次性问法（one-shot prompting）：写一段话，模型答一次，结束。

但在 Globex 这样的 AgentLoop 项目里，system prompt 是完全不同的东西：

```text
一次购物任务 = 一个 AgentLoop 主循环 + N 次 fork 子 AgentLoop
             = 同一段 system prompt 被复用几十次

用户问一句"旅行三件套预算 300"：
  主 loop 第 1 轮：system prompt + [user]
  主 loop 第 2 轮：system prompt + [user] + [Planner 结果]
  主 loop 第 3 轮：system prompt + [user] + ... + [CategoryInsight 结果]
  fork 子 loop ×4：每个子 loop 又各自带一份 system prompt 跑多轮
  ...
```

同一段 system prompt，一次任务里可能被送进模型三四十次。 这意味着：

- prompt 里任何一句模糊的话，会在几十轮里持续误导模型；
- prompt 里任何一个多余的段落，会在几十轮里持续烧 token；
- prompt 里任何一条没被遵守的约束，会在几十轮里反复翻车。

所以 Agent 的 system prompt 不是"问法"，而是一份契约：它定义了这个 Agent 在整个生命周期里的角色、边界、行为准则和工具使用规则。

### 1.2 契约思维带来的三个要求

| 要求 | 含义 | 反例 |
| --- | --- | --- |
| 稳定 | prompt 前缀要尽量固定，别每轮都变（否则缓存全废，见第 5 章） | 在 system prompt 里拼当前时间戳 |
| 精确 | 每条规则都要可判定，别写"尽量""适当""合理" | "适当的时候调用子 Agent" |
| 分层 | 按职责和易变性分层，便于维护和缓存 | 把工具描述、安全约束、示例全揉成一大段 |

本章解决"分层"和"精确"，缓存相关的"稳定"放到 19-3 展开。

## 2、拆解一个工业级 Agent 的系统提示词分层

Claude Code 是目前公开可考、被反复逆向分析的工业级 Agent 之一。把它的 system prompt 拆开看，是一个非常清晰的分层结构。我们先看它的分层，再映射到 Globex。

### 2.1 Claude Code 的系统提示词分层

| 层 | 段落名 | 放什么 | 作用 |
| --- | --- | --- | --- |
| 1 | 角色定义 | "You are an interactive CLI tool that helps..." | 一句话锁定身份和场景 |
| 2 | 安全边界 | "IMPORTANT: Assist with defensive security tasks only..." | 最高优先级的红线，放最前面 |
| 3 | 语气风格（Tone and style） | "You MUST answer concisely with fewer than 4 lines..." | 控制输出的详略、格式、废话量 |
| 4 | 主动性（Proactiveness） | "be proactive, but only when the user asks..." | 界定"该主动做"和"别擅自做"的边界 |
| 5 | 约定遵循（Following conventions） | "Mimic code style, use existing libraries..." | 让行为贴合环境而不是想当然 |
| 6 | 任务管理（Task Management） | "Use the TodoWrite tools... VERY frequently" | 规定怎么规划和跟踪多步任务 |
| 7 | 工具策略（Tool usage policy） | "prefer to use the Task tool... batch your tool calls" | 规定工具怎么选、怎么并行 |
| 8 | 环境信息（env / model） | 工作目录、OS、日期、模型 ID | 动态注入的运行时上下文 |

这个顺序不是随意的，它遵循一条主线：先定身份，再画红线，再管风格和行为，最后给运行时信息。 越靠前越稳定、越高优先级；越靠后越动态、越易变。

### 2.2 映射到 Globex

Globex 是个购物 Agent，不是 coding Agent，但这套分层几乎可以一比一搬过来，只是每层的内容换成电商购物场景：

| 层 | Claude Code | Globex 对应 |
| --- | --- | --- |
| 1 角色 | 交互式 CLI 编程工具 | 跨境电商购物 Agent |
| 2 安全边界 | 只做防御性安全任务 | 不诱导消费 / 不编造不存在的商品和价格 / 不泄露其他用户偏好 |
| 3 语气 | 简洁少废话 | 结论先行 + 每件商品附购买理由，不堆砌营销话术 |
| 4 主动性 | 用户让做才做 | 信息不全时先问，别擅自替用户下单式推荐 |
| 5 约定 | 贴合代码库风格 | 贴合用户已沉淀的长期偏好（不要塑料 / 偏好小众） |
| 6 任务管理 | TodoWrite 规划 | Think→Act→Observe→Reflect 循环 + Planner 拆解 |
| 7 工具策略 | Task 工具 / 并行 | 9 个工具 + dispatch_tool fork 的选择规则（19-2 详解） |
| 8 环境信息 | cwd / OS / date | 平台可用性 / 当前汇率 / 用户等级 |

关键洞察：一个成熟 Agent 的 system prompt，绝大部分篇幅不是在教模型"怎么答得好"，而是在定义"边界、风格、工具规则"。 这正是"契约"的体现。

## 3、分级强调：让模型知道什么最重要

### 3.1 强调标记的语义梯度

翻开 Claude Code 的 system prompt，会看到大量大写强调词。它们不是随手写的，而是有明确的强度梯度：

| 标记 | 强度 | 语义 | Globex 使用场景 |
| --- | --- | --- | --- |
| （无标记） | 常规 | 一般性指引 | "优先展示评分高的商品" |
| IMPORTANT | 高 | 重要，容易被忽略所以强调 | "IMPORTANT: 价格必须来自工具返回，不能推测" |
| You MUST | 高 | 强制要求，必须遵守 | "You MUST 在给最终清单前调用 ShoppingSummary" |
| NEVER / DO NOT | 最高（禁止） | 绝对禁止 | "NEVER 编造工具没返回的商品" |
| CRITICAL / VERY IMPORTANT | 最高（关键） | 出错代价极大 | "CRITICAL: 跨平台比价必须加上运费再比" |

### 3.2 强调泛滥 = 全部失效

这是提示词工程里最常见、也最隐蔽的反模式：

```text
反模式：一段 prompt 里有 20 个 IMPORTANT
后果：模型无法区分优先级，等于一个 IMPORTANT 都没有
就像一份文档全是红色加粗——红色就失去了意义
```

Claude Code 的做法值得学：整段 system prompt 里，最高级别的 CRITICAL 只留给极少数真正致命的规则（比如"绝不提交密钥"），其余用 IMPORTANT / You MUST，大部分规则根本不加标记。

Globex 的强调预算建议：

| 级别 | 数量上限 | 例子 |
| --- | --- | --- |
| CRITICAL | ≤ 2 条 | 比价必须含运费；不泄露他人偏好 |
| IMPORTANT / MUST | ≤ 6 条 | 价格来自工具；给清单前必过 ShoppingSummary |
| 无标记 | 不限 | 其余所有一般性指引 |

原则：强调是稀缺资源。当你想加第 3 个 CRITICAL 时，先问自己——它真的和前两个一样致命吗？

### 3.3 强调要跟"为什么"，不要空喊

对比两种写法：

```text
弱：IMPORTANT: 一定要比价。
强：IMPORTANT: 跨平台比价必须把运费和关税算进去再比——
因为速卖通标价常比亚马逊低，但加上跨境运费后反而更贵，
只比标价会给出错误结论。
```

后者给了"为什么"，模型在边界情况下更知道该怎么权衡。这和第 5 章讲的"约束要可判定"是一致的。

## 4、在 system prompt 里内嵌 few-shot 示例

### 4.1 Claude Code 用示例锁定"输出详略"

Claude Code 为了让模型输出足够简洁，在 system prompt 里直接塞了一组极短的问答示例：

```text
<example>
user: 2 + 2
assistant: 4
</example>

<example>
user: is 11 a prime number?
assistant: Yes
</example>
```

这组示例的作用不是教模型算数，而是用具体样例锁定"这种问题就该这么短地答"——比任何"请简洁"的抽象指令都有效。

### 4.2 Globex 该用示例锁定什么

Globex 里最值得用示例锁定的是两类行为：输出格式和边界行为。

输出格式示例（锁定"每件商品怎么呈现"）：

```text
<example>
user: 帮我看看有没有便宜点的机械键盘
assistant: 给你挑了 3 把（含运费，可直邮）：
1. XX 机械键盘 ¥219（Amazon）——热插拔轴，预算内最耐用
2. ...
</example>
```

边界行为示例（锁定"信息不全时先问，不要瞎搜"）：

```text
<example>
user: 帮我买个好点的礼物
assistant: 想先确认几点好帮你精准挑：送谁？预算多少？有没有偏好的品类？
</example>
```

### 4.3 示例的成本与取舍

示例很有效，但它占 token，而且进 system prompt 就会被每轮复用。所以：

| 原则 | 说明 |
| --- | --- |
| 少而精 | 2-4 个示例覆盖最高频的格式/边界即可，别堆 |
| 只放"最容易做错的" | 模型天然会做对的行为不用示例 |
| 放在稳定区 | 示例属于"全天不变"的内容，进缓存前缀（见 19-3） |

## 5、XML 标签与结构化分区

### 5.1 为什么长 prompt 要用标签分区

当 system prompt 长到几百上千 token，纯自然语言段落会让模型"分不清哪句是指令、哪句是示例、哪句是数据"。用 XML 风格标签把不同性质的内容框起来，能显著提升可解析性：

```text
<role>你是 Globex 跨境电商购物 Agent...</role>

<constraints>
- CRITICAL: 比价必须含运费关税
- NEVER: 编造工具未返回的商品
</constraints>

<tool_policy>
...（工具选择规则，19-2 详解）
</tool_policy>

<examples>
<example>...</example>
</examples>

<user_preferences>
{long_term_preferences}
</user_preferences>
```

### 5.2 标签的三个好处

| 好处 | 说明 |
| --- | --- |
| 边界清晰 | 模型明确知道 <constraints> 里是硬约束、<examples> 里是样例 |
| 便于注入 | <user_preferences> 这种动态块有明确的注入位（呼应第 10 章 {long_term_preferences}） |
| 便于维护 | 改某一层时不会误伤其它层，也便于做 diff 和版本管理 |

这一点在 Anthropic 官方的提示工程建议里也被反复强调：XML 标签帮助模型无歧义地解析混合了指令、上下文、示例和变量输入的复杂 prompt。

### 5.3 标签不是越多越好

标签是为了分区，不是为了嵌套炫技。三到六个顶层标签足够 Globex 用了。深层嵌套（标签套标签套标签）反而会增加噪声。

## 6、Globex system prompt 的目标分层骨架

把前面几节的方法论合起来，就是对第 10 章 prompts.yml 里那段 system prompt 的一次结构化重构。下面这份骨架标注了每一层的职责和易变性——易变性这一列直接决定了 19-3 里它进不进缓存。

```text
# app/prompt/prompts.yml（结构化重构版骨架）
system_prompt: |
<role>
你是 Globex，一个跨境电商购物 Agent，帮用户跨亚马逊 / Shopee / 速卖通 / eBay
检索、比价、算关税运费，并给出带购买理由的清单。
</role>

<constraints>
- CRITICAL: 跨平台比价必须把运费和关税算进去再比，只比标价会得出错误结论。
- CRITICAL: 不得泄露或引用其他用户的偏好数据。
- IMPORTANT: 所有价格、库存、商品必须来自工具返回，NEVER 推测或编造。
- IMPORTANT: 给最终清单前，必须调用 ShoppingSummary 收尾。
- 信息不全（缺预算 / 品类 / 收礼人）时先追问，不要擅自开搜。
</constraints>

<loop>
每一轮走 Think → Act → Observe → Reflect：
- Think：拆解意图，判断缺什么信息。
- Act：调工具，或 dispatch_tool 派子 Agent。
- Observe：读工具返回，关注结构化字段。
- Reflect：信息够了给 ShoppingSummary，不够回到 Think。
</loop>

<tool_policy>
# 何时单干 / 何时 Planner / 何时 fork —— 详见 19-2
...
</tool_policy>

<examples>
<example>...</example>   # 输出格式 + 边界行为示例
</examples>

<user_preferences>
{long_term_preferences}   # 动态注入位，放最末尾（见 19-3）
</user_preferences>
```

每层的易变性标注：

| 层 | 易变性 | 是否进缓存前缀 |
| --- | --- | --- |
| role / constraints / loop | 全天不变 | 是（cache_control 打这里） |
| tool_policy / examples | 全天不变 | 是 |
| user_preferences | 每个用户不同、会更新 | 否，放最末尾（见 19-3） |

这份骨架和第 10 章的区别： 第 10 章解决"怎么把 prompt 从代码里拆到 YAML"（工程问题），本章解决"YAML 里这段 prompt 内部怎么分层、怎么强调、怎么给示例"（内容问题）。两者互补。

## 7、反模式清单

写 Globex 的 system prompt 时，下面这些坑最常见：

| 反模式 | 后果 | 正确做法 |
| --- | --- | --- |
| 强调泛滥（满屏 IMPORTANT） | 模型分不清优先级，强调失效 | 分级预算：CRITICAL ≤ 2，IMPORTANT ≤ 6 |
| 约束不可判定（"适当""合理"） | 模型每次理解都不同，行为漂移 | 写成可判定规则 + 给"为什么" |
| 一大段揉在一起 | 模型解析困难，维护也困难 | XML 标签分层 |
| 只讲抽象要求不给示例 | 输出格式/边界行为不稳定 | 高频格式/边界用 few-shot 锁定 |
| 动态内容混进稳定区 | 破坏缓存前缀（19-3） | 动态块（偏好/时间）放最末尾或走注入 |
| 把工具的"怎么用"写进 role | role 臃肿，工具规则找不到 | 工具规则独立成 <tool_policy>（19-2） |

本章小结：

到这里，你应该建立起 Globex 系统提示词的"架构观"：

- Agent 的 system prompt 不是"问法"，而是被复用几十次的系统级契约——稳定、精确、分层是三个基本要求。
- 一个工业级 Agent 的 system prompt 按"角色 → 安全边界 → 语气 → 主动性 → 约定 → 任务管理 → 工具策略 → 环境信息"分层，越靠前越稳定、越高优先级。
- 分级强调（CRITICAL / IMPORTANT / MUST / NEVER）有明确的强度梯度，强调是稀缺资源——泛滥就等于失效，最高级别要留给极少数致命规则，并跟上"为什么"。
- 在 system prompt 里内嵌 few-shot 示例，是锁定输出格式和边界行为最有效的手段，但要少而精、只放最容易做错的。
- XML 标签分区让长 prompt 边界清晰、便于注入和维护，三到六个顶层标签足够。
- Globex 的 system prompt 骨架在第 10 章基础上按"职责 + 易变性"重构，易变性直接决定了后面缓存怎么打。

下一章「[19-2 工具与子 Agent 提示词与决策路由]」会钻进最关键的 <tool_policy> 段——把"什么时候主 Agent 单干、什么时候用 Planner 规划、什么时候 fork 子 AgentLoop"这套决策路由，真正写成模型能执行的提示词。
