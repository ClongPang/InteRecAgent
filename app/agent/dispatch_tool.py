# app/agent/dispatch_tool.py
from pydantic import BaseModel
from langchain_core.tools import tool


class DispatchOutput(BaseModel):
    accepted: bool
    demands: str


@tool
async def dispatch_tool(demands: str) -> DispatchOutput:
    """派一个同质子 AgentLoop 执行自包含 demands。

    Use when: 下一步子任务满足并行、上下文隔离或链深三件事之一，例如
    跨多个平台同时 ItemSearch，或子任务会拉回大量候选需要隔离。
    Do not use when: 单步原子操作就能完成、只是想换个工具调一下、或
    子任务输出很小不需要隔离。

    demands 必须 stateless、自包含、明确返回摘要：写清平台、品类、
    硬约束、软偏好、排序依据、Top N 和需要补齐的字段。要求子 Agent
    只返回精简候选摘要，不要回传原始 API 全量响应；除非 demands 明确
    要求，否则子 Agent 不应再次调用 dispatch_tool 二次 fork。
    """
    return DispatchOutput(accepted=True, demands=demands)
