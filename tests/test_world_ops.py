from backend.application.dto.dialogue import SetPredicate
from backend.application.services.world_ops import (
    compare_candidates,
    display_name,
    evaluate_set_query,
    parse_set_predicate,
)


def test_display_name_strips_seo_tail() -> None:
    title = "Soundcore by Anker, Space One, Active Noise Cancelling Headphones 2X Stronger Voice Reduction"
    assert display_name(title) == "Soundcore by Anker, Space One"


def test_compare_reports_form_and_merchant() -> None:
    result = compare_candidates(
        [
            {
                "snapshot_id": "s1",
                "title": "Soundcore Space One Over Ear ANC",
                "merchant": "amazon.sg",
                "market": "SG",
                "estimated_cny": {"amount": 520},
            },
            {
                "snapshot_id": "s2",
                "title": "1-Vibe Lite 真無線降噪耳機",
                "merchant": "shopify",
                "market": "US",
                "estimated_cny": {"amount": 1675},
            },
        ]
    )
    assert result is not None
    names = {item.name for item in result.non_price_diffs}
    assert "形态" in names
    assert "商户" in names
    assert result.cheaper_index == 0


def test_evaluate_set_query_is_membership_not_focus() -> None:
    result = evaluate_set_query(
        [
            {"snapshot_id": "s1", "title": "Space One", "merchant": "amazon.sg"},
            {"snapshot_id": "s2", "title": "Buds", "merchant": "shopify"},
        ],
        SetPredicate(attr="merchant", values=["lazada"], label="lazada"),
    )
    assert result.matched is False
    assert result.scanned == 2
    assert parse_set_predicate("有货吗") is None
    assert parse_set_predicate("有lazada平台的吗") is not None
