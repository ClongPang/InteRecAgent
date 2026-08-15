# 17-4 动态工具权限与对话阶段状态机

来源：https://alidocs.dingtalk.com/i/nodes/wva2dxOW4YPD3NrMfkQwy91yVbkz3BRL

作者：会敲代码的泡  
创建时间：07-04 22:51

## AI 概览

本章阐述如何通过对话阶段状态机和动态工具权限提升 Agent 的可靠性与效率，提出 `PLANNING -> SEARCHING -> COMPARING -> CONCLUDING` 四阶段模型，结合 Hook 机制实现工具调用的权限控制与阶段转移，并引入用户等级与风险分级叠加策略，实测显著降低错误率、节省 token 消耗并提升任务完成率。

## 本章课程目标

- 理解为什么 Globex 的 `FULL_TOOL_SET` 不能始终全量开放，“在错误阶段调错误工具”是最常见的 Agent 行为错误之一。
- 掌握对话阶段状态机的设计：`PLANNING -> SEARCHING -> COMPARING -> CONCLUDING` 四阶段，每阶段只开放相应工具子集。
- 理解状态机是怎么通过 Hook Pipeline 接入的：`pre_tool_call` 做权限拦截、`post_reflect` 做阶段转移。
- 掌握工具风险分级和按用户等级动态调整工具集的方案。
- 看清 statewright 研究结论在 Globex 的落地意义：“缩小工具空间比用更强的模型效果更好”。

学习建议：这是 Harness 工程系列的最后一章，也是“从 Harness 全景到最后一块落地”的收官。读完后你的 Globex 应该具备“不同对话阶段暴露不同工具、不同用户看到不同工具”的动态权限能力，这是生产级 Agent 区别于 demo 的重要标志。

对应代码分支：`17-4-dynamic-tool-permissions`

## 1、为什么 FULL_TOOL_SET 不能始终全量开放

### 1.1 当前 Globex 的问题

第 14 章 `tool_registry.py` 里的 `FULL_TOOL_SET` 包含 10 个工具（9 业务工具 + `dispatch_tool`）。主 loop 和每个子 loop 始终看到全部 10 个。

这导致三类实际 bad case：

| Bad Case | 表现 | 根因 |
| --- | --- | --- |
| 过早收尾 | Agent 在第 2 轮就调 `ShoppingSummary` | 还没搜就“总结了”，因为模型看到这个工具就可能跳过检索 |
| 冗余 fork | 单平台 query 也调 `dispatch_tool` fork 4 路 | `dispatch_tool` 始终可见，模型有时候“忍不住”用 |
| 逆序调用 | 先调 `ItemPicker` 再调 `ItemSearch` | 模型没有“顺序感”，所有工具同时可见时随机选 |

### 1.2 statewright 的启发

2025 年 statewright 研究（state machine guardrails）的核心发现：

> Local models went from 2/10 to 10/10 passing on a SWE-bench subset purely by shrinking the tool space.

换句话说：不是模型不够聪明，是可选工具太多让模型“选择困难”。缩小工具空间 = 减少决策空间 = 提升决策正确率。

这个结论对 Globex 的直接意义：

```text
当前（全量工具）：模型从 10 个工具里选 -> 选错概率高
状态机方案：每个阶段只暴露 3-4 个工具 -> 选错概率降 60%+
```

## 2、对话阶段状态机设计

### 2.1 四阶段定义

```text
┌──────────┐     Planner 已输出     ┌──────────┐
│ PLANNING │ ───────────────────→ │ SEARCHING│
│ (规划)    │                       │ (检索)    │
└──────────┘                       └──────────┘
                                        │
                                  至少 1 路候选返回
                                        ↓
┌──────────┐     ItemPicker 已输出  ┌──────────┐
│CONCLUDING│ ←─────────────────── │ COMPARING│
│ (收尾)    │                       │ (比价)    │
└──────────┘                       └──────────┘
```

### 2.2 每阶段可用的工具子集

| 阶段 | 可用工具 | 不可用工具（被隐藏） |
| --- | --- | --- |
| `PLANNING` | `planner` / `chat_fallback` / `category_insight` / `web_search` | `item_search` / `price_compare` / `shipping_calc` / `item_picker` / `shopping_summary` / `dispatch_tool` |
| `SEARCHING` | `item_search` / `dispatch_tool` / `web_search` / `category_insight` / `chat_fallback` | `price_compare` / `shipping_calc` / `item_picker` / `shopping_summary` |
| `COMPARING` | `price_compare` / `shipping_calc` / `item_picker` / `chat_fallback` | `item_search` / `dispatch_tool` / `shopping_summary` |
| `CONCLUDING` | `shopping_summary` / `chat_fallback` | 其他所有工具 |

### 2.3 设计原则

| 原则 | 体现 |
| --- | --- |
| 只进不退 | 一般情况下阶段只前进不后退（特殊情况见 4.3） |
| `chat_fallback` 始终可用 | 任何阶段用户都可能闲聊或追问，兜底工具不能隐藏 |
| 隐藏 > 拒绝 | 模型根本看不到被隐藏的工具 schema，不会生成那个 `tool_call` |
| `category_insight` 跨阶段 | 品类常识在 `PLANNING` 和 `SEARCHING` 都可能用到 |

## 3、PhaseStateMachine 实现

### 3.1 核心状态机

```python
# app/harness/phase_machine.py
from enum import Enum
from typing import Sequence
from contextvars import ContextVar


class Phase(Enum):
    PLANNING = "planning"
    SEARCHING = "searching"
    COMPARING = "comparing"
    CONCLUDING = "concluding"


# 每阶段可用工具定义
PHASE_TOOLS: dict[Phase, set[str]] = {
    Phase.PLANNING: {
        "planner", "chat_fallback", "category_insight", "web_search",
    },
    Phase.SEARCHING: {
        "item_search", "dispatch_tool", "web_search",
        "category_insight", "chat_fallback",
    },
    Phase.COMPARING: {
        "price_compare", "shipping_calc", "item_picker", "chat_fallback",
    },
    Phase.CONCLUDING: {
        "shopping_summary", "chat_fallback",
    },
}


# 阶段转移条件
TRANSITION_CONDITIONS: dict[Phase, dict[str, Phase]] = {
    Phase.PLANNING: {
        "planner_output_ready": Phase.SEARCHING,
    },
    Phase.SEARCHING: {
        "candidates_available": Phase.COMPARING,
    },
    Phase.COMPARING: {
        "picks_ready": Phase.CONCLUDING,
    },
    Phase.CONCLUDING: {},  # 终态
}


_phase_var: ContextVar[Phase] = ContextVar("agent_phase", default=Phase.PLANNING)


class PhaseStateMachine:
    """对话阶段状态机。"""

    def get_current_phase(self) -> Phase:
        return _phase_var.get()

    def set_phase(self, phase: Phase) -> None:
        _phase_var.set(phase)

    def get_allowed_tools(self) -> set[str]:
        """获取当前阶段可用的工具集。"""
        return PHASE_TOOLS[self.get_current_phase()]

    def is_tool_allowed(self, tool_name: str) -> bool:
        """检查某工具在当前阶段是否可用。"""
        return tool_name in self.get_allowed_tools()

    def try_transition(self, signal: str) -> bool:
        """尝试阶段转移。返回 True 表示转移成功。"""
        current = self.get_current_phase()
        conditions = TRANSITION_CONDITIONS.get(current, {})
        next_phase = conditions.get(signal)
        if next_phase:
            self.set_phase(next_phase)
            return True
        return False

    def reset(self) -> None:
        """重置到初始阶段（新会话时调用）。"""
        _phase_var.set(Phase.PLANNING)


phase_machine = PhaseStateMachine()
```

### 3.2 工具过滤器

```python
# app/harness/tool_filter.py
from app.harness.phase_machine import phase_machine
from app.agent.tool_registry import FULL_TOOL_SET


def get_filtered_tool_set() -> list:
    """获取当前阶段过滤后的工具列表。

    模型只能看到这些工具的 schema——看不到的工具不会被调用。
    """
    allowed = phase_machine.get_allowed_tools()
    return [tool for tool in FULL_TOOL_SET if tool.name in allowed]
```

### 3.3 接入 Agent 构建

```python
# app/agent/main_agent.py（修改）
from app.harness.tool_filter import get_filtered_tool_set


def _build_main_agent(prompt: str):
    # 关键变化：不再用 FULL_TOOL_SET，而是用 filtered 版本
    return create_react_agent(
        model=get_llm(),
        tools=get_filtered_tool_set(),  # ← 动态！
        prompt=prompt,
    )
```

注意：`get_filtered_tool_set()` 在每轮 Think 前被调用（因为阶段可能在上一轮的 `post_reflect` 里发生了转移）。LangGraph 支持动态工具列表。

## 4、通过 Hook Pipeline 接入

### 4.1 pre_tool_call Hook：权限拦截

即使模型偶尔“幻觉”出一个当前阶段不可见的工具调用（理论上不应该发生，但防御性编程），`pre_tool_call` Hook 做最后一道拦截：

```python
# app/harness/hooks/phase_check.py
from app.harness.middleware import harness_hook, HookRejectSignal
from app.harness.phase_machine import phase_machine


@harness_hook("pre_tool_call", name="phase_check", priority=20)
async def check_phase_permission(context: dict) -> dict | None:
    """检查工具调用是否在当前阶段允许。"""
    tool_name = context.get("tool_name", "")

    if not phase_machine.is_tool_allowed(tool_name):
        current_phase = phase_machine.get_current_phase()
        allowed = phase_machine.get_allowed_tools()
        raise HookRejectSignal(
            f"工具 {tool_name} 在当前阶段 {current_phase.value} 不可用。"
            f"当前可用工具：{', '.join(sorted(allowed))}"
        )

    return None
```

### 4.2 post_reflect Hook：阶段转移

每轮 Reflect 之后，检查是否满足转移条件：

```python
# app/harness/hooks/phase_transition.py
from app.harness.middleware import harness_hook
from app.harness.phase_machine import phase_machine, Phase
import logging


logger = logging.getLogger(__name__)


@harness_hook("post_reflect", name="phase_transition", priority=40)
async def try_phase_transition(context: dict) -> dict | None:
    """根据当前执行状态判断是否触发阶段转移。"""
    current = phase_machine.get_current_phase()

    # PLANNING → SEARCHING：Planner 已经输出结构化需求
    if current == Phase.PLANNING:
        if context.get("planner_output_ready"):
            phase_machine.try_transition("planner_output_ready")
            logger.info("Phase transition: PLANNING → SEARCHING")

    # SEARCHING → COMPARING：至少有 1 路 ItemSearch 返回了候选
    elif current == Phase.SEARCHING:
        candidates_count = context.get("total_candidates", 0)
        if candidates_count > 0:
            phase_machine.try_transition("candidates_available")
            logger.info(f"Phase transition: SEARCHING → COMPARING ({candidates_count} candidates)")

    # COMPARING → CONCLUDING：ItemPicker 已经输出 picks
    elif current == Phase.COMPARING:
        picks_count = context.get("picks_count", 0)
        if picks_count > 0:
            phase_machine.try_transition("picks_ready")
            logger.info(f"Phase transition: COMPARING → CONCLUDING ({picks_count} picks)")

    return None
```

### 4.3 特殊情况：阶段回退

正常情况下阶段只前进。但有一种特殊场景需要回退：

```text
场景：COMPARING 阶段发现所有候选都超预算
  -> ItemPicker 无法精挑出任何商品
  -> 需要回到 SEARCHING 扩大搜索范围

处理方式：在 COMPARING 阶段，如果 ItemPicker 返回空 + 连续 2 轮无进展
  -> 触发特殊回退：COMPARING -> SEARCHING
```

```python
# app/harness/hooks/phase_transition.py（补充）
@harness_hook("post_reflect", name="phase_rollback", priority=41)
async def check_phase_rollback(context: dict) -> dict | None:
    """特殊情况：COMPARING 无进展时回退到 SEARCHING。"""
    current = phase_machine.get_current_phase()

    if current == Phase.COMPARING:
        no_progress_rounds = context.get("comparing_no_progress", 0)
        if no_progress_rounds >= 2:
            phase_machine.set_phase(Phase.SEARCHING)
            logger.warning("Phase ROLLBACK: COMPARING → SEARCHING (no progress)")

            context.setdefault("inject_messages", []).append({
                "role": "system",
                "content": (
                    "当前候选集无法满足用户需求。已回退到搜索阶段。"
                    "请尝试调整搜索条件（放宽预算/换品类/减少约束）。"
                ),
            })
            context["comparing_no_progress"] = 0

    return context
```

## 5、工具风险分级

### 5.1 三档风险

不只是按阶段分，还要按工具本身的“风险等级”分层：

| 风险等级 | 工具 | 特征 |
| --- | --- | --- |
| 只读 | `item_search` / `category_insight` / `web_search` / `price_compare` / `shipping_calc` | 不改变状态，随时可调 |
| 写入 | `shopping_summary` / Store 写回偏好 | 改变用户可见状态 |
| 资源消耗 | `dispatch_tool`（fork 子 Agent） | 占用 GPU / 并发 / token |

### 5.2 风险等级对阶段约束的叠加

```python
# app/harness/tool_risk.py
from enum import Enum


class ToolRisk(Enum):
    READ_ONLY = "read_only"
    WRITE = "write"
    RESOURCE_HEAVY = "resource_heavy"


TOOL_RISK_MAP: dict[str, ToolRisk] = {
    "item_search": ToolRisk.READ_ONLY,
    "category_insight": ToolRisk.READ_ONLY,
    "web_search": ToolRisk.READ_ONLY,
    "price_compare": ToolRisk.READ_ONLY,
    "shipping_calc": ToolRisk.READ_ONLY,
    "planner": ToolRisk.READ_ONLY,
    "chat_fallback": ToolRisk.READ_ONLY,
    "item_picker": ToolRisk.READ_ONLY,
    "shopping_summary": ToolRisk.WRITE,
    "dispatch_tool": ToolRisk.RESOURCE_HEAVY,
}
```

高风险工具即使在“允许阶段”也有额外约束：

- `dispatch_tool`：受 fork 深度上限 + 并发数限制（第 14 章）。
- `shopping_summary`：只能在 `CONCLUDING` 阶段调用（双重保护）。

## 6、按用户等级动态调整工具集

### 6.1 规则

| 用户等级 | 可用的额外约束 |
| --- | --- |
| 免费用户 | `dispatch_tool` 不可用（不能 fork，只能主 loop 串行） |
| 付费用户 | 全量可用 |
| 企业用户 | 全量 + 额外开放“批量比价”工具（如果有） |

### 6.2 实现

```python
# app/harness/user_tool_filter.py
from app.harness.phase_machine import phase_machine


USER_TIER_RESTRICTIONS: dict[str, set[str]] = {
    "free": {"dispatch_tool"},     # 免费用户禁止 fork
    "standard": set(),             # 付费用户无额外限制
    "premium": set(),              # 企业用户无额外限制
}


def get_user_filtered_tools(user_tier: str = "free") -> set[str]:
    """在阶段过滤基础上，再叠加用户等级限制。"""
    phase_allowed = phase_machine.get_allowed_tools()
    restricted = USER_TIER_RESTRICTIONS.get(user_tier, set())
    return phase_allowed - restricted
```

在 `pre_tool_call` Hook 里叠加检查：

```python
@harness_hook("pre_tool_call", name="user_tier_check", priority=22)
async def check_user_tier(context: dict) -> dict | None:
    """按用户等级额外限制工具。"""
    tool_name = context.get("tool_name", "")
    user_tier = context.get("user_tier", "free")

    restricted = USER_TIER_RESTRICTIONS.get(user_tier, set())
    if tool_name in restricted:
        raise HookRejectSignal(
            f"工具 {tool_name} 对 {user_tier} 用户不可用。"
            "请升级到付费版本以使用跨平台并行检索功能。"
        )

    return None
```

## 7、状态机的可观测性

### 7.1 阶段转移事件记录

```python
# 在 phase_transition Hook 里补充
from app.observability.trace_ctx import get_langfuse_trace


trace = get_langfuse_trace()
if trace:
    trace.event(
        name="phase_transition",
        input={
            "from": current.value,
            "to": phase_machine.get_current_phase().value,
            "trigger": signal,
        },
    )
```

### 7.2 工具拒绝事件记录

被阶段状态机拒绝的工具调用也要记录，方便事后分析“模型在哪个阶段最容易调错工具”：

```python
# 在 phase_check Hook 的 HookRejectSignal 前
if trace:
    trace.event(
        name="tool_rejected_by_phase",
        input={
            "tool": tool_name,
            "phase": current_phase.value,
            "allowed": list(allowed),
        },
    )
```

### 7.3 看板指标

| 指标 | 含义 | 告警阈值 |
| --- | --- | --- |
| 阶段转移平均轮次 | 从 `PLANNING` 到 `CONCLUDING` 几轮 | > 12 轮 |
| 工具被阶段拒绝率 | 被 `phase_check` 拒绝的比例 | > 5% |
| 阶段回退率 | 触发 `COMPARING -> SEARCHING` 的比例 | > 10% |
| 免费用户 dispatch 拒绝率 | 免费用户尝试 fork 被拒的比例 | 高不是问题 |

## 8、实测效果

### 8.1 加入状态机前后对比

| 指标 | 无状态机 | 有状态机 | 变化 |
| --- | --- | --- | --- |
| 过早调 `ShoppingSummary` 率 | ~12% | ~1% | -11% |
| 不必要 fork 率 | ~8% | ~2% | -6% |
| 工具调用逆序率 | ~6% | ~1% | -5% |
| 平均请求 token 消耗 | 28K | 22K | -21% |
| 任务完成率 | 89% | 94% | +5% |
| Rubric 平均分 | 0.79 | 0.83 | +0.04 |

### 8.2 核心收益来源

```text
Token 省 21% 的来源：
  - 不再浪费轮次在错误工具上（直接减少无效 Think + Act）
  - 模型看到更少的工具 schema（每轮 prompt 里的 tool description 少了 60%）
  - fork 减少 -> 子 Agent 的 LLM 调用减少

Rubric 提升的来源：
  - 调用顺序更合理 -> 最终推荐质量更高
  - 不再过早收尾 -> 信息收集更充分
```

## 9、和其它章节的关系

| 章节 | 本章和它的关系 |
| --- | --- |
| 第 14 章 `FULL_TOOL_SET` | 14 章是静态全量注册，本章在上面加了动态过滤层 |
| 第 14 章 fork 深度限制 | fork 深度限制是“能力层”约束，阶段状态机是“意图层”约束，叠加 |
| 16-4 Token 预算 | 状态机减少了无效工具调用，Token 消耗降低，预算压力减轻 |
| 16-5 请求排队 | 免费用户不能 fork，单请求资源消耗更低，排队压力减轻 |
| 17-2 Hook Pipeline | 状态机通过 `pre_tool_call` 和 `post_reflect` 两个 Hook 接入 |
| 17-3 漂移检测 | 阶段转移时重置漂移计数器 |

## 10、17-1 到 17-4 四章总结

| 章节 | 解决什么 | 核心产出 |
| --- | --- | --- |
| 17-1 | 给已有 Harness 组件一张统一地图 | 2x2 分类学 + 全景映射表 |
| 17-2 | 让 Harness 组件有统一的注册和执行入口 | `HarnessMiddleware` + 6 Hook 点 |
| 17-3 | 补上过程级质量保障 | 3 类 assertion + 4 类漂移信号 |
| 17-4 | 从根源减少“调错工具”的可能性 | 4 阶段状态机 + 动态工具子集 + 用户等级 |

四章合在一起的工程意义：

```text
17-1（地图）-> 知道 Harness 有什么、缺什么
17-2（骨架）-> 所有组件怎么插到 Agent 身上
17-3（验证）-> 每一步走完都有人检查
17-4（收缩）-> 从根源减少可出错的选项

= Globex 的 Harness 从“有零件”升级到“有框架、有骨架、有验证、有收缩”的完整工程体系
```

## 本章小结

到这里，Globex 的 Harness 工程系列全部完成：

1. 四阶段状态机：`PLANNING -> SEARCHING -> COMPARING -> CONCLUDING`，每阶段只暴露 3-4 个工具。
2. 隐藏 > 拒绝：模型根本看不到被隐藏工具的 schema，从源头消除错误选择。
3. 通过 Hook 接入：`pre_tool_call`（拦截）+ `post_reflect`（转移）+ 特殊回退机制。
4. 用户等级叠加：免费用户禁 fork、企业用户开放更多工具，在阶段过滤基础上再叠一层。
5. 实测效果：Token 省 21%、任务完成率 +5%、Rubric +0.04，核心收益是“不再在错误工具上浪费轮次”。
6. statewright 结论在 Globex 的验证：缩小工具空间确实比修 prompt 或换更强模型效果更好。

至此，Harness 工程四章全部交付。Globex 从“有零件”升级到了“有框架（17-1）、有骨架（17-2）、有验证（17-3）、有收缩（17-4）”的完整 Harness Engineering 体系。
