"""研究环里的受控 JSON 决策：本轮语义 keep 与 query 改写。

失败返回「未决定」，由控制器跳过或回退确定性步骤。输出必须和已有 ID / 已用过的
检索词求交，模型不能发明商品或改预算；最终排序由代码完成。
"""

from __future__ import annotations

import json
import logging
from dataclasses import dataclass
from typing import Any

from ..application.dto import EvidenceRef, ProductSemanticProfile, SemanticProfileMethod
from ..application.errors import ModelUnavailableError
from ..application.ports import ModelBackend
from ..application.services.rec.rank import rank_with_belief
from ..application.services.rec.semantic import (
    SEMANTIC_MODEL_SHADOW_VERSION,
    adjudicate_profile,
    build_rule_profile,
)
from ..application.services.rec.state import rec_state_from_mission
from ..domain.models import NormalizedProduct
from ..domain.product_ontology import DETECTED_ITEM_TYPES
from .tools.context import ResearchContext

logger = logging.getLogger(__name__)

_KEEP_SYSTEM = """你是跨境选物的相关性法官。只输出一个 JSON 对象，不要解释。
字段：keep，字符串 ID 数组。
规则：
- 只能从输入 candidates 的 id 里勾选本轮要留下的商品。
- 配件、错品类、明显不是用户要买的主体，不要放进 keep。
- 标题是型号名、但形态对得上（如耳机型号、显示器型号）可以 keep。
- 不得编造 ID，不得改预算或库存。"""

_REWRITE_SYSTEM = """你是检索词改写器。只输出一个 JSON 对象，不要解释。
字段：query，新的检索词字符串；无法写出更好的词时为 null。
规则：
- 必须服务同一购买意图，不要换品类。
- 不要重复 previous_queries 或当前 query。
- 可以换成英文型号、同义词、更具体的形态词。
- 不要写预算、市场或整句说明。"""

_SEMANTIC_PROFILE_SYSTEM = """你是商品 listing 语义分类器。只输出一个 JSON 对象。
字段 profiles：数组；每项包含 id, item_type, relation, brand, model, confidence,
evidence_spans。relation 只能是 product/accessory/bundle/service/consumable/
replacement/unknown。只能使用输入 listing 的原文片段作为 evidence_spans；不能生成规格、
库存、保修或其他输入中不存在的事实。不确定时 item_type 为 null、relation 为 unknown。"""


@dataclass(frozen=True)
class JsonDecision:
    """模型一次结构化决定。decided=False 表示失败，应回退。"""

    decided: bool
    payload: dict[str, Any]


def _brief(product: NormalizedProduct) -> dict[str, Any]:
    return {
        "id": product.id,
        "title": product.title,
        "merchant": product.merchant,
        "market": product.country_code,
        "rmb_price": product.rmb_price,
        "in_stock": product.in_stock,
    }


def preselect_for_judge(
    ctx: ResearchContext, products: list[NormalizedProduct]
) -> list[NormalizedProduct]:
    limit = ctx.limits.max_judge_batch
    if len(products) <= limit:
        return products
    ranked = rank_with_belief(products, rec_state_from_mission(ctx.mission))
    return ranked[:limit]


async def _ask(
    backend: ModelBackend, ctx: ResearchContext, *, system: str, user: str
) -> JsonDecision:
    if not ctx.reserve_model_call(system=system, user=user):
        ctx.add_warnings("模型调用或 Token 预算已用尽，回退确定性策略")
        return JsonDecision(False, {})
    try:
        payload = await backend.complete_json(system=system, user=user)
    except ModelUnavailableError:
        logger.info("research json step unavailable")
        return JsonDecision(False, {})
    except Exception:  # noqa: BLE001 - 单步失败不得炸掉整趟研究
        logger.exception("research json step failed")
        return JsonDecision(False, {})
    if not isinstance(payload, dict):
        return JsonDecision(False, {})
    return JsonDecision(True, payload)


async def judge_keep(
    backend: ModelBackend, ctx: ResearchContext, batch: list[NormalizedProduct]
) -> list[str] | None:
    """成功则返回 keep ID（可空）；失败返回 None，本轮不并入。"""
    if not batch:
        return []
    visible = preselect_for_judge(ctx, batch)
    rec = rec_state_from_mission(ctx.mission)
    decision = await _ask(
        backend,
        ctx,
        system=_KEEP_SYSTEM,
        user=json.dumps(
            {
                "task": "keep",
                "query": rec.query,
                "use_case": rec.use_case,
                "candidates": [_brief(item) for item in visible],
            },
            ensure_ascii=False,
        ),
    )
    if not decision.decided:
        return None
    raw = decision.payload.get("keep")
    if not isinstance(raw, list):
        return None
    return [str(item).strip() for item in raw if str(item).strip()]


async def shadow_semantic_profiles(
    backend: ModelBackend,
    ctx: ResearchContext,
    products: list[NormalizedProduct],
) -> None:
    """Record bounded model proposals and deterministic adjudication without enforcement."""
    if not products:
        return
    visible = preselect_for_judge(ctx, products)
    stats = ctx.semantic_shadow_stats
    stats["attempted_count"] += len(visible)
    decision = await _ask(
        backend,
        ctx,
        system=_SEMANTIC_PROFILE_SYSTEM,
        user=json.dumps(
            {
                "task": "semantic_profile_shadow",
                "listings": [
                    {
                        "id": item.id,
                        "title": item.title,
                        "metadata": {
                            key: value
                            for key, value in (item.attrs or {}).items()
                            if key in {"category", "product_type", "tags", "brand", "model"}
                        },
                    }
                    for item in visible
                ],
            },
            ensure_ascii=False,
        ),
    )
    if not decision.decided or not isinstance(decision.payload.get("profiles"), list):
        stats["invalid_proposal_count"] += len(visible)
        return
    by_id = {item.id: item for item in visible}
    valid_relations = {
        "product",
        "accessory",
        "bundle",
        "service",
        "consumable",
        "replacement",
        "unknown",
    }
    seen_ids: set[str] = set()
    for raw in decision.payload["profiles"]:
        if not isinstance(raw, dict):
            stats["invalid_proposal_count"] += 1
            continue
        candidate_id = str(raw.get("id") or "")
        product = by_id.get(candidate_id)
        if product is None or candidate_id in seen_ids:
            stats["invalid_proposal_count"] += 1
            continue
        seen_ids.add(candidate_id)
        invalid_schema = False
        item_type = raw.get("item_type")
        if item_type is not None and str(item_type) not in DETECTED_ITEM_TYPES:
            item_type = None
            invalid_schema = True
        relation = str(raw.get("relation") or "unknown")
        if relation not in valid_relations:
            relation = "unknown"
            invalid_schema = True
        evidence_payload = raw.get("evidence_spans") or []
        if not isinstance(evidence_payload, list):
            evidence_payload = []
            invalid_schema = True
        raw_spans = [str(span).strip() for span in evidence_payload]
        spans = [
            str(span).strip()
            for span in raw_spans
            if str(span).strip()
            and str(span).strip().casefold() in (product.title or "").casefold()
        ][:8]
        stats["raw_evidence_span_count"] += len(raw_spans)
        stats["valid_evidence_span_count"] += len(spans)
        try:
            confidence = min(1.0, max(0.0, float(raw.get("confidence") or 0.0)))
        except (TypeError, ValueError):
            confidence = 0.0
            invalid_schema = True
        if invalid_schema:
            stats["invalid_proposal_count"] += 1
        proposal = ProductSemanticProfile(
            category_id=str(item_type) if item_type else None,
            item_type=str(item_type) if item_type else None,
            relation=relation,
            brand=str(raw["brand"]).strip() if raw.get("brand") else None,
            model=str(raw["model"]).strip() if raw.get("model") else None,
            method=SemanticProfileMethod.MODEL,
            confidence=confidence,
            evidence_spans=spans,
            evidence_refs=[
                EvidenceRef(
                    source="normalized",
                    path="normalized.title",
                    value=span,
                    evidence_level="observed",
                )
                for span in spans
            ],
            classifier_version=SEMANTIC_MODEL_SHADOW_VERSION,
        )
        guard = build_rule_profile(product)
        adjudicated = adjudicate_profile(guard, proposal)
        ctx.semantic_profile_proposals[candidate_id] = proposal.model_dump(mode="json")
        stats["proposal_count"] += 1
        ctx.semantic_profile_shadow[candidate_id] = {
            "observed_text": product.title,
            "guard": guard.model_dump(mode="json"),
            "adjudicated": adjudicated.model_dump(mode="json"),
            "would_change_active_profile": adjudicated != guard,
        }
    stats["invalid_proposal_count"] += len(set(by_id) - seen_ids)


async def rewrite_query(backend: ModelBackend, ctx: ResearchContext) -> JsonDecision:
    sample = [_brief(item) for item in ctx.pool[:8]]
    rec = rec_state_from_mission(ctx.mission)
    return await _ask(
        backend,
        ctx,
        system=_REWRITE_SYSTEM,
        user=json.dumps(
            {
                "task": "rewrite",
                "query": ctx.current_query,
                "intent_query": rec.query,
                "previous_queries": [ctx.plan.query, *ctx.rewritten_queries],
                "pool_size": len(ctx.pool),
                "pool_sample": sample,
            },
            ensure_ascii=False,
        ),
    )


def parse_rewrite(decision: JsonDecision, ctx: ResearchContext) -> str | None:
    if not decision.decided:
        return None
    raw = decision.payload.get("query")
    if raw is None:
        return None
    query = str(raw).strip()[:200]
    if not query or query == ctx.current_query or query in ctx.rewritten_queries:
        return None
    return query
