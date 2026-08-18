"""对话策略：分类用户话轮、决定是否重搜、投影线程。

确定性规则优先；模型只允许填同一套 Schema。检索依赖 query/markets/有货，
预算/偏好/排除只失效过滤层（技术文档 §3.1）。
"""
from __future__ import annotations

import re

from ..dto.dialogue import DialogueAct, DialogueActKind, ThreadMessage, ThreadView, TurnRoute
from ..dto.mission import MissionConstraints
from ..dto.runner import IntentPatch
from .parse_intent import CLARIFYING_QUESTION, parse_intent

_UNDO = re.compile(r"撤销|还原刚才|刚才的条件|undo", re.I)
_META = re.compile(r"你能做什么|你会什么|你是谁|怎么用")
_COMPARE = re.compile(r"比较|对比|横评|比一比|比一下|帮我比")
_ASK = re.compile(r"保修|为什么推荐|为什么选|差在哪|怎么样|有货吗|这款|这一款|这个呢")
_REJECT = re.compile(r"(?:不要|别买|排除)\s*([^\s，,。；;]+)")
_RANK_FIRST = re.compile(r"第[一1]件|第一个|首选")
_RANK_SECOND = re.compile(r"第[二2]件|第二个")
_RANK_TOP2 = re.compile(r"前两[个件]|这两[个件]")


def search_reuse_key(constraints: MissionConstraints) -> dict:
    """候选能否复用只取决于检索输入，不含预算/偏好/排除。"""
    return {
        "query": constraints.query or "",
        "markets": list(constraints.markets),
        "only_in_stock": bool(constraints.only_in_stock),
    }


def reuse_key_matches(constraints: MissionConstraints, cached: dict | None) -> bool:
    if not cached:
        return False
    return search_reuse_key(constraints) == {
        "query": cached.get("query") or "",
        "markets": list(cached.get("markets") or []),
        "only_in_stock": bool(cached.get("only_in_stock")),
    }


def classify_turn(text: str) -> DialogueAct:
    """先识别对话行为，再填约束增量。避免把提问/排除当成新 query。"""
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
        return DialogueAct(kind=DialogueActKind.ASK_ITEM, referent_ranks=_referent_ranks(raw, default=(1,)))
    rejected = _REJECT.search(raw)
    if rejected:
        term = rejected.group(1).strip("的了呢啊")
        if term:
            return DialogueAct(kind=DialogueActKind.REJECT, exclude_terms=[term])
    patch = parse_intent(raw)
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
    if event_type == "message.received":
        return ThreadMessage(
            sequence=sequence,
            kind="user",
            text=str(payload.get("text") or ""),
            constraints_version=version,
            created_at=created,
        )
    if event_type == "agent.message":
        return ThreadMessage(
            sequence=sequence,
            kind="agent",
            text=str(payload.get("text") or ""),
            constraints_version=version,
            snapshot_ids=snapshot_ids,
            created_at=created,
        )
    if event_type == "clarification.required":
        return ThreadMessage(
            sequence=sequence,
            kind="clarification",
            text=str(payload.get("question") or CLARIFYING_QUESTION),
            created_at=created,
        )
    if event_type == "recommendation.ready":
        count = payload.get("count")
        return ThreadMessage(
            sequence=sequence,
            kind="recommendation",
            text=f"已根据当前约束给出推荐，候选 {count} 件。" if count is not None else "已给出推荐。",
            constraints_version=version,
            created_at=created,
        )
    if event_type == "run.degraded":
        return ThreadMessage(
            sequence=sequence,
            kind="warning",
            text="本轮结果不完整，请查看任务警告。",
            constraints_version=version,
            created_at=created,
        )
    if event_type == "constraints.updated":
        return ThreadMessage(
            sequence=sequence,
            kind="change",
            text="已更新购物约束。",
            constraints_version=version,
            created_at=created,
        )
    if event_type == "constraints.undo":
        return ThreadMessage(
            sequence=sequence,
            kind="change",
            text="已撤销最近一次约束变更。",
            constraints_version=version,
            created_at=created,
        )
    if event_type == "comparison.updated":
        return ThreadMessage(
            sequence=sequence,
            kind="change",
            text="已更新比较集合。",
            constraints_version=version,
            snapshot_ids=snapshot_ids,
            created_at=created,
        )
    return None
