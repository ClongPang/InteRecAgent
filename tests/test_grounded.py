"""证据条件回复：只引用快照事实，不编造保修、库存或评分。"""
from __future__ import annotations

from backend.application.dto.dialogue import DialogueAct, DialogueActKind
from backend.application.dto.mission import MissionConstraints
from backend.application.services.dialogue import classify_turn
from backend.application.services.grounded import compose_ready_reply, compose_talk_reply


def _ranked() -> list[dict]:
    return [
        {
            "snapshot_id": "s1",
            "title": "Sony WH-1000XM5",
            "merchant": "Amazon",
            "market": "US",
            "estimated_cny": {"amount": 2100.0, "rate": 7.2, "source": "ecb", "rate_date": "2026-08-01"},
            "native_price": {"amount": 278.0, "currency": "USD"},
            "decision_reasons": ["within_budget", "lowest_estimated_cny"],
            "unavailable_fields": ["rating", "brand", "availability"],
            "merchant_url": "https://example.com/s1",
            "rank": 1,
        },
        {
            "snapshot_id": "s2",
            "title": "Bose QC Ultra",
            "merchant": "BestBuy",
            "market": "US",
            "estimated_cny": {"amount": 2600.0, "rate": 7.2, "source": "ecb", "rate_date": "2026-08-01"},
            "native_price": {"amount": 349.0, "currency": "USD"},
            "decision_reasons": ["within_budget"],
            "unavailable_fields": ["rating", "brand", "availability"],
            "rank": 2,
        },
    ]


def _reply(text: str, *, focus: str | None = None) -> str:
    act = classify_turn(text, current_query="降噪耳机")
    return compose_talk_reply(
        act=act,
        text=text,
        ranked=_ranked(),
        constraints=MissionConstraints(query="降噪耳机", budget_cny=4000),
        focus_snapshot_id=focus,
    ).text


def test_classify_ask_topics() -> None:
    assert classify_turn("这款保修吗").topic.value == "warranty"
    assert classify_turn("有货吗").topic.value == "stock"
    assert classify_turn("为什么推荐这款").topic.value == "why"
    assert classify_turn("这两款差在哪").topic.value == "tradeoff"
    assert classify_turn("这款怎么样").topic.value == "overview"


def test_warranty_does_not_pretend_or_dump_stock() -> None:
    text = _reply("这款保修吗")
    assert "Sony WH-1000XM5" in text
    assert "不能确认" in text
    assert "2100" in text
    assert "有货" not in text
    assert "保修一年" not in text
    assert "提供保修" not in text


def test_stock_does_not_invent_availability() -> None:
    text = _reply("有货吗")
    assert "不能判断现在是否有货" in text
    assert "现货" not in text
    assert "保修" not in text


def test_why_cites_price_not_rating() -> None:
    text = _reply("为什么推荐")
    assert "2100" in text
    assert "最低" in text
    assert "4000" in text
    assert "评分" in text and "不是" in text
    assert "4.8" not in text


def test_focus_snapshot_overrides_rank() -> None:
    text = _reply("这款保修吗", focus="s2")
    assert "Bose QC Ultra" in text
    assert "Sony" not in text


def test_compare_only_uses_recorded_facts() -> None:
    reply = compose_talk_reply(
        act=classify_turn("帮我比前两个"),
        text="帮我比前两个",
        ranked=_ranked(),
        constraints=MissionConstraints(query="降噪耳机", budget_cny=4000),
    )
    assert reply.comparison_snapshot_ids == ["s1", "s2"]
    assert "2100" in reply.text and "2600" in reply.text
    assert "更低" in reply.text
    assert "保修" in reply.text and "未提供" in reply.text
    assert "星" not in reply.text


def test_ready_reply_matches_why() -> None:
    text = compose_ready_reply(_ranked(), MissionConstraints(query="降噪耳机", budget_cny=4000))
    assert "Sony WH-1000XM5" in text
    assert "2100" in text
    assert "保修和库存未提供" in text


def test_empty_ranked_asks_for_query() -> None:
    reply = compose_talk_reply(
        act=DialogueAct(kind=DialogueActKind.ASK_ITEM),
        text="这款保修吗",
        ranked=[],
        constraints=MissionConstraints(),
    )
    assert reply.requires_clarification is True
    assert "候选" in reply.text
