"""对话式推荐的工作记忆。约束投影仍用 MissionConstraints；本模块只累积批评与软偏好。"""
from __future__ import annotations

from pydantic import BaseModel, Field


class SoftPref(BaseModel):
    attr: str
    direction: str = "higher"
    status: str = "active"  # active | unsupported


class Critique(BaseModel):
    kind: str
    snapshot_id: str | None = None
    attr: str | None = None


class PreferenceBelief(BaseModel):
    use_case: str | None = None
    rejected_snapshot_ids: list[str] = Field(default_factory=list)
    critiques: list[Critique] = Field(default_factory=list)
    soft: list[SoftPref] = Field(default_factory=list)
    price_sensitivity: str | None = None

    def reject(self, snapshot_id: str, *, kind: str = "reject_item") -> PreferenceBelief:
        rejected = list(self.rejected_snapshot_ids)
        if snapshot_id and snapshot_id not in rejected:
            rejected.append(snapshot_id)
        critiques = list(self.critiques)
        critiques.append(Critique(kind=kind, snapshot_id=snapshot_id))
        return self.model_copy(update={"rejected_snapshot_ids": rejected, "critiques": critiques})

    def mark_unsupported(self, attr: str, direction: str = "higher") -> PreferenceBelief:
        soft = [item for item in self.soft if item.attr != attr]
        soft.append(SoftPref(attr=attr, direction=direction, status="unsupported"))
        return self.model_copy(update={"soft": soft})

    def mark_price_stance(self, stance: str) -> PreferenceBelief:
        soft = [item for item in self.soft if item.attr != "price"]
        soft.append(SoftPref(attr="price", direction="lower", status="active"))
        critiques = list(self.critiques)
        critiques.append(Critique(kind="price_stance", attr="price"))
        return self.model_copy(
            update={"soft": soft, "critiques": critiques, "price_sensitivity": stance}
        )
