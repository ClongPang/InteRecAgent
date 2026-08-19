"""持久化决策快照节点（AGT-004/AGT-005、DAT-004）。"""
from __future__ import annotations

from collections.abc import Callable

from ...application.dto import MissionStage, RunnerStatus, TurnPhase
from ...application.dto.mission import next_constraints_version
from ...application.errors import MissionVersionConflict
from ...application.ports import UnitOfWork
from ...application.services.dialogue import search_reuse_key
from ...application.services.grounded import citations_from_ranked, compose_ready_reply
from ...application.services.present import candidate_record, remap_draft
from ..state import MissionGraphState

CONTRACT_VERSION = "1.0"


def make_persist_decision_snapshot(uow_factory: Callable[[], UnitOfWork]):
    async def persist_decision_snapshot(state: MissionGraphState) -> dict:
        mission = state["mission"]
        run_id = state["run_id"]
        run_version = state["run_version"]
        warnings = list(state.get("warnings", []))
        turn_route = state.get("turn_route") or "research"

        async with uow_factory() as uow:
            if state.get("requires_clarification") or turn_route == "clarify":
                updated = mission.model_copy(
                    update={"stage": MissionStage.CLARIFYING, "turn_phase": TurnPhase.IDLE}
                )
                try:
                    await uow.missions.save(updated, expected_version=run_version)
                except MissionVersionConflict:
                    await uow.rollback()
                    return {
                        "status": RunnerStatus.SUPERSEDED,
                        "warnings": ["运行基于旧版本约束，已标记 superseded"],
                    }
                await uow.events.append(
                    mission_id=mission.id,
                    event_type="clarification.required",
                    payload={"run_id": run_id, "question": state.get("clarification_question")},
                )
                await uow.recommendation_runs.save(
                    mission_id=mission.id, run_id=run_id, payload={"status": "completed"}
                )
                await uow.commit()
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
                )

            ranked = state.get("ranked", [])
            rates = state.get("rates") or {}
            snapshot_map: dict[str, str] = dict(state.get("snapshot_map") or {})
            reuse = bool(state.get("reuse_snapshots"))
            if not reuse:
                snapshot_map = {}
                for product in ranked:
                    snap_id = await uow.products.save(
                        product=product,
                        raw_payload=product.model_dump(mode="json"),
                        contract_version=CONTRACT_VERSION,
                    )
                    snapshot_map[product.id] = snap_id
                fx_ids = [await uow.fx_snapshots.save(snapshot=s) for s in state.get("fx", [])]
            else:
                fx_ids = list(state.get("cached_fx_snapshot_ids") or [])
                for product in ranked:
                    snapshot_map.setdefault(product.id, snapshot_map.get(product.id, product.id))

            budget = mission.constraints.budget_cny
            ranked_records = [
                candidate_record(
                    product,
                    snapshot_id=snapshot_map[product.id],
                    fx=rates.get(product.native_currency),
                    rank=index + 1,
                    budget_cny=budget,
                )
                for index, product in enumerate(ranked)
            ]
            candidate_payload = {
                "snapshot_map": snapshot_map,
                "ranked": ranked_records,
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
            comparison_ids = state.get("comparison_snapshot_ids")
            updates = {
                "stage": stage,
                "turn_phase": TurnPhase.IDLE,
                "constraints_version": constraints_version,
                "candidate_set_id": candidate_set_id,
                "recommendation_run_id": run_id,
                "warnings": warnings,
                "dialogue": mission.dialogue,
                "belief": mission.belief,
            }
            if comparison_ids:
                updates["comparison_snapshot_ids"] = comparison_ids
            updated = mission.model_copy(update=updates)
            try:
                await uow.missions.save(updated, expected_version=run_version)
            except MissionVersionConflict:
                await uow.rollback()
                return {"status": RunnerStatus.SUPERSEDED, "warnings": ["运行基于旧版本约束，已标记 superseded"]}

            event_type = "recommendation.ready" if stage == MissionStage.READY else "run.degraded"
            citations = citations_from_ranked(ranked_records)
            agent_text = state.get("agent_message") or compose_ready_reply(
                ranked_records, mission.constraints
            )
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
                },
            )
            await uow.events.append(
                mission_id=mission.id,
                event_type="agent.message",
                payload={
                    "run_id": run_id,
                    "text": agent_text,
                    "act": "refine_constraints",
                    "constraints_version": constraints_version,
                    "snapshot_ids": [item["snapshot_id"] for item in citations],
                    "citations": citations,
                },
            )
            await uow.commit()

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
) -> dict:
    comparison_ids = state.get("comparison_snapshot_ids") or mission.comparison_snapshot_ids
    updated = mission.model_copy(
        update={
            "stage": current.stage,
            "turn_phase": TurnPhase.IDLE,
            "constraints_version": constraints_version,
            "candidate_set_id": current.candidate_set_id,
            "recommendation_run_id": current.recommendation_run_id,
            "comparison_snapshot_ids": comparison_ids,
            "warnings": warnings or current.warnings,
            "dialogue": mission.dialogue,
            "belief": mission.belief,
            "active_run_id": run_id,
        }
    )
    try:
        await uow.missions.save(updated, expected_version=run_version)
    except MissionVersionConflict:
        await uow.rollback()
        return {"status": RunnerStatus.SUPERSEDED, "warnings": ["运行基于旧版本约束，已标记 superseded"]}
    await uow.recommendation_runs.save(
        mission_id=mission.id, run_id=run_id, payload={"status": "completed"}
    )
    text = state.get("agent_message") or "已根据当前候选回答。"
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
    return {
        "status": RunnerStatus.COMPLETED,
        "candidate_set_id": current.candidate_set_id,
        "recommendation_run_id": current.recommendation_run_id,
    }
