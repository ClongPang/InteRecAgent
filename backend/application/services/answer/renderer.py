from __future__ import annotations

from dataclasses import dataclass

from ...dto.answer import AnswerPlan, ClaimLedger


@dataclass(frozen=True)
class RenderedAnswer:
    text: str
    claim_ids: frozenset[str]


@dataclass(frozen=True)
class RenderedRecommendationCopy:
    rationale: str
    tradeoff: str
    claim_ids: frozenset[str]


def render_recommendation_copy(
    primary_snapshot_id: str,
    ledger: ClaimLedger,
    *,
    budget_cny: float | None,
) -> RenderedRecommendationCopy:
    """Render the recommendation card without consuming model-authored facts."""
    facts = {
        claim.predicate: claim
        for claim in ledger.claims
        if claim.subject == primary_snapshot_id
    }
    used: set[str] = set()
    title = facts.get("title")
    eligibility = facts.get("eligibility")
    estimated = facts.get("estimated_cny")
    if title is not None:
        used.add(title.claim_id)
    if eligibility is not None:
        used.add(eligibility.claim_id)

    if estimated is not None and estimated.value is not None:
        amount = float(estimated.value)
        used.add(estimated.claim_id)
        rationale = f"商品价估算约 ¥{amount:.0f}，已通过当前硬约束资格门。"
        if budget_cny is not None and amount <= budget_cny:
            rationale = (
                f"商品价估算约 ¥{amount:.0f}，在你的 ¥{budget_cny:.0f} "
                "商品价预算内，并已通过当前硬约束资格门。"
            )
    else:
        rationale = "该商品已通过当前硬约束资格门，作为本轮首选。"

    return RenderedRecommendationCopy(
        rationale=rationale,
        tradeoff="购买前请在商户页复核实时库存、规格、运费与税费。",
        claim_ids=frozenset(used),
    )


def render_answer_from_ledger(plan: AnswerPlan, ledger: ClaimLedger) -> RenderedAnswer:
    """Deterministic renderer: every external fact is read from ClaimLedger."""
    if plan.goal_version != ledger.goal_version:
        raise ValueError("answer plan and claim ledger goal versions differ")
    if plan.scope_candidate_set_id != ledger.candidate_set_id:
        raise ValueError("answer plan and claim ledger candidate sets differ")
    by_subject: dict[str, dict[str, object]] = {}
    claim_ids: set[str] = set()
    for claim in ledger.claims:
        by_subject.setdefault(claim.subject, {})[claim.predicate] = claim.value

    facet = plan.obligations[0].facet if plan.obligations else "recommendation"
    if facet == "warranty":
        return RenderedAnswer("现有商品快照没有保修或售后政策证据，暂时无法确认。", frozenset())

    if facet == "stock":
        lines: list[str] = []
        for subject, facts in by_subject.items():
            if subject in {"set", "mission"}:
                continue
            title = facts.get("title")
            stock = facts.get("in_stock")
            title_claim = f"{subject}:title"
            stock_claim = f"{subject}:in_stock"
            if title is not None:
                claim_ids.add(title_claim)
            if stock is True:
                lines.append(f"{title or '该商品'}：快照记录为有货，仍请在商户页确认实时库存。")
                claim_ids.add(stock_claim)
            elif stock is False:
                lines.append(f"{title or '该商品'}：快照记录为无货。")
                claim_ids.add(stock_claim)
            else:
                lines.append(f"{title or '该商品'}：当前没有可验证的库存证据。")
        return RenderedAnswer("\n".join(lines) or "当前没有可验证的库存证据。", frozenset(claim_ids))

    set_claims = [claim for claim in ledger.claims if claim.subject == "set"]
    if set_claims:
        claim = set_claims[0]
        return RenderedAnswer(
            f"按当前已验证候选集，共有 {claim.value} 件匹配。",
            frozenset({claim.claim_id}),
        )

    lines = []
    rank = 0
    for subject, facts in by_subject.items():
        if subject in {"set", "mission"}:
            continue
        rank += 1
        title = facts.get("title")
        if title is None:
            continue
        claim_ids.add(f"{subject}:title")
        parts = [str(title)]
        if facts.get("estimated_cny") is not None:
            parts.append(f"估算约 ¥{float(str(facts['estimated_cny'])):.0f}")
            claim_ids.add(f"{subject}:estimated_cny")
        if facts.get("merchant") is not None:
            parts.append(f"商户 {facts['merchant']}")
            claim_ids.add(f"{subject}:merchant")
        if facts.get("market") is not None:
            parts.append(f"市场 {facts['market']}")
            claim_ids.add(f"{subject}:market")
        if facts.get("in_stock") is True:
            parts.append("快照有货")
            claim_ids.add(f"{subject}:in_stock")
        elif facts.get("in_stock") is False:
            parts.append("快照无货")
            claim_ids.add(f"{subject}:in_stock")
        lines.append(f"{rank}. " + "；".join(parts))

    if not lines:
        return RenderedAnswer(
            "当前没有满足已确认硬约束且证据充分的商品；我不会用未知或不合格商品补位。",
            frozenset(),
        )
    prefix = "基于当前已验证证据：" if facet != "recommendation" else "当前可推荐："
    return RenderedAnswer(prefix + "\n" + "\n".join(lines), frozenset(claim_ids))
