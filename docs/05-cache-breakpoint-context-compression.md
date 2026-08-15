# 05 Cache-Breakpoint上下文压缩与缓存治理

来源：https://alidocs.dingtalk.com/i/nodes/pYLaezmVNe26kznBHPORX03GWrMqPxX6

作者：会敲代码的泡
创建时间：06-15 13:34
对应代码分支：`05-cache-breakpoint`（示例脚本位于 `examples/05_compress_demo.py`）

## 本章课程目标

- 理解为什么多轮对话会导致 token 成本失控：每轮循环追加消息，上下文只增不减。

- 掌握"压缩和缓存是同一个问题的两面"这个核心洞察，以及盲目压缩为什么会适得其反。

- 学会 Cache Breakpoint 的设计：把对话切成"缓存区"和"可压缩区"，在不破坏缓存命中率的前提下压缩。

- 建立 Globex 的上下文治理视角：不是把 prompt 变短，而是把会话状态、工作记忆、冷数据和检查点分层管理。

学习建议： 本章是 Globex 项目里"最不起眼但最关键"的工程层能力。如果你之前做过长对话 Agent 并被 token 成本困扰过，这章会直接解决你的痛点。如果没遇到过这个问题，先记住结论：脱离缓存谈压缩，省下的都是假的。

## 1、本章导读

上几章搭好了 AgentLoop 的决策层（主循环 + 多 Agent fork）和召回层（三塔向量召回）。但有一个很实际的问题还没解决：

10+ 轮工具调用之后，上下文里的消息历史可能膨胀到 2 万 token。每次请求模型，这 2 万 token 都要全量发过去。

这意味着：

- 成本：按 3 元 / 百万 token 计算，一次请求就是 0.24 元。一天几百次调用，成本飞速膨胀。

- 延迟：更长的 prompt 意味着更长的首 token 延迟（TTFT）。

- 质量：关键信息被淹没在中间，模型检索性能下降（Lost in the Middle 效应）。

## 2、问题有多痛

### 2.1 Globex 项目的实测数据

根据 Globex 项目在构建购物 Agent 时的实测：

| 场景 | token 膨胀情况 | 成本影响 |
| --- | --- | --- |
| 一次 item_search 返回 100 件商品 | 可能吃掉 3 万 token | 相当于 10 次普通请求 |
| 一次 parallel_task_tool 跨 4 平台 | 四份结果累计上万行 | 后续每轮都带着这些结果 |
| 10 轮循环后 | 上下文逼近窗口上限 | 触发 InputContentTooLong |

主 loop 调用 item_search 返回 100 件商品的结构化数据，再调 price_compare 返回跨平台价格——几轮下来，上下文就从几千 token 膨胀到几万。

### 2.2 最直觉的解法：压缩

第一反应通常是：把历史消息做摘要，减少 token 数。

```text
压缩前：80K token（完整历史）
压缩后：20K token（摘要版）
压缩率：75%
```

听起来省了很多钱。但实测后发现了灾难性问题。

## 3、盲目压缩的代价：缓存命中率暴跌

### 3.1 Prompt Cache 是什么

主流 LLM 供应商支持 Prompt Cache 功能——将 system prompt 和对话历史的前缀缓存起来，下次请求如果前缀相同，直接复用 KV Cache：

- 减少 50-80% 的首 token 延迟

- 降低 40-50% 的 prompt token 成本

但它有一个苛刻的约束：缓存只有 5 分钟 TTL，且必须前缀完全匹配。

### 3.2 压缩为什么会杀死缓存

如果你在每次请求前都对历史做"微压缩"（删掉一些消息、改写一些内容），前缀就变了。前缀一变，缓存就失效。

实测结果：

| 方案 | 压缩率 | 缓存命中率 | 综合成本 |
| --- | --- | --- | --- |
| 不压缩 | 0% | 85% | 基准（高但稳定） |
| 盲目压缩 | 30% | 15% | 更高（缓存全废） |
| Cache-Aware 压缩 | 25% | 80% | 最低 |

盲目压缩省下的 token 费，全被掉缓存的部分原价输入吃回去了。 整体成本不降反升。

### 3.3 核心洞察

压缩和缓存是同一个问题的两面。 任何压缩方案都必须和 Prompt Cache 命中率放在一起评估。脱离缓存谈压缩效果，就像脱离网络谈序列化方案——可能得出完全错误的结论。

## 4、Cache Breakpoint：正确的解法

### 4.1 核心概念

引入一个关键分界线：Cache Breakpoint（缓存断点）。

```text
对话历史：
[system prompt]          ← 固定不变，始终缓存
[user message 1]         ← 固定不变，始终缓存
[assistant response 1]   ← 固定不变，始终缓存
[tool call 1 result]     ← 固定不变，始终缓存
--- Cache Breakpoint ---  ← 从这里开始可以压缩
[user message 2]         ← 可能被压缩
[assistant response 2]   ← 可能被压缩
[tool call 2 result]     ← 可能被压缩
...
```

Breakpoint 之前：绝对不动，保证缓存命中率。

Breakpoint 之后：可以自由压缩，不影响缓存复用。

### 4.2 Breakpoint 怎么定位

策略是：保留最近 K 个工具调用在 Breakpoint 之前（因为它们最可能被下次请求复用），后生成的消息放到 Breakpoint 之后做压缩。

```python
def compute_breakpoint(messages: list, keep_recent: int = 3) -> int:
    """计算 Cache Breakpoint 的位置。

    保留最近 keep_recent 轮工具调用在缓存区，
    更早的历史进入可压缩区。
    """
    tool_call_indices = [
        i for i, msg in enumerate(messages)
        if msg.type == "tool"
    ]

    if len(tool_call_indices) <= keep_recent:
        # 工具调用不多，全部保留在缓存区
        return len(messages)

    # Breakpoint 设在"最近 K 个工具调用"的起始位置
    breakpoint_idx = tool_call_indices[-keep_recent]
    return breakpoint_idx
```

### 4.3 Breakpoint 之后怎么压缩

对 Breakpoint 之后的历史消息，可以用以下策略：

| 策略 | 做法 | 适用场景 |
| --- | --- | --- |
| 截断 | 直接丢弃最早的 N 条消息 | 早期消息已不影响当前任务 |
| 摘要 | 用 LLM 把 N 条消息压缩成一段摘要 | 需要保留关键决策信息 |
| 工具结果精简 | 把大段的 tool_result 只保留关键字段 | 工具返回了过多细节 |

```python
def compress_after_breakpoint(messages: list, breakpoint_idx: int) -> list:
    """压缩 Breakpoint 之后的消息。"""
    cached_part = messages[:breakpoint_idx]       # 不动
    compressible_part = messages[breakpoint_idx:]  # 可压缩

    # 策略：把 tool_result 中超过 500 token 的内容截断

    compressed = [ ]

    for msg in compressible_part:
        if msg.type == "tool" and len(msg.content) > 2000:
            msg = msg.copy()
            msg.content = msg.content[:2000] + "\n[...内容已精简]"
        compressed.append(msg)

    return cached_part + compressed
```

### 4.4 在 Anthropic API 上落地 cache_control

Cache Breakpoint 在概念上很清晰，落到 Anthropic API 的具体写法是 cache_control 标记。下面是最小可运行示例：

```python
from anthropic import Anthropic

client = Anthropic()

# 静态/动态分层结构（关键：从前到后内容应该越来越易变）
response = client.messages.create(
    model="claude-sonnet-4-5",
    max_tokens=1024,
    system=[
        {
            "type": "text",
            "text": SYSTEM_PROMPT,
        },
        {
            "type": "text",
            "text": TOOLS_SPEC,
            # cache_control #1：工具定义打缓存（小时级 TTL）
            "cache_control": {"type": "ephemeral", "ttl": "1h"},
        },
    ],
    messages=[
        # Cache Breakpoint 之前：早期对话历史
        {
            "role": "user",
            "content": [
                {"type": "text", "text": old_history,
                 # cache_control #2：早期历史打缓存（默认 5 分钟 TTL）
                 "cache_control": {"type": "ephemeral"}},
            ],
        },
        # Cache Breakpoint 之后：可压缩区，不打 cache_control
        *compressed_recent_messages,
        # 当前用户消息：永远变化的部分
        {"role": "user", "content": current_user_msg},
    ],
)

# 响应里能看到缓存命中情况
print(response.usage.cache_creation_input_tokens)   # 写入缓存的 token 数
print(response.usage.cache_read_input_tokens)       # 命中缓存的 token 数
```

落到 API 上有几条硬约束必须知道：

| 约束 | 数值 | 踩坑后果 |
| --- | --- | --- |
| 一次请求最多 cache_control 标记 | 4 个 | 第 5 个会被忽略，缓存无法写入 |
| 默认 TTL | 5 分钟 | 凌晨低峰期就过期，每天早高峰首请求全部 miss |
| Extended TTL | 1 小时（{"type": "ephemeral", "ttl": "1h"}） | 适合 SYSTEM_PROMPT / TOOLS_SPEC 这类一天不变的内容 |
| 最低写入 token 阈值 | Sonnet 1024、Haiku 2048 | 比阈值短的内容根本不会被写入缓存 |
| 必须前缀完全匹配 | 任何字符变化（包括空格、换行）都会让命中失效 | 不能动态拼时间戳到 SYSTEM_PROMPT 里 |

按“内容易变性”做静态/动态分层是核心心法：

```text
[ system prompt + 工具 schema + 知识库摘要 ]   ← cache_control #1（1h TTL，全天不变）
[ 早期对话历史                          ]    ← cache_control #2（5 分钟 TTL，每轮往后挪）
↑ 此线之上是 Cache Breakpoint
[ 最近 K 轮工具调用                       ]   ← 可压缩区，不打 cache_control
[ 当前用户消息                          ]    ← 不缓存，永远变化
```

§4.1 的概念图和这张实现图是同一件事：「Cache Breakpoint」在工程上就是一个或多个 cache_control 标记的位置。§4.2 的 compute_breakpoint 函数返回的 breakpoint_idx，就是给 messages 数组里某条消息打 cache_control 的位置索引。

## 5、从压缩到上下文治理

前面几节解决的是一个局部问题：怎么在不破坏 Prompt Cache 的前提下减少 token。

但 Globex 真正遇到的上下文膨胀，不只是 token 变多。更准确地说，它是一个状态管理问题：用户目标、历史约束、工具结果、失败尝试、子 Agent 回传、缓存前缀、当前请求，全部混在同一段 prompt 里。模型每轮都要从一大坨历史里重新找重点，成本会上升，注意力会稀释，约束也容易漏。

所以 Globex 的上下文治理不是简单做摘要，而是把会话系统拆成三件事：

```text
状态机：记录当前任务走到哪一步
记忆系统：保存仍然有用的偏好、约束和关键决策
检查点系统：保留可恢复、可审计的完整执行轨迹
```

### 5.1 四层上下文分层

Globex 在每轮 AgentLoop 之前，不会把所有历史都塞回模型，而是按价值和时效分成四层：

| 层级 | 名称 | 放什么 | 进 prompt 吗 | 设计原则 |
| --- | --- | --- | --- | --- |
| 第 1 层 | 热上下文 | 当前用户请求、最近一次工具结果、正在处理的约束 | 必进 | 当前决策必须依赖，不能压缩丢失 |
| 第 2 层 | 结构化任务状态 | 总目标、预算、平台、材质偏好、当前计划、已失败工具 | 必进，但用结构化字段 | 避免模型从自然语言历史里重新猜状态 |
| 第 3 层 | 可更新工作记忆 | 本轮会话内沉淀的用户偏好、已确认结论、不能碰的边界 | 按需进 | 增量更新，不每轮从头总结 |
| 第 4 层 | 冷数据 | 完整 trace、原始工具输出、历史对话、子 Agent 全量返回 | 默认不进 | 用于审计、回放、失败恢复 |

举个例子，用户说："旅行三件套，预算 300，不要塑料，亚马逊和速卖通都看看。"

这句话不会只作为一条历史消息躺在上下文里，而会被拆成：

```yaml
hot_context:
  current_request: "继续比较亚马逊和速卖通候选商品"
  latest_observation: "亚马逊返回 20 件，速卖通返回 18 件"

task_state:
  goal: "推荐旅行三件套"
  budget: "300 元以内"
  platforms: ["Amazon", "AliExpress"]
  constraints: ["不要塑料", "偏小众"]
  current_step: "price_compare"

  failed_tools: [ ]

working_memory:
  user_preferences: ["avoid_plastic", "prefer_niche_style"]
  confirmed_decisions: ["只比较可直邮商品"]

cold_data:
  raw_item_search_results: "output/session_xxx/item_search.json"
  trace: "output/session_xxx/trace.json"
```

这样做的关键好处是：每一轮不是追加历史，而是重建一份最小可用上下文。

### 5.2 为什么不只用一种方案

上下文治理有几种常见做法，但单独使用都有明显短板：

| 方案 | 优点 | 问题 |
| --- | --- | --- |
| 滑动窗口截断 | 实现最简单，成本最低 | 容易丢掉早期约束，例如用户第一轮说过"不要塑料" |
| 全量摘要 | token 降得明显 | 摘要会漂移，写偏后后续每轮都在错误记忆上推理 |
| 检索增强 | 适合召回静态知识 | 不适合管理动态任务状态，因为当前计划和失败尝试每轮都在变 |
| 完全结构化状态 | 鲁棒性高，恢复方便 | 工程复杂度高，状态迁移和字段维护成本大 |

所以 Globex 采用折中方案：

```text
高价值、高稳定信息：结构化
中价值、可压缩信息：摘要化
低价值但需追溯信息：归档到文件或 trace
每轮推理前：由 Context Manager 重新组装 prompt
```

### 5.3 Context Manager 每轮怎么组装上下文

在 Globex 里，Context Manager 是上下文治理的入口。主 AgentLoop 或子 AgentLoop 每次请求模型前，都会先走一次组装流程：

```text
1. 读取 thread_id / session_dir
2. 加载当前热上下文：current_request、latest_observation、active_constraints
3. 注入结构化任务状态：goal、budget、platforms、current_step、failed_tools
4. 召回必要工作记忆：本轮已确认偏好、关键决策、不能碰的边界
5. 保留 Cache Breakpoint 之前的稳定前缀
6. 对 Breakpoint 之后的工具结果做压缩或截断
7. 输出最终 prompt 给模型
```

伪代码可以理解成这样：

```python
def build_context(thread_id: str, session_dir: Path, current_request: str) -> list:
    hot_context = load_hot_context(thread_id)
    task_state = load_task_state(thread_id)
    working_memory = retrieve_working_memory(thread_id, current_request)
    raw_messages = load_recent_messages(thread_id)

    breakpoint_idx = compute_breakpoint(raw_messages, keep_recent=3)
    messages = compress_after_breakpoint(raw_messages, breakpoint_idx)

    return [
        render_system_prompt(),
        render_task_state(task_state),
        render_working_memory(working_memory),
        *messages,
        {"role": "user", "content": current_request},
    ]
```

注意，这里的工作记忆只服务当前会话内的任务连续性。跨会话、长期保存的用户偏好，会在下一章长期记忆 Store 里单独讲。

## 6、工具侧防线：从源头控住体积

### 6.1 L0 层：不该进来的别进来

在压缩之前，还有一层更基础的防线：让工具返回的内容在进入上下文之前就控住体积。

```text
item_search:
├─ 默认最多返回 20 件商品（不是 100 件）
├─ 每件商品只保留：名称、价格、平台、评分
├─ 去掉：完整描述、评论原文、图片 URL
└─ 超出 3000 token 自动截断

price_compare:
├─ 只返回 top-5 最便宜的结果
└─ 不返回完整的各平台原始 API 响应
```

### 6.2 为什么这一层最重要

一个被控住体积的 item_search 返回（3000 token），比让它返回全量数据（15000 token）再事后压缩，省了一次 LLM 压缩调用的成本。

投入产出比最高的一层防线。

## 7、五层压缩体系全景

第 5 节讲的是"信息分层模型"：哪些信息应该进 prompt，哪些信息应该变成状态，哪些信息应该归档。

本节讲的是"压缩执行层"：当 Context Manager 已经决定某类信息要进入上下文时，具体用哪一层手段控制体积。

| 层 | 名称 | 做什么 | 成本 | 对应信息层 |
| --- | --- | --- | --- | --- |
| L0 | 工具侧防线 | 控制工具返回体积，大内容写文件而非注入上下文 | 零 | 冷数据 / 热上下文入口 |
| L1 | 工程手段 | 动态 max_tokens、断点续传、服务端缓存 | 零 | 热上下文 |
| L2 | Cache-Aware 微压缩 | 在 Breakpoint 之后做轻度压缩 | 低 | 热上下文 / 近期消息 |
| L3 | 会话压缩 | 当上下文逼近阈值时，用 LLM 做阶段性摘要 | 中（一次 LLM 调用） | 可更新工作记忆 |
| L4 | Session Memory | 维护结构化任务状态和会话内记忆，替代全量历史 | 低（增量更新） | 结构化任务状态 / 工作记忆 |

越往上越"重"（需要 LLM 或状态维护），但越能保住关键语义。越往下越"轻"（纯工程），但只能控制体积，不能理解任务状态。

本章讲的 Cache Breakpoint 属于 L2 层，它解决的是缓存边界问题。L4 里的跨会话用户偏好，会在下一章「长期记忆与用户偏好 Store」里进一步展开；本章只讨论会话内状态和当前任务上下文。

## 8、关键数据：为什么 Cache Breakpoint 有效

| 指标 | 不压缩 | 盲目压缩 | Cache Breakpoint |
| --- | --- | --- | --- |
| token 数 | 80K | 56K | 60K |
| 压缩率 | 0% | 30% | 25% |
| 缓存命中率 | 85% | 15% | 80% |
| 实际计费 token | 12K | 47.6K | 12K |
| 综合成本 | 基准 | +297% | -35% |

关键理解：实际计费 token = 总 token × (1 - 缓存命中率 × 折扣)。缓存命中的部分按半价或免费计费，所以命中率才是决定成本的关键变量。

### 8.1 Benchmark 不能只看 token 降了多少

如果一个方案只是把 prompt 变短，但恢复后经常忘记用户约束、改错平台、漏掉失败工具，那它不叫上下文治理，只是把问题藏起来了。

Globex 评估上下文治理方案时，会同时看四类指标：

| 指标 | 看什么 | 失败信号 |
| --- | --- | --- |
| 任务成功率 | 最终是否完成跨平台检索、比价和推荐 | token 降了，但回答经常缺商品、缺价格、缺理由 |
| 约束遗漏率 | 用户约束是否被保留，例如预算、平台、材质偏好 | 用户第一轮说"不要塑料"，后面又推荐塑料商品 |
| 中断恢复成功率 | 服务重启或子 Agent 超时后，能否从 Checkpoint 继续 | 任务从头跑、重复调用工具、丢失当前计划 |
| 单位任务成本与延迟 | 每次完整任务的 token 成本、TTFT、端到端耗时 | token 省了，但首 token 更慢，或摘要调用把延迟吃回去 |

对应到 Globex 的实测口径：

```text
缓存命中率：15% → 80%+
综合 token 成本：降低 35%
任务完成率：71% → 89%（配合 LoopDetector / 工具超时 / 截断策略）
约束遗漏率：重点看预算、平台、材质偏好三个字段
恢复成功率：通过 thread_id + checkpoint_id 验证长任务能否断点续跑
```

也就是说，Cache Breakpoint 只解决"成本和缓存"，Context Manager 解决"当前任务不丢状态"，Checkpoint 解决"中断后能恢复"。三者合起来，才是完整的上下文治理。

## 本章小结

到这里，你应该理解 Globex 上下文治理的核心设计：

1. 多轮对话的上下文只增不减，10 轮后 token 成本会失控。这不是优化问题，是基础设施问题。

2. 盲目压缩会破坏 Prompt Cache 前缀匹配，导致缓存命中率暴跌。省下的压缩费全被原价计费吃回去。

3. Cache Breakpoint 把对话切成"缓存区"和"可压缩区"——断点之前一字不动保缓存，断点之后自由压缩。

4. 上下文治理不只是压缩历史，而是把会话拆成热上下文、结构化任务状态、可更新工作记忆和冷数据四层。

5. Context Manager 每轮根据 thread_id / session_dir 重建最小可用上下文，避免把所有历史无脑塞回 prompt。

6. 工具侧防线（L0）是投入产出比最高的层——从源头控住体积，比事后压缩省一个数量级。

7. 五层压缩体系是执行层，从轻到重逐层兜底；四层上下文是信息模型，负责决定哪些信息值得进入 prompt。

8. 评估上下文治理不能只看 token 降幅，还要看任务成功率、约束遗漏率、中断恢复成功率、单位任务成本和延迟。

下一章「06 长期记忆与用户偏好Store」会讲一个更彻底的方案：不靠压缩历史保留信息，而是用一个独立的结构化记忆文件持久化跨会话偏好，让当前会话上下文可以大胆丢弃而不丢失用户长期偏好。
