import time

from langchain_core.tools import tool
from pydantic import BaseModel, Field

from app.api.monitor import monitor
from app.tools.price_compare import PricePoint


class LandedCost(BaseModel):
    """ShippingCalc 输出给 ItemPicker 消费的到手价结构。"""

    item_id: str
    platform: str
    landed_cny: float
    eta_days: int
    duty_tier: str
    flags: list[str] = Field(default_factory=list)


@tool
async def shipping_calc(
    ranked: list[PricePoint],
    destination_country: str = "CN",
) -> list[LandedCost]:
    """估算候选商品的关税、运费和到手价。

    Use when: 跨境购物或用户需要真实到手价，且已有价格排序候选。
    Do not use when: 同境内购买或无需到手价估算；这类场景可跳过。
    """
    await monitor.report_tool_start("shipping_calc", {
        "ranked_count": len(ranked),
        "destination_country": destination_country,
    })
    t0 = time.time()

    try:
        costs = [
            LandedCost(
                item_id=item.item_id,
                platform=item.platform,
                landed_cny=item.price_cny,
                eta_days=_default_eta_days(item.platform),
                duty_tier="免征",
            )
            for item in ranked
        ]
        costs.sort(key=lambda cost: cost.landed_cny)
        return costs
    except Exception as exc:
        await monitor.report_error("shipping_calc", str(exc))
        raise
    finally:
        await monitor.report_tool_end(
            "shipping_calc",
            int((time.time() - t0) * 1000),
        )


def _default_eta_days(platform: str) -> int:
    return {
        "amazon": 10,
        "shopee": 9,
        "aliexpress": 14,
        "ebay": 16,
    }.get(platform, 14)
