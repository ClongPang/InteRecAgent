from __future__ import annotations

from ...dto.answer import (
    AnswerClaim,
    AnswerObligation,
    AnswerPlan,
    ClaimLedger,
    ObligationStatus,
)
from ...dto.dialogue import DialogueAct, DialogueActKind, TurnPlan
from ...dto.qualification import EvidenceRef


def build_candidate_claim_ledger(
    candidate_set_id: str,
    ranked_records: list[dict],
    *,
    goal_version: int,
) -> ClaimLedger:
    claims: list[AnswerClaim] = []
    for record in ranked_records:
        snapshot_id = str(record["snapshot_id"])
        claims.append(
            AnswerClaim(
                claim_id=f"{snapshot_id}:eligibility",
                subject=snapshot_id,
                predicate="eligibility",
                value="eligible",
                evidence_refs=[
                    EvidenceRef(
                        snapshot_id=snapshot_id,
                        source="candidate_set",
                        path="ranked",
                        json_path="ranked",
                        observed_at=record.get("observed_at"),
                        value="eligible",
                        evidence_level="derived",
                        derivation_version="qualification-v2",
                    )
                ],
            )
        )
        for predicate, path, value in (
            ("title", "normalized.title", record.get("title")),
            ("merchant", "normalized.merchant", record.get("merchant")),
            ("market", "normalized.country_code", record.get("market")),
            ("merchant_url", "normalized.merchant_url", record.get("merchant_url")),
            ("image_url", "normalized.image_url", record.get("image_url")),
            ("brand", "normalized.attrs.brand", record.get("brand")),
            ("source_updated_at", "normalized.updated_at", record.get("source_updated_at")),
        ):
            if value is not None:
                claims.append(
                    AnswerClaim(
                        claim_id=f"{snapshot_id}:{predicate}",
                        subject=snapshot_id,
                        predicate=predicate,
                        value=value,
                        evidence_refs=[
                            EvidenceRef(
                                snapshot_id=snapshot_id,
                                source="product_snapshot",
                                path=path,
                                json_path=path,
                                observed_at=record.get("observed_at"),
                                value=value,
                            )
                        ],
                    )
                )
        native = record.get("native_price")
        if isinstance(native, dict):
            for predicate, value in (
                ("native_price_amount", native.get("amount")),
                ("native_price_currency", native.get("currency")),
            ):
                if value is None:
                    continue
                claims.append(
                    AnswerClaim(
                        claim_id=f"{snapshot_id}:{predicate}",
                        subject=snapshot_id,
                        predicate=predicate,
                        value=value,
                        evidence_refs=[
                            EvidenceRef(
                                snapshot_id=snapshot_id,
                                source="product_snapshot",
                                path=f"normalized.{predicate}",
                                json_path=f"normalized.{predicate}",
                                value=value,
                            )
                        ],
                    )
                )
        estimated = record.get("estimated_cny")
        if isinstance(estimated, dict) and estimated.get("amount") is not None:
            claims.append(
                AnswerClaim(
                    claim_id=f"{snapshot_id}:estimated_cny",
                    subject=snapshot_id,
                    predicate="estimated_cny",
                    value=estimated["amount"],
                    evidence_refs=[
                        EvidenceRef(
                            snapshot_id=snapshot_id,
                            source="candidate_set",
                            path="estimated_cny.amount",
                            json_path="estimated_cny.amount",
                            observed_at=record.get("observed_at"),
                            value=estimated["amount"],
                            evidence_level="derived",
                            derivation_version="fx-v1",
                        )
                    ],
                )
            )
        if record.get("in_stock") is not None:
            claims.append(
                AnswerClaim(
                    claim_id=f"{snapshot_id}:in_stock",
                    subject=snapshot_id,
                    predicate="in_stock",
                    value=bool(record["in_stock"]),
                    polarity="positive" if bool(record["in_stock"]) else "negative",
                    evidence_refs=[
                        EvidenceRef(
                            snapshot_id=snapshot_id,
                            source="buywhere",
                            path="availability.in_stock",
                            json_path="availability.in_stock",
                            observed_at=record.get("observed_at"),
                            value=bool(record["in_stock"]),
                            evidence_level=str(record.get("stock_source") or "unknown"),
                        )
                    ],
                )
            )
    return ClaimLedger(
        goal_version=goal_version,
        candidate_set_id=candidate_set_id,
        claims=claims,
    )


def build_recommendation_answer_plan(
    candidate_set_id: str,
    ranked_records: list[dict],
    *,
    goal_version: int,
) -> AnswerPlan:
    status = ObligationStatus.ANSWERED if ranked_records else ObligationStatus.UNKNOWN
    return AnswerPlan(
        goal_version=goal_version,
        question_intents=["recommend_products"],
        obligations=[AnswerObligation(facet="recommendation", status=status)],
        scope_candidate_set_id=candidate_set_id,
        missing_facets=[] if ranked_records else ["eligible_candidates"],
        proposed_next_action=None if ranked_records else "relax_or_research",
    )


def build_talk_answer_artifacts(
    *,
    goal_version: int,
    candidate_set_id: str | None,
    act: DialogueAct,
    records: list[dict],
    snapshot_ids: list[str],
    plan: TurnPlan | None = None,
) -> tuple[AnswerPlan, ClaimLedger]:
    selected = [
        record for record in records if str(record.get("snapshot_id")) in set(snapshot_ids)
    ]
    ledger = build_candidate_claim_ledger(
        candidate_set_id or "",
        selected,
        goal_version=goal_version,
    )
    acts = plan.talk_ops() if plan is not None and plan.talk_ops() else [act]
    obligations: list[AnswerObligation] = []
    question_intents: list[str] = []
    required_facets: list[str] = []
    missing_facets: list[str] = []
    for operation in acts:
        facet = operation.topic.value if operation.topic else operation.kind.value
        status = ObligationStatus.ANSWERED
        if facet == "warranty":
            status = ObligationStatus.UNKNOWN
        elif facet == "stock" and not any(
            claim.predicate == "in_stock" for claim in ledger.claims
        ):
            status = ObligationStatus.UNKNOWN
        if operation.kind == DialogueActKind.ASK_SET:
            predicate = operation.predicate.attr if operation.predicate else "set_membership"
            facet = predicate
            ledger.claims.append(
                AnswerClaim(
                    claim_id=f"set:{predicate}:count",
                    subject="set",
                    predicate=f"{predicate}_match_count",
                    value=len(snapshot_ids),
                    evidence_refs=[
                        EvidenceRef(
                            source="candidate_set",
                            path="displayed_snapshot_ids",
                            value=len(snapshot_ids),
                        )
                    ],
                )
            )
        if operation.kind == DialogueActKind.COMPARE:
            facet = "comparison"
        question_intents.append(operation.kind.value)
        required_facets.append(facet)
        obligations.append(AnswerObligation(facet=facet, status=status))
        if status == ObligationStatus.UNKNOWN:
            missing_facets.append(facet)
    answer_plan = AnswerPlan(
        goal_version=goal_version,
        question_intents=list(dict.fromkeys(question_intents)),
        obligations=obligations,
        scope_candidate_set_id=candidate_set_id,
        required_facets=list(dict.fromkeys(required_facets)),
        missing_facets=list(dict.fromkeys(missing_facets)),
        proposed_next_action=(
            "request_provider_evidence" if missing_facets else None
        ),
    )
    return answer_plan, ledger
