# app/api/monitor.py
from contextlib import suppress
from datetime import datetime
from typing import Any
from app.api.context import get_thread_id
from app.api.connection import manager
from app.observability.alerts import rt_monitor, send_alert
from app.observability.trace_ctx import (
    get_current_span,
    get_langfuse_trace,
    set_current_span,
)


class Monitor:
    """统一封装 AGUI 事件上报。"""

    async def _emit(self, event: str, message: str, data: dict[str, Any]) -> None:
        thread_id = get_thread_id()
        if thread_id is None:
            return  # 没有上下文（如离线脚本调用工具）就静默丢弃

        payload = {
            "type": "monitor_event",
            "event": event,
            "message": message,
            "data": data,
            "timestamp": datetime.now().isoformat(),
        }
        await manager.send_to_thread(payload, thread_id)

    async def report_tool_start(self, tool_name: str, args: dict) -> None:
        await self._emit("tool_start", f"正在调用 {tool_name}", {
            "tool_name": tool_name, "args": args,
        })

        trace = get_langfuse_trace()
        if trace:
            with suppress(Exception):
                span = trace.span(
                    name=f"tool:{tool_name}",
                    input=args,
                    metadata={"thread_id": get_thread_id()},
                )
                set_current_span(span)  # 存到 ContextVar，tool_end 时关闭

    async def report_tool_end(self, tool_name: str, duration_ms: int) -> None:
        await self._emit("tool_end", f"{tool_name} 完成", {
            "tool_name": tool_name, "duration_ms": duration_ms,
        })

        span = get_current_span()
        if span:
            with suppress(Exception):
                span.end(
                    output={"duration_ms": duration_ms},
                    metadata={"tool_name": tool_name},
                )
            set_current_span(None)

        rt_monitor.record(tool_name, duration_ms)
        for alert in rt_monitor.check_alerts():
            await send_alert(alert)

    async def report_fork(self, sub_thread_id: str, demands: str) -> None:
        await self._emit("fork", "派发子 AgentLoop", {
            "sub_thread_id": sub_thread_id,
            "demands": demands[:200],
        })

    async def report_assistant_call(self, step: str, preview: str = "") -> None:
        await self._emit("assistant_call", "Agent 正在思考", {
            "step": step,
            "preview": preview[:200],
        })

    async def report_session_created(self, thread_id: str, session_dir: str) -> None:
        await self._emit("session_created", "会话已创建", {
            "thread_id": thread_id,
            "session_dir": session_dir,
        })

    async def report_task_result(self, final_answer: str) -> None:
        await self._emit("task_result", "任务完成", {
            "final_answer": final_answer,
        })

    async def report_task_cancelled(self) -> None:
        await self._emit("task_cancelled", "任务已取消", {})

    async def report_error(self, error_type: str, message: str) -> None:
        await self._emit("error", message, {
            "error_type": error_type,
            "message": message,
        })


monitor = Monitor()
