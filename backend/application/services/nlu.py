"""对话 NLU：分类、指代、约束预览。路由决策在 policy / route。"""
from __future__ import annotations

import re

from ..dto.dialogue import AskTopic, DialogueAct, DialogueActKind
from ..dto.mission import MissionConstraints
from ..dto.runner import IntentPatch
from .parse_intent import CLARIFYING_QUESTION, parse_intent

_UNDO = re.compile(r"撤销|还原刚才|刚才的条件|undo", re.I)
_META = re.compile(r"你能做什么|你会什么|你是谁|怎么用")
_COMPARE = re.compile(r"比较|对比|横评|比一比|比一下|帮我比")
_ASK = re.compile(r"保修|质保|售后|退货|为什么推荐|为什么选|推荐理由|差在哪|怎么样|有货吗|库存|这款|这一款|这个呢")
_ASK_WARRANTY = re.compile(r"保修|质保|售后|退货|退换")
_ASK_STOCK = re.compile(r"有货|库存|缺货|现货")
_ASK_WHY = re.compile(r"为什么推荐|为什么选|为何选|推荐理由")
_ASK_TRADEOFF = re.compile(r"差在哪|哪款好|有什么区别")
_REJECT = re.compile(r"(?:不要|别买|排除)\s*([^\s，,。；;]+)")
_STANCE_EXPENSIVE = re.compile(r"太贵|好贵|贵了|超出预算")
_STANCE_CHEAPER = re.compile(r"再便宜|便宜点|更便宜|降低预算|收一[点下]预算")
_STANCE_LIGHTER = re.compile(r"更轻|轻一点|轻便一点|太重")
_RANK_FIRST = re.compile(r"第[一1]件|第一个|首选")
_RANK_SECOND = re.compile(r"第[二2]件|第二个")
_RANK_TOP2 = re.compile(r"前两[个件]|这两[个件]")
_REF_SONY = re.compile(r"那个索尼|索尼的?(?:那|这)?[个款]|that sony", re.I)
_REF_BOSE = re.compile(r"那个bose|bose的?(?:那|这)?[个款]", re.I)
_REF_CHEAP = re.compile(r"便宜那个|便宜的那|最便宜")
_REF_FOCUS = re.compile(r"刚才那个|刚才的|刚刚那")
_NOT_INEAR = re.compile(r"不是入耳|不要入耳|不要耳塞")
_WANT_OVEREAR = re.compile(r"是头戴|要头戴|头戴式")


def build_turn_context(
    events: list[dict] | None,
    mission,
    cache_payload: dict | None = None,
) -> dict:
    """从事件切最近原话，给分类/指代，不进生成回复。"""
    dialogue = getattr(mission, "dialogue", None)
    belief = getattr(mission, "belief", None)
    users: list[str] = []
    last_act = getattr(dialogue, "last_act", None)
    last_topic = None
    mentioned = list(getattr(dialogue, "mentioned_snapshot_ids", None) or [])
    for event in events or []:
        payload = event.get("payload") if isinstance(event, dict) else {}
        payload = payload if isinstance(payload, dict) else {}
        kind = event.get("event_type") if isinstance(event, dict) else None
        if kind == "message.received" and payload.get("text"):
            users.append(str(payload["text"]))
            last_act = payload.get("act") or last_act
            last_topic = payload.get("topic") or last_topic
        if kind == "agent.message":
            last_act = payload.get("act") or last_act
            last_topic = payload.get("topic") or last_topic
            cited = [
                str(item["snapshot_id"])
                for item in list(payload.get("citations") or [])
                if isinstance(item, dict) and item.get("snapshot_id")
            ]
            if not cited:
                cited = [str(item) for item in list(payload.get("snapshot_ids") or []) if item]
            if cited:
                mentioned = cited
    ranked = []
    for item in list((cache_payload or {}).get("ranked") or [])[:4]:
        if not isinstance(item, dict):
            continue
        estimated = item.get("estimated_cny") if isinstance(item.get("estimated_cny"), dict) else {}
        ranked.append(
            {
                "snapshot_id": item.get("snapshot_id"),
                "title": item.get("title"),
                "estimated_cny": estimated.get("amount") if estimated else item.get("estimated_cny"),
            }
        )
    return {
        "recent_user_texts": users[-3:],
        "last_act": last_act,
        "last_topic": last_topic,
        "focus_snapshot_id": getattr(dialogue, "focus_snapshot_id", None),
        "mentioned_snapshot_ids": mentioned[:4],
        "belief": belief.model_dump(mode="json") if belief is not None else {},
        "ranked": ranked,
    }


def search_reuse_key(constraints: MissionConstraints) -> dict:
    """候选能否复用只取决于检索输入，不含预算/偏好/排除。"""
    return {
        "query": constraints.query or "",
        "markets": list(constraints.markets),
    }


def reuse_key_matches(constraints: MissionConstraints, cached: dict | None) -> bool:
    if not cached:
        return False
    return search_reuse_key(constraints) == {
        "query": cached.get("query") or "",
        "markets": list(cached.get("markets") or []),
    }


def classify_turn(
    text: str,
    *,
    current_query: str | None = None,
    context: dict | None = None,
) -> DialogueAct:
    """先识别对话行为，再填约束增量。残句与态度不得覆盖 query。"""
    raw = (text or "").strip()
    context = context or {}
    if not raw:
        return DialogueAct(
            kind=DialogueActKind.UNKNOWN,
            patch=IntentPatch(
                requires_clarification=True,
                clarification_question=CLARIFYING_QUESTION,
            ),
        )
    if _UNDO.search(raw):
        return DialogueAct(kind=DialogueActKind.UNDO)
    if _META.search(raw):
        return DialogueAct(kind=DialogueActKind.META)
    if _COMPARE.search(raw):
        return DialogueAct(kind=DialogueActKind.COMPARE, referent_ranks=_referent_ranks(raw, default=(1, 2)))
    rejected = _REJECT.search(raw)
    if rejected:
        term = rejected.group(1).strip("的了呢啊")
        if term in {"这款", "这一款", "这个", "它"}:
            return DialogueAct(
                kind=DialogueActKind.REJECT,
                referent_ranks=_referent_ranks(raw, default=(1,)),
            )
        if term:
            return DialogueAct(kind=DialogueActKind.REJECT, exclude_terms=[term])
    if _ASK.search(raw):
        return DialogueAct(
            kind=DialogueActKind.ASK_ITEM,
            referent_ranks=_referent_ranks(raw, default=(1,)),
            topic=detect_ask_topic(raw),
        )
    stance = _detect_stance(raw)
    if stance:
        patch = parse_intent(raw, current_query=current_query)
        patch = _stance_patch(patch)
        return DialogueAct(kind=DialogueActKind.STANCE, patch=patch, stance=stance)
    if current_query and _NOT_INEAR.search(raw):
        return DialogueAct(
            kind=DialogueActKind.REFINE,
            patch=IntentPatch(query=current_query, exclude_terms=["入耳", "耳塞"]),
        )
    if current_query and _WANT_OVEREAR.search(raw):
        query = current_query if "头戴" in current_query else f"{current_query} 头戴"
        return DialogueAct(kind=DialogueActKind.REFINE, patch=IntentPatch(query=query))
    patch = parse_intent(raw, current_query=current_query)
    kind = DialogueActKind.UNKNOWN if patch.requires_clarification else DialogueActKind.REFINE
    return DialogueAct(kind=kind, patch=patch)


def detect_ask_topic(text: str) -> AskTopic:
    if _ASK_WARRANTY.search(text):
        return AskTopic.WARRANTY
    if _ASK_STOCK.search(text):
        return AskTopic.STOCK
    if _ASK_WHY.search(text):
        return AskTopic.WHY
    if _ASK_TRADEOFF.search(text):
        return AskTopic.TRADEOFF
    return AskTopic.OVERVIEW


def detect_referent_hint(text: str) -> str | None:
    if _REF_FOCUS.search(text):
        return "focus"
    if _REF_CHEAP.search(text):
        return "cheapest"
    if _REF_SONY.search(text):
        return "brand:sony"
    if _REF_BOSE.search(text):
        return "brand:bose"
    return None


def resolve_referent_ids(
    text: str,
    ranked: list[dict],
    *,
    focus_snapshot_id: str | None = None,
    mentioned_snapshot_ids: list[str] | None = None,
) -> list[str]:
    hint = detect_referent_hint(text)
    if not hint:
        return []
    if hint == "focus":
        sid = focus_snapshot_id or ((mentioned_snapshot_ids or [None])[0])
        return [sid] if sid else []
    if not ranked:
        return []
    if hint == "cheapest":
        priced = []
        for item in ranked:
            estimated = item.get("estimated_cny") if isinstance(item.get("estimated_cny"), dict) else {}
            amount = estimated.get("amount")
            sid = item.get("snapshot_id")
            if sid is not None and amount is not None:
                priced.append((float(amount), str(sid)))
        if priced:
            priced.sort(key=lambda pair: pair[0])
            return [priced[0][1]]
        return []
    if hint.startswith("brand:"):
        brand = hint.split(":", 1)[1]
        for item in ranked:
            blob = f"{item.get('title') or ''} {item.get('brand') or ''}".lower()
            if brand in blob:
                sid = item.get("snapshot_id")
                if sid:
                    return [str(sid)]
    return []


def snapshot_ids_for_ranks(ranked_records: list[dict], ranks: list[int]) -> list[str]:
    ids = [str(item["snapshot_id"]) for item in ranked_records if item.get("snapshot_id")]
    out: list[str] = []
    for rank in ranks:
        if 1 <= rank <= len(ids):
            sid = ids[rank - 1]
            if sid not in out:
                out.append(sid)
    return out


def apply_stance_budget(act: DialogueAct, constraints: MissionConstraints) -> DialogueAct:
    """保留兼容入口。态度不再改硬预算，只原样返回。"""
    del constraints
    return act


def preview_merged_constraints(constraints: MissionConstraints, act: DialogueAct) -> MissionConstraints:
    """命令层预览合并结果，与 merge_mission_state 对齐，但不写库。"""
    if act.kind in {
        DialogueActKind.ASK_ITEM,
        DialogueActKind.COMPARE,
        DialogueActKind.META,
        DialogueActKind.UNDO,
    }:
        return constraints
    if act.kind == DialogueActKind.STANCE:
        patch = act.patch or IntentPatch()
        if patch.budget_cny is None:
            return constraints
        return constraints.model_copy(update={"budget_cny": patch.budget_cny})
    patch = act.patch or IntentPatch()
    if patch.requires_clarification and not constraints.query:
        return constraints
    excluded = list(constraints.excluded_terms)
    for term in list(patch.exclude_terms or []) + list(act.exclude_terms):
        if term and term not in excluded:
            excluded.append(term)
    return MissionConstraints(
        query=patch.query or constraints.query,
        budget_cny=patch.budget_cny if patch.budget_cny is not None else constraints.budget_cny,
        markets=patch.markets or constraints.markets,
        preference=patch.preference or constraints.preference,
        only_in_stock=(
            patch.only_in_stock if patch.only_in_stock is not None else constraints.only_in_stock
        ),
        excluded_terms=excluded,
    )


def summarize_constraint_change(before: MissionConstraints, after: MissionConstraints) -> str:
    parts: list[str] = []
    if before.query != after.query:
        parts.append(f"商品：{after.query or '未指定'}")
    if before.budget_cny != after.budget_cny:
        parts.append(f"预算 {after.budget_cny:.0f} 元" if after.budget_cny is not None else "清除预算")
    if before.preference != after.preference:
        parts.append(f"排序：{after.preference}")
    if before.only_in_stock != after.only_in_stock:
        parts.append("仅看有货" if after.only_in_stock else "显示全部库存")
    if before.markets != after.markets:
        parts.append("市场：" + "、".join(after.markets))
    if before.excluded_terms != after.excluded_terms:
        parts.append("排除：" + "、".join(after.excluded_terms) if after.excluded_terms else "清除排除")
    return "已更新" + ("：" + "、".join(parts) if parts else "购物约束")


def _detect_stance(text: str) -> str | None:
    if _STANCE_EXPENSIVE.search(text):
        return "too_expensive"
    if _STANCE_CHEAPER.search(text):
        return "want_cheaper"
    if _STANCE_LIGHTER.search(text):
        return "want_lighter"
    return None


def _stance_patch(patch: IntentPatch) -> IntentPatch:
    return IntentPatch(
        query=None,
        budget_cny=patch.budget_cny,
        markets=patch.markets,
        preference=patch.preference,
        only_in_stock=None,
        price_stance=patch.price_stance,
        requires_clarification=False,
    )


def _referent_ranks(text: str, *, default: tuple[int, ...]) -> list[int]:
    if _RANK_TOP2.search(text):
        return [1, 2]
    ranks: list[int] = []
    if _RANK_FIRST.search(text) or re.search(r"这款|这一款|这个", text):
        ranks.append(1)
    if _RANK_SECOND.search(text):
        ranks.append(2)
    return ranks or list(default)
