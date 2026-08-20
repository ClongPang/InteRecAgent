"""事件流投影为对话线程。"""
from __future__ import annotations

from ..dto.belief import PreferenceBelief
from ..dto.dialogue import (
    Citation,
    DialogueActKind,
    NextMove,
    ThreadChange,
    ThreadMessage,
    ThreadView,
)
from ..dto.mission import MissionConstraints
from .next_move import next_moves_for
from .nlu import summarize_constraint_change
from .parse_intent import CLARIFYING_QUESTION


def project_thread(
    events: list[dict],
    *,
    has_query: bool = False,
    has_candidates: bool = False,
    ranked: list[dict] | None = None,
    belief: PreferenceBelief | None = None,
    budget_cny: float | None = None,
) -> ThreadView:
    mapped = [item for item in (_map_event(event) for event in events) if item is not None]
    return ThreadView(
        messages=_fold_thread(
            mapped,
            has_query=has_query,
            has_candidates=has_candidates,
            ranked=ranked,
            belief=belief,
            budget_cny=budget_cny,
        )
    )


def _fold_thread(
    messages: list[ThreadMessage],
    *,
    has_query: bool,
    has_candidates: bool,
    ranked: list[dict] | None = None,
    belief: PreferenceBelief | None = None,
    budget_cny: float | None = None,
) -> list[ThreadMessage]:
    dialogue_runs = {item.run_id for item in messages if item.kind != "change" and item.run_id}
    agent_runs = {item.run_id for item in messages if item.kind == "agent" and item.run_id}
    changes = {
        item.run_id: item
        for item in messages
        if item.kind == "change" and item.run_id
    }
    out: list[ThreadMessage] = []
    for item in messages:
        if item.kind == "change" and item.run_id and item.run_id in dialogue_runs:
            continue
        if item.kind == "recommendation" and item.run_id and item.run_id in agent_runs:
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
                belief=belief,
                budget_cny=budget_cny,
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
            next_moves=next_moves,
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
    if event_type == "run.cancelled":
        return ThreadMessage(
            sequence=sequence,
            kind="warning",
            role="system",
            text="已停止本轮检索。",
            constraints_version=version,
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
