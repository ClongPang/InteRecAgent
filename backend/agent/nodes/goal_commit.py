"""Goal revision commit gate.

Any state that can affect research is compare-and-swapped before ProductSource is
called.  This makes a search execution attributable to an already committed
goal_version instead of an in-memory future state.
"""

from __future__ import annotations

from collections.abc import Callable

from ...application.dto import RunnerStatus
from ...application.errors import MissionVersionConflict
from ...application.ports import UnitOfWork
from ...application.services.goal import ensure_goal_authority
from ...application.services.turn_actions import ledger_constraint_event
from ..state import MissionGraphState
from .world import apply_world_ops


def make_commit_goal_revision(
    uow_factory: Callable[[], UnitOfWork],
    *,
    enabled_item_types: frozenset[str],
):
    async def commit_goal_revision(state: MissionGraphState) -> dict:
        world = await apply_world_ops(state, enabled_item_types=enabled_item_types)
        before = state["mission"]
        mission = world.get("mission", before)
        run_version = state["run_version"]
        baseline_goal = ensure_goal_authority(
            before.goal,
            before.constraints,
            version=max(before.goal.goal_version, before.constraints_version),
            belief=before.belief,
        )
        goal_changed = mission.goal != baseline_goal
        constraints_changed = mission.constraints != before.constraints
        revision_changed = goal_changed or constraints_changed
        committed_version = run_version + (1 if revision_changed else 0)
        mission = mission.model_copy(update={"constraints_version": committed_version})
        operations = list(world.get("goal_operations") or [])

        # Even non-mutating operations (ask/compare/research) belong to the audit
        # stream, so the CAS check is always performed before execution.
        async with uow_factory() as uow:
            current = await uow.missions.get(owner_id=before.owner_id, mission_id=before.id)
            if current is None or current.constraints_version != run_version:
                await uow.events.append(
                    mission_id=before.id,
                    event_type="run.superseded",
                    payload={"run_id": state["run_id"], "constraints_version": run_version},
                )
                await uow.recommendation_runs.mark_superseded(
                    mission_id=before.id, run_id=state["run_id"]
                )
                await uow.commit()
                return {
                    **world,
                    "mission": before,
                    "status": RunnerStatus.SUPERSEDED,
                    "goal_revision_blocked": True,
                    "warnings": ["运行基于旧版本目标，已在检索前阻止"],
                }

            if operations:
                await uow.events.append(
                    mission_id=mission.id,
                    event_type="goal.operations_proposed",
                    payload={
                        "run_id": state["run_id"],
                        "base_goal_version": before.goal.goal_version,
                        "operations": operations,
                    },
                )
            if revision_changed:
                try:
                    await uow.missions.save(mission, expected_version=run_version)
                except MissionVersionConflict:
                    await uow.rollback()
                    await uow.events.append(
                        mission_id=before.id,
                        event_type="run.superseded",
                        payload={"run_id": state["run_id"], "constraints_version": run_version},
                    )
                    await uow.recommendation_runs.mark_superseded(
                        mission_id=before.id, run_id=state["run_id"]
                    )
                    await uow.commit()
                    return {
                        **world,
                        "mission": before,
                        "status": RunnerStatus.SUPERSEDED,
                        "goal_revision_blocked": True,
                        "warnings": ["目标版本提交冲突，已在检索前阻止"],
                    }
                if constraints_changed:
                    event_type, event_payload = ledger_constraint_event(
                        undo_applied=bool(world.get("undo_applied")),
                        run_id=state["run_id"],
                        before=before.constraints,
                        after=mission.constraints,
                        version=committed_version,
                    )
                    await uow.events.append(
                        mission_id=mission.id,
                        event_type=event_type,
                        payload=event_payload,
                    )
            if operations:
                await uow.events.append(
                    mission_id=mission.id,
                    event_type="goal.operations_committed",
                    payload={
                        "run_id": state["run_id"],
                        "goal_version": mission.goal.goal_version,
                        "constraints_version": committed_version,
                        "operations": operations,
                    },
                )
            await uow.commit()

        return {
            **world,
            "mission": mission,
            "run_version": committed_version,
            "goal_revision_committed": True,
            "enabled_item_types": sorted(enabled_item_types),
        }

    return commit_goal_revision
