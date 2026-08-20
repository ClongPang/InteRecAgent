"""对话式推荐的工作记忆。约束投影仍用 MissionConstraints；本模块只累积批评与软偏好。"""
from __future__ import annotations

from pydantic import BaseModel, Field


class SoftPref(BaseModel):
    """一个通用软偏好维度。cues 是该维度的匹配线索（同义词/跨语言/型号码），
    由 LLM 在解析时给出，使确定性打分能通用匹配任意维度，而无需在代码里写死品类枚举。"""

    attr: str
    direction: str = "higher"
    status: str = "active"  # active | unsupported
    cues: list[str] = Field(default_factory=list)


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
    asked_slots: list[str] = Field(default_factory=list)
    skipped_slots: list[str] = Field(default_factory=list)
    pending_slot: str | None = None

    def reject(self, snapshot_id: str, *, kind: str = "reject_item") -> PreferenceBelief:
        rejected = list(self.rejected_snapshot_ids)
        if snapshot_id and snapshot_id not in rejected:
            rejected.append(snapshot_id)
        critiques = list(self.critiques)
        critiques.append(Critique(kind=kind, snapshot_id=snapshot_id))
        return self.model_copy(update={"rejected_snapshot_ids": rejected, "critiques": critiques})

    def with_soft_prefs(self, dims: list[SoftPref]) -> PreferenceBelief:
        """并入 LLM 解析出的通用软偏好维度（按 attr 去重，新维度覆盖旧同名维度）。

        price/weight 等已有专门通道（价格态度、不支持维度）的维度不在此覆盖，
        以免打乱既定语义。"""
        if not dims:
            return self
        reserved = {"price", "weight"}
        merged: dict[str, SoftPref] = {
            item.attr: item for item in self.soft if item.attr in reserved
        }
        for item in self.soft:
            merged.setdefault(item.attr, item)
        for dim in dims:
            attr = (dim.attr or "").strip()
            if not attr or attr in reserved:
                continue
            merged[attr] = dim
        return self.model_copy(update={"soft": list(merged.values())})

    def mark_unsupported(self, attr: str, direction: str = "higher") -> PreferenceBelief:
        soft = [item for item in self.soft if item.attr != attr]
        soft.append(SoftPref(attr=attr, direction=direction, status="unsupported"))
        return self.model_copy(update={"soft": soft})

    def mark_asked(self, slot: str) -> PreferenceBelief:
        asked = list(self.asked_slots)
        if slot and slot not in asked:
            asked.append(slot)
        return self.model_copy(update={"asked_slots": asked, "pending_slot": slot})

    def mark_skipped(self, slot: str) -> PreferenceBelief:
        skipped = list(self.skipped_slots)
        if slot and slot not in skipped:
            skipped.append(slot)
        return self.model_copy(update={"skipped_slots": skipped, "pending_slot": None})

    def resolve_slot(self, slot: str) -> PreferenceBelief:
        skipped = [item for item in self.skipped_slots if item != slot]
        return self.model_copy(update={"skipped_slots": skipped, "pending_slot": None})

    def mark_price_stance(self, stance: str) -> PreferenceBelief:
        soft = [item for item in self.soft if item.attr != "price"]
        soft.append(SoftPref(attr="price", direction="lower", status="active"))
        critiques = list(self.critiques)
        critiques.append(Critique(kind="price_stance", attr="price"))
        return self.model_copy(
            update={"soft": soft, "critiques": critiques, "price_sensitivity": stance}
        )
