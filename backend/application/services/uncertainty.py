"""把「会翻盘的未知条件」做成可计算事实，再升格为至多一条 Probe。

问句必须能兑现（进 IntentPatch → 过滤/排序/检索）。直邮、保修、评分为不可问。
LLM 不参与选题；生产和评测共用 SlotId。
"""
from __future__ import annotations

from dataclasses import dataclass

from ..dto.belief import PreferenceBelief
from ..dto.dialogue import DialogueAct, DialogueActKind, NextMove
from ..dto.mission import MissionConstraints
from ..dto.probe import Probe, ProbeOption, SlotId, Uncertainty
from ..dto.runner import IntentPatch
from .next_move import next_moves_for
from .parse_intent import CLARIFYING_QUESTION

BUDGET_SPREAD_MIN = 400.0
SPLIT_MIN_GROUP = 2

_FORM_GROUPS: dict[str, tuple[str, ...]] = {
    "overear": ("头戴", "over-ear", "over ear", "overear", "wh-1000", "wh1000", "headset"),
    "inear": ("入耳", "耳塞", "earbud", "earbuds", "in-ear", "inear", "earphone"),
    "openear": ("open-ear", "open ear", "开放式", "open headphone"),
}

_FORM_EXCLUDE = {
    "overear": "入耳",
    "inear": "头戴",
    "openear": "头戴",
}

_PASSIVE_KINDS = {
    DialogueActKind.ASK_ITEM,
    DialogueActKind.COMPARE,
    DialogueActKind.META,
    DialogueActKind.UNDO,
}


@dataclass(frozen=True)
class CandidateView:
    id: str
    title: str
    cny: float | None
    brand: str | None = None


def record_cny(record: object) -> float | None:
    if hasattr(record, "rmb_price") and not getattr(record, "fx_failed", False):
        price = getattr(record, "rmb_price", None)
        return float(price) if price is not None else None
    if not isinstance(record, dict):
        return None
    estimated = record.get("estimated_cny")
    if isinstance(estimated, dict) and estimated.get("amount") is not None:
        return float(estimated["amount"])
    if estimated is not None and not isinstance(estimated, dict):
        try:
            return float(estimated)
        except (TypeError, ValueError):
            return None
    return None


def views_from_ranked(ranked: list | None) -> list[CandidateView]:
    out: list[CandidateView] = []
    for item in ranked or []:
        if hasattr(item, "title") and hasattr(item, "id"):
            brand = None
            attrs = getattr(item, "attrs", None) or {}
            if isinstance(attrs, dict):
                brand = attrs.get("brand")
            out.append(
                CandidateView(
                    id=str(item.id),
                    title=str(item.title or ""),
                    cny=record_cny(item),
                    brand=brand,
                )
            )
            continue
        if not isinstance(item, dict):
            continue
        ident = item.get("snapshot_id") or item.get("id") or item.get("source_product_id")
        if not ident:
            continue
        out.append(
            CandidateView(
                id=str(ident),
                title=str(item.get("title") or ""),
                cny=record_cny(item),
                brand=(str(item["brand"]) if item.get("brand") else None),
            )
        )
    return out


def assess_uncertainty(
    *,
    constraints: MissionConstraints,
    belief: PreferenceBelief,
    ranked: list | None = None,
    last_act: DialogueAct | None = None,
) -> list[Uncertainty]:
    """全部可兑现不确定，按严重度降序。不选题。"""
    found: list[Uncertainty] = []
    if not constraints.query:
        found.append(_query_uncertainty())
    views = views_from_ranked(ranked)
    budget = _budget_uncertainty(constraints, belief, views)
    if budget is not None:
        found.append(budget)
    split = _form_split_uncertainty(constraints, belief, views)
    if split is not None:
        found.append(split)
    reject = _reject_reason_uncertainty(belief, last_act, views)
    if reject is not None:
        found.append(reject)
    found.sort(key=lambda item: item.severity, reverse=True)
    return found


def select_probe(
    *,
    constraints: MissionConstraints,
    belief: PreferenceBelief,
    ranked: list | None = None,
    last_act: DialogueAct | None = None,
) -> Probe | None:
    """升格恰好一条。无 query 才 blocking。"""
    blocked = set(belief.asked_slots) | set(belief.skipped_slots)
    for item in assess_uncertainty(
        constraints=constraints, belief=belief, ranked=ranked, last_act=last_act
    ):
        if not item.actionable or item.slot.value in blocked:
            continue
        if item.slot == SlotId.QUERY:
            return _to_probe(item, blocking=True)
        if not constraints.query:
            continue
        return _to_probe(item, blocking=False)
    return None


def bind_emitted_probe(belief: PreferenceBelief, probe: Probe | None) -> PreferenceBelief:
    if probe is None:
        return belief
    return belief.mark_asked(probe.slot.value)


def probe_event_fields(probe: Probe | None) -> dict:
    if probe is None:
        return {}
    return {
        "next_moves": [item.model_dump() for item in probe.next_moves()],
        "probe": probe.model_dump(mode="json"),
    }


def present_probe(probe: Probe | None, text: str) -> tuple[str, list[NextMove]]:
    if probe is None:
        return text, []
    question = probe.question.strip()
    combined = text
    if question and question not in (text or ""):
        combined = f"{text.rstrip()}\n\n{question}" if text else question
    return combined, probe.next_moves()


def moves_for_reply(
    probe: Probe | None,
    *,
    kind: str | None,
    topic: str | None,
    has_query: bool,
    has_candidates: bool,
    ranked: list | None = None,
    belief: PreferenceBelief | None = None,
    budget_cny: float | None = None,
) -> list[NextMove]:
    if probe is not None:
        return probe.next_moves()
    return next_moves_for(
        kind=kind,
        topic=topic,
        has_query=has_query,
        has_candidates=has_candidates,
        ranked=list(ranked or []),
        belief=belief,
        budget_cny=budget_cny,
    )


def resolve_probe_coverage(
    belief: PreferenceBelief,
    act: DialogueAct,
    *,
    before: MissionConstraints | None = None,
    after: MissionConstraints | None = None,
) -> PreferenceBelief:
    """用户回答了挂起的槽则消解；问旁支不跳过；其余视为跳过。"""
    pending = belief.pending_slot
    if not pending:
        return belief
    if act.kind in _PASSIVE_KINDS:
        return belief
    if _addresses(pending, act, before=before, after=after):
        return belief.resolve_slot(pending)
    return belief.mark_skipped(pending)


def _to_probe(item: Uncertainty, *, blocking: bool) -> Probe:
    return Probe(
        slot=item.slot,
        question=item.question,
        options=item.options,
        blocking=blocking,
        observation=item.observation,
        evidence_ids=item.evidence_ids,
        split_key=item.split_key,
    )


def _query_uncertainty() -> Uncertainty:
    return Uncertainty(
        slot=SlotId.QUERY,
        severity=1.0,
        observation="还没有商品品类或型号",
        question=CLARIFYING_QUESTION,
        options=[
            ProbeOption(label="通勤降噪耳机", text="通勤降噪耳机，预算 4000 元"),
            ProbeOption(label="27 寸 4K 显示器", text="27 寸 4K 显示器，预算 3000 元"),
            ProbeOption(label="轻便徒步鞋", text="轻便徒步鞋，预算 1000 元"),
        ],
    )


def _budget_uncertainty(
    constraints: MissionConstraints, belief: PreferenceBelief, views: list[CandidateView]
) -> Uncertainty | None:
    if constraints.budget_cny is not None:
        return None
    priced = [item for item in views if item.cny is not None]
    if len(priced) < 2:
        return None
    amounts = [item.cny for item in priced if item.cny is not None]
    lo, hi = min(amounts), max(amounts)
    if hi - lo < BUDGET_SPREAD_MIN:
        return None
    mid = round(((lo + hi) / 2) / 100.0) * 100.0
    low = max(100.0, round(lo / 100.0) * 100.0)
    options = [
        ProbeOption(label=f"预算 {low:.0f} 元", text=f"预算 {low:.0f} 元"),
        ProbeOption(label=f"预算 {mid:.0f} 元", text=f"预算 {mid:.0f} 元"),
        ProbeOption(label="先不设预算", text="先不设预算"),
    ]
    if belief.price_sensitivity in {"too_expensive", "want_cheaper"}:
        options[0], options[1] = options[1], options[0]
    return Uncertainty(
        slot=SlotId.BUDGET,
        severity=0.85,
        observation=f"候选人民币大约 {lo:.0f}–{hi:.0f} 元",
        question=f"这批候选人民币大约 {lo:.0f}–{hi:.0f} 元。预算大概定在哪？",
        options=options,
        evidence_ids=[item.id for item in priced[:4]],
    )


def _form_split_uncertainty(
    constraints: MissionConstraints, belief: PreferenceBelief, views: list[CandidateView]
) -> Uncertainty | None:
    del belief
    excluded = " ".join(constraints.excluded_terms)
    if any(token in excluded for token in ("头戴", "入耳", "耳塞", "开放")):
        return None
    if len(views) < SPLIT_MIN_GROUP * 2:
        return None
    groups: dict[str, list[CandidateView]] = {key: [] for key in _FORM_GROUPS}
    for item in views:
        text = item.title.lower()
        for key, cues in _FORM_GROUPS.items():
            if any(cue in text for cue in cues):
                groups[key].append(item)
                break
    live = {key: items for key, items in groups.items() if len(items) >= SPLIT_MIN_GROUP}
    if len(live) < 2:
        return None
    keys = list(live)
    labels = {"overear": "头戴", "inear": "入耳", "openear": "开放式"}
    options = [
        ProbeOption(
            label=f"只要{labels[key]}",
            text=f"只要{labels[key]}，不要{_FORM_EXCLUDE[key]}",
        )
        for key in keys[:2]
    ]
    options.append(ProbeOption(label="都可以", text="形态都可以"))
    return Uncertainty(
        slot=SlotId.SPLIT,
        severity=0.7,
        observation="候选被形态撕成两簇",
        question=(
            f"候选里既有{labels[keys[0]]}也有{labels[keys[1]]}。"
            "你更想要哪种？"
        ),
        options=options,
        evidence_ids=[item.id for items in live.values() for item in items[:2]],
        split_key="form",
    )


def _reject_reason_uncertainty(
    belief: PreferenceBelief, last_act: DialogueAct | None, views: list[CandidateView]
) -> Uncertainty | None:
    if last_act is None or last_act.kind != DialogueActKind.REJECT:
        return None
    if last_act.exclude_terms:
        return None
    if last_act.stance:
        return None
    if not belief.rejected_snapshot_ids:
        return None
    return Uncertainty(
        slot=SlotId.REJECT_REASON,
        severity=0.6,
        observation="否定了候选但没有原因",
        question="不要这款，是太贵、形态不对，还是换个品牌？",
        options=[
            ProbeOption(label="太贵了", text="太贵了"),
            ProbeOption(label="不要入耳", text="不要入耳"),
            ProbeOption(label="换个品牌", text="不要这个品牌"),
        ],
        evidence_ids=[views[0].id] if views else list(belief.rejected_snapshot_ids[:1]),
    )


def _addresses(
    slot: str,
    act: DialogueAct,
    *,
    before: MissionConstraints | None,
    after: MissionConstraints | None,
) -> bool:
    patch = act.patch or IntentPatch()
    if slot == SlotId.QUERY:
        return bool(after and after.query)
    if slot == SlotId.BUDGET:
        if act.kind == DialogueActKind.STANCE and act.stance in {"too_expensive", "want_cheaper"}:
            return True
        if patch.budget_cny is not None:
            return True
        return bool(
            before is not None
            and after is not None
            and after.budget_cny is not None
            and after.budget_cny != before.budget_cny
        )
    if slot == SlotId.SPLIT:
        if act.kind == DialogueActKind.REJECT and act.exclude_terms:
            return True
        if before is not None and after is not None:
            if after.excluded_terms != before.excluded_terms:
                return True
            if (after.query or "") != (before.query or ""):
                return True
        text = " ".join(act.exclude_terms + list(patch.exclude_terms or []))
        return any(token in text for token in ("头戴", "入耳", "耳塞", "开放"))
    if slot == SlotId.REJECT_REASON:
        return act.kind in {DialogueActKind.STANCE, DialogueActKind.REJECT} or bool(
            act.exclude_terms
        )
    return False
