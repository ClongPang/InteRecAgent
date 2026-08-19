"""对话策略：分类用户话轮、决定是否重搜、投影线程。

确定性规则优先；模型只允许填同一套 Schema。检索依赖 query/markets/有货，
预算/偏好/排除只失效过滤层（技术文档 §3.1）。
"""
from __future__ import annotations

import re

from ..dto.dialogue import (
    AskTopic,
    Citation,
    DialogueAct,
    DialogueActKind,
    NextMove,
    ThreadChange,
    ThreadMessage,
    ThreadView,
    TurnRoute,
)
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
            return TurnRoute.RERANK
        return TurnRoute.RESEARCH if has_query else TurnRoute.CLARIFY
    if kind == DialogueActKind.STANCE and constraints_changed and has_cache:
        return TurnRoute.RERANK
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
    if route in {TurnRoute.REFILTER, TurnRoute.RERANK}:
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


def next_moves_for(
    *,
    kind: str | None,
    topic: str | None,
    has_query: bool,
    has_candidates: bool,
    ranked: list[dict] | None = None,
) -> list[NextMove]:
    """上一轮结束后的可执行下一句。有候选时按价差/品牌差生成。"""
    if not has_query:
        return [
            NextMove(label="通勤降噪耳机", text="通勤降噪耳机，预算 4000 元"),
            NextMove(label="27 寸 4K 显示器", text="27 寸 4K 显示器，预算 3000 元"),
            NextMove(label="轻便徒步鞋", text="轻便徒步鞋，预算 1000 元"),
        ]
    delta_moves = _moves_from_ranked(ranked or [])
    if topic == AskTopic.WARRANTY.value or topic == "warranty":
        return delta_moves[:1] + [
            NextMove(label="为什么选它", text="为什么推荐这款"),
            NextMove(label="换一款", text="不要这款"),
        ]
    if topic == AskTopic.STOCK.value or topic == "stock":
        return [
            NextMove(label="这款保修吗", text="这款保修吗"),
            NextMove(label="为什么推荐", text="为什么推荐"),
        ]
    if topic == AskTopic.TRADEOFF.value or kind == DialogueActKind.COMPARE.value:
        return [
            NextMove(label="为什么推荐", text="为什么推荐"),
            *delta_moves[:2],
        ]
    if kind == DialogueActKind.STANCE.value:
        return [
            NextMove(label="预算 2000 元", text="预算 2000 元"),
            NextMove(label="对比前两件", text="帮我比前两个"),
        ]
    if has_candidates:
        return [
            NextMove(label="为什么推荐", text="为什么推荐"),
            *delta_moves[:3],
        ]
    return []


def _moves_from_ranked(ranked: list[dict]) -> list[NextMove]:
    if len(ranked) < 2:
        return [
            NextMove(label="再便宜一点", text="再便宜一点"),
            NextMove(label="对比前两件", text="帮我比前两个"),
        ]
    first, second = ranked[0], ranked[1]
    moves = [NextMove(label="对比前两件", text="帮我比前两个")]
    cny_a = _record_cny(first)
    cny_b = _record_cny(second)
    if cny_a is not None and cny_b is not None and cny_a != cny_b:
        gap = abs(cny_a - cny_b)
        moves.append(NextMove(label=f"再收 ¥{gap:.0f}", text="再便宜一点"))
    else:
        moves.append(NextMove(label="再便宜一点", text="再便宜一点"))
    brand = (first.get("brand") or _title_brand(str(first.get("title") or "")) or "").strip()
    if brand:
        moves.append(NextMove(label=f"不要{brand}", text=f"不要{brand}"))
    else:
        moves.append(NextMove(label="不要这款", text="不要这款"))
    return moves


def _record_cny(record: dict) -> float | None:
    estimated = record.get("estimated_cny")
    if isinstance(estimated, dict) and estimated.get("amount") is not None:
        return float(estimated["amount"])
    if record.get("estimated_cny") is not None and not isinstance(record.get("estimated_cny"), dict):
        try:
            return float(record["estimated_cny"])
        except (TypeError, ValueError):
            return None
    return None


def _title_brand(title: str) -> str | None:
    for token in ("Sony", "Bose", "Apple", "Samsung", "Dell", "Salomon"):
        if token.lower() in title.lower():
            return token
    return None


def project_thread(
    events: list[dict],
    *,
    has_query: bool = False,
    has_candidates: bool = False,
    ranked: list[dict] | None = None,
) -> ThreadView:
    mapped = [item for item in (_map_event(event) for event in events) if item is not None]
    return ThreadView(
        messages=_fold_thread(
            mapped, has_query=has_query, has_candidates=has_candidates, ranked=ranked
        )
    )


def _fold_thread(
    messages: list[ThreadMessage],
    *,
    has_query: bool,
    has_candidates: bool,
    ranked: list[dict] | None = None,
) -> list[ThreadMessage]:
    dialogue_runs = {item.run_id for item in messages if item.kind != "change" and item.run_id}
    changes = {
        item.run_id: item
        for item in messages
        if item.kind == "change" and item.run_id
    }
    out: list[ThreadMessage] = []
    for item in messages:
        if item.kind == "change" and item.run_id and item.run_id in dialogue_runs:
            continue
        updates: dict = {}
        if item.run_id and item.run_id in changes and item.kind != "change":
            change_msg = changes[item.run_id]
            updates["change"] = ThreadChange(
                kind=change_msg.change_kind or "constraints",
                summary=change_msg.text,
            )
            updates["change_kind"] = change_msg.change_kind
        if item.kind in {"agent", "clarification", "recommendation"}:
            updates["role"] = "agent"
            updates["next_moves"] = item.next_moves or next_moves_for(
                kind=item.act or item.kind,
                topic=item.topic,
                has_query=False if item.kind == "clarification" and not has_query else has_query,
                has_candidates=has_candidates or bool(item.citations or item.snapshot_ids),
                ranked=ranked,
            )
            if not item.citations and item.snapshot_ids:
                updates["citations"] = [
                    Citation(snapshot_id=sid, role="primary" if index == 0 else "compare")
                    for index, sid in enumerate(item.snapshot_ids)
                ]
        elif item.kind == "user":
            updates["role"] = "user"
        elif item.kind in {"change", "warning"}:
            updates["role"] = "system"
        out.append(item.model_copy(update=updates) if updates else item)
    return out


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
    citations = _citations_from_payload(payload, snapshot_ids)
    next_moves = [
        NextMove(label=str(item.get("label") or ""), text=str(item.get("text") or ""))
        for item in payload.get("next_moves") or []
        if isinstance(item, dict) and item.get("label") and item.get("text")
    ]
    if event_type == "message.received":
        return ThreadMessage(
            sequence=sequence,
            kind="user",
            role="user",
            text=str(payload.get("text") or ""),
            act=payload.get("act"),
            topic=payload.get("topic"),
            constraints_version=version,
            run_id=run_id,
            created_at=created,
        )
    if event_type == "agent.message":
        return ThreadMessage(
            sequence=sequence,
            kind="agent",
            role="agent",
            text=str(payload.get("text") or ""),
            act=payload.get("act"),
            topic=payload.get("topic"),
            constraints_version=version,
            snapshot_ids=snapshot_ids,
            citations=citations,
            next_moves=next_moves,
            run_id=run_id,
            created_at=created,
        )
    if event_type == "clarification.required":
        return ThreadMessage(
            sequence=sequence,
            kind="clarification",
            role="agent",
            text=str(payload.get("question") or CLARIFYING_QUESTION),
            act=DialogueActKind.UNKNOWN.value,
            run_id=run_id,
            created_at=created,
        )
    if event_type == "recommendation.ready":
        count = payload.get("count")
        title = (citations[0].title if citations else None) or payload.get("title")
        text = str(payload.get("text") or "")
        if not text:
            text = (
                f"推荐 {title}。"
                if title
                else (f"已根据当前约束给出推荐，候选 {count} 件。" if count is not None else "已给出推荐。")
            )
        return ThreadMessage(
            sequence=sequence,
            kind="recommendation",
            role="agent",
            text=text,
            act=DialogueActKind.REFINE.value,
            constraints_version=version,
            snapshot_ids=snapshot_ids or [item.snapshot_id for item in citations],
            citations=citations,
            run_id=run_id,
            created_at=created,
        )
    if event_type == "run.degraded":
        return ThreadMessage(
            sequence=sequence,
            kind="warning",
            role="system",
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
            role="system",
            text=text,
            change=ThreadChange(kind="constraints", summary=text),
            constraints_version=version,
            run_id=run_id,
            change_kind="constraints",
            created_at=created,
        )
    if event_type == "constraints.undo":
        return ThreadMessage(
            sequence=sequence,
            kind="change",
            role="system",
            text="已撤销最近一次约束变更。",
            change=ThreadChange(kind="undo", summary="已撤销最近一次约束变更。"),
            constraints_version=version,
            run_id=run_id,
            change_kind="undo",
            created_at=created,
        )
    if event_type == "comparison.updated":
        return ThreadMessage(
            sequence=sequence,
            kind="change",
            role="system",
            text="已更新比较集合。",
            change=ThreadChange(kind="comparison", summary="已更新比较集合。"),
            constraints_version=version,
            snapshot_ids=snapshot_ids,
            citations=citations,
            change_kind="comparison",
            created_at=created,
        )
    return None


def _citations_from_payload(payload: dict, snapshot_ids: list[str]) -> list[Citation]:
    raw = payload.get("citations")
    if isinstance(raw, list) and raw:
        out: list[Citation] = []
        for item in raw:
            if not isinstance(item, dict) or not item.get("snapshot_id"):
                continue
            cny = item.get("estimated_cny")
            out.append(
                Citation(
                    snapshot_id=str(item["snapshot_id"]),
                    role=str(item.get("role") or "primary"),
                    title=item.get("title"),
                    estimated_cny=float(cny) if cny is not None else None,
                    market=item.get("market"),
                )
            )
        if out:
            return out
    return [Citation(snapshot_id=sid, role="primary" if index == 0 else "compare") for index, sid in enumerate(snapshot_ids)]
