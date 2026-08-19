"""由候选与信念缺口生成可执行下一句。"""
from __future__ import annotations

from ..dto.belief import PreferenceBelief
from ..dto.dialogue import AskTopic, DialogueActKind, NextMove


def next_moves_for(
    *,
    kind: str | None,
    topic: str | None,
    has_query: bool,
    has_candidates: bool,
    ranked: list[dict] | None = None,
    belief: PreferenceBelief | None = None,
) -> list[NextMove]:
    """上一轮结束后的可执行下一句。有候选时按价差/品牌差生成。"""
    if not has_query:
        return [
            NextMove(label="通勤降噪耳机", text="通勤降噪耳机，预算 4000 元"),
            NextMove(label="27 寸 4K 显示器", text="27 寸 4K 显示器，预算 3000 元"),
            NextMove(label="轻便徒步鞋", text="轻便徒步鞋，预算 1000 元"),
        ]
    unsupported_weight = bool(
        belief
        and any(item.attr == "weight" and item.status == "unsupported" for item in belief.soft)
    )
    delta_moves = _moves_from_ranked(ranked or [], skip_lighter=unsupported_weight)
    if topic == AskTopic.WARRANTY.value or topic == "warranty":
        return delta_moves[:1] + [
            NextMove(label="为什么选它", text="为什么推荐这款"),
            NextMove(label="换一款", text="不要这款"),
        ]
    if topic == AskTopic.STOCK.value or topic == "stock":
        return [
            NextMove(label="这款保修吗", text="这款保修吗"),
            NextMove(label="为什么推荐", text="为什么推荐"),
        ]
    if topic == AskTopic.TRADEOFF.value or kind == DialogueActKind.COMPARE.value:
        return [
            NextMove(label="为什么推荐", text="为什么推荐"),
            *delta_moves[:2],
        ]
    if kind == DialogueActKind.STANCE.value:
        return [
            NextMove(label="预算 2000 元", text="预算 2000 元"),
            NextMove(label="对比前两件", text="帮我比前两个"),
        ]
    if has_candidates:
        moves = [
            NextMove(label="为什么推荐", text="为什么推荐"),
            *delta_moves[:3],
        ]
        return _with_price_budget_move(moves, belief)
    return []


def _with_price_budget_move(moves: list[NextMove], belief: PreferenceBelief | None) -> list[NextMove]:
    if not belief or belief.price_sensitivity not in {"too_expensive", "want_cheaper"}:
        return moves
    if any(item.text.startswith("预算") for item in moves):
        return moves
    return [NextMove(label="预算 2000 元", text="预算 2000 元"), *moves]


def _moves_from_ranked(ranked: list[dict], *, skip_lighter: bool = False) -> list[NextMove]:
    del skip_lighter
    if len(ranked) < 2:
        return [
            NextMove(label="再便宜一点", text="再便宜一点"),
            NextMove(label="对比前两件", text="帮我比前两个"),
        ]
    first, second = ranked[0], ranked[1]
    moves = [NextMove(label="对比前两件", text="帮我比前两个")]
    cny_a = _record_cny(first)
    cny_b = _record_cny(second)
    if cny_a is not None and cny_b is not None and cny_a != cny_b:
        gap = abs(cny_a - cny_b)
        moves.append(NextMove(label=f"再收 ¥{gap:.0f}", text="再便宜一点"))
    else:
        moves.append(NextMove(label="再便宜一点", text="再便宜一点"))
    brand = (first.get("brand") or _title_brand(str(first.get("title") or "")) or "").strip()
    if brand:
        moves.append(NextMove(label=f"不要{brand}", text=f"不要{brand}"))
    else:
        moves.append(NextMove(label="不要这款", text="不要这款"))
    return moves


def _record_cny(record: dict) -> float | None:
    estimated = record.get("estimated_cny")
    if isinstance(estimated, dict) and estimated.get("amount") is not None:
        return float(estimated["amount"])
    if record.get("estimated_cny") is not None and not isinstance(record.get("estimated_cny"), dict):
        try:
            return float(record["estimated_cny"])
        except (TypeError, ValueError):
            return None
    return None


def _title_brand(title: str) -> str | None:
    for token in ("Sony", "Bose", "Apple", "Samsung", "Dell", "Salomon"):
        if token.lower() in title.lower():
            return token
    return None
