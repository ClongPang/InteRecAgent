# 17-2 Middleware-Hook-Pipeline 与工具调用生命周期

来源：https://alidocs.dingtalk.com/i/nodes/yQod3RxJKGkMNXZ5hoZX9qkqJkb4Mw9r

作者：会敲代码的泡  
创建时间：07-04 22:51

## AI 概览

本章阐述了构建统一 Hook Pipeline 的必要性，通过定义 6 个标准 Hook 点和实现 `HarnessMiddleware`，将分散的检查逻辑（如白名单、截断、安全过滤等）统一注册与执行，解决新增功能需修改多处代码的问题，并明确 Hook 与 LangGraph Callback 的分工：Hook 可拦截修改，Callback 仅用于观测。

## 本章课程目标

- 理解为什么分散的 pre/post 检查需要一个统一的 Hook Pipeline，不统一的后果是“新增一个检查要改 5 个文件”。
- 掌握 Agent 生命周期的 6 个 Hook 点及其职责边界。
- 拿到一份可直接复用的 `HarnessMiddleware` 实现（约 80 行），支持 Hook 注册、按顺序执行、异常不中断主流程。
- 理解 Hook Pipeline 和 LangGraph callbacks 的区别：callbacks 只能观测，Hook 能拦截和修改。
- 看清 Globex 已有组件（LoopDetector、truncate、安全过滤、Token 预算）怎么迁移进 Hook Pipeline。

学习建议：这一章是 Harness 工程的“骨架层”。17-1 给了全景地图，本章给出“所有 Harness 组件怎么插到 Agent 身上”的统一接口。读完后你应该能回答：“如果我要新增一个检查逻辑，我应该实现哪个 Hook、怎么注册进 Pipeline。”

对应代码分支：`17-2-middleware-hooks`

## 1、为什么需要统一的 Hook Pipeline

### 1.1 当前 Globex 的分散现状

| 检查逻辑 | 当前放在哪里 | 问题 |
| --- | --- | --- |
| 工具白名单校验 | `pre_tool_check()` 散函数 | 和 `tool_node` 耦合 |
| 工具返回截断 | `truncate_long_tool_result()` | 手动插在 `tool_node` 之后 |
| LoopDetector | `LoopDetector` 类 | 手动在 `post_step` 调用 |
| Token 预算检查 | `TokenBudgetCallback` | 挂在 LangGraph callbacks |
| 安全内容过滤 | `sanitize_tool_output()` | 手动在 monitor 里调 |
| LangFuse 打标 | `LangfuseCallbackHandler` | 又一个 callback |

6 个检查逻辑分布在 6 个不同的地方，用 3 种不同的接入方式（散函数 / 类 / callback）。

### 1.2 不统一的后果

新增一个检查要改多少地方？

假设现在要新增“工具调用顺序校验”（如“ShoppingSummary 前必须有 ItemPicker”）：

```text
不统一时：
  1. 找到 tool_node 的代码 -> 在里面加 if 判断？还是在外面包一层？
  2. 这个检查应该在 truncate 之前还是之后？和白名单校验的顺序是什么？
  3. 如果检查失败了怎么处理？raise？返回特殊值？
  4. 要不要在 LangFuse 里记录这个事件？自己写还是复用已有的？
  -> 改完要动 3-4 个文件，还容易改出 bug

统一 Hook Pipeline 后：
  1. 实现一个 SequencingAssertion 函数
  2. 注册到 post_tool_call hook
  3. 完成。Pipeline 自动管执行顺序、异常处理、事件记录
```

### 1.3 Hook vs LangGraph Callback

| 维度 | LangGraph Callback | Harness Hook |
| --- | --- | --- |
| 能力 | 只能观测（`on_llm_end` 等） | 能拦截并修改（修改输入 / 拒绝执行） |
| 执行时机 | 由 LangGraph 框架触发 | 由 `HarnessMiddleware` 按注册顺序触发 |
| 异常处理 | 异常会传播到主流程 | Hook 异常被捕获，不中断 Agent |
| 状态修改 | 不能修改 State | 可以修改 messages / 工具参数 / 返回值 |
| 适合什么 | 观测 + 打点（LangFuse / 计费） | 行为控制 + 验证 + 修改 |

结论：LangFuse 这类“只需要看不需要改”的逻辑继续用 callback；需要拦截 / 修改 / 拒绝的逻辑走 Hook Pipeline。

## 2、Agent 生命周期的 6 个 Hook 点

### 2.1 完整生命周期

```text
用户 query 进入
  |
  +-- [1] on_session_start ----------- 初始化环境
  |
  +-- Loop Begin ---------------------
  |   |
  |   +-- [2] pre_think -------------- Think 前注入
  |   |        |
  |   |   LLM Think（产出 tool_call 或最终回答）
  |   |        |
  |   +-- [3] pre_tool_call ---------- 工具调用前拦截
  |   |        |
  |   |   Tool 执行（返回结果）
  |   |        |
  |   +-- [4] post_tool_call --------- 工具调用后处理
  |   |        |
  |   |   Observe（结果注入 State）
  |   |        |
  |   +-- [5] post_reflect ----------- Reflect 后检测
  |   |
  |   +-- Loop End（继续 / 收敛）
  |
  +-- [6] on_session_end ------------- 收尾清理
```

### 2.2 各 Hook 点的职责

| Hook | 触发时机 | 职责 | 已有组件迁入 |
| --- | --- | --- | --- |
| `on_session_start` | Agent 任务启动时 | 初始化 ContextVar / TokenBudget / 加载长期偏好 / 阶段重置 | `init_budget()` / `set_thread_context()` |
| `pre_think` | 每轮 Think 之前 | 注入降级 hint / 注入漂移纠正信号 / 注入阶段约束 | Token 预算 hint 注入 |
| `pre_tool_call` | 工具执行之前 | 白名单校验 / 权限状态机检查 / 参数 schema 校验 | `validate_tool_call()` / 阶段状态机 |
| `post_tool_call` | 工具执行之后 | 内容过滤 / 体积截断 / 熔断计数 / 单步 assertion | truncate / sanitize / `breaker.record` |
| `post_reflect` | 每轮 Reflect 之后 | LoopDetector / 漂移检测 / Token 余量检查 / 阶段转移 | LoopDetector / `budget_aware_compress` |
| `on_session_end` | Agent 任务结束时 | 写回 Store / 输出审核 / LangFuse score 注入 | `audit_output()` / Store 写回 |

## 3、HarnessMiddleware 实现

### 3.1 核心类

```python
# app/harness/middleware.py
import asyncio
import logging
from collections import defaultdict
from typing import Any, Callable, Awaitable


logger = logging.getLogger(__name__)


# Hook 函数签名：接收 context dict，返回 context dict（可修改）或 None（不修改）
HookFn = Callable[[dict[str, Any]], Awaitable[dict[str, Any] | None]]


# 6 个 Hook 点
HOOK_POINTS = [
    "on_session_start",
    "pre_think",
    "pre_tool_call",
    "post_tool_call",
    "post_reflect",
    "on_session_end",
]


class HarnessMiddleware:
    """Agent Harness 的统一 Hook Pipeline。

    设计原则：
    - Hook 按注册顺序依次执行
    - 单个 Hook 异常不中断整个 Pipeline（catch + log）
    - Hook 可以修改 context（如截断工具返回、注入 hint）
    - Hook 也可以返回特殊 signal（如 REJECT 拒绝工具调用）
    """

    def __init__(self):
        self._hooks: dict[str, list[tuple[str, HookFn]]] = defaultdict(list)

    def register(self, hook_point: str, name: str, fn: HookFn, priority: int = 100):
        if hook_point not in HOOK_POINTS:
            raise ValueError(f"Unknown hook point: {hook_point}")

        fn._priority = priority
        self._hooks[hook_point].append((name, fn))
        self._hooks[hook_point].sort(key=lambda item: getattr(item[1], "_priority", 100))

    async def run(self, hook_point: str, context: dict[str, Any]) -> dict[str, Any]:
        if hook_point not in HOOK_POINTS:
            raise ValueError(f"Unknown hook point: {hook_point}")

        for name, fn in self._hooks.get(hook_point, []):
            try:
                result = await fn(context)
                if result is not None:
                    context = result
            except HookRejectSignal as e:
                context["_rejected"] = True
                context["_reject_reason"] = str(e)
                break
            except Exception as e:
                logger.error(f"Hook [{name}] 执行异常: {e}", exc_info=True)
                continue

        return context


class HookRejectSignal(Exception):
    """Hook 显式拒绝当前操作。"""


harness = HarnessMiddleware()
```

### 3.2 Hook 注册的两种方式

方式 A：装饰器注册（推荐）

```python
# app/harness/hooks/tool_whitelist.py
from app.harness.middleware import harness, HookRejectSignal
from app.security.tool_whitelist import ALLOWED_TOOLS


@harness_hook("pre_tool_call", name="tool_whitelist", priority=10)
async def check_tool_whitelist(context: dict) -> dict | None:
    """工具白名单校验——最先执行（priority=10）。"""
    tool_name = context.get("tool_name", "")
    if tool_name not in ALLOWED_TOOLS:
        raise HookRejectSignal(f"工具 {tool_name} 不在白名单内")
    return None  # 不修改 context，继续下一个 Hook


def harness_hook(hook_point: str, name: str, priority: int = 100):
    """装饰器：自动注册 Hook。"""
    def decorator(fn):
        fn._priority = priority
        harness.register(hook_point, name, fn, priority)
        return fn
    return decorator
```

方式 B：启动时批量注册

```python
# app/harness/setup.py
from app.harness.middleware import harness
from app.harness.hooks.tool_whitelist import check_tool_whitelist
from app.harness.hooks.truncate import truncate_tool_result
from app.harness.hooks.loop_detector import detect_loop
from app.harness.hooks.token_budget import check_budget
from app.harness.hooks.content_filter import filter_tool_output
from app.harness.hooks.output_guard import audit_final_output


def setup_harness():
    """启动时注册所有 Hook。"""
    # pre_tool_call hooks（按 priority 顺序）
    harness.register("pre_tool_call", "tool_whitelist", check_tool_whitelist, priority=10)
    harness.register("pre_tool_call", "phase_check", check_phase_permission, priority=20)
    harness.register("pre_tool_call", "schema_validate", validate_tool_args, priority=30)

    # post_tool_call hooks
    harness.register("post_tool_call", "content_filter", filter_tool_output, priority=10)
    harness.register("post_tool_call", "truncate", truncate_tool_result, priority=20)
    harness.register("post_tool_call", "breaker_record", record_breaker_result, priority=30)
    harness.register("post_tool_call", "step_assertion", run_step_assertion, priority=40)

    # post_reflect hooks
    harness.register("post_reflect", "loop_detector", detect_loop, priority=10)
    harness.register("post_reflect", "drift_check", check_drift, priority=20)
    harness.register("post_reflect", "budget_check", check_budget, priority=30)
    harness.register("post_reflect", "phase_transition", try_phase_transition, priority=40)

    # on_session_end hooks
    harness.register("on_session_end", "output_guard", audit_final_output, priority=10)
    harness.register("on_session_end", "store_writeback", writeback_preferences, priority=20)
```

## 4、在 Agent 主循环里接入 Hook Pipeline

### 4.1 接入位置

```python
# app/agent/main_agent.py（关键修改点）
from app.harness.middleware import harness


async def run_agent(query: str, thread_id: str, user_id: str | None = None) -> dict:
    # [Hook 1] on_session_start
    ctx = await harness.run("on_session_start", {
        "query": query,
        "thread_id": thread_id,
        "user_id": user_id,
    })

    # ... 构建 Agent、注入偏好 ...
    # Agent 执行（LangGraph 内部循环中通过自定义 node 触发 Hook）
    result = await agent.ainvoke(...)

    # [Hook 6] on_session_end
    ctx = await harness.run("on_session_end", {
        "final_answer": result["messages"][-1].content,
        "thread_id": thread_id,
        "trajectory": result["messages"],
    })

    # 如果输出被审核修改了
    final_text = ctx.get("final_answer", result["messages"][-1].content)
    return {"status": "ok", "final": final_text}
```

### 4.2 在 LangGraph 节点内触发 Hook

LangGraph 的 `tool_node` 执行工具前后，分别触发 `pre_tool_call` 和 `post_tool_call`：

```python
# app/agent/harness_tool_node.py
from langgraph.prebuilt import ToolNode
from app.harness.middleware import harness


class HarnessToolNode(ToolNode):
    """带 Harness Hook 的 ToolNode。"""

    async def _run_one_tool(self, tool_call: dict, config: dict) -> dict:
        # [Hook 3] pre_tool_call
        ctx = await harness.run("pre_tool_call", {
            "tool_name": tool_call["name"],
            "tool_args": tool_call["args"],
            "tool_call_id": tool_call["id"],
        })

        # 如果被 Hook 拒绝
        if ctx.get("_rejected"):
            return {
                "tool_call_id": tool_call["id"],
                "content": f"[Harness 拒绝] {ctx.get('_reject_reason', '未知原因')}",
            }

        # 正常执行工具
        result = await super()._run_one_tool(tool_call, config)

        # [Hook 4] post_tool_call
        ctx = await harness.run("post_tool_call", {
            "tool_name": tool_call["name"],
            "tool_result": result["content"],
            "duration_ms": result.get("duration_ms", 0),
        })

        # 如果 Hook 修改了结果（如截断）
        if "tool_result" in ctx:
            result["content"] = ctx["tool_result"]

        return result
```

## 5、已有组件迁移进 Hook

### 5.1 迁移对照表

| 原组件 | 迁移到哪个 Hook | priority | 改动量 |
| --- | --- | --- | --- |
| `validate_tool_call()` | `pre_tool_call` | 10 | 改签名 |
| `truncate_long_tool_result()` | `post_tool_call` | 20 | 改签名 |
| `sanitize_tool_output()` | `post_tool_call` | 10 | 改签名 |
| `LoopDetector.record()` | `post_reflect` | 10 | 改签名 |
| `budget_aware_compress()` | `post_reflect` | 30 | 改签名 |
| `audit_output()` | `on_session_end` | 10 | 改签名 |
| TokenBudget hint 注入 | `pre_think` | 10 | 新建 |

### 5.2 迁移示例：LoopDetector

原实现是一个类，直接调 `detector.record(tool_name)`，改为 Hook 函数：

```python
# app/harness/hooks/loop_detector.py
from app.harness.middleware import harness_hook
from collections import deque


_recent_tools: deque[str] = deque(maxlen=6)
REPEAT_THRESHOLD = 4


@harness_hook("post_reflect", name="loop_detector", priority=10)
async def detect_loop(context: dict) -> dict | None:
    """检测工具调用循环，触发时注入收敛提示。"""
    tool_name = context.get("last_tool_name")
    if not tool_name:
        return None

    _recent_tools.append(tool_name)
    if _recent_tools.count(tool_name) >= REPEAT_THRESHOLD:
        # 注入收敛提示（将在下一轮 pre_think 被模型看到）
        context.setdefault("inject_messages", []).append({
            "role": "system",
            "content": (
                f"你已重复调用 {tool_name} 工具 {REPEAT_THRESHOLD} 次，"
                "请基于已有信息直接给出结论，或换一种思路。"
            ),
        })
        _recent_tools.clear()

    return context
```

### 5.3 迁移示例：工具返回截断

```python
# app/harness/hooks/truncate.py
from app.harness.middleware import harness_hook


MAX_TOOL_RESULT_CHARS = 16000  # ~4000 token


@harness_hook("post_tool_call", name="truncate", priority=20)
async def truncate_tool_result(context: dict) -> dict | None:
    """工具返回过长时截断。"""
    result = context.get("tool_result", "")
    if len(result) <= MAX_TOOL_RESULT_CHARS:
        return None

    truncated = result[:MAX_TOOL_RESULT_CHARS - 200]
    truncated += "\n\n[…工具结果过长已截断，如需完整内容请缩小查询范围]"
    context["tool_result"] = truncated
    return context
```

## 6、Hook 的执行保障

### 6.1 异常不中断

单个 Hook 出 bug 不能让整个 Agent 挂掉：

```python
except Exception as e:
    logger.error(f"Hook [{name}] 执行异常: {e}", exc_info=True)
    continue  # 跳过这个 Hook，继续执行后面的
```

### 6.2 执行顺序可控

所有 Hook 按 priority 排序。低 priority 先执行：

```text
pre_tool_call 执行顺序：
  1. tool_whitelist (priority=10)  <- 最先，不合法直接拒绝
  2. phase_check (priority=20)     <- 阶段检查
  3. schema_validate (priority=30) <- 参数校验
```

### 6.3 Hook 可观测

每个 Hook 的执行情况都可以被 LangFuse 记录：

```python
# 在 HarnessMiddleware.run() 内部
for name, fn in self._hooks.get(hook_point, []):
    t0 = time.time()
    try:
        result = await fn(context)
        duration = int((time.time() - t0) * 1000)
        # 可选：记录到 LangFuse
        if duration > 50:  # 慢 Hook 记录
            logger.info(f"Hook [{name}] took {duration}ms")
    except ...
```

## 7、新增 Hook 的开发流程

当你遇到一个新的 bad case 需要加检查时：

1. 判断这个检查应该在哪个 Hook 点。
   - 想在工具执行前拦截？-> `pre_tool_call`
   - 想在工具执行后处理返回？-> `post_tool_call`
   - 想在每轮结束后检测行为模式？-> `post_reflect`
   - 想在最终输出前审核？-> `on_session_end`
2. 实现一个 async 函数，签名：`context dict -> context dict | None`。
   - 返回 `None` = 不修改
   - 返回修改后的 `context` = 修改生效
   - raise `HookRejectSignal` = 拒绝当前操作
3. 用 `@harness_hook` 装饰器注册，选择合适的 priority。
4. 写一个单元测试验证 Hook 行为。
5. 部署。不需要改 Agent 主循环代码。

这就是 Hook Pipeline 的核心价值：新增检查逻辑只需要写一个函数 + 一行注册，不动主流程代码。

## 8、和其它章节的关系

| 章节 | 本章为它解决了什么 |
| --- | --- |
| 第 14 章 防失控四件套 | 四件套迁移进 Hook Pipeline，变成可插拔、可观测、有优先级 |
| 16-4 Token 预算 | hint 注入从散落代码变成 `pre_think` Hook |
| 16-5 工具熔断 | 熔断计数从工具内部提取到 `post_tool_call` Hook |
| 16-6 安全护栏 | 四层防御中的 L1/L3/L4 全部变成 Hook，统一管理 |
| 17-1 Harness 全景 | 本章是全景图上“还没有的第一块”——统一骨架 |
| 17-3 单步验证 | StepValidator 作为一个 `post_tool_call` Hook 注册 |
| 17-4 动态工具权限 | PhaseStateMachine 作为 `pre_tool_call` 和 `post_reflect` Hook |

## 本章小结

到这里，Globex 有了统一的 Harness Hook Pipeline：

1. 6 个 Hook 点覆盖 Agent 完整生命周期：`session_start` / `pre_think` / `pre_tool_call` / `post_tool_call` / `post_reflect` / `session_end`。
2. `HarnessMiddleware`：80 行代码，支持注册 + 按优先级顺序执行 + 异常不中断 + `HookRejectSignal` 拦截。
3. 装饰器注册：新增一个检查只需要写一个函数 + `@harness_hook(...)` 一行。
4. 已有组件全部可迁入：LoopDetector / truncate / 安全过滤 / Token 预算 / 熔断计数，统一为 Hook。
5. Hook vs Callback：Callback 只能看，Hook 能拦截和修改，两者分工明确。

下一章「[单步验证与 Silent Drift 漂移检测](17-3 单步验证与Silent-Drift漂移检测.md)」会在这个 Hook Pipeline 上注册两个新的核心 Hook：`post_tool_call` 的 StepValidator 和 `post_reflect` 的 DriftDetector，补上 Globex 目前没有的“过程级质量保障”。
