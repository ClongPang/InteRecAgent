"""只根据已引用快照组回复。缺字段就说没有，不编造保修、库存或评分。"""
from __future__ import annotations

from dataclasses import dataclass, field

from ..dto.belief import PreferenceBelief
from ..dto.dialogue import AskTopic, DialogueAct, DialogueActKind, NextMove
from ..dto.mission import MissionConstraints
from .nlu import (
    detect_ask_topic,
    detect_referent_hint,
    resolve_referent_ids,
    snapshot_ids_for_ranks,
)
from .parse_intent import CLARIFYING_QUESTION
from .world_ops import (
    compare_candidates,
    evaluate_set_query,
    parse_set_predicate,
    set_query_next_moves,
)


@dataclass(frozen=True)
class TalkReply:
    text: str
    snapshot_ids: list[str] = field(default_factory=list)
    citations: list[dict] = field(default_factory=list)
    comparison_snapshot_ids: list[str] | None = None
    next_moves: list[NextMove] = field(default_factory=list)
    requires_clarification: bool = False
    clarification_question: str | None = None


def cite_item(item: CitedFacts, *, role: str = "primary") -> dict:
    return {
        "snapshot_id": item.snapshot_id,
        "role": role,
        "title": item.title,
        "estimated_cny": item.cny,
        "market": item.market,
    }


def citations_from_ranked(ranked: list[dict], *, limit: int = 3) -> list[dict]:
    out: list[dict] = []
    for index, record in enumerate(ranked[:limit]):
        item = cited_facts(record)
        if item is not None:
            out.append(cite_item(item, role="primary" if index == 0 else "alternative"))
    return out


@dataclass(frozen=True)
class CitedFacts:
    snapshot_id: str
    title: str
    merchant: str | None
    market: str | None
    native_amount: float | None
    native_currency: str | None
    cny: float | None
    fx_failed: bool
    rank: int | None
    reasons: list[str]
    unavailable: list[str]
    merchant_url: str | None
    availability: str = "unknown"
    stock_source: str | None = None
    brand: str | None = None
    derived_fields: list[str] = field(default_factory=list)

    @property
    def within_budget(self) -> bool:
        return "within_budget" in self.reasons

    @property
    def lowest(self) -> bool:
        return "lowest_estimated_cny" in self.reasons


def cited_facts(record: dict) -> CitedFacts | None:
    snapshot_id = record.get("snapshot_id")
    if not snapshot_id:
        return None
    native = record.get("native_price") if isinstance(record.get("native_price"), dict) else {}
    estimated = record.get("estimated_cny") if isinstance(record.get("estimated_cny"), dict) else {}
    native_amount = native.get("amount", record.get("native_price_amount"))
    cny = estimated.get("amount", record.get("rmb_price"))
    attrs = record.get("attrs") if isinstance(record.get("attrs"), dict) else {}
    return CitedFacts(
        snapshot_id=str(snapshot_id),
        title=str(record.get("title") or "当前候选"),
        merchant=record.get("merchant"),
        market=record.get("market") or record.get("country_code"),
        native_amount=float(native_amount) if native_amount is not None else None,
        native_currency=str(native.get("currency") or record.get("native_currency") or "") or None,
        cny=float(cny) if cny is not None else None,
        fx_failed=bool(record.get("fx_failed")),
        rank=record.get("rank"),
        reasons=list(record.get("decision_reasons") or []),
        unavailable=list(record.get("unavailable_fields") or record.get("unavailable") or []),
        merchant_url=record.get("merchant_url") or record.get("click_url") or record.get("url"),
        availability=_availability_of(record),
        stock_source=record.get("stock_source") if record.get("stock_source") in {"top_level", "metadata"} else None,
        brand=record.get("brand") or attrs.get("brand"),
        derived_fields=list(record.get("derived_fields") or []),
    )


def compose_talk_reply(
    *,
    act: DialogueAct,
    text: str,
    ranked: list[dict],
    constraints: MissionConstraints,
    focus_snapshot_id: str | None = None,
    belief: PreferenceBelief | None = None,
    comparison_records: list[dict] | None = None,
) -> TalkReply:
    if act.kind == DialogueActKind.META:
        return TalkReply(
            text="我可以根据品类、预算和市场帮你检索并比较跨境商品。价格来自已校验快照；保修、运费和库存未提供时不会编造。"
        )
    if not ranked:
        return TalkReply(
            text="还没有可引用的候选。请先告诉我品类，例如「降噪耳机」。",
            requires_clarification=not bool(constraints.query),
            clarification_question=CLARIFYING_QUESTION if not constraints.query else None,
        )
    if act.kind == DialogueActKind.ASK_SET:
        return _set_query_reply(act, ranked, constraints, text)
    if act.kind == DialogueActKind.COMPARE or (act.kind == DialogueActKind.ASK_ITEM and _topic(act, text) == AskTopic.TRADEOFF):
        return _compare_reply(act, ranked, constraints, focus_snapshot_id, text=text)
    items = _resolve_items(
        act,
        ranked,
        focus_snapshot_id,
        text=text,
        comparison_records=comparison_records,
    )
    if not items:
        return TalkReply(text="当前候选里找不到你指的那一件，可以说「第一件」或先打开商品详情。")
    item = items[0]
    topic = _topic(act, text)
    cited = [cite_item(item, role="focus")]
    if act.kind == DialogueActKind.ASK_ITEM and topic == AskTopic.WARRANTY:
        return TalkReply(text=_warranty_reply(item), snapshot_ids=[item.snapshot_id], citations=cited)
    if act.kind == DialogueActKind.ASK_ITEM and topic == AskTopic.STOCK:
        return TalkReply(text=_stock_reply(item), snapshot_ids=[item.snapshot_id], citations=cited)
    if act.kind == DialogueActKind.ASK_ITEM and topic == AskTopic.WHY:
        return TalkReply(
            text=_why_reply(item, constraints, belief=belief),
            snapshot_ids=[item.snapshot_id],
            citations=cited,
        )
    if act.kind == DialogueActKind.ASK_ITEM:
        return TalkReply(text=_overview_reply(item, constraints), snapshot_ids=[item.snapshot_id], citations=cited)
    return TalkReply(text=_overview_reply(item, constraints), snapshot_ids=[item.snapshot_id], citations=cited)


def compose_ready_reply(
    ranked: list[dict],
    constraints: MissionConstraints,
    *,
    belief: PreferenceBelief | None = None,
    recall_mode: str | None = None,
) -> str:
    if not ranked:
        return "当前检索没有可用候选。"
    item = cited_facts(ranked[0])
    if item is None:
        return "当前检索没有可用候选。"
    text = _why_reply(item, constraints, belief=belief)
    if recall_mode == "exploratory" and not _looks_precise(constraints.query):
        text += "这是按关键词检索的探索结果，不是精确型号匹配。"
    return text


def _topic(act: DialogueAct, text: str) -> AskTopic:
    return act.topic or detect_ask_topic(text)


def _resolve_items(
    act: DialogueAct,
    ranked: list[dict],
    focus_snapshot_id: str | None,
    *,
    text: str = "",
    comparison_records: list[dict] | None = None,
) -> list[CitedFacts]:
    by_id = {str(item.get("snapshot_id")): item for item in ranked if item.get("snapshot_id")}
    hinted = resolve_referent_ids(
        text or "",
        ranked,
        focus_snapshot_id=focus_snapshot_id,
        comparison_records=comparison_records,
    )
    if hinted:
        items = [cited_facts(by_id[sid]) for sid in hinted if sid in by_id]
        found = [item for item in items if item is not None]
        if found:
            return found
    if comparison_records and detect_referent_hint(text or ""):
        return []
    if focus_snapshot_id and focus_snapshot_id in by_id:
        item = cited_facts(by_id[focus_snapshot_id])
        return [item] if item else []
    ranks = act.referent_ranks or [1]
    ids = snapshot_ids_for_ranks(ranked, ranks)
    items: list[CitedFacts] = []
    for sid in ids:
        fact = cited_facts(by_id[sid]) if sid in by_id else None
        if fact is not None:
            items.append(fact)
    if items:
        return items
    first = cited_facts(ranked[0])
    return [first] if first else []


def _compare_reply(
    act: DialogueAct,
    ranked: list[dict],
    constraints: MissionConstraints,
    focus_snapshot_id: str | None,
    *,
    text: str = "",
) -> TalkReply:
    ranks = act.referent_ranks or [1, 2]
    ids = snapshot_ids_for_ranks(ranked, ranks)
    ordered = [str(item.get("snapshot_id")) for item in ranked if item.get("snapshot_id")]
    if focus_snapshot_id and focus_snapshot_id in ordered:
        if "上一件" in text:
            index = ordered.index(focus_snapshot_id)
            previous = ordered[index - 1] if index > 0 else (ordered[1] if len(ordered) > 1 else None)
            ids = [focus_snapshot_id] + ([previous] if previous else [])
        else:
            others = [sid for sid in ordered if sid != focus_snapshot_id]
            ids = [focus_snapshot_id] + others[:1]
    if len(ids) < 2:
        ids = snapshot_ids_for_ranks(ranked, [1, 2])
    del constraints
    if not 2 <= len(ids) <= 4:
        return TalkReply(text="比较需要 2–4 件当前候选。可以说「帮我比前两个」。")
    by_id = {str(item.get("snapshot_id")): item for item in ranked}
    facts = [cited_facts(by_id[sid]) for sid in ids if sid in by_id]
    items = [item for item in facts if item is not None]
    if len(items) < 2:
        return TalkReply(text="比较需要 2–4 件当前候选。可以说「帮我比前两个」。")
    compared = compare_candidates([by_id[item.snapshot_id] for item in items])
    if compared is None:
        return TalkReply(text="比较需要 2–4 件当前候选。可以说「帮我比前两个」。")
    return TalkReply(
        text=_render_compare(compared),
        snapshot_ids=[item.snapshot_id for item in items],
        citations=[cite_item(item, role="compare") for item in items],
        comparison_snapshot_ids=[item.snapshot_id for item in items],
    )


def _set_query_reply(
    act: DialogueAct,
    ranked: list[dict],
    constraints: MissionConstraints,
    text: str,
) -> TalkReply:
    predicate = act.predicate or parse_set_predicate(text)
    if predicate is None:
        return TalkReply(text="可以说平台或商户名，例如「有 Lazada 吗」。")
    result = evaluate_set_query(ranked, predicate)
    moves = set_query_next_moves(result, query=constraints.query)
    if result.matched:
        names = "、".join(hit.display_name for hit in result.hits[:4])
        text_out = f"当前对照里有 {len(result.hits)} 件{result.predicate.label}：{names}。"
        cited = []
        for hit in result.hits[:4]:
            record = next((item for item in ranked if str(item.get("snapshot_id")) == hit.snapshot_id), None)
            if record:
                item = cited_facts(record)
                if item:
                    cited.append(cite_item(item, role="set"))
        return TalkReply(
            text=text_out,
            snapshot_ids=[hit.snapshot_id for hit in result.hits],
            citations=cited,
            next_moves=moves,
        )
    present = "、".join(result.merchants_present[:4]) if result.merchants_present else "现有商户"
    return TalkReply(
        text=(
            f"当前 {result.scanned} 件对照里没有{result.predicate.label}。"
            f"现有商户是 {present}。"
            f"要再搜{result.predicate.label}，还是先看现在这几款？"
        ),
        next_moves=moves,
    )


def _render_compare(result) -> str:
    lines = [
        f"{name}：{'，'.join(_compare_facts(result, index))}"
        for index, name in enumerate(result.names)
    ]
    diffs = result.non_price_diffs
    if diffs:
        summary = "；".join(
            f"{item.name}不同（{' / '.join(item.values)}）" for item in diffs
        )
        tail = f"主要差别：{summary}。"
    else:
        tail = "除估算价外，快照没有可对照的形态、商户或市场差异，这两件不好比。"
    if result.cheaper_index is not None:
        tail += f"{result.names[result.cheaper_index]} 估算更低。"
    tail += "保修、库存和评分未提供，不当对照依据。"
    return "按已记录事实对照：\n" + "\n".join(lines) + "\n" + tail


def _compare_facts(result, index: int) -> list[str]:
    parts: list[str] = []
    if index < len(result.prices):
        parts.append(f"估算约 {result.prices[index]}")
    for dim in result.dimensions:
        if dim.name == "估算" or index >= len(dim.values) or not dim.values[index]:
            continue
        if dim.name == "形态":
            parts.append(dim.values[index])
        elif dim.name == "市场":
            parts.append(f"市场 {dim.values[index]}")
        else:
            parts.append(dim.values[index])
    return parts


def _warranty_reply(item: CitedFacts) -> str:
    return (
        f"{item.title}：快照没有保修、退货或售后政策，我不能确认这款是否保修。"
        f"已经记录的是{_price_clause(item)}{_place_clause(item)}。"
        f"{_merchant_check(item)}"
    )


def _stock_reply(item: CitedFacts) -> str:
    merchant = item.stock_source == "metadata"
    if item.availability == "in_stock":
        stock = "店家标注为有货，这是 BuyWhere 转述，不是实时库存。" if merchant else "快照记录为有货。"
    elif item.availability == "out_of_stock":
        stock = "店家标注为无货，这是 BuyWhere 转述，不是实时库存。" if merchant else "快照记录为无货。"
    elif item.availability == "limited":
        stock = "店家标注库存有限，这是 BuyWhere 转述，不是实时库存。" if merchant else "快照记录库存有限。"
    else:
        stock = "快照没有库存或可买性字段，我不能判断现在是否有货。"
    confirm = "请到商户页确认。" if merchant or item.availability == "unknown" else ""
    return (
        f"{item.title}：{stock}{confirm}"
        f"已经记录的是{_price_clause(item)}{_place_clause(item)}。"
        f"{_merchant_check(item)}"
    )


def _why_reply(
    item: CitedFacts,
    constraints: MissionConstraints,
    *,
    belief: PreferenceBelief | None = None,
) -> str:
    parts = [f"推荐 {item.title}，依据是已记录的价格与市场，不是评分或商户声明的品牌。"]
    if item.lowest and item.cny is not None:
        parts.append(f"在当前已换算候选里，它的人民币估算最低，{_price_clause(item)}。")
    elif item.cny is not None:
        parts.append(f"已记录{_price_clause(item)}。")
    elif item.fx_failed:
        parts.append(f"{_price_clause(item)}，所以没有把它当成已确认的人民币价。")
    if item.within_budget and constraints.budget_cny is not None:
        parts.append(f"这个估算落在 {constraints.budget_cny:.0f} 元预算内。")
    elif constraints.budget_cny is not None and item.cny is not None and item.cny > constraints.budget_cny:
        parts.append(f"它高于当前 {constraints.budget_cny:.0f} 元预算，只是现有候选里相对更接近。")
    if "matches_noise_cue" in item.reasons:
        parts.append("标题含降噪相关描述，已按你的降噪偏好加权。")
    if "matches_battery_cue" in item.reasons:
        parts.append("标题含续航相关描述，已按你的续航偏好加权。")
    if item.brand and "brand" in item.derived_fields:
        parts.append(f"标题解析品牌为 {item.brand}，不是商户声明。")
    if belief and belief.rejected_snapshot_ids:
        parts.append("已排除你否定过的候选。")
    if belief and belief.price_sensitivity in {"too_expensive", "want_cheaper"}:
        parts.append("已记下「更便宜」的态度，但没有改硬预算。")
    if item.availability == "unknown" or "availability" in item.unavailable:
        parts.append("保修和库存未提供，因此不是推荐理由。")
    else:
        parts.append("保修未提供，因此不是推荐理由。")
    return "".join(parts)


def _overview_reply(item: CitedFacts, constraints: MissionConstraints) -> str:
    extras: list[str] = []
    if item.merchant:
        extras.append(item.merchant)
    if item.market:
        extras.append(f"市场 {item.market}")
    if item.within_budget and constraints.budget_cny is not None:
        extras.append(f"在 {constraints.budget_cny:.0f} 元预算内")
    extra = "，" + "，".join(extras) if extras else ""
    return (
        f"{item.title}：{_price_clause(item)}{extra}。"
        "快照未提供保修、库存、评分和品牌，这些不能用来判断好坏。"
    )


def _availability_of(record: dict) -> str:
    raw = record.get("availability")
    if raw in {"in_stock", "limited", "out_of_stock", "unknown"}:
        return str(raw)
    if record.get("in_stock") is True:
        return "in_stock"
    if record.get("in_stock") is False:
        return "out_of_stock"
    return "unknown"


def _price_clause(item: CitedFacts) -> str:
    if item.cny is not None:
        return f"估算约 {item.cny:.0f} 元"
    if item.fx_failed and item.native_amount is not None:
        currency = item.native_currency or "原币"
        amount = item.native_amount
        shown = f"{amount:.0f}" if amount == int(amount) else f"{amount:.2f}"
        return f"标价 {shown} {currency}，人民币估算因汇率暂不可用"
    return "价格尚未换算"


def _place_clause(item: CitedFacts) -> str:
    if item.market:
        return f"，市场 {item.market}"
    return ""


def _merchant_check(item: CitedFacts) -> str:
    if item.merchant_url:
        return "需要到商户页核对。"
    return "商户链接受限时，也没有额外政策字段可引用。"


def _looks_precise(query: str | None) -> bool:
    from .rec.retrieve import looks_like_exact_model

    return looks_like_exact_model(query)
