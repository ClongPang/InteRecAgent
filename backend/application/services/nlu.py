"""对话 NLU：propose（句式）+ 世界绑定 + 约束预览。"""
from __future__ import annotations

from ..dto.dialogue import DialogueAct, DialogueActKind, SetPredicate
from ..dto.mission import MissionConstraints
from ..dto.runner import IntentPatch
from .frames import detect_ask_topic, detect_stance, parse_probe_needle, propose_act, referent_hint
from .model_context import turn_view
from .parse_intent import CLARIFYING_QUESTION, parse_intent
from .plan import propose_plan
from .world import World
from .working_set import WorkingSet


def build_turn_context(
    events: list[dict] | None,
    mission,
    cache_payload: dict | None = None,
) -> dict:
    """分类窗口：邻接对 + DST 摘要 + 比较集，不 dump 全量信念。"""
    return turn_view(mission, cache_payload, events).as_classify_payload()


def search_reuse_key(constraints: MissionConstraints) -> dict:
    """候选能否复用只取决于检索输入。

    预算进入原币 max_price，必须计入复用键：放宽预算时旧缓存会漏召回。
    仅看有货 / 排序偏好 / 排除词仍是过滤输入，不进本键。
    """
    return {
        "query": constraints.query or "",
        "markets": list(constraints.markets),
        "budget_cny": constraints.budget_cny,
    }


def reuse_key_matches(constraints: MissionConstraints, cached: dict | None) -> bool:
    if not cached:
        return False
    return search_reuse_key(constraints) == {
        "query": cached.get("query") or "",
        "markets": list(cached.get("markets") or []),
        "budget_cny": cached.get("budget_cny"),
    }


def classify_turn(
    text: str,
    *,
    current_query: str | None = None,
    context: dict | None = None,
) -> DialogueAct:
    """句式 propose，再补封闭约束槽。名词不在这里认。"""
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
    world = WorkingSet.from_cache({"ranked": list(context.get("ranked") or []), "pool": list(context.get("pool") or [])}).world()
    plan = propose_plan(raw, current_query=current_query, world=world)
    proposed = plan.primary
    if proposed.kind == DialogueActKind.STANCE:
        patch = _stance_patch(parse_intent(raw, current_query=current_query))
        return proposed.model_copy(update={"patch": patch})
    return proposed


_GROUNDABLE = {DialogueActKind.REFINE, DialogueActKind.UNKNOWN}
_SPEECH_ACTS = {
    DialogueActKind.COMPARE,
    DialogueActKind.ASK_ITEM,
    DialogueActKind.ASK_SET,
    DialogueActKind.REJECT,
    DialogueActKind.STANCE,
    DialogueActKind.UNDO,
    DialogueActKind.META,
}


def ground_dialogue_act(
    act: DialogueAct,
    text: str,
    *,
    current_query: str | None = None,
    ranked: list[dict] | None = None,
) -> DialogueAct:
    """只补封闭槽；kind 以句式为准，不用名词表盖模型。"""
    world = World.from_ranked(ranked)
    framed = propose_act(text, current_query=current_query, world=world)
    if act.kind in _GROUNDABLE and framed is not None and framed.kind in _SPEECH_ACTS:
        patch = framed.patch
        if act.patch and framed.kind == DialogueActKind.STANCE:
            patch = _stance_patch(act.patch)
        return act.model_copy(
            update={
                "kind": framed.kind,
                "stance": framed.stance or act.stance,
                "referent_ranks": framed.referent_ranks or act.referent_ranks,
                "exclude_terms": framed.exclude_terms or act.exclude_terms,
                "topic": framed.topic or act.topic,
                "predicate": framed.predicate or act.predicate,
                "patch": patch,
            }
        )
    if act.kind == DialogueActKind.STANCE and not act.stance:
        stance = detect_stance(text)
        if stance:
            return act.model_copy(
                update={"stance": stance, "patch": _stance_patch(act.patch or IntentPatch())}
            )
    if act.kind == DialogueActKind.ASK_ITEM:
        if framed is not None and framed.kind == DialogueActKind.ASK_SET:
            return framed
        patch = framed.patch if framed is not None else None
        if framed is not None and framed.kind == DialogueActKind.REFINE and patch is not None:
            if patch.only_in_stock or patch.budget_cny is not None or patch.query or patch.merchants:
                return framed
        fallback = parse_intent(text, current_query=current_query)
        if fallback.only_in_stock or fallback.merchants:
            return DialogueAct(kind=DialogueActKind.REFINE, patch=fallback)
    if act.kind == DialogueActKind.ASK_SET and act.predicate is None and framed is not None:
        if framed.predicate is not None:
            return act.model_copy(update={"predicate": framed.predicate})
        needle = parse_probe_needle(text)
        if needle:
            return act.model_copy(
                update={"predicate": SetPredicate(attr="merchant", values=[needle.lower()], label=needle)}
            )
    if act.kind not in _GROUNDABLE:
        return act
    fallback = parse_intent(text, current_query=current_query)
    patch = act.patch or IntentPatch()
    updates: dict = {}
    if not (patch.query or "").strip() and fallback.query:
        updates["query"] = fallback.query
        updates["requires_clarification"] = False
        updates["clarification_question"] = None
    if patch.budget_cny is None and fallback.budget_cny is not None:
        updates["budget_cny"] = fallback.budget_cny
    if not patch.markets and fallback.markets:
        updates["markets"] = fallback.markets
    if not patch.use_case and fallback.use_case:
        updates["use_case"] = fallback.use_case
    if not patch.spec_gates and fallback.spec_gates:
        updates["spec_gates"] = fallback.spec_gates
    if not updates:
        return act
    grounded = patch.model_copy(update=updates)
    kind = DialogueActKind.REFINE if grounded.query else act.kind
    return act.model_copy(update={"kind": kind, "patch": grounded})


def is_undo_text(text: str) -> bool:
    from .frames import is_undo_text as _is_undo

    return _is_undo(text)


def detect_referent_hint(text: str) -> str | None:
    return referent_hint(text)


def resolve_referent_ids(
    text: str,
    ranked: list[dict],
    *,
    focus_snapshot_id: str | None = None,
    mentioned_snapshot_ids: list[str] | None = None,
    comparison_records: list[dict] | None = None,
    bind_records: list[dict] | None = None,
) -> list[str]:
    hint = referent_hint(text)
    pool = list(comparison_records or []) or list(bind_records or ranked)
    if not hint:
        return []
    if hint == "focus":
        compare_ids = [str(item.get("snapshot_id")) for item in (comparison_records or []) if item.get("snapshot_id")]
        sid = focus_snapshot_id or (compare_ids[0] if compare_ids else None) or (
            (mentioned_snapshot_ids or [None])[0]
        )
        return [sid] if sid else []
    if not pool:
        return []
    if hint == "cheapest":
        priced = []
        for item in pool:
            estimated = item.get("estimated_cny") if isinstance(item.get("estimated_cny"), dict) else {}
            amount = estimated.get("amount") if estimated else item.get("estimated_cny")
            sid = item.get("snapshot_id")
            if sid is not None and amount is not None:
                priced.append((float(amount), str(sid)))
        if priced:
            priced.sort(key=lambda pair: pair[0])
            return [priced[0][1]]
        return []
    if hint.startswith("token:"):
        token = hint.split(":", 1)[1]
        return list(World.from_ranked(pool).lookup(token))
    return []


def snapshot_ids_for_ranks(ranked_records: list[dict], ranks: list[int]) -> list[str]:
    ids = [str(item["snapshot_id"]) for item in ranked_records if item.get("snapshot_id")]
    out: list[str] = []
    for rank in ranks:
        if rank == -1 and ids:
            sid = ids[-1]
            if sid not in out:
                out.append(sid)
            continue
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
        DialogueActKind.ASK_SET,
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
        merchants=list(patch.merchants) if patch.merchants is not None else list(constraints.merchants),
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
    if before.merchants != after.merchants:
        parts.append("商户：" + "、".join(after.merchants) if after.merchants else "清除商户过滤")
    return "已更新" + ("：" + "、".join(parts) if parts else "购物约束")


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
