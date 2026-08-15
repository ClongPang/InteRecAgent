# app/tools/shopping_summary.py
import json
import time

from langchain_core.tools import tool
from pydantic import BaseModel

from app.agent.llm import get_llm
from app.agent.prompts import get_shopping_summary_prompt
from app.api.monitor import monitor
from app.tools.item_picker import PickedItem


class ShoppingSummaryOutput(BaseModel):
    final_text: str  # 给前端展示的最终回答（Markdown）
    picks: list[PickedItem]
    learned_preferences: list[str]  # 本轮新沉淀的偏好（写入 Store）


@tool
async def shopping_summary(
    picks: list[PickedItem],
    user_query: str,
    new_preferences: list[str] | None = None,
) -> ShoppingSummaryOutput:
    """生成最终购物清单 + 选购理由（终结性工具）。

    Use when: 信息已足够、候选已精挑完毕，准备收尾给用户最终答案。
    Do not use when: 候选不足、价格/运费/偏好过滤信息不全；不要提前收尾。
    """
    await monitor.report_tool_start("shopping_summary", {"picks_count": len(picks)})
    t0 = time.time()

    try:
        prompt = get_shopping_summary_prompt()
        messages = [
            ("system", prompt),
            ("user", json.dumps({
                "user_query": user_query,
                "picks": [pick.model_dump() for pick in picks],
            }, ensure_ascii=False)),
        ]
        resp = await get_llm().ainvoke(messages)

        return ShoppingSummaryOutput(
            final_text=resp.content,
            picks=picks,
            learned_preferences=new_preferences or [],
        )
    except Exception as exc:
        await monitor.report_error("shopping_summary", str(exc))
        raise
    finally:
        await monitor.report_tool_end(
            "shopping_summary",
            int((time.time() - t0) * 1000),
        )
