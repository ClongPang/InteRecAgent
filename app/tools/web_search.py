# app/tools/web_search.py
from pydantic import BaseModel, Field
from langchain_core.tools import tool


class WebSearchOutput(BaseModel):
    query: str
    results: list[str] = Field(default_factory=list)


@tool
async def web_search(query: str) -> WebSearchOutput:
    """检索外部评测、博主推荐、价格趋势或站外资料。

    Use when: 站内商品数据不够，需要外部佐证、趋势判断或评测信息。
    Do not use when: 任务只是商品检索本身；明确平台和品类时应使用
    ItemSearch。
    """
    return WebSearchOutput(query=query)
