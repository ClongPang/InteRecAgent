# 06 长期记忆与用户偏好 Store

来源：钉钉文档当前页面 `06 长期记忆与用户偏好Store`

作者：会敲代码的泡

创建时间：06-15 13:35

## AI 概览

本章阐述长期记忆机制如何解决跨会话遗忘问题，通过将用户偏好结构化存储于独立的 Store 中，并在新会话时注入 system prompt，实现上下文压缩与关键信息保留的平衡。

## 本章课程目标

- 区分“长上下文”和“长期记忆”：前者按 token 涨钱，后者按条目持久化。
- 理解 Store 的数据结构：用户偏好、历史选择、黑名单关键词怎么存、怎么读。
- 掌握记忆注入时机：新会话起来时自动注入到 system prompt，让 Agent “记得你”。

学习建议：上一章讲了怎么“丢掉”历史消息（压缩）。本章讲的是：在丢掉历史之前，把值得记住的东西抽出来存好。两者是一对互补关系：有了长期记忆，上下文才能放心压缩，不怕丢失用户偏好。

## 1、本章导读

### 1.1 一个真实的用户体验问题

用户第一次对话：

```text
用户：帮我搜旅行收纳袋，不要塑料的
Agent：好的，已为你过滤掉塑料材质的商品...（返回帆布/硅胶款）
```

用户第二次对话（新会话）：

```text
用户：帮我搜洗漱包
Agent：返回了一堆塑料洗漱包
```

为什么？因为新会话没有上一次的对话历史。Agent 不知道用户“不要塑料”的偏好。

这个问题不能靠“把所有历史消息都保留”来解决：跨会话的消息历史不共享，即使共享了也会让上下文爆炸。

正确的解法是：把“不要塑料”这个偏好存到一个独立的长期记忆里，每次新会话起来时自动注入。

### 1.2 本章先做什么，不做什么

本章完成的是：

1. 理解长期记忆和上下文的本质区别。
2. 看懂 Store 的数据结构和读写接口。
3. 理解记忆注入的时机和方式。

暂时不碰的：

- Store 的持久化后端选型（Redis / Postgres / 文件系统，放项目主线章节）。
- 记忆的自动提取（从对话中自动识别“值得记住的偏好”，涉及 NLU，放高级章节）。

## 2、长上下文 ≠ 长期记忆

### 2.1 两个完全不同的数据结构

| 维度 | 长上下文（消息历史） | 长期记忆（Store） |
| --- | --- | --- |
| 数据格式 | 有序消息列表（human/ai/tool） | 结构化条目（key-value） |
| 生命周期 | 一次会话内有效 | 跨会话持久化 |
| 成本模型 | 按 token 计费（越长越贵） | 按存储计费（条目数固定就不涨） |
| 增长方式 | 每轮循环自动追加 | 只在检测到新偏好时才写入 |
| 对模型影响 | 占用注意力窗口 | 只注入相关条目，不占过多窗口 |

### 2.2 互补关系

```text
长期记忆 Store（存偏好）    长上下文（存对话过程）
         ↓                           ↓
   新会话时注入              本会话内追加
         ↓                           ↓
   “用户不要塑料”           “第 3 轮搜了洗漱包”
         ↓                           ↓
   不随上下文膨胀            会膨胀，需要压缩
```

有了 Store，上下文可以放心压缩：即使丢掉了“用户上次说不要塑料”这条历史消息，偏好已经存在 Store 里了，下次新会话起来时会自动注入。

## 3、Store 的数据结构

### 3.1 偏好条目

每个用户的 Store 里保存的是一组结构化的偏好条目：

```python
from dataclasses import dataclass, field
from datetime import datetime


@dataclass
class PreferenceEntry:
    """用户偏好的一条记录。"""
    key: str                          # 唯一标识，如 "material_blacklist"
    category: str                     # 分类：preference / history / blacklist
    content: str                      # 偏好内容，如 "不要塑料材质"
    source_session: str               # 来源会话 ID
    created_at: datetime = field(default_factory=datetime.now)
    confidence: float = 1.0           # 置信度（多次提及 → 高置信）
```

### 3.2 一个用户的 Store 长什么样

```yaml
user_id: "user-abc123"
preferences:
  - key: material_blacklist
    category: blacklist
    content: "不接受塑料材质的商品"
    confidence: 1.0

  - key: style_preference
    category: preference
    content: "偏好小众、设计感强的品牌"
    confidence: 0.8

  - key: budget_range
    category: preference
    content: "单件预算通常在 100-300 元"
    confidence: 0.9

  - key: platform_preference
    category: preference
    content: "倾向在 Shopee 购买，因为之前有好的购物体验"
    confidence: 0.6

history:
  - key: last_purchase
    category: history
    content: "上次购买了硅胶旅行瓶套装（Shopee, ¥65）"

  - key: last_search
    category: history
    content: "上次搜索了旅行收纳袋，最终选了帆布款"
```

注意：Store 里存的不是原始对话消息，而是从对话中提取出来的结构化偏好。

这样做有两个好处：

1. 信息密度高：一条偏好只占几十 token。
2. 可更新：用户后续说“其实塑料也可以”，可以删除或降低原偏好的置信度。

## 4、记忆的写入

### 4.1 什么时候写

记忆写入发生在 AgentLoop 的 Reflect 阶段：当主 loop 检测到用户表达了明确的偏好时，触发写入：

```python
async def maybe_write_preference(user_message: str, user_id: str):
    """检测用户消息中是否包含值得记住的偏好。"""
    # 简单规则匹配（生产环境可用 NLU 模型）
    blacklist_patterns = ["不要", "不接受", "排除", "别推"]
    preference_patterns = ["喜欢", "偏好", "倾向", "习惯"]

    for pattern in blacklist_patterns:
        if pattern in user_message:
            await store.write(user_id, PreferenceEntry(
                key=f"blacklist_{hash(user_message)[:8]}",
                category="blacklist",
                content=user_message,
                source_session=get_current_thread_id(),
            ))
            return
```

项目实现中使用稳定哈希生成 key，避免 Python `hash()` 在不同进程中变化。

### 4.2 写入时机在链路中的位置

```text
用户说 "不要塑料的"
  → 主 loop Think: 识别到这是偏好表达
  → 同时做两件事：
    1. 在当前 Observe 中过滤塑料商品（即时生效）
    2. 写入 Store（持久化，下次会话也生效）
```

## 5、记忆的读取与注入

### 5.1 注入时机：新会话起来时

每次新会话创建时（`run_agent` 函数开头），从 Store 读取该用户的偏好，注入到 system prompt 末尾：

```python
async def run_agent(query: str, thread_id: str, user_id: str):
    """AgentLoop 执行入口。"""
    # 读取用户长期偏好
    preferences = await store.read(user_id)

    # 格式化成一段文本
    pref_text = format_preferences(preferences)
    # 示例输出：
    # "用户偏好：不接受塑料材质 | 偏好小众设计 | 预算 100-300 元 | 倾向 Shopee"

    # 注入到 system prompt 末尾
    full_prompt = SYSTEM_PROMPT + f"\n\n【用户长期偏好】\n{pref_text}"

    # 创建 AgentLoop 实例（带偏好的 prompt）
    agent = create_react_agent(
        model=get_llm(),
        tools=FULL_TOOL_SET,
        prompt=full_prompt,
    )

    # 执行...
```

### 5.2 注入后的效果

注入前（无记忆）：

```text
System: 你是 Globex 购物助手...
User: 帮我搜洗漱包
Agent: [返回各种材质的洗漱包，包括塑料的]
```

注入后（有记忆）：

```text
System: 你是 Globex 购物助手...
【用户长期偏好】不接受塑料材质 | 偏好小众设计 | 预算 100-300 元

User: 帮我搜洗漱包
Agent: [自动过滤塑料款，只推荐硅胶/帆布/皮质的小众设计款]
```

用户没有重复说“不要塑料”，但 Agent 记得。

### 5.3 token 成本

整个偏好注入通常只有 100-300 token（取决于偏好条目数）。相比把所有历史会话都保留（可能几万 token），这种方式：

- token 成本：几百 vs 几万。
- 信息密度：高（只有结论性偏好）vs 低（大量无关对话过程）。
- 时效性：始终最新 vs 可能包含已过时的偏好。

## 6、Store 接口设计

### 6.1 核心接口

```python
class PreferenceStore:
    """用户偏好存储的抽象接口。"""

    async def read(self, user_id: str) -> list[PreferenceEntry]:
        """读取某用户的所有偏好条目。"""
        ...

    async def write(self, user_id: str, entry: PreferenceEntry) -> None:
        """写入一条偏好。如果 key 相同则覆盖。"""
        ...

    async def delete(self, user_id: str, key: str) -> None:
        """删除某条偏好（用户主动撤回时）。"""
        ...

    async def read_relevant(
        self,
        user_id: str,
        query: str,
        top_k: int = 5,
    ) -> list[PreferenceEntry]:
        """读取和当前 query 最相关的 top_k 条偏好（向量匹配）。"""
        ...
```

### 6.2 read_relevant 为什么重要

如果一个用户积累了 50 条偏好，全部注入会占 2000+ token。`read_relevant` 基于当前 query 做向量匹配，只注入最相关的 5 条：

```text
用户搜 "洗漱包"
  → read_relevant 返回：
    - "不接受塑料材质"（相关：洗漱包常见塑料材质）
    - "预算 100-300 元"（相关：价格约束）
    - "偏好小众设计"（相关：风格约束）
  → 不返回：
    - "上次在 eBay 买过充电宝"（不相关）
    - "喜欢数码产品"（不相关）
```

## 7、和上一章压缩的协同

| 上一章（Cache Breakpoint） | 本章（长期记忆 Store） |
| --- | --- |
| 解决“上下文太长” | 解决“跨会话遗忘” |
| 通过压缩/丢弃减少 token | 通过持久化保留关键信息 |
| 作用域：单次会话内 | 作用域：跨会话持久 |
| 对象：消息历史 | 对象：结构化偏好条目 |

两者协同的方式：

```text
会话 1：用户说"不要塑料" → 写入 Store
会话 1 结束：消息历史被丢弃

会话 2 开始：从 Store 读取"不要塑料" → 注入 system prompt
会话 2：用户搜任何东西，Agent 自动过滤塑料
```

## 本章小结

到这里，你应该理解长期记忆在 Globex 中的作用：

1. 长上下文和长期记忆是两个不同的数据结构：前者按 token 涨钱且只在单会话有效，后者按条目持久化且跨会话共享。
2. Store 里存的是结构化的偏好条目（偏好 / 历史 / 黑名单），不是原始对话消息。
3. 记忆写入发生在 Reflect 阶段（检测到用户表达偏好时），读取发生在新会话起来时（注入 system prompt）。
4. `read_relevant` 按 query 相关性只注入最相关的 5 条偏好，避免注入过多无关信息。
5. 长期记忆和上下文压缩是互补关系：有了 Store 保底，上下文才能放心压缩。

下一章「[AGUI 事件协议与 WebSocket 实时推送](07 AGUI事件协议与WebSocket实时推送.md)」会讲前端怎么实时看到 Agent 正在干什么：`tool_start` / `assistant_call` / `task_result` 这套事件协议是怎么设计的。
