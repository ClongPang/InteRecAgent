from backend.application.dto.dialogue import DialogueActKind
from backend.application.services.nlu import snapshot_ids_for_ranks
from backend.application.services.plan import propose_plan


def test_propose_plan_keeps_probe_and_compare() -> None:
    plan = propose_plan("有lazada平台的吗，帮我比前两个", current_query="降噪耳机")
    kinds = [item.kind for item in plan.ops]
    assert DialogueActKind.ASK_SET in kinds
    assert DialogueActKind.COMPARE in kinds
    assert plan.primary.kind == DialogueActKind.ASK_SET
    assert plan.leftover == []


def test_propose_plan_filter_leaves_compare() -> None:
    plan = propose_plan("只要lazada，帮我比前两个", current_query="降噪耳机")
    assert plan.primary.kind == DialogueActKind.REFINE
    assert plan.primary.patch is not None
    assert plan.primary.patch.merchants == ["lazada"]
    assert any(item.kind == DialogueActKind.COMPARE for item in plan.leftover)


def test_third_and_last_ranks() -> None:
    ranked = [{"snapshot_id": "a"}, {"snapshot_id": "b"}, {"snapshot_id": "c"}]
    assert snapshot_ids_for_ranks(ranked, [3]) == ["c"]
    assert snapshot_ids_for_ranks(ranked, [-1]) == ["c"]
