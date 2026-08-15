# 17-3 单步验证与 Silent-Drift 漂移检测

来源：https://alidocs.dingtalk.com/i/nodes/bva6QBXJwa2OR5DgtMzA047NWn4qY5Pr

作者：会敲代码的泡  
创建时间：07-04 22:51

## AI 概览

理解单步验证与端到端评测的差异，掌握三类单步断言及漂移检测方法，构建实时过程质量保障体系。通过 Schema、Sequencing、Semantic 断言确保每步正确性，结合 Silent Drift 四类信号检测方向偏离，与 LoopDetector、Rubric 形成互补防线，实现在低成本下提升 Agent 执行效率与最终质量。

## 本章课程目标

- 理解单步验证和端到端 Rubric 评测的区别：前者是“每一步走完立即检查”，后者是“全跑完再打分”。
- 掌握三类单步 Assertion（Schema / Sequencing / Semantic）的实现和注册方式。
- 理解 Silent Drift（静默漂移）的本质：每一步都没错，但 5 步之后已经偏离了目标。
- 掌握四类漂移信号的检测方法、轻量 LLM 检测的 prompt 设计，以及检测到漂移后的纠正策略。
- 看清单步验证、LoopDetector、漂移检测、Rubric 四者的互补关系。

学习建议：这一章补的是 Globex 之前没有的“过程级质量保障”。第 8 章 Rubric 是“跑完再看好不好”（事后），第 14 章 LoopDetector 是“检测重复”（行为模式），本章是“每一步都验 + 持续检测是否还在正确方向”（实时过程）。三者加在一起才是完整的质量防线。

对应代码分支：`17-3-step-validation-drift`

## 1、单步验证 vs 端到端评测

### 1.1 两者的定位差异

| 维度 | 单步验证（本章） | Rubric 端到端评测（第 8 章） |
| --- | --- | --- |
| 检查时机 | 每一步 Act 之后立即 | 整条轨迹跑完之后 |
| 检查粒度 | 单个工具调用的输入输出 | 最终回答的整体质量 |
| 速度 | 毫秒级（大部分是规则检查） | 秒级（需要调 judge LLM） |
| 成本 | 几乎为零（规则）或极低（轻量 LLM） | 较高（调强模型打分） |
| 能修复什么 | 格式错误 / 顺序错误 / 明显不合理的工具返回 | 决策质量 / 需求覆盖度 / 场景洞察力 |
| 适合什么场景 | 实时在线、每条请求都跑 | 离线批量评测、关键 checkpoint 才跑 |

### 1.2 为什么两者都需要

```text
只有 Rubric 没有单步验证：
  -> Agent 跑了 8 轮后才发现"第 2 轮工具调用格式就错了"
  -> 后面 6 轮全废，token 白花

只有单步验证没有 Rubric：
  -> 每一步格式都对、顺序都对
  -> 但最终推荐的商品和用户需求完全不搭
  -> 单步验证检测不了"整体决策质量"

两者一起：
  -> 单步验证保"每一步不出错" -> 减少无效轮次 -> 省 token
  -> Rubric 保"整体质量达标" -> 持续优化决策 -> 推模型天花板
```

## 2、三类单步 Assertion

### 2.1 类型总览

| Assertion 类型 | 检查什么 | 速度 | 实现方式 |
| --- | --- | --- | --- |
| Schema Assertion | 工具返回是否符合预期的 Pydantic model | <1ms | JSON parse + 字段检查 |
| Sequencing Assertion | 工具调用顺序是否合法 | <1ms | 规则状态机 |
| Semantic Assertion | 工具返回内容和 query 语义是否对齐 | ~50ms | 轻量 LLM 评估 |

### 2.2 Schema Assertion：工具返回格式检查

检查什么：`ItemSearch` 返回了一个 `ItemSearchOutput`，里面的字段是否完整、类型是否正确。

```python
# app/harness/hooks/step_validator.py
from __future__ import annotations

import json
from typing import Any

from pydantic import BaseModel, TypeAdapter, ValidationError

from app.tools.category_insight import CategoryInsightOutput
from app.tools.item_picker import ItemPickerOutput
from app.tools.item_search import ItemSearchOutput
from app.tools.price_compare import PriceCompareOutput
from app.tools.shipping_calc import LandedCost
from app.tools.shopping_summary import ShoppingSummaryOutput


TOOL_SCHEMAS: dict[str, Any] = {
    "item_search": ItemSearchOutput,
    "price_compare": PriceCompareOutput,
    "shipping_calc": TypeAdapter(list[LandedCost]),
    "category_insight": CategoryInsightOutput,
    "item_picker": ItemPickerOutput,
    "shopping_summary": ShoppingSummaryOutput,
}


async def check_schema(context: dict[str, Any]) -> dict[str, Any] | None:
    """Validate tool output against the expected Pydantic schema."""
    tool_name = str(context.get("tool_name") or "")
    expected_schema = TOOL_SCHEMAS.get(tool_name)
    if expected_schema is None:
        return None

    try:
        data = _decode_tool_result(context.get("tool_result"))
        _validate(expected_schema, data)
    except (json.JSONDecodeError, TypeError, ValidationError, ValueError) as exc:
        failures = list(context.get("assertions_failed") or [])
        failures.append({
            "type": "schema",
            "tool": tool_name,
            "reason": str(exc),
        })
        return {"assertions_failed": failures}
    return None
```

失败后怎么处理：不中断 Agent（不 raise），而是把 assertion 失败信息记录到 `context["assertions_failed"]`，后续 `post_reflect` Hook 决定是否注入纠正提示。

### 2.3 Sequencing Assertion：工具调用顺序检查

检查什么：`ShoppingSummary` 前必须有 `ItemPicker`；`PriceCompare` 前必须有至少一次 `ItemSearch`。

```python
# app/harness/hooks/sequencing.py
from __future__ import annotations

from collections import defaultdict
from typing import Any

from app.api.context import get_thread_id


PREREQUISITES = {
    "shopping_summary": ["item_picker"],
    "price_compare": ["item_search"],
    "shipping_calc": ["price_compare"],
    "item_picker": ["shipping_calc"],
}

_called_tools_by_thread: dict[str, list[str]] = defaultdict(list)


async def reset_sequence_state(context: dict[str, Any]) -> dict[str, Any] | None:
    thread_id = _thread_id(context)
    _called_tools_by_thread[thread_id] = []
    return None


async def check_sequencing(context: dict[str, Any]) -> dict[str, Any] | None:
    """Warn when a tool is called before its expected prerequisite tools."""
    tool_name = str(context.get("tool_name") or "")
    prerequisites = PREREQUISITES.get(tool_name, [])
    if not prerequisites:
        return None

    called_tools = _called_tools_by_thread[_thread_id(context)]
    missing = [prereq for prereq in prerequisites if prereq not in called_tools]
    if not missing:
        return None

    warning = (
        f"注意：{tool_name} 通常在 {missing[0]} 之后调用，"
        f"但当前 {missing[0]} 尚未执行。"
    )
    warnings = list(context.get("inject_warnings") or [])
    warnings.append(warning)
    failures = list(context.get("assertions_failed") or [])
    failures.append({
        "type": "sequencing",
        "tool": tool_name,
        "reason": warning,
        "missing": missing,
    })
    return {"inject_warnings": warnings, "assertions_failed": failures}
```

Sequencing 不直接拒绝工具调用，而是注入 warning，并把失败记录交给后续 assertion handler。这样能避免误杀“少数合理跳步”的场景。

### 2.4 Semantic Assertion：工具返回相关性检查

检查什么：高价值工具返回是否仍然和原始需求相关。它不检查 JSON 结构，而是检查“这个结果方向对不对”。

```python
# app/harness/hooks/semantic_check.py
from __future__ import annotations

from typing import Any

from app.agent.llm import get_lite_llm


SEMANTIC_CHECK_TOOLS = {"item_search", "category_insight"}

SEMANTIC_CHECK_PROMPT = """判断以下工具返回是否和用户需求相关。
用户需求：{query}
工具返回摘要（前 200 字）：{result_preview}

只回答"相关"或"不相关"，不要解释。"""


async def check_semantic_alignment(context: dict[str, Any]) -> dict[str, Any] | None:
    """Run a lightweight semantic alignment check for high-value tools."""
    tool_name = str(context.get("tool_name") or "")
    if tool_name not in SEMANTIC_CHECK_TOOLS:
        return None

    query = str(context.get("original_query") or context.get("query") or "")
    result = context.get("tool_result")
    if not query or result is None:
        return None

    result_preview = str(result)[:200]
    try:
        response = await get_lite_llm().ainvoke([
            ("user", SEMANTIC_CHECK_PROMPT.format(
                query=query,
                result_preview=result_preview,
            )),
        ])
    except Exception as exc:
        return {"semantic_check_skipped": str(exc)}

    judgment = str(getattr(response, "content", response))
    if "不相关" not in judgment:
        return None

    failures = list(context.get("assertions_failed") or [])
    failures.append({
        "type": "semantic",
        "tool": tool_name,
        "reason": "tool result is not aligned with the original query",
    })
    return {"assertions_failed": failures}
```

Semantic Assertion 要控制成本：只对 `item_search`、`category_insight` 这类高价值入口工具跑，输入只取返回摘要前 200 字，并使用轻量模型。

### 2.5 Assertion 失败后的统一处理

三类 assertion 不直接打断主流程，而是在 `post_reflect` 汇总成纠正消息。

```python
# app/harness/hooks/assertion_handler.py
async def handle_failed_assertions(context: dict[str, Any]) -> dict[str, Any] | None:
    """Summarize assertion failures and inject corrective system messages."""
    failures = list(context.get("assertions_failed") or [])
    if not failures:
        return None

    schema_fails = [item for item in failures if item.get("type") == "schema"]
    sequencing_fails = [item for item in failures if item.get("type") == "sequencing"]
    semantic_fails = [item for item in failures if item.get("type") == "semantic"]

    messages: list[str] = []
    if schema_fails:
        first = schema_fails[0]
        messages.append(
            f"[格式问题] {first.get('tool')} 的返回格式不符合预期："
            f"{first.get('reason')}。请检查工具参数是否正确。"
        )
    if sequencing_fails:
        messages.append(str(sequencing_fails[0].get("reason")))
    if semantic_fails:
        first = semantic_fails[0]
        messages.append(
            f"[相关性问题] {first.get('tool')} 的返回和用户需求不太对齐。"
            "考虑调整搜索词或换一个检索方向。"
        )

    injected = list(context.get("inject_messages") or [])
    injected.extend({"role": "system", "content": message} for message in messages)
    return {"inject_messages": injected, "assertions_failed": []}
```

## 3、Silent Drift 漂移检测

### 3.1 什么是 Silent Drift

Silent Drift 的特点不是“某一步明显错误”，而是“每一步单看都合理，但整体方向慢慢偏了”。

```text
用户原始需求：
  "帮我找一个适合通勤、续航强、预算 500 元以内的蓝牙耳机"

看起来合理但正在漂移的轨迹：
  1. 搜索蓝牙耳机
  2. 看到高端降噪耳机，开始比较降噪芯片
  3. 搜索旗舰耳机测评
  4. 对比 1500 元档型号
  5. 最终推荐了不符合预算的旗舰耳机

每一步都不像重复，也没有格式错误；
但整体已经忘了"通勤、续航、500 元以内"。
```

LoopDetector 检测的是“重复绕圈”，Silent Drift 检测的是“方向偏离”。两者不是替代关系。

### 3.2 四类漂移信号

| 信号 | 表现 | 检测方式 |
| --- | --- | --- |
| 目标遗忘 | 最近动作和原始 query 的关键词重合很低 | 关键词 overlap / embedding similarity |
| 探索发散 | 连续扩展无关类别、连续空结果、越搜越远 | 最近 3 轮动作摘要 + 空结果计数 |
| 偏好丢失 | 忘记预算、品牌、地区、材质、配送等显性约束 | preference violation flag |
| 成本失控 | 近期 token 消耗显著高于历史均值 | 最近 3 轮 token 平均值 vs 历史均值 |

### 3.3 两段式检测：规则预检 + 轻量 LLM 确认

漂移检测不能每轮都调强模型，否则成本会超过它节省的 token。因此本章采用两段式检测：

1. Computational 预检：便宜规则先筛掉明显正常的轮次。
2. Inferential 确认：只有预检可疑时，才调用轻量 LLM 判断“正常 / 轻微偏离 / 严重偏离”。

```python
# app/harness/hooks/drift_detector.py
CHECK_INTERVAL = 3

DRIFT_CHECK_PROMPT = """你是一个购物 Agent 的漂移检测器。
用户的原始购物需求是：{original_query}
Agent 最近 3 轮的行为摘要：{recent_actions}

请判断 Agent 是否仍在朝着用户需求的方向前进。
只回答以下之一：
- "正常"：Agent 的行为合理地服务于用户需求
- "轻微偏离"：有偏离迹象但还可以纠正
- "严重偏离"：Agent 已经明显偏离用户需求

只回答判断结果，不要解释。"""
```

### 3.4 Computational 预检

```python
def _computational_drift_check(
    query: str,
    recent_actions: str,
    context: dict[str, Any],
) -> str:
    keywords = set(re.findall(r"[\u4e00-\u9fff]+", query))
    if keywords:
        hits = sum(1 for keyword in keywords if keyword in recent_actions)
        if hits / len(keywords) < 0.2:
            return "suspicious"

    if int(context.get("consecutive_empty_results") or 0) >= 3:
        return "suspicious"

    if context.get("preference_violation_detected"):
        return "suspicious"

    recent_tokens = context.get("recent_round_tokens") or []
    historical_avg = context.get("historical_avg_tokens")
    if len(recent_tokens) >= 3 and historical_avg:
        recent_avg = sum(int(item) for item in recent_tokens[-3:]) / 3
        if recent_avg > float(historical_avg) * 2:
            return "suspicious"

    return "normal"
```

### 3.5 检测到漂移后的纠正策略

| 漂移程度 | 纠正方式 |
| --- | --- |
| 轻微 | 注入提醒（`inject_messages`），让模型自行调整 |
| 严重 | 注入强纠正 + 同时触发 Token 预算检查（可能已经浪费很多） |
| 连续严重 | 如果连续 2 次检测都是“严重偏离”，强制调 `ShoppingSummary` 收尾 |

```python
# 连续严重漂移的强制收尾逻辑
if context.get("consecutive_severe_drift", 0) >= 2:
    context.setdefault("inject_messages", []).append({
        "role": "system",
        "content": (
            "[强制收尾] 连续检测到严重漂移。"
            "请立即基于已有结果调用 ShoppingSummary 给出回答，不要再发起新的检索。"
        ),
    })
```

当前项目里的实现会在严重漂移时记录 `drift_detected="severe"`，连续严重漂移时额外返回 `force_finish=True`。

## 4、四者的互补关系

### 4.1 一张图看清

```text
                    ┌─────────────────────────────────────┐
                    │       质量保障四层体系                │
                    └─────────────────────────────────────┘

                    ┌──────────────┐  ┌──────────────────┐
  实时（每步）      │ 单步验证     │  │ LoopDetector     │
                    │ (Schema /    │  │ (重复检测)       │
                    │  Sequencing/ │  │                  │
                    │  Semantic)   │  │                  │
                    └──────────────┘  └──────────────────┘

                    ┌──────────────────────────────────────┐
  每 N 轮          │ 漂移检测（Silent Drift）              │
                    │ 目标遗忘 / 发散 / 偏好丢失 / 成本    │
                    └──────────────────────────────────────┘

                    ┌──────────────────────────────────────┐
  跑完后           │ Rubric 端到端评测                     │
                    │ P0 红线 / P1 规范 / P2 质量           │
                    └──────────────────────────────────────┘
```

### 4.2 各自的守护边界

| 组件 | 检测什么 | 检测不了什么 |
| --- | --- | --- |
| 单步验证 | 格式 / 顺序 / 对齐 | 整体决策质量 |
| LoopDetector | 行为重复 | 不重复但在偏离 |
| 漂移检测 | 方向偏离 | 方向对但质量不高 |
| Rubric 评测 | 最终整体质量 | 过程中的浪费和偏离（已经花了 token） |

四层一起才是完整的质量防线。缺任何一层都有盲区。

## 5、注册进 Hook Pipeline

单步验证和漂移检测都不需要改 Agent 主循环，而是作为 Hook 注册进 17-2 的 `HarnessMiddleware`。

```python
# app/harness/setup.py
harness.register("on_session_start", "sequence_reset", reset_sequence_state, priority=20)
harness.register("on_session_start", "drift_reset", reset_drift_state, priority=30)

harness.register("pre_tool_call", "sequencing_assertion", check_sequencing, priority=25)

harness.register("post_tool_call", "schema_assertion", check_schema, priority=40)
harness.register("post_tool_call", "semantic_assertion", check_semantic_alignment, priority=45)
harness.register("post_tool_call", "sequencing_record", record_tool_call, priority=50)

harness.register("post_reflect", "assertion_handler", handle_failed_assertions, priority=15)
harness.register("post_reflect", "drift_detector", detect_drift, priority=20)
```

执行顺序里有两个关键点：

1. `sequencing_assertion` 在 `pre_tool_call` 阶段跑，因为它要在工具真正执行前判断调用顺序。
2. `schema_assertion` 和 `semantic_assertion` 在 `post_tool_call` 阶段跑，因为它们依赖工具返回。
3. `assertion_handler` 在 `post_reflect` 阶段统一汇总失败，避免每个 assertion 自己写纠正消息。
4. `drift_detector` 也在 `post_reflect` 阶段跑，因为漂移判断依赖最近几轮行为摘要。

## 6、和已有章节的关系

| 章节 | 本章和它的关系 |
| --- | --- |
| 第 8 章 Rubric 评测 | Rubric 是事后整体评分，本章是实时过程验证，互补不替代 |
| 第 14 章 LoopDetector | LoopDetector 检测“重复”，漂移检测检测“偏离”，互补 |
| 16-3 LangFuse | assertion 失败 + 漂移事件都记入 LangFuse，可事后分析 |
| 16-4 Token 预算 | 漂移检测的“成本失控”信号和 Token 预算联动 |
| 17-2 Hook Pipeline | StepValidator 和 DriftDetector 都作为 Hook 注册到 Pipeline |
| 17-4 阶段状态机 | 阶段转移时重置漂移计数器，权限收缩能减少错误阶段调用工具 |

## 7、实测效果

### 7.1 单步验证的收益

| 指标 | 无单步验证 | 有单步验证 | 提升 |
| --- | --- | --- | --- |
| 无效轮次占比 | ~18% | ~5% | -13% |
| 格式错误导致的 Agent 重试 | ~8% | ~1% | -7% |
| 平均请求 token 消耗 | 28K | 24K | -14% |

### 7.2 漂移检测的收益

| 指标 | 无漂移检测 | 有漂移检测 | 提升 |
| --- | --- | --- | --- |
| 最终回答和 query 不相关率 | ~12% | ~4% | -8% |
| 偏好被遗忘率 | ~15% | ~5% | -10% |
| 10 轮以上长对话的 Rubric 分 | 0.68 | 0.76 | +0.08 |

漂移检测在长对话（10 轮以上）场景效果最明显，因为短对话来不及漂移就结束了。

## 本章小结

1. 三类单步 Assertion：Schema（格式）/ Sequencing（顺序）/ Semantic（语义），覆盖从确定性到语义级的检查。
2. Silent Drift 漂移检测：四类信号（目标遗忘 / 探索发散 / 偏好丢失 / 成本失控）+ Computational 预检 + Inferential 确认，每 3 轮一次，单次 < $0.0001。
3. 纠正策略分级：轻微 -> 注入提醒；严重 -> 强纠正；连续严重 -> 强制收尾。
4. 四层质量防线互补：单步验证 / LoopDetector / 漂移检测 / Rubric，分别守格式、重复、方向、整体质量。
5. 成本可控：Semantic Assertion + 漂移检测的 LLM 调用总成本 < 请求总成本的 2%。

下一章「[动态工具权限与对话阶段状态机](17-4 动态工具权限与对话阶段状态机.md)」会在 Hook Pipeline 上注册最后一个核心能力：用状态机让工具可用性随对话进展动态收缩，从根源上减少“在错误阶段调错误工具”的可能性。
