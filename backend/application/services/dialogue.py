"""对话策略：分类用户话轮、决定是否重搜、投影线程。

确定性规则优先；模型只允许填同一套 Schema。检索依赖 query/markets/有货，
预算/偏好/排除只失效过滤层（技术文档 §3.1）。
"""
from __future__ import annotations

import re

from ..dto.dialogue import AskTopic, DialogueAct, DialogueActKind, ThreadMessage, ThreadView, TurnRoute
from ..dto.mission import MissionConstraints, MissionStage, TurnPhase
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


def classify_turn(text: str, *, current_query: str | None = None) -> DialogueAct:
    """先识别对话行为，再填约束增量。残句与态度不得覆盖 query。"""
    raw = (text or "").strip()
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
    if _ASK.search(raw):
        return DialogueAct(
            kind=DialogueActKind.ASK_ITEM,
            referent_ranks=_referent_ranks(raw, default=(1,)),
            topic=detect_ask_topic(raw),
        )
    rejected = _REJECT.search(raw)
    if rejected:
        term = rejected.group(1).strip("的了呢啊")
        if term:
            return DialogueAct(kind=DialogueActKind.REJECT, exclude_terms=[term])
    stance = _detect_stance(raw)
    if stance:
        patch = parse_intent(raw, current_query=current_query)
        patch = _stance_patch(patch, stance, current_query=current_query)
        return DialogueAct(kind=DialogueActKind.STANCE, patch=patch, stance=stance)
    patch = parse_intent(raw, current_query=current_query)
    kind = DialogueActKind.UNKNOWN if patch.requires_clarification else DialogueActKind.REFINE
    return DialogueAct(kind=kind, patch=patch)


def plan_route(
    *,
    kind: DialogueActKind,
    has_query: bool,
    has_cache: bool,
    reuse_matches: bool,
    skip_intent_patch: bool,
    constraints_changed: bool,
) -> TurnRoute:
    if kind in {DialogueActKind.META, DialogueActKind.ASK_ITEM, DialogueActKind.COMPARE}:
        return TurnRoute.TALK
    if kind == DialogueActKind.STANCE and not constraints_changed:
        return TurnRoute.TALK if has_query else TurnRoute.CLARIFY
    if kind == DialogueActKind.REJECT:
        if has_cache:
            return TurnRoute.REFILTER
        return TurnRoute.RESEARCH if has_query else TurnRoute.CLARIFY
    if not has_query:
        return TurnRoute.CLARIFY
    if skip_intent_patch:
        if has_cache and reuse_matches:
            return TurnRoute.REFILTER
        return TurnRoute.RESEARCH
    if has_cache and reuse_matches:
        return TurnRoute.TALK if not constraints_changed else TurnRoute.REFILTER
    return TurnRoute.RESEARCH


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


def _detect_stance(text: str) -> str | None:
    if _STANCE_EXPENSIVE.search(text):
        return "too_expensive"
    if _STANCE_CHEAPER.search(text):
        return "want_cheaper"
    if _STANCE_LIGHTER.search(text):
        return "want_lighter"
    return None


def apply_stance_budget(act: DialogueAct, constraints: MissionConstraints) -> DialogueAct:
    """「太贵了」在已有预算时收紧，而不是改 query。"""
    if act.kind != DialogueActKind.STANCE or act.stance not in {"too_expensive", "want_cheaper"}:
        return act
    patch = act.patch or IntentPatch()
    if patch.budget_cny is not None or constraints.budget_cny is None:
        return act
    tightened = max(100.0, round(float(constraints.budget_cny) * 0.8))
    if tightened >= constraints.budget_cny:
        return act
    return act.model_copy(update={"patch": patch.model_copy(update={"budget_cny": tightened})})


def _stance_patch(patch: IntentPatch, stance: str, *, current_query: str | None) -> IntentPatch:
    """态度可以收预算，但不能改 query。"""
    budget = patch.budget_cny
    return IntentPatch(
        query=None,
        budget_cny=budget,
        markets=patch.markets,
        preference=patch.preference,
        only_in_stock=None,
        requires_clarification=False,
    )


def preview_merged_constraints(constraints: MissionConstraints, act: DialogueAct) -> MissionConstraints:
    """命令层预览合并结果，与 merge_mission_state 对齐，但不写库。"""
    if act.kind in {
        DialogueActKind.ASK_ITEM,
        DialogueActKind.COMPARE,
        DialogueActKind.META,
        DialogueActKind.UNDO,
    }:
        return constraints
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


def preview_turn(
    *,
    act: DialogueAct,
    constraints: MissionConstraints,
    has_cache: bool,
    cache_reuse_key: dict | None,
    skip_intent_patch: bool = False,
) -> tuple[TurnRoute, TurnPhase]:
    """在调度前决定本轮动作。talk/clarify 不得进入 researching。"""
    merged = constraints if skip_intent_patch else preview_merged_constraints(constraints, act)
    route = plan_route(
        kind=act.kind,
        has_query=bool(merged.query),
        has_cache=has_cache,
        reuse_matches=reuse_key_matches(merged, cache_reuse_key),
        skip_intent_patch=skip_intent_patch,
        constraints_changed=merged != constraints,
    )
    return route, phase_for_route(route)


def phase_for_route(route: TurnRoute) -> TurnPhase:
    if route == TurnRoute.RESEARCH:
        return TurnPhase.RESEARCHING
    if route == TurnRoute.REFILTER:
        return TurnPhase.REFILTERING
    return TurnPhase.RESPONDING


def stage_for_phase(phase: TurnPhase, current: MissionStage) -> MissionStage:
    if phase == TurnPhase.RESEARCHING:
        return MissionStage.SEARCHING
    if phase == TurnPhase.REFILTERING:
        return MissionStage.RANKING
    return current


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


def snapshot_ids_for_ranks(ranked_records: list[dict], ranks: list[int]) -> list[str]:
    ids = [str(item["snapshot_id"]) for item in ranked_records if item.get("snapshot_id")]
    out: list[str] = []
    for rank in ranks:
        if 1 <= rank <= len(ids):
            sid = ids[rank - 1]
            if sid not in out:
                out.append(sid)
    return out


def project_thread(events: list[dict]) -> ThreadView:
    messages: list[ThreadMessage] = []
    for event in events:
        mapped = _map_event(event)
        if mapped is not None:
            messages.append(mapped)
    return ThreadView(messages=messages)


def _referent_ranks(text: str, *, default: tuple[int, ...]) -> list[int]:
    if _RANK_TOP2.search(text):
        return [1, 2]
    ranks: list[int] = []
    if _RANK_FIRST.search(text) or re.search(r"这款|这一款|这个", text):
        ranks.append(1)
    if _RANK_SECOND.search(text):
        ranks.append(2)
    return ranks or list(default)


def _map_event(event: dict) -> ThreadMessage | None:
    payload = event.get("payload") or {}
    sequence = int(event.get("sequence") or 0)
    created = event.get("created_at")
    event_type = event.get("event_type")
    version = payload.get("constraints_version")
    snapshot_ids = list(payload.get("snapshot_ids") or [])
    run_id = payload.get("run_id")
    run_id = str(run_id) if run_id else None
    if event_type == "message.received":
        return ThreadMessage(
            sequence=sequence,
            kind="user",
            text=str(payload.get("text") or ""),
            constraints_version=version,
            run_id=run_id,
            created_at=created,
        )
    if event_type == "agent.message":
        return ThreadMessage(
            sequence=sequence,
            kind="agent",
            text=str(payload.get("text") or ""),
            constraints_version=version,
            snapshot_ids=snapshot_ids,
            run_id=run_id,
            created_at=created,
        )
    if event_type == "clarification.required":
        return ThreadMessage(
            sequence=sequence,
            kind="clarification",
            text=str(payload.get("question") or CLARIFYING_QUESTION),
            run_id=run_id,
            created_at=created,
        )
    if event_type == "recommendation.ready":
        count = payload.get("count")
        return ThreadMessage(
            sequence=sequence,
            kind="recommendation",
            text=f"已根据当前约束给出推荐，候选 {count} 件。" if count is not None else "已给出推荐。",
            constraints_version=version,
            run_id=run_id,
            created_at=created,
        )
    if event_type == "run.degraded":
        return ThreadMessage(
            sequence=sequence,
            kind="warning",
            text="本轮结果不完整，请查看任务警告。",
            constraints_version=version,
            run_id=run_id,
            created_at=created,
        )
    if event_type == "constraints.updated":
        before = payload.get("before") or {}
        after = payload.get("after") or {}
        try:
            text = summarize_constraint_change(
                MissionConstraints(**before), MissionConstraints(**after)
            )
        except Exception:
            text = "已更新购物约束"
        return ThreadMessage(
            sequence=sequence,
            kind="change",
            text=text,
            constraints_version=version,
            run_id=run_id,
            change_kind="constraints",
            created_at=created,
        )
    if event_type == "constraints.undo":
        return ThreadMessage(
            sequence=sequence,
            kind="change",
            text="已撤销最近一次约束变更。",
            constraints_version=version,
            run_id=run_id,
            change_kind="undo",
            created_at=created,
        )
    if event_type == "comparison.updated":
        return ThreadMessage(
            sequence=sequence,
            kind="change",
            text="已更新比较集合。",
            constraints_version=version,
            snapshot_ids=snapshot_ids,
            change_kind="comparison",
            created_at=created,
        )
    return None
