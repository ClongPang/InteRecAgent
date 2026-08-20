"""Mission API 请求/响应 Schema。"""
from __future__ import annotations

from pydantic import BaseModel, Field


class CreateMissionRequest(BaseModel):
    text: str = Field(min_length=1, max_length=2000)            # 品类、预算、市场都从这里解析，会话首句，同时创建任务
    title: str | None = Field(default=None, max_length=100)     # 任务在列表里的显示名，不填就是 「新选购」。不进分类，不当检索词


class ConstraintsUpdateRequest(BaseModel):
    constraints_version: int = Field(ge=1)
    query: str | None = Field(default=None, max_length=200)
    budget_cny: float | None = Field(default=None, ge=0, le=1_000_000)
    markets: list[str] | None = Field(default=None, max_length=10)
    preference: str | None = Field(default=None, pattern="^(balanced|battery|noise|lowest)$")
    only_in_stock: bool | None = None


class ComparisonRequest(BaseModel):
    constraints_version: int = Field(ge=1)
    snapshot_ids: list[str] = Field(
        min_length=2,
        max_length=4,
        description="当前候选集中的 snapshot_id（商品快照 UUID）",
    )


class TurnRequest(BaseModel):
    command: str = Field(default="message", pattern="^(message|undo)$")
    text: str | None = Field(default=None, max_length=2000)
    focus_snapshot_id: str | None = Field(default=None, max_length=64)
    constraints_version: int | None = Field(default=None, ge=1)


class RunAccepted(BaseModel):
    run_id: str
    constraints_version: int
