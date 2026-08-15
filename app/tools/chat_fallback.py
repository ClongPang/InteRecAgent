# app/tools/chat_fallback.py
from langchain_core.tools import tool


@tool
async def chat_fallback(message: str) -> str:
    """非购物闲聊或购物链路无法继续时的兜底回复。

    Use when: 用户输入与购物无关，例如问候、闲聊、询问你的能力，
    或当前购物任务无法继续且需要简短说明。
    Do not use when: 用户请求仍然包含购物意图；只要沾购物，就继续
    Planner / 检索 / 比价链路。
    """
    return message
