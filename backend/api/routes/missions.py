"""Mission 命令与查询路由（P4-W02）。Route 只调用 Application Service。"""
from __future__ import annotations

from fastapi import APIRouter, Depends, Query

from ...application.dto import MissionConstraints
from ..dependencies import get_anonymous_user_id, get_command_service
from ..schemas import (
    ComparisonRequest,
    ConstraintsUpdateRequest,
    CreateMissionRequest,
    MessageRequest,
    RunAccepted,
    UndoRequest,
)

router = APIRouter(tags=["missions"])


@router.post("", status_code=201)
async def create_mission(
    body: CreateMissionRequest,
    svc=Depends(get_command_service),
    owner_id: str = Depends(get_anonymous_user_id),
) -> dict:
    """创建任务并提交第一条消息"""
    mission = await svc.create_mission(owner_id=owner_id, title=body.title or "新选购")
    run_id = await svc.submit_message(
        owner_id=owner_id, mission_id=mission.id, text=body.text, constraints_version=1
    )
    loaded = await svc.get_mission(owner_id=owner_id, mission_id=mission.id)
    return {
        "mission": loaded.model_dump(mode="json"),
        "run_id": run_id,
        "constraints_version": loaded.constraints_version,
    }


@router.get("")
async def list_missions(
    limit: int = Query(default=20, ge=1, le=100),
    offset: int = Query(default=0, ge=0),
    svc=Depends(get_command_service),
    owner_id: str = Depends(get_anonymous_user_id),
) -> dict:
    """分页获取当前匿名用户的任务列表（按 updated_at DESC, id ASC 稳定排序）。"""
    missions = await svc.list_missions(owner_id=owner_id, limit=limit, offset=offset)
    return {
        "missions": [m.model_dump(mode="json") for m in missions],
        "limit": limit,
        "offset": offset,
    }


@router.get("/{mission_id}")
async def get_mission(
    mission_id: str,
    svc=Depends(get_command_service),
    owner_id: str = Depends(get_anonymous_user_id),
) -> dict:
    """当前任务投影。"""
    mission = await svc.get_mission(owner_id=owner_id, mission_id=mission_id)
    return mission.model_dump(mode="json")


@router.post("/{mission_id}/messages", status_code=202, response_model=RunAccepted)
async def submit_message(
    mission_id: str,
    body: MessageRequest,
    svc=Depends(get_command_service),
    owner_id: str = Depends(get_anonymous_user_id),
) -> RunAccepted:
    """追加消息并启动新运行。"""
    mission = await svc.get_mission(owner_id=owner_id, mission_id=mission_id)
    run_id = await svc.submit_message(
        owner_id=owner_id,
        mission_id=mission_id,
        text=body.text,
        constraints_version=mission.constraints_version,
    )
    return RunAccepted(run_id=run_id, constraints_version=mission.constraints_version)


@router.patch("/{mission_id}/constraints", status_code=202, response_model=RunAccepted)
async def update_constraints(
    mission_id: str,
    body: ConstraintsUpdateRequest,
    svc=Depends(get_command_service),
    owner_id: str = Depends(get_anonymous_user_id),
) -> RunAccepted:
    """显式修改约束，产生新版本并启动运行。版本冲突返回 409。"""
    mission = await svc.get_mission(owner_id=owner_id, mission_id=mission_id)
    constraints = MissionConstraints(
        query=body.query,
        budget_cny=body.budget_cny,
        markets=body.markets or mission.constraints.markets,
        preference=body.preference or mission.constraints.preference,
        only_in_stock=body.only_in_stock
        if body.only_in_stock is not None
        else mission.constraints.only_in_stock,
    )
    run_id = await svc.update_constraints(
        owner_id=owner_id,
        mission_id=mission_id,
        constraints_version=body.constraints_version,
        constraints=constraints,
    )
    return RunAccepted(run_id=run_id, constraints_version=body.constraints_version + 1)


@router.post("/{mission_id}/undo", status_code=202, response_model=RunAccepted)
async def undo(
    mission_id: str,
    body: UndoRequest,
    svc=Depends(get_command_service),
    owner_id: str = Depends(get_anonymous_user_id),
) -> RunAccepted:
    """撤销最近一次可撤销条件变更。"""
    run_id = await svc.undo(
        owner_id=owner_id,
        mission_id=mission_id,
        constraints_version=body.constraints_version,
    )
    return RunAccepted(run_id=run_id, constraints_version=body.constraints_version + 1)


@router.put("/{mission_id}/comparison")
async def set_comparison(
    mission_id: str,
    body: ComparisonRequest,
    svc=Depends(get_command_service),
    owner_id: str = Depends(get_anonymous_user_id),
) -> dict:
    """替换 2–4 件比较集合（BUS-005）。数量校验失败返回 400。"""
    updated = await svc.set_comparison(
        owner_id=owner_id,
        mission_id=mission_id,
        constraints_version=body.constraints_version,
        snapshot_ids=body.snapshot_ids,
    )
    return updated.model_dump(mode="json")


@router.get("/{mission_id}/candidates")
async def get_candidates(
    mission_id: str,
    svc=Depends(get_command_service),
    owner_id: str = Depends(get_anonymous_user_id),
) -> dict:
    """当前版本候选集。无候选集时返回空结构。"""
    payload = await svc.get_candidates(owner_id=owner_id, mission_id=mission_id)
    if payload is None:
        return {"ranked": [], "snapshot_map": {}, "fx_snapshot_ids": []}
    return payload


@router.get("/{mission_id}/recommendation")
async def get_recommendation(
    mission_id: str,
    svc=Depends(get_command_service),
    owner_id: str = Depends(get_anonymous_user_id),
) -> dict:
    """当前已验证推荐。"""
    return await svc.get_recommendation(owner_id=owner_id, mission_id=mission_id)
