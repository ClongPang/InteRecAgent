# app/tools/price_compare.py
import time

from langchain_core.tools import tool
from pydantic import BaseModel

from app.api.monitor import monitor
from app.recall.fx import to_base
from app.tools.item_search import Candidate


class PricePoint(BaseModel):
    item_id: str
    platform: str
    title: str
    price_local: float
    currency_local: str
    price_cny: float  # 归一后的 CNY 价格（仅商品本体，不含运费）
    rating: float | None = None
    sales: int | None = None
    note: str | None = None  # 例如 "一套 3 件，等价单件 ~80 CNY"


class PriceCompareOutput(BaseModel):
    base_currency: str = "CNY"
    ranked: list[PricePoint]
    cheapest_per_platform: dict[str, str]  # {"amazon": "A1", "shopee": "S2", ...}


DEFAULT_PRICE_COMPARE_TOP_N = 5
MAX_PRICE_COMPARE_TOP_N = 5


@tool
async def price_compare(
    candidates: list[Candidate],
    base_currency: str = "CNY",
    top_n: int = DEFAULT_PRICE_COMPARE_TOP_N,
) -> PriceCompareOutput:
    """跨平台候选商品比价，输出币种归一后的排序。

    Use when: 多个平台候选已经合流回主 loop，需要归一币种并排序。
    Do not use when: 只有单平台候选；单平台结果无需跨平台比价。
    """
    top_n = max(0, min(top_n, MAX_PRICE_COMPARE_TOP_N))
    candidates = candidates[:100]
    await monitor.report_tool_start("price_compare", {
        "candidates_count": len(candidates),
        "base_currency": base_currency,
    })
    t0 = time.time()

    try:
        points: list[PricePoint] = []
        for c in candidates:
            try:
                price_base = to_base(c.price, c.currency, base_currency)
            except ValueError:
                continue

            points.append(PricePoint(
                item_id=c.item_id,
                platform=c.platform,
                title=c.title,
                price_local=c.price,
                currency_local=c.currency,
                price_cny=round(price_base, 2),
                rating=c.rating,
                sales=c.sales,
                note=_pack_note(c),
            ))

        points.sort(key=lambda p: p.price_cny)
        ranked = points[:top_n]

        cheapest: dict[str, str] = {}
        for p in points:
            if p.platform not in cheapest:
                cheapest[p.platform] = p.item_id

        return PriceCompareOutput(
            base_currency=base_currency,
            ranked=ranked,
            cheapest_per_platform=cheapest,
        )
    except Exception as exc:
        await monitor.report_error("price_compare", str(exc))
        raise
    finally:
        await monitor.report_tool_end(
            "price_compare",
            int((time.time() - t0) * 1000),
        )


def _pack_note(c: Candidate) -> str | None:
    """从 attributes 中识别"一套 N 件"这类信息。"""
    pack_size = c.attributes.get("pack_size")
    if pack_size is None:
        return None

    try:
        pack_count = float(pack_size)
    except (TypeError, ValueError):
        return None

    if pack_count <= 1:
        return None

    unit_price = round(c.price / pack_count, 2)
    display_count = int(pack_count) if pack_count.is_integer() else pack_count
    return f"一套 {display_count} 件，等价单件 ~{unit_price} {c.currency}"
