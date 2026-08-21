"""持久化决策快照节点（AGT-004/AGT-005、DAT-004）。"""
from __future__ import annotations

from collections.abc import Callable

from ...application.dto import MissionStage, RunnerStatus, TurnPhase
from ...application.dto.mission import next_constraints_version
from ...application.errors import MissionVersionConflict
from ...application.ports import RunTextHub, UnitOfWork
from ...application.services.dialogue import search_reuse_key
from ...application.services.grounded import citations_from_ranked, compose_ready_reply
from ...application.services.present import candidate_record, remap_draft
from ...application.services.uncertainty import (
    bind_emitted_probe,
    present_probe,
    probe_event_fields,
    select_probe,
)
from ..state import MissionGraphState

CONTRACT_VERSION = "1.0"


def _finish_text(hub: RunTextHub | None, run_id: str, text: str | None = None) -> None:
    if hub is None:
        return
    snap = hub.snapshot(run_id)
    if snap and snap["text"]:
        hub.complete(run_id)
        return
    if text:
        hub.publish(run_id, text)
    hub.complete(run_id, text=text)


def make_persist_decision_snapshot(
    uow_factory: Callable[[], UnitOfWork],
    *,
    text_hub: RunTextHub | None = None,
):
    async def persist_decision_snapshot(state: MissionGraphState) -> dict:
        mission = state["mission"]
        run_id = state["run_id"]
        run_version = state["run_version"]
        warnings = list(state.get("warnings", []))
        turn_route = state.get("turn_route") or "research"

        async with uow_factory() as uow:
            if state.get("requires_clarification") or turn_route == "clarify":
                probe = select_probe(
                    constraints=mission.constraints,
                    belief=mission.belief,
                    last_act=state.get("dialogue_act"),
                )
                belief = bind_emitted_probe(mission.belief, probe)
                question = state.get("clarification_question")
                if probe is not None:
                    question = probe.question
                updated = mission.model_copy(
                    update={
                        "stage": MissionStage.CLARIFYING,
                        "turn_phase": TurnPhase.IDLE,
                        "belief": belief,
                    }
                )
                try:
                    await uow.missions.save(updated, expected_version=run_version)
                except MissionVersionConflict:
                    await uow.rollback()
                    if text_hub is not None:
                        text_hub.abort(run_id)
                    return {
                        "status": RunnerStatus.SUPERSEDED,
                        "warnings": ["运行基于旧版本约束，已标记 superseded"],
                    }
                await uow.events.append(
                    mission_id=mission.id,
                    event_type="clarification.required",
                    payload={
                        "run_id": run_id,
                        "question": question,
                        **probe_event_fields(probe),
                    },
                )
                await uow.recommendation_runs.save(
                    mission_id=mission.id, run_id=run_id, payload={"status": "completed"}
                )
                await uow.commit()
                _finish_text(text_hub, run_id, question)
                return {"status": RunnerStatus.COMPLETED, "warnings": warnings}

            current = await uow.missions.get(owner_id=mission.owner_id, mission_id=mission.id)
            if current is None or current.constraints_version != run_version:
                await uow.events.append(
                    mission_id=mission.id,
                    event_type="run.superseded",
                    payload={"run_id": run_id, "constraints_version": run_version},
                )
                await uow.recommendation_runs.mark_superseded(
                    mission_id=mission.id, run_id=run_id
                )
                await uow.commit()
                if text_hub is not None:
                    text_hub.abort(run_id)
                return {"status": RunnerStatus.SUPERSEDED, "warnings": ["运行基于旧版本约束，已标记 superseded"]}

            constraints_version = next_constraints_version(
                current.constraints_version, current.constraints, mission.constraints
            )

            if turn_route == "talk":
                return await _persist_talk(
                    uow,
                    state=state,
                    mission=mission,
                    current=current,
                    run_id=run_id,
                    run_version=run_version,
                    constraints_version=constraints_version,
                    warnings=warnings,
                    text_hub=text_hub,
                )

            ranked = state.get("ranked", [])
            rates = state.get("rates") or {}
            snapshot_map: dict[str, str] = dict(state.get("snapshot_map") or {})
            reuse = bool(state.get("reuse_snapshots"))
            pool_products = list(state.get("pool") or [])
            to_snap = list(ranked) + [item for item in pool_products if item.id not in {p.id for p in ranked}]
            if not reuse:
                snapshot_map = {}
                for product in to_snap:
                    snap_id = await uow.products.save(
                        product=product,
                        raw_payload=product.model_dump(mode="json"),
                        contract_version=CONTRACT_VERSION,
                    )
                    snapshot_map[product.id] = snap_id
                fx_ids = [await uow.fx_snapshots.save(snapshot=s) for s in state.get("fx", [])]
            else:
                fx_ids = list(state.get("cached_fx_snapshot_ids") or [])
                for product in to_snap:
                    snapshot_map.setdefault(product.id, snapshot_map.get(product.id, product.id))

            budget = mission.constraints.budget_cny
            belief = mission.belief
            ranked_records = [
                candidate_record(
                    product,
                    snapshot_id=snapshot_map[product.id],
                    fx=rates.get(product.native_currency),
                    rank=index + 1,
                    budget_cny=budget,
                    preference=mission.constraints.preference,
                    price_sensitive=getattr(belief, "price_sensitivity", None)
                    in {"too_expensive", "want_cheaper"},
                )
                for index, product in enumerate(ranked)
            ]
            pool_records = [
                candidate_record(
                    product,
                    snapshot_id=snapshot_map[product.id],
                    fx=rates.get(product.native_currency),
                    rank=index + 1,
                    budget_cny=budget,
                    preference=mission.constraints.preference,
                    price_sensitive=getattr(belief, "price_sensitivity", None)
                    in {"too_expensive", "want_cheaper"},
                )
                for index, product in enumerate(pool_products)
                if product.id in snapshot_map
            ]
            if not pool_records:
                pool_records = list((state.get("cache_payload") or {}).get("pool") or []) or ranked_records
            candidate_payload = {
                "snapshot_map": snapshot_map,
                "ranked": ranked_records,
                "pool": pool_records,
                "fx_snapshot_ids": fx_ids,
                "reuse_key": search_reuse_key(mission.constraints),
            }
            candidate_set_id = await uow.candidate_sets.save(
                mission_id=mission.id,
                run_id=run_id,
                constraints_version=constraints_version,
                payload=candidate_payload,
            )

            draft = state.get("recommendation")
            stored_draft = remap_draft(draft, snapshot_map) if draft else None
            await uow.recommendation_runs.save(
                mission_id=mission.id,
                run_id=run_id,
                payload={
                    "status": "completed",
                    "candidate_set_id": candidate_set_id,
                    "draft_json": stored_draft.model_dump(mode="json") if stored_draft else None,
                },
            )

            stage = MissionStage.READY if ranked else MissionStage.DEGRADED
            if state.get("fx_failed_currencies") or state.get("failed_markets"):
                stage = MissionStage.DEGRADED
            citations = citations_from_ranked(ranked_records)
            comparison_ids = state.get("comparison_snapshot_ids")
            agent_text = state.get("agent_message") or compose_ready_reply(
                ranked_records,
                mission.constraints,
                belief=mission.belief,
                recall_mode=getattr(state.get("search_plan"), "recall_mode", None),
            )
            probe = select_probe(
                constraints=mission.constraints,
                belief=mission.belief,
                ranked=ranked_records,
                last_act=state.get("dialogue_act"),
            )
            agent_text, _ = present_probe(probe, agent_text)
            belief = bind_emitted_probe(mission.belief, probe)
            updates = {
                "stage": stage,
                "turn_phase": TurnPhase.IDLE,
                "constraints_version": constraints_version,
                "candidate_set_id": candidate_set_id,
                "recommendation_run_id": run_id,
                "warnings": warnings,
                "dialogue": _dialogue_with_mentions(mission.dialogue, citations),
                "belief": belief,
            }
            if comparison_ids:
                updates["comparison_snapshot_ids"] = comparison_ids
            updated = mission.model_copy(update=updates)
            try:
                await uow.missions.save(updated, expected_version=run_version)
            except MissionVersionConflict:
                await uow.rollback()
                if text_hub is not None:
                    text_hub.abort(run_id)
                return {"status": RunnerStatus.SUPERSEDED, "warnings": ["运行基于旧版本约束，已标记 superseded"]}

            # 控制反转后约束合并在图内发生；补发 constraints.updated 以支撑 undo 回溯与线程投影。
            if mission.constraints != current.constraints:
                await uow.events.append(
                    mission_id=mission.id,
                    event_type="constraints.updated",
                    payload={
                        "run_id": run_id,
                        "before": current.constraints.model_dump(mode="json"),
                        "after": mission.constraints.model_dump(mode="json"),
                        "constraints_version": constraints_version,
                    },
                )

            event_type = "recommendation.ready" if stage == MissionStage.READY else "run.degraded"
            probe_fields = probe_event_fields(probe)
            await uow.events.append(
                mission_id=mission.id,
                event_type=event_type,
                payload={
                    "mission_id": mission.id,
                    "run_id": run_id,
                    "candidate_set_id": candidate_set_id,
                    "constraints_version": constraints_version,
                    "count": len(ranked_records),
                    "text": agent_text,
                    "snapshot_ids": [item["snapshot_id"] for item in citations],
                    "citations": citations,
                    "title": citations[0]["title"] if citations else None,
                    **probe_fields,
                },
            )
            await uow.events.append(
                mission_id=mission.id,
                event_type="agent.message",
                payload={
                    "run_id": run_id,
                    "text": agent_text,
                    "act": state.get("agent_act") or mission.dialogue.last_act or "refine_constraints",
                    "constraints_version": constraints_version,
                    "snapshot_ids": [item["snapshot_id"] for item in citations],
                    "citations": citations,
                    **probe_fields,
                },
            )
            await uow.commit()
            _finish_text(text_hub, run_id, agent_text)

            status = RunnerStatus.COMPLETED if stage == MissionStage.READY else RunnerStatus.DEGRADED
            return {
                "status": status,
                "candidate_set_id": candidate_set_id,
                "recommendation_run_id": run_id,
            }

    return persist_decision_snapshot


async def _persist_talk(
    uow: UnitOfWork,
    *,
    state: MissionGraphState,
    mission,
    current,
    run_id: str,
    run_version: int,
    constraints_version: int,
    warnings: list[str],
    text_hub: RunTextHub | None = None,
) -> dict:
    comparison_ids = state.get("comparison_snapshot_ids") or mission.comparison_snapshot_ids
    ranked = list((state.get("cache_payload") or {}).get("ranked") or [])
    text = state.get("agent_message") or "已根据当前候选回答。"
    probe = select_probe(
        constraints=mission.constraints,
        belief=mission.belief,
        ranked=ranked,
        last_act=state.get("dialogue_act"),
    )
    text, _ = present_probe(probe, text)
    belief = bind_emitted_probe(mission.belief, probe)
    updated = mission.model_copy(
        update={
            "stage": current.stage,
            "turn_phase": TurnPhase.IDLE,
            "constraints_version": constraints_version,
            "candidate_set_id": current.candidate_set_id,
            "recommendation_run_id": current.recommendation_run_id,
            "comparison_snapshot_ids": comparison_ids,
            "warnings": warnings or current.warnings,
            "dialogue": _dialogue_with_mentions(
                mission.dialogue, list(state.get("agent_citations") or []), list(state.get("agent_snapshot_ids") or [])
            ),
            "belief": belief,
            "active_run_id": run_id,
        }
    )
    try:
        await uow.missions.save(updated, expected_version=run_version)
    except MissionVersionConflict:
        await uow.rollback()
        if text_hub is not None:
            text_hub.abort(run_id)
        return {"status": RunnerStatus.SUPERSEDED, "warnings": ["运行基于旧版本约束，已标记 superseded"]}
    await uow.recommendation_runs.save(
        mission_id=mission.id, run_id=run_id, payload={"status": "completed"}
    )
    snapshot_ids = list(state.get("agent_snapshot_ids") or [])
    citations = list(state.get("agent_citations") or [])
    await uow.events.append(
        mission_id=mission.id,
        event_type="agent.message",
        payload={
            "run_id": run_id,
            "text": text,
            "act": state.get("agent_act"),
            "topic": state.get("agent_topic"),
            "constraints_version": constraints_version,
            "snapshot_ids": snapshot_ids,
            "citations": citations,
            **probe_event_fields(probe),
            **(
                {"next_moves": state["agent_next_moves"]}
                if state.get("agent_next_moves")
                else {}
            ),
        },
    )
    if state.get("comparison_snapshot_ids"):
        await uow.events.append(
            mission_id=mission.id,
            event_type="comparison.updated",
            payload={
                "snapshot_ids": list(state["comparison_snapshot_ids"]),
                "constraints_version": constraints_version,
            },
        )
    await uow.commit()
    _finish_text(text_hub, run_id, text)
    return {
        "status": RunnerStatus.COMPLETED,
        "candidate_set_id": current.candidate_set_id,
        "recommendation_run_id": current.recommendation_run_id,
    }


def _dialogue_with_mentions(dialogue, citations: list, snapshot_ids: list | None = None):
    ids = [
        str(item["snapshot_id"])
        for item in citations
        if isinstance(item, dict) and item.get("snapshot_id")
    ]
    if not ids:
        ids = [str(item) for item in list(snapshot_ids or []) if item]
    if not ids:
        return dialogue
    return dialogue.model_copy(update={"mentioned_snapshot_ids": ids[:4]})
