"""商品快照查询（规格 §6.1）。只返回可展示的标准化字段，不含 raw。"""
from __future__ import annotations

from fastapi import APIRouter, Depends

from ...application.dto import ProductCandidate
from ..dependencies import get_anonymous_user_id, get_command_service

router = APIRouter(prefix="/product-snapshots", tags=["snapshots"])


@router.get("/{snapshot_id}", response_model=ProductCandidate)
async def get_product_snapshot(
    snapshot_id: str,
    svc=Depends(get_command_service),
    _owner_id: str = Depends(get_anonymous_user_id),
) -> ProductCandidate:
    return await svc.get_snapshot(snapshot_id=snapshot_id)
