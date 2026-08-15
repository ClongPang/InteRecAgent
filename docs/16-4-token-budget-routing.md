# 16-4 Token预算管理与模型路由降级

来源：https://alidocs.dingtalk.com/i/nodes/b9Y4gmKWrPjda5OKt4Ny09wZJGXn6lpz

作者：会敲代码的泡

创建时间：07-04 22:51

## AI 概览

Agent 场景下需实施请求级 Token 预算以防止成本失控，通过 ContextVar 实时追踪消耗、四档降级路由（main/lite/minimal/fallback）、system prompt 注入简洁提示、与 Cache Breakpoint 协同压缩及 LangFuse 降级打标，实现成本可控与质量平衡。

本章课程目标：

- 理解为什么 Agent 场景下必须做请求级 Token 预算——不加控制，一条长对话就能把整天的成本预算打穿。
- 掌握 Token 预算的实现：ContextVar 累计消耗 + 每次 LLM 调用前余量检查 + 四档路由降级。
- 理解降级时的 system prompt 注入策略——让模型知道自己在"省钱模式"下应该怎么行动。
- 掌握降级事件在 LangFuse 打标的方式，事后能统计降级率和降级对质量的影响。
- 理解 Token 预算和 Cache Breakpoint（第 5 章）的协同——预算紧张时强制触发压缩。

学习建议：这一章是"成本控制"的工程实现。16-3 章讲了"怎么看到 Token 在哪花了"（可观测性），本章讲"看到花太多后怎么实时干预"（控制）。两者一起才构成"成本可控"的闭环。

对应代码分支：`16-4-token-budget-routing`

---

## 1、为什么 Agent 必须做请求级 Token 预算

### 1.1 普通 LLM 应用 vs Agent 的 Token 消耗模式

| 维度 | 普通对话（如 ChatGPT） | Agent（Globex） |
| --- | --- | --- |
| 每轮 Token | 相对固定（用户消息 + 模型回复） | 极度不确定（Think + 工具返回 + 压缩残留） |
| 总轮数 | 用户控制（问多少算多少） | 模型自主决定（5-15 轮 Act） |
| 最大单次请求消耗 | 通常 < 10K token | 可达 50K-100K token（跨 4 平台 + 长对话） |
| 成本可预测性 | 高 | 极低 |

### 1.2 不加控制会发生什么

真实案例：

```text
用户 query："帮我对比 4 个平台上所有 500 元以下的旅行背包，要详细列出每一件"
  → Agent fork 4 路，每路 ItemSearch top_k=50
  → 4 × 50 件 × 平均 200 token/件 = 40000 token（工具返回）
  → 主 loop 5 轮 Think，每轮看完整上下文 = 5 × 40000 = 200000 token（prompt）
  → 单条请求总消耗 > 200K token
  → 按 Claude 3.5 Sonnet 计费：约 $3-5（一条请求）
```

如果不限制，10 个这样的用户就能把一天的预算烧完。

### 1.3 Token 预算解决什么

```text
给每条请求设一个"Token 总额上限"
  → 每次调 LLM 前检查余量
  → 余量不够时自动切到便宜模型 / 强制压缩 / 规则兜底
  → 保证单条请求的成本在可控范围内
```

## 2、Token 预算的实现

### 2.1 核心数据结构

```python
# app/budget/token_budget.py
from contextvars import ContextVar
from dataclasses import dataclass, field
from typing import Literal


@dataclass
class TokenBudget:
    """请求级 Token 预算。"""
    total_limit: int = 50000           # 单请求上限（token）
    consumed: int = 0                  # 已消耗
    model_tier: Literal["main", "lite", "minimal", "fallback"] = "main"

    @property
    def remaining(self) -> int:
        return max(0, self.total_limit - self.consumed)

    @property
    def remaining_ratio(self) -> float:
        return self.remaining / self.total_limit if self.total_limit > 0 else 0.0

    def consume(self, tokens: int) -> None:
        self.consumed += tokens
        self._update_tier()

    def _update_tier(self) -> None:
        ratio = self.remaining_ratio
        if ratio > 0.50:
            self.model_tier = "main"
        elif ratio > 0.20:
            self.model_tier = "lite"
        elif ratio > 0.05:
            self.model_tier = "minimal"
        else:
            self.model_tier = "fallback"


_budget_var: ContextVar[TokenBudget | None] = ContextVar("token_budget", default=None)


def init_budget(total_limit: int = 50000) -> TokenBudget:
    budget = TokenBudget(total_limit=total_limit)
    _budget_var.set(budget)
    return budget


def get_budget() -> TokenBudget | None:
    return _budget_var.get()
```

### 2.2 在 Agent 入口初始化

```python
# app/agent/main_agent.py（修改 run_agent）
from app.budget.token_budget import init_budget


async def run_agent(query: str, thread_id: str, user_id: str | None = None) -> dict:
    # 初始化 Token 预算（可按用户等级动态调整上限）
    budget = init_budget(total_limit=get_user_token_limit(user_id))

    # ... 后续 Agent 执行 ...
```

### 2.3 每次 LLM 调用前检查余量

```python
# app/budget/middleware.py
from app.budget.token_budget import get_budget
from app.agent.llm import get_llm, get_lite_llm, get_minimal_llm


MODEL_REGISTRY = {
    "main": get_llm,            # Qwen3-35B / Claude 3.5 Sonnet
    "lite": get_lite_llm,       # Qwen3-8B / Claude Haiku
    "minimal": get_minimal_llm, # Qwen3-8B + 简洁模式
    "fallback": None,           # 不调 LLM，规则兜底
}


def get_current_model():
    """根据当前 Token 预算余量，返回对应 tier 的模型。"""
    budget = get_budget()
    if budget is None:
        return get_llm()  # 无预算限制时用主力模型

    tier = budget.model_tier
    factory = MODEL_REGISTRY.get(tier)
    if factory is None:
        return None  # fallback tier 不调 LLM
    return factory()
```

## 3、四档路由降级

### 3.1 降级规则

| 剩余预算比例 | Tier | 使用模型 | 行为调整 |
| --- | --- | --- | --- |
| > 50% | main | Qwen3-35B / Claude Sonnet | 无限制，正常执行 |
| 20% - 50% | lite | Qwen3-8B / Claude Haiku | 正常执行，模型更轻 |
| 5% - 20% | minimal | Qwen3-8B + 简洁 hint | 注入简洁模式，限制 Think 长度 |
| < 5% | fallback | 不调 LLM | 规则兜底回答，直接用已有中间结果 |

### 3.2 实际效果

```text
一条请求的典型生命周期：

Round 1-3: 预算充裕 (remaining > 50%) → 用主力模型，正常 Think
Round 4:   ItemSearch 返回大量结果 → 消耗跳增 → remaining 降到 40%
           → 自动切到 lite 模型
Round 5:   PriceCompare + ShippingCalc → remaining 降到 15%
           → 切到 minimal + 注入简洁 hint
Round 6:   模型收到简洁 hint → 直接调 ShoppingSummary 收尾
           → 任务完成，没有触发 fallback
```

大多数请求在 lite 阶段就能完成——只有极端长对话才会走到 minimal 或 fallback。

### 3.3 降级时 system prompt 注入

当 tier 降到 minimal 时，在 system prompt 末尾追加：

```python
# app/budget/middleware.py（续）
MINIMAL_HINT = """
[系统提示：当前请求 Token 预算紧张，请遵循以下约束]
- Think 阶段不要展开详细推理，直接给出结论
- 不要再发起新的检索工具调用
- 基于已有的 Observation 结果直接生成最终回答
- 优先调用 ShoppingSummary 或 ChatFallback 收尾
"""


def inject_budget_hint(messages: list[dict], tier: str) -> list[dict]:
    """在 minimal tier 时注入简洁模式 hint。"""
    if tier != "minimal":
        return messages
    # 在 system 消息末尾追加
    if messages and messages[0]["role"] == "system":
        messages[0]["content"] += "\n" + MINIMAL_HINT
    return messages
```

这段 hint 的核心目的：让模型知道"别再探索了，用你已有的信息收尾"——而不是继续 Think → Act 循环把预算彻底花完。

## 4、Token 消耗的精确记账

### 4.1 在 LLM 调用后记账

```python
# app/budget/accounting.py
from app.budget.token_budget import get_budget


async def account_llm_usage(prompt_tokens: int, completion_tokens: int):
    """每次 LLM 调用后，把实际消耗记入预算。"""
    budget = get_budget()
    if budget is None:
        return
    total = prompt_tokens + completion_tokens
    budget.consume(total)
```

### 4.2 在 LangGraph callback 里自动触发

```python
# app/budget/callback.py
from langchain_core.callbacks import BaseCallbackHandler
from app.budget.accounting import account_llm_usage


class TokenBudgetCallback(BaseCallbackHandler):
    """LangGraph callback：每次 LLM 调用结束后自动记账。"""

    async def on_llm_end(self, response, **kwargs):
        usage = response.llm_output.get("token_usage", {})
        prompt_tokens = usage.get("prompt_tokens", 0)
        completion_tokens = usage.get("completion_tokens", 0)
        await account_llm_usage(prompt_tokens, completion_tokens)
```

注入方式和 16-3 章的 LangFuse callback 一样——都放在 `config["callbacks"]` 里。

### 4.3 工具返回也要计入

工具返回虽然不走 LLM，但它会出现在下一轮 prompt 里。所以工具返回的 token 也要预估计入：

```python
# app/budget/accounting.py（续）
def account_tool_result(result_text: str):
    """工具返回的内容会在下一轮 prompt 里出现，需要预估计入。"""
    budget = get_budget()
    if budget is None:
        return
    estimated_tokens = len(result_text) // 3  # 粗估：3 字符 ≈ 1 token
    budget.consume(estimated_tokens)
```

## 5、和 Cache Breakpoint 的协同

### 5.1 预算紧张时强制压缩

正常情况下，Cache Breakpoint 只在"边界外消息积累够多"时才触发。但预算紧张时应该更积极地压缩：

```python
# app/budget/middleware.py（续）
from app.compress.compressor import compress_messages
from app.compress.breakpoint import compute_breakpoint


async def budget_aware_compress(messages: list[dict]) -> list[dict]:
    """预算紧张时强制触发更激进的压缩。"""
    budget = get_budget()
    if budget is None:
        return messages

    if budget.remaining_ratio < 0.30:
        # 预算剩余 < 30%：把 keep_recent 从 3 降到 1，更激进压缩
        breakpoint = compute_breakpoint(messages, keep_recent=1)
    elif budget.remaining_ratio < 0.50:
        # 预算剩余 < 50%：正常压缩（keep_recent=3）
        breakpoint = compute_breakpoint(messages, keep_recent=3)
    else:
        # 预算充裕：不额外压缩
        return messages

    if breakpoint < len(messages):
        compressed = await compress_messages(messages[:breakpoint])
        return compressed + messages[breakpoint:]
    return messages
```

### 5.2 压缩和降级的协同时序

```text
预算余量 50%: → 切 lite 模型 + 正常 Cache Breakpoint（keep_recent=3）
预算余量 30%: → 切 lite 模型 + 激进压缩（keep_recent=1）
预算余量 20%: → 切 minimal 模型 + 注入简洁 hint + 激进压缩
预算余量 5%:  → fallback 规则兜底，不再调 LLM
```

压缩先行，降级随后——先压缩能省 token，省完还不够再降级模型。

## 6、Fallback 规则兜底

### 6.1 什么时候触发

当预算剩余 < 5%（约 2500 token），此时连一次 LLM 调用都不够了。

### 6.2 兜底逻辑

```python
# app/budget/fallback.py
from app.tools.item_picker import PickedItem


def generate_fallback_answer(
    picks: list[PickedItem] | None,
    user_query: str,
) -> str:
    """不调 LLM，用已有中间结果拼出一个可用回答。"""
    if picks and len(picks) > 0:
        # 有已经精挑过的商品，直接格式化输出
        lines = ["## 推荐商品（基于已有检索结果）\n"]
        for i, p in enumerate(picks, 1):
            lines.append(f"{i}. **{p.item_id}**（{p.platform}）— 到手价 ¥{p.landed_cny}")
            if p.reasons:
                lines.append(f"   理由：{'；'.join(p.reasons[:2])}")
        lines.append("\n> 注：由于请求较长，已基于已有结果生成推荐，如需更多选项请开启新对话。")
        return "\n".join(lines)
    else:
        # 连中间结果都没有，给用户一个友好提示
        return (
            f"抱歉，您的请求「{user_query[:50]}...」处理时间较长，"
            "已有信息不足以给出完整推荐。建议缩小搜索范围后重新提问。"
        )
```

### 6.3 Fallback 不是失败

关键认知：fallback 不是"系统报错"，是"在有限预算内给出力所能及的最好回答"。前端展示时不应该是 error 样式，而是正常回答 + 一句提示。

## 7、降级事件在 LangFuse 打标

### 7.1 打标代码

```python
# app/budget/middleware.py（续）
from app.observability.trace_ctx import get_langfuse_trace


def report_tier_change(old_tier: str, new_tier: str, remaining_ratio: float):
    """降级发生时在 LangFuse 里打标。"""
    trace = get_langfuse_trace()
    if trace:
        trace.event(
            name="budget_tier_change",
            input={
                "old_tier": old_tier,
                "new_tier": new_tier,
                "remaining_ratio": round(remaining_ratio, 3),
            },
        )
```

### 7.2 事后统计

在 LangFuse 面板里可以：

- 按 `budget_tier_change` 事件筛选所有发生过降级的 Trace。
- 统计降级率：发生过 `tier_change` 的 Trace / 总 Trace。
- 对比降级 Trace 和非降级 Trace 的 Rubric Score 差异——量化降级对质量的影响。

### 7.3 Globex 的经验值

| 指标 | 值 | 说明 |
| --- | --- | --- |
| 总降级率 | ~15% | 15% 的请求触发了至少一次降级 |
| 降到 lite 的比例 | ~12% | 大部分降级止步于 lite |
| 降到 minimal 的比例 | ~3% | 极少数长对话 |
| 降到 fallback 的比例 | ~0.5% | 几乎不触发 |
| 降级 Trace 的 Rubric 分 | 0.72 | 比非降级（0.79）低约 9% |
| 用户感知 | 低 | 大多数用户不知道发生了降级 |

## 8、模型路由与成本估算

### 8.1 各 Tier 成本对比

| Tier | 模型 | 输入价格（/1M token） | 输出价格（/1M token） | 相对主力的成本 |
| --- | --- | --- | --- | --- |
| main | Claude 3.5 Sonnet | $3 | $15 | 1x |
| lite | Claude Haiku | $0.25 | $1.25 | ~10x 便宜 |
| minimal | Haiku + 简洁模式 | $0.25 | $0.80（输出短） | ~15x 便宜 |
| fallback | 不调 LLM | $0 | $0 | 免费 |

### 8.2 预算上限怎么设

```text
目标：单条请求平均成本 < $0.05

推算：
  - 平均 5 轮 Think，每轮 prompt ~8K token + completion ~500 token
  - 主力模型：5 × (8K × $3/M + 500 × $15/M) = $0.16（超预算）
  - 混合模式：3 轮 main + 2 轮 lite = 3×$0.032 + 2×$0.003 = $0.10（仍超）
  - 加 Cache Breakpoint 后 prompt 降 35%：$0.10 × 0.65 = $0.065（接近）
  - 再加 Token 预算（极端 case 被 lite 兜住）：平均 ≈ $0.05 ✓

结论：预算上限 50K token × 混合计费 ≈ 单条 $0.04-0.06
```

### 8.3 按用户等级动态调整

```python
# app/budget/limits.py
USER_TIER_LIMITS = {
    "free": 30000,       # 免费用户 30K token
    "standard": 50000,   # 付费用户 50K token
    "premium": 100000,   # 高级用户 100K token
}


def get_user_token_limit(user_id: str | None) -> int:
    if user_id is None:
        return USER_TIER_LIMITS["free"]
    tier = lookup_user_tier(user_id)  # 从用户服务查
    return USER_TIER_LIMITS.get(tier, USER_TIER_LIMITS["free"])
```

## 9、和其它章节的关系

| 章节 | 本章和它的关系 |
| --- | --- |
| 第 5 章 Cache Breakpoint | 预算紧张时强制触发更激进的压缩 |
| 第 14 章 防失控 | Token 预算是"成本维度的防失控"，LoopDetector 是"行为维度的防失控" |
| 16-2 vLLM | 降级到 lite 模型时，可能路由到不同的 vLLM 实例 |
| 16-3 LangFuse | 降级事件打标 + 降级率统计 |
| 16-5 工具熔断 | 工具熔断后工具返回为空 → token 消耗降低 → 预算压力减轻 |

## 本章小结

到这里，Globex 有了完整的请求级成本控制：

1. TokenBudget 数据结构：ContextVar 存储，每次 LLM 调用 + 工具返回都实时记账。
2. 四档路由降级：main（>50%）→ lite（20-50%）→ minimal（5-20%）→ fallback（<5%），大多数降级止步于 lite。
3. 简洁模式 hint 注入：告诉模型"别再探索了，收尾"，有效缩短 minimal 阶段的 Think 长度。
4. Fallback 兜底：不是报错，是"基于已有结果给最好回答"。
5. 和 Cache Breakpoint 协同：预算紧张时 keep_recent 从 3 降到 1，先压缩再降级。
6. LangFuse 打标：事后统计降级率、降级对质量的影响。
7. 成本估算：混合模式 + Cache Breakpoint + 预算控制，单条请求平均 < $0.05。

下一章「[工具熔断与请求排队优先级](16-5 工具熔断与请求排队优先级.md)」会讲当外部工具不可靠时怎么保护系统——和 Token 预算一起，构成"成本可控 + 可用性有保障"的完整防线。
