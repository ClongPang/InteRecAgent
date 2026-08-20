"""推荐轨迹的政策检查。只扫已落盘的文案与候选事实，不调模型。"""
from __future__ import annotations

import re

from ..dto.probe import Probe, SlotId

_SHIPPING = re.compile(r"直邮|包邮到|可寄到中国|配送到中国大陆|保证送到")
_WARRANTY_CLAIM = re.compile(r"正品保修|全国联保|官方保修|质保\s*\d+")
_MERCHANT_HEDGE = re.compile(r"商户页|商家页|结算页")
_PRICE_NUMBER = re.compile(r"(\d{3,5}(?:\.\d+)?)\s*元")

CASHABLE_SLOTS = {item.value for item in SlotId}


def check_policies(
    *,
    text: str,
    primary_cny: float | None = None,
    budget_cny: float | None = None,
    fx_failed: bool = False,
    citations: list[dict] | None = None,
    named_product: bool = False,
    ranked_empty: bool = False,
    has_primary: bool = False,
    probe: Probe | None = None,
    extra_probes: int = 0,
) -> list[str]:
    """返回违规码。空列表即本轮合规。"""
    hits: list[str] = []
    body = text or ""
    if _SHIPPING.search(body):
        hits.append("no_unverified_shipping")
    if _WARRANTY_CLAIM.search(body) and not _MERCHANT_HEDGE.search(body):
        hits.append("no_unverified_warranty")
    if ranked_empty and has_primary:
        hits.append("abstain_if_empty")
    if (
        budget_cny is not None
        and primary_cny is not None
        and not fx_failed
        and primary_cny > budget_cny
    ):
        hits.append("budget_hard")
    if named_product and not (citations or []):
        hits.append("cite_or_silence")
    for amount in _PRICE_NUMBER.findall(body):
        price = float(amount)
        if primary_cny is not None and abs(price - primary_cny) <= 1:
            continue
        if budget_cny is not None and abs(price - budget_cny) <= 1:
            continue
        if _looks_probe_budget(price, probe):
            continue
        hits.append("no_fabricated_price")
        break
    if probe is not None and probe.slot.value not in CASHABLE_SLOTS:
        hits.append("probe_actionable")
    if extra_probes > 0:
        hits.append("single_probe")
    return hits


def _looks_probe_budget(price: float, probe: Probe | None) -> bool:
    if probe is None or probe.slot != SlotId.BUDGET:
        return False
    for option in probe.options:
        if f"{price:.0f}" in option.text:
            return True
    return f"{price:.0f}" in (probe.question or "") or f"{price:.0f}" in (probe.observation or "")
