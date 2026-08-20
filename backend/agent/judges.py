"""研究环里三次单次 JSON：本轮 keep、改写 query、从池子选 TopK。

失败返回「未决定」，由控制器跳过或回退确定性步骤。输出必须和已有 ID / 已用过的
检索词求交，模型不能发明商品或改预算。
"""
from __future__ import annotations

import json
import logging
from dataclasses import dataclass
from typing import Any

from ..application.errors import ModelUnavailableError
from ..application.ports import ModelBackend
from ..application.services.rec.rank import rank_with_belief
from ..application.services.rec.state import rec_state_from_mission
from ..domain.models import NormalizedProduct
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

_TOPK_SYSTEM = """你是候选比较器。只输出一个 JSON 对象，不要解释。
字段：ranked，按推荐优先级排列的 ID 数组，长度最多为 k。
规则：
- 只能从 candidates 的 id 里选。
- 优先主体商品、更贴近预算与偏好的项。
- 不得编造 ID，不得编造价格或库存。"""


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


async def _ask(backend: ModelBackend, *, system: str, user: str) -> JsonDecision:
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
    """成功则返回 keep ID（可空）；失败返回 None，本轮规则结果全部保留。"""
    if not batch:
        return []
    visible = preselect_for_judge(ctx, batch)
    decision = await _ask(
        backend,
        system=_KEEP_SYSTEM,
        user=json.dumps(
            {
                "task": "keep",
                "query": ctx.mission.constraints.query,
                "use_case": getattr(ctx.mission.belief, "use_case", None),
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


async def rewrite_query(backend: ModelBackend, ctx: ResearchContext) -> JsonDecision:
    sample = [_brief(item) for item in ctx.pool[:8]]
    return await _ask(
        backend,
        system=_REWRITE_SYSTEM,
        user=json.dumps(
            {
                "task": "rewrite",
                "query": ctx.current_query,
                "intent_query": ctx.mission.constraints.query,
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


async def select_topk(backend: ModelBackend, ctx: ResearchContext) -> list[str] | None:
    if not ctx.pool:
        return []
    decision = await _ask(
        backend,
        system=_TOPK_SYSTEM,
        user=json.dumps(
            {
                "task": "select_topk",
                "k": ctx.limits.top_k,
                "query": ctx.mission.constraints.query,
                "budget_cny": ctx.mission.constraints.budget_cny,
                "preference": ctx.mission.constraints.preference,
                "use_case": getattr(ctx.mission.belief, "use_case", None),
                "candidates": [_brief(item) for item in ctx.pool],
            },
            ensure_ascii=False,
        ),
    )
    if not decision.decided:
        return None
    raw = decision.payload.get("ranked")
    if not isinstance(raw, list):
        return None
    return [str(item).strip() for item in raw if str(item).strip()]
