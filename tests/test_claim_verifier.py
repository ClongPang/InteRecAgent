from __future__ import annotations

import pytest

from backend.application.dto import (
    AnswerClaim,
    AnswerPlan,
    AskTopic,
    ClaimLedger,
    DecisionBundle,
    DialogueAct,
    DialogueActKind,
    EvidenceRef,
    SetPredicate,
    TurnPlan,
)
from backend.application.services.answer import (
    ClaimVerificationError,
    build_candidate_claim_ledger,
    build_recommendation_answer_plan,
    build_talk_answer_artifacts,
    render_answer_from_ledger,
    render_recommendation_copy,
    verify_claim_ledger,
    verify_rendered_answer,
)


def test_verified_claim_must_reference_canonical_candidate():
    ledger = ClaimLedger(
        goal_version=1,
        candidate_set_id="set-1",
        claims=[
            AnswerClaim(
                claim_id="c1",
                subject="s1",
                predicate="price_cny",
                value=1200,
                evidence_refs=[EvidenceRef(source="snapshot", path="estimated_cny.amount", value=1200)],
            )
        ],
    )
    assert verify_claim_ledger(ledger, displayed_snapshot_ids={"s1"}) == ledger
    with pytest.raises(ClaimVerificationError, match="outside canonical"):
        verify_claim_ledger(ledger, displayed_snapshot_ids={"s2"})


def test_factual_claim_without_evidence_is_rejected():
    ledger = ClaimLedger(
        goal_version=1,
        claims=[AnswerClaim(claim_id="c1", subject="s1", predicate="stock", value=True)]
    )
    with pytest.raises(ClaimVerificationError, match="no evidence"):
        verify_claim_ledger(ledger, displayed_snapshot_ids={"s1"})


def test_factual_claim_value_must_match_its_evidence():
    ledger = ClaimLedger(
        goal_version=1,
        claims=[
            AnswerClaim(
                claim_id="set:count",
                subject="set",
                predicate="count",
                value=6,
                evidence_refs=[EvidenceRef(source="candidate_set", path="displayed", value=17)],
            )
        ]
    )
    with pytest.raises(ClaimVerificationError, match="not supported"):
        verify_claim_ledger(ledger, displayed_snapshot_ids=set())


def test_source_product_id_is_never_user_subject():
    ledger = ClaimLedger(
        goal_version=1,
        claims=[
            AnswerClaim(
                claim_id="c1",
                subject="source:71673752",
                predicate="price",
                value=1,
                evidence_refs=[EvidenceRef(source="snapshot", path="price", value=1)],
            )
        ]
    )
    with pytest.raises(ClaimVerificationError, match="must not be exposed"):
        verify_claim_ledger(ledger, displayed_snapshot_ids={"source:71673752"})


def test_candidate_ledger_is_snapshot_scoped_and_verifiable():
    records = [
        {
            "snapshot_id": "snap-1",
            "title": "Apple iPhone 16 Pro",
            "merchant": "shop",
            "market": "US",
            "estimated_cny": {"amount": 7999},
            "in_stock": None,
        }
    ]
    ledger = build_candidate_claim_ledger("set-1", records, goal_version=1)
    verify_claim_ledger(ledger, displayed_snapshot_ids={"snap-1"})
    assert {claim.subject for claim in ledger.claims} == {"snap-1"}
    assert all(claim.evidence_refs for claim in ledger.claims)
    assert all(claim.predicate != "in_stock" for claim in ledger.claims)
    plan = build_recommendation_answer_plan("set-1", records, goal_version=1)
    assert plan.scope_candidate_set_id == "set-1"
    assert plan.obligations[0].status == "answered"


def test_set_answer_has_explicit_obligation_and_set_scoped_claim():
    act = DialogueAct(
        kind=DialogueActKind.ASK_SET,
        predicate=SetPredicate(attr="merchant", values=["amazon"]),
    )
    plan, ledger = build_talk_answer_artifacts(
        goal_version=1,
        candidate_set_id="set-1",
        act=act,
        records=[],
        snapshot_ids=[],
    )
    verify_claim_ledger(ledger, displayed_snapshot_ids=set())
    assert plan.obligations[0].facet == "merchant"
    assert ledger.claims[0].subject == "set"
    assert ledger.claims[0].value == 0


def test_compound_turn_builds_one_obligation_per_question() -> None:
    stock = DialogueAct(kind=DialogueActKind.ASK_ITEM, topic=AskTopic.STOCK)
    warranty = DialogueAct(kind=DialogueActKind.ASK_ITEM, topic=AskTopic.WARRANTY)
    turn = TurnPlan(ops=[stock, warranty], lead=stock)
    plan, _ledger = build_talk_answer_artifacts(
        goal_version=1,
        candidate_set_id="set-1",
        act=stock,
        records=[],
        snapshot_ids=[],
        plan=turn,
    )
    assert [item.facet for item in plan.obligations] == ["stock", "warranty"]
    assert all(item.status == "unknown" for item in plan.obligations)
    assert plan.required_facets == ["stock", "warranty"]
    assert plan.missing_facets == ["stock", "warranty"]


def test_rendered_answer_rejects_provider_id_leak():
    ledger = ClaimLedger(goal_version=1, candidate_set_id="set-1")
    with pytest.raises(ClaimVerificationError, match="leaked"):
        verify_rendered_answer(
            "Open product 71673752",
            ledger,
            forbidden_source_ids={"71673752"},
        )


def test_renderer_cannot_reference_claim_outside_ledger():
    ledger = ClaimLedger(
        goal_version=1,
        claims=[
            AnswerClaim(
                claim_id="s1:title",
                subject="s1",
                predicate="title",
                value="Sony Headphones",
                evidence_refs=[EvidenceRef(source="snapshot", path="title", value="Sony Headphones")],
            )
        ]
    )
    with pytest.raises(ClaimVerificationError, match="outside ledger"):
        verify_rendered_answer(
            "unsupported",
            ledger,
            rendered_claim_ids={"s1:made_up"},
        )


def test_renderer_consumes_only_verified_ledger_claims():
    records = [
        {
            "snapshot_id": "snap-1",
            "title": "Sony Headphones",
            "merchant": "shop",
            "market": "US",
            "estimated_cny": {"amount": 2100},
            "in_stock": True,
            "stock_source": "top_level",
        }
    ]
    ledger = build_candidate_claim_ledger("set-1", records, goal_version=1)
    plan = build_recommendation_answer_plan("set-1", records, goal_version=1)
    rendered = render_answer_from_ledger(plan, ledger)
    verify_rendered_answer(
        rendered.text,
        ledger,
        rendered_claim_ids=rendered.claim_ids,
    )
    assert rendered.claim_ids <= {claim.claim_id for claim in ledger.claims}
    assert "2100" in rendered.text


def test_renderer_rejects_cross_goal_artifacts() -> None:
    plan = AnswerPlan(goal_version=2, scope_candidate_set_id="set-1")
    ledger = ClaimLedger(goal_version=1, candidate_set_id="set-1")
    with pytest.raises(ValueError, match="goal versions differ"):
        render_answer_from_ledger(plan, ledger)


def test_decision_bundle_rejects_cross_candidate_set_artifacts() -> None:
    plan = AnswerPlan(goal_version=1, scope_candidate_set_id="set-a")
    ledger = ClaimLedger(goal_version=1, candidate_set_id="set-b")
    with pytest.raises(ValueError, match="candidate set"):
        DecisionBundle(
            goal_version=1,
            candidate_set_id="set-a",
            answer_plan=plan,
            claim_ledger=ledger,
            rendered_text="",
        )


def test_recommendation_card_copy_consumes_only_ledger_claims():
    records = [
        {
            "snapshot_id": "snap-1",
            "title": "Sony Headphones",
            "merchant": "shop",
            "market": "US",
            "estimated_cny": {"amount": 2100},
            "in_stock": None,
        }
    ]
    ledger = build_candidate_claim_ledger("set-1", records, goal_version=1)

    rendered = render_recommendation_copy("snap-1", ledger, budget_cny=4000)

    verify_rendered_answer(
        rendered.rationale + rendered.tradeoff,
        ledger,
        rendered_claim_ids=rendered.claim_ids,
    )
    assert rendered.claim_ids <= {claim.claim_id for claim in ledger.claims}
    assert "¥2100" in rendered.rationale
    assert "实时库存" in rendered.tradeoff
