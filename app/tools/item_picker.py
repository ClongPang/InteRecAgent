# app/tools/item_picker.py
import time

from langchain_core.tools import tool
from pydantic import BaseModel, Field

from app.api.monitor import monitor
from app.tools.category_insight import CategoryInsightOutput
from app.tools.shipping_calc import LandedCost


class PickedItem(BaseModel):
    item_id: str
    platform: str
    landed_cny: float
    score: float  # 综合分（价格 / 评分 / 偏好对齐）
    reasons: list[str] = Field(default_factory=list)  # 选它的 1-3 条理由
    flags: list[str] = Field(default_factory=list)  # 排除标记，如"含塑料"


class ItemPickerOutput(BaseModel):
    picks: list[PickedItem]  # 最多 3 件
    rejected_brief: list[str]  # 被排除的简短原因（不要把所有候选塞回来）


@tool
async def item_picker(
    landed: list[LandedCost],
    insight: CategoryInsightOutput | None = None,
    user_preferences: list[str] | None = None,
    top_n: int = 3,
) -> ItemPickerOutput:
    """从合流候选集中按用户偏好精挑 1-3 件商品。

    Use when: 已经有候选商品、到手价或品类洞察，且需要按硬约束和
    软偏好做二次过滤。
    Do not use when: 还没搜到候选；应先 ItemSearch / PriceCompare /
    ShippingCalc。
    """
    top_n = max(0, min(top_n, 3))
    await monitor.report_tool_start("item_picker", {
        "landed_count": len(landed),
        "preferences": user_preferences or [],
    })
    t0 = time.time()

    try:
        rejected: list[str] = []
        candidates: list[PickedItem] = []
        prefs = user_preferences or []

        for cost in landed:
            flags = _check_preferences(cost, prefs)
            if any(flag.startswith("HARD_FAIL:") for flag in flags):
                rejected.append(f"{cost.item_id}：{flags[0].split(':', 1)[1]}")
                continue
            score, reasons = _score(cost, insight, prefs)
            candidates.append(PickedItem(
                item_id=cost.item_id,
                platform=cost.platform,
                landed_cny=cost.landed_cny,
                score=score,
                reasons=reasons,
                flags=flags,
            ))

        candidates.sort(key=lambda item: item.score, reverse=True)
        picks = candidates[:top_n]
        return ItemPickerOutput(picks=picks, rejected_brief=rejected[:8])
    except Exception as exc:
        await monitor.report_error("item_picker", str(exc))
        raise
    finally:
        await monitor.report_tool_end("item_picker", int((time.time() - t0) * 1000))


def _check_preferences(cost: LandedCost, prefs: list[str]) -> list[str]:
    """硬约束（材质 / 黑名单）走 HARD_FAIL，软偏好走普通 flag。"""
    flags: list[str] = []

    # 这里是示意：真实场景从 cost 关联回 Candidate.attributes 读材质
    if any("不要塑料" in pref for pref in prefs):
        if cost.platform == "ebay" and cost.item_id.endswith("-PLASTIC"):
            flags.append("HARD_FAIL:含塑料，命中用户黑名单")
    return flags


def _score(
    cost: LandedCost,
    insight: CategoryInsightOutput | None,
    prefs: list[str],
) -> tuple[float, list[str]]:
    score = 0.0
    reasons: list[str] = []

    # 价格档位匹配（CategoryInsight 提供）
    if insight and insight.price_tiers:
        budget_tier = next((tier for tier in insight.price_tiers if tier.tier == "mid"), None)
        if budget_tier and budget_tier.range_cny[0] <= cost.landed_cny <= budget_tier.range_cny[1]:
            score += 0.4
            reasons.append(f"到手价 {cost.landed_cny} 落在中档 {budget_tier.range_cny}")

    # 时效偏好
    if cost.eta_days <= 12:
        score += 0.2
        reasons.append(f"{cost.eta_days} 天到手")

    # 关税友好
    if cost.duty_tier == "免征":
        score += 0.2
        reasons.append("跨境直邮免税")

    # 软偏好对齐
    if any("小众" in pref for pref in prefs) and cost.platform in {"shopee", "aliexpress"}:
        score += 0.2
        reasons.append("平台偏向小众款")

    return round(score, 2), reasons[:3]
