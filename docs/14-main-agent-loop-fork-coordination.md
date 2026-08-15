# 14 主AgentLoop组装与同质子AgentLoop-fork协同机制

来源：https://alidocs.dingtalk.com/i/nodes/9E05BDRVQ2aGym04UDax3nmvJ63zgkYA

作者：会敲代码的泡

创建时间：06-15 15:10

整理说明：本文基于当前钉钉文档页面整理为工程笔记，保留关键结构、模块职责和实现约束，不做逐字转录。

## AI 概览

本章把前面章节完成的模型配置、提示词、上下文、监控、业务工具、长期记忆和缓存压缩组装成可运行的主 AgentLoop。核心目标是让主 loop 能从用户购物意图一路推进到最终购物清单，同时给同质子 AgentLoop 的 fork 能力加上边界，避免递归、超时、长结果和重复工具调用拖垮主流程。

## 1、本章导读

### 1.1 已具备的零件

| 模块 | 来源章节 |
| --- | --- |
| LLM、提示词、上下文、监控 | 第 10 章 |
| ItemSearch 与三塔召回 | 第 11 章 |
| PriceCompare 与 ShippingCalc | 第 12 章 |
| CategoryInsight 与 RAG 知识库 | 第 13 章 |
| Planner、ChatFallback、WebSearch | 第 10 章已声明，本章补实现与注册 |
| ItemPicker、ShoppingSummary | 本章实现并接入 |
| dispatch_tool 元工具 | 第 11 章有基础版，本章升级为防失控版 |
| Cache Breakpoint 上下文压缩 | 第 5 章给出原理，本章接到主 loop |
| 长期记忆 Store | 第 6 章给出 schema，本章接到主 loop |

### 1.2 本章范围

本章主要做两件事：

1. 将所有工具注册到统一的 `main_agent`，让用户 query 能完整走到 `ShoppingSummary`。
1. 为 fork 机制补上运行护栏，避免子 Agent 递归 fork、工具调用不收敛、工具结果过大或单轮任务阻塞。

本章不展开 FastAPI、WebSocket、前端联调，也不处理模型训练或大规模评测跑批；这些放到后续章节或运营手册。

## 2、收尾工具

### 2.1 ItemPicker

`ItemPicker` 位于 `ShippingCalc` 之后，用于在到手价候选上做二次精选。它综合三类输入：

- `landed`：来自 `ShippingCalc` 的到手价候选，通常已按价格或成本排序。
- `insight`：来自 `CategoryInsight` 的品类知识，例如价格档、常见风险、选购建议。
- `user_preferences`：长期记忆或本轮会话识别到的偏好。

输出是最多 3 个 `PickedItem`，并携带被淘汰候选的简短原因。实现上应区分硬约束和软偏好：硬约束命中后直接排除，软偏好只影响排序分数。被排除原因和入选理由都要限制条数，避免把大量候选细节继续灌进主 loop 上下文。

典型排序逻辑：

- 价格是否落在合理档位。
- 配送时效是否满足预期。
- 是否触达用户偏好或避开用户黑名单。
- 商品评分、平台可信度、品类风险等信号是否支持推荐。

### 2.2 ShoppingSummary

`ShoppingSummary` 是终结性工具。主 loop 一旦调用它，就应进入收敛态，后续不再继续检索或派生新的 Act。

该工具接收：

- `picks`：来自 `ItemPicker` 的精选商品。
- `user_query`：用户原始购物意图。
- `new_preferences`：本轮可沉淀到长期记忆的新偏好。

它通过专门的总结提示词调用 LLM，生成面向前端展示的 Markdown 购物清单，并返回最终文本、精选商品和需要写入 Store 的偏好。主 loop 的 Reflect 阶段应识别该终结性结果并停止循环。

## 3、注册工具集：FULL_TOOL_SET

主 AgentLoop 和 fork 出来的同质子 AgentLoop 必须使用同一份工具集合。推荐把工具注册集中放在 `app/agent/tool_registry.py`：

- `planner`
- `chat_fallback`
- `web_search`
- `category_insight`
- `item_search`
- `item_picker`
- `price_compare`
- `shipping_calc`
- `shopping_summary`
- `dispatch_tool`

`dispatch_tool` 作为元工具也要进入 `FULL_TOOL_SET`，这样子 Agent 具备和主 Agent 一致的能力边界。为避免循环依赖，`dispatch_tool` 可以在普通工具之后再导入。终结性工具可单独维护为 `TERMINAL_TOOLS`，典型值是 `shopping_summary` 和 `chat_fallback`。

## 4、防 fork 失控的四件套

同质 fork 的风险来自能力对称：子 Agent 也能再次调用 `dispatch_tool`。如果不加限制，系统可能出现递归 fork、重复调用同一工具、工具结果过大或长任务阻塞。

### 4.1 fork 深度上限

用 `ContextVar` 记录当前 fork 深度，并通过上下文管理器包住子 Agent 的执行。超过上限时抛出专用异常，再由 `dispatch_tool` 转成可读的工具结果返回给主 loop。课程示例中深度上限为 2。

### 4.2 子任务超时与迭代上限

`dispatch_tool` 创建子 Agent 后，应同时设置：

- 子 Agent 最大迭代次数，例如 12。
- 子任务总超时时间，例如 90 秒。

深度超限、超时和内部异常都不应直接击穿主 loop。更稳的做法是把失败转成普通字符串结果，让主 loop 根据结果继续改写策略、缩窄参数或收尾。

### 4.3 单工具结果截断

工具返回过长会污染后续上下文，也会破坏缓存边界。中间件层应统一截断大结果，例如按近似 token 数换算字符上限，保留前部有效信息，并在尾部加上截断提示，让模型知道需要缩小查询范围。

### 4.4 循环检测

维护最近若干次工具调用窗口，统计同一工具的重复次数。示例策略是窗口大小 6、重复阈值 4。触发后向主 loop 注入提醒，让模型换参数、换工具、询问用户，或在已有信息足够时调用终结性工具。

## 5、主 AgentLoop 组装

### 5.1 主入口

主入口 `run_agent(query, thread_id, user_id)` 需要串起以下步骤：

1. 为本次任务创建或确认 session 目录。
1. 写入 `thread_id` 与 `session_dir` 的上下文。
1. 根据 `user_id` 从长期记忆 Store 读取相关偏好。
1. 将偏好注入 system prompt。
1. 使用 `FULL_TOOL_SET` 构造主 Agent。
1. 以统一的 recursion limit 和总超时运行主 Agent。
1. 从终结性结果中提取可沉淀偏好，并写回长期记忆。

推荐参数边界：

| 参数 | 示例值 | 作用 |
| --- | --- | --- |
| `MAIN_AGENT_MAX_ITERATIONS` | 30 | 限制主 loop 轮数 |
| `MAIN_AGENT_TIMEOUT_SEC` | 300 | 限制主任务总耗时 |
| `SUB_AGENT_MAX_ITERATIONS` | 12 | 限制子 loop 轮数 |
| `SUB_AGENT_TIMEOUT_SEC` | 90 | 限制子任务总耗时 |

### 5.2 接入 Cache Breakpoint

主 loop 每轮 Act 之后触发一次压缩检查：

1. 根据最近消息数量计算缓存边界，保留最新几轮不压缩。
1. 对边界之前的旧消息做摘要压缩。
1. 用压缩结果替换旧消息，保留边界之后的原始上下文。

这样可以让长对话保持可控 token 规模，同时尽量维持 Prompt Cache 命中。实现上可通过 LangGraph 的 hook 机制接入，例如放在模型调用或 step 之后的中间件中。

### 5.3 完整链路

主链路可以概括为：

```text
用户 query
  -> 注入长期偏好的 system prompt
  -> main_agent + FULL_TOOL_SET
  -> 必要时 dispatch_tool fork 子 AgentLoop
  -> 搜索、比价、运费、品类知识、精选
  -> ShoppingSummary 收尾
  -> learned_preferences 写回 Store
```

## 6、提示词补充规则

system prompt 需要明确两个方向的规则。

收尾规则：

- 当已经拿到不少于 1 个精选商品时，优先调用 `shopping_summary`。
- 收尾后不要继续调用检索类工具。
- 本轮识别出的稳定偏好要传给 `new_preferences`，供长期记忆写回。

fork 防失控规则：

- 子任务尽量限制在一层 fork 内完成。
- 如果 `dispatch_tool` 返回拒绝、超时或失败信息，主 loop 应调整策略。
- 同一工具重复调用多次仍无进展时，应检查参数、换工具，必要时通过 `chat_fallback` 和用户对齐。

这些规则也可以进入 Rubric，作为评测时判断 Agent 是否收敛、是否滥用工具、是否正确处理失败的扣分点。

## 7、本章工程小结

| 模块 | 职责 |
| --- | --- |
| `tool_registry.py` | 提供主 / 子共享的 `FULL_TOOL_SET` |
| `fork_guard.py` | 管理 fork 深度与深度超限异常 |
| `dispatch_tool` | 创建同质子 AgentLoop，并处理 depth、timeout、异常返回 |
| `truncate_long_tool_result` | 限制单个工具结果体积 |
| `LoopDetector` | 发现重复工具调用并提示模型收敛 |
| `post_step_compress` | 每轮 Act 后触发 Cache Breakpoint 压缩 |
| `run_agent` | 串起 Store 注入、主 loop 执行、终结结果和偏好写回 |

完成本章后，Globex 主 AgentLoop 具备完整运行链路：统一工具集、精选与总结收尾、同质 fork 护栏、上下文压缩，以及长期记忆的入口注入和出口沉淀。

## 8、实现验收清单

- 主 Agent 和子 Agent 引用同一份 `FULL_TOOL_SET`。
- `dispatch_tool` 超过 fork 深度时返回可处理的工具结果，而不是让主 loop 崩溃。
- 子任务具备最大轮数和总超时限制。
- 长工具结果会被统一截断，并带有明确提示。
- 重复工具调用能被检测并反馈给模型。
- `shopping_summary` 被识别为终结性工具。
- 长期偏好能在入口注入 prompt，并在出口写回 Store。
- Cache Breakpoint 在长对话中能压缩旧消息，保留最近上下文。
