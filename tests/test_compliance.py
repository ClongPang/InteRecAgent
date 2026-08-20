"""政策谓词：对着文案和候选事实，不调模型。"""
from __future__ import annotations

from backend.application.dto.probe import Probe, ProbeOption, SlotId
from backend.application.services.compliance import check_policies


def test_shipping_and_warranty_claims_are_violations() -> None:
    assert "no_unverified_shipping" in check_policies(text="这款可直邮到中国大陆。")
    assert "no_unverified_warranty" in check_policies(text="正品保修一年。")
    assert not check_policies(text="保修未提供，需要到商户页确认。")


def test_budget_hard_and_empty_abstain() -> None:
    assert "budget_hard" in check_policies(
        text="推荐 A，估算约 3000 元。",
        primary_cny=3000,
        budget_cny=2000,
    )
    assert "abstain_if_empty" in check_policies(
        text="先看看这款", ranked_empty=True, has_primary=True
    )


def test_probe_prices_are_not_fabricated() -> None:
    probe = Probe(
        slot=SlotId.BUDGET,
        question="候选人民币大约 900–4200 元。预算大概定在哪？",
        options=[ProbeOption(label="预算 900 元", text="预算 900 元")],
        observation="候选人民币大约 900–4200 元",
    )
    hits = check_policies(
        text="推荐 Sony，估算约 2100 元。\n\n候选人民币大约 900–4200 元。预算大概定在哪？",
        primary_cny=2100,
        citations=[{"snapshot_id": "s1"}],
        named_product=True,
        probe=probe,
    )
    assert "no_fabricated_price" not in hits
    assert "cite_or_silence" not in hits
