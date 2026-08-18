"""持久化决策快照节点（AGT-004/AGT-005、DAT-004）。"""
from __future__ import annotations

from collections.abc import Callable

from ...application.dto import MissionStage, RunnerStatus
from ...application.errors import MissionVersionConflict
from ...application.ports import UnitOfWork
from ...application.services.present import candidate_record, remap_draft
from ..state import MissionGraphState

CONTRACT_VERSION = "1.0"


def make_persist_decision_snapshot(uow_factory: Callable[[], UnitOfWork]):
    async def persist_decision_snapshot(state: MissionGraphState) -> dict:
        mission = state["mission"]
        run_id = state["run_id"]
        run_version = state["run_version"]
        warnings = list(state.get("warnings", []))

        async with uow_factory() as uow:
            # 澄清路径：只保存 stage=clarifying + 事件，不推进版本
            if state.get("requires_clarification"):
                updated = mission.model_copy(update={"stage": MissionStage.CLARIFYING})
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

            # 版本竞争：任务当前版本已推进 → 旧运行不提交候选/推荐（AGT-005）
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

            ranked = state.get("ranked", [])
            rates = state.get("rates") or {}
            snapshot_map: dict[str, str] = {}
            for product in ranked:
                snap_id = await uow.products.save(
                    product=product,
                    raw_payload=product.model_dump(mode="json"),
                    contract_version=CONTRACT_VERSION,
                )
                snapshot_map[product.id] = snap_id
            fx_ids = [await uow.fx_snapshots.save(snapshot=s) for s in state.get("fx", [])]

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
            }
            candidate_set_id = await uow.candidate_sets.save(
                mission_id=mission.id,
                run_id=run_id,
                constraints_version=mission.constraints_version,
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

            # 更新任务（版本条件写回）
            stage = MissionStage.READY if ranked else MissionStage.DEGRADED
            if state.get("fx_failed_currencies") or state.get("failed_markets"):
                stage = MissionStage.DEGRADED
            updated = mission.model_copy(
                update={
                    "stage": stage,
                    "candidate_set_id": candidate_set_id,
                    "recommendation_run_id": run_id,
                    "warnings": warnings,
                }
            )
            try:
                await uow.missions.save(updated, expected_version=run_version)
            except MissionVersionConflict:
                await uow.rollback()
                return {"status": RunnerStatus.SUPERSEDED, "warnings": ["运行基于旧版本约束，已标记 superseded"]}

            event_type = "recommendation.ready" if stage == MissionStage.READY else "run.degraded"
            await uow.events.append(
                mission_id=mission.id,
                event_type=event_type,
                payload={
                    "mission_id": mission.id,
                    "run_id": run_id,
                    "candidate_set_id": candidate_set_id,
                    "constraints_version": mission.constraints_version,
                    "count": len(ranked_records),
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
