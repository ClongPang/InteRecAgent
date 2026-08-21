"""句式框架：只认封闭动词结构，不认商品名词。

有…吗 / 只要… / 不要… / 帮我比 / 太贵了。
中间的针原样交给 World 绑定。
"""
from __future__ import annotations

import re
from dataclasses import dataclass

from ..dto.dialogue import AskTopic, DialogueAct, DialogueActKind, SetPredicate
from ..dto.runner import IntentPatch
from .world import World, bind_market

_UNDO = re.compile(r"撤销|还原刚才|刚才的条件|undo", re.I)
_META = re.compile(r"你能做什么|你会什么|你是谁|怎么用")
_COMPARE = re.compile(r"比较|对比|横评|比一比|比一下|帮我比")
_PROBE = re.compile(
    r"有(?:没有)?\s*(?P<needle>.+?)(?:平台|商户|店站)?\s*的?\s*吗",
    re.I,
)
_FILTER = re.compile(
    r"(?:只要|只看|仅看)\s*(?P<needle>[^，,。；;]+?)(?:平台|商户|店)?(?:[，,。；;]|$)",
    re.I,
)
_STOCK_FILTER = re.compile(r"只看有货|仅看有货")
_REJECT = re.compile(r"(?:不要|别买|排除)\s*([^\s，,。；;]+)")
_ASK_WARRANTY = re.compile(r"保修|质保|售后|退货|退换")
_ASK_STOCK = re.compile(r"有货|库存|缺货|现货")
_ASK_WHY = re.compile(r"为什么推荐|为什么选|为何选|推荐理由")
_ASK_TRADEOFF = re.compile(r"差在哪|哪款好|有什么区别")
_ASK_ITEM = re.compile(r"怎么样|这款|这一款|这个呢")
_STANCE_EXPENSIVE = re.compile(r"太贵|好贵|贵了|超出预算")
_STANCE_CHEAPER = re.compile(r"再便宜|便宜点|更便宜|降低预算|收一[点下]预算")
_STANCE_LIGHTER = re.compile(r"更轻|轻一点|轻便一点|太重")
_RANK_FIRST = re.compile(r"第[一1]件|第一个|首选")
_RANK_SECOND = re.compile(r"第[二2]件|第二个")
_RANK_THIRD = re.compile(r"第[三3]件|第三个")
_RANK_TOP2 = re.compile(r"前两[个件]|这两[个件]")
_RANK_LAST = re.compile(r"最后[一那这]?[个件]|末尾")
_REF_FOCUS = re.compile(r"刚才那个|刚才的|刚刚那")
_REF_CHEAP = re.compile(r"便宜那个|便宜的那|最便宜")
_REF_DEIXIS = re.compile(r"那[个款]|这[个款]|那个")
_NOT_INEAR = re.compile(r"不是入耳|不要入耳|不要耳塞")
_WANT_OVEREAR = re.compile(r"是头戴|要头戴|头戴式")
_DEIXIS_STRIP = re.compile(
    r"刚才的?|刚刚的?|那[个款]|这[个款]|那个|怎么样|如何|呢|啊|的",
)
_CLOSED_PROBE = frozenset({"货", "库存", "缺货", "现货"})
_CLOSED_FILTER = frozenset({"有货", "库存", "现货", "头戴", "入耳", "耳塞", "开放", "开放式"})


@dataclass(frozen=True)
class Frame:
    kind: DialogueActKind
    needle: str | None = None
    topic: AskTopic | None = None
    stance: str | None = None


def is_undo_text(text: str) -> bool:
    return bool(_UNDO.search(text or ""))


def collect_acts(
    text: str,
    *,
    current_query: str | None = None,
    world: World | None = None,
) -> list[DialogueAct]:
    """抽出本句全部独立运算。撤销/元能力独占。"""
    del world
    raw = (text or "").strip()
    if not raw:
        return []
    if _UNDO.search(raw):
        return [DialogueAct(kind=DialogueActKind.UNDO)]
    if _META.search(raw):
        return [DialogueAct(kind=DialogueActKind.META)]
    if _STOCK_FILTER.search(raw):
        return []
    acts: list[DialogueAct] = []
    probe = parse_probe_needle(raw)
    if probe is not None:
        if probe in _CLOSED_PROBE:
            acts.append(
                DialogueAct(
                    kind=DialogueActKind.ASK_ITEM,
                    topic=AskTopic.STOCK,
                    referent_ranks=referent_ranks(raw, default=(1,)),
                )
            )
        else:
            acts.append(
                DialogueAct(
                    kind=DialogueActKind.ASK_SET,
                    predicate=SetPredicate(attr="merchant", values=[probe.lower()], label=probe),
                )
            )
    if _COMPARE.search(raw):
        acts.append(
            DialogueAct(
                kind=DialogueActKind.COMPARE,
                referent_ranks=referent_ranks(raw, default=(1, 2)),
            )
        )
    rejected = _REJECT.search(raw)
    if rejected:
        term = rejected.group(1).strip("的了呢啊")
        if term in {"这款", "这一款", "这个", "它"}:
            acts.append(
                DialogueAct(
                    kind=DialogueActKind.REJECT,
                    referent_ranks=referent_ranks(raw, default=(1,)),
                )
            )
        elif term:
            acts.append(DialogueAct(kind=DialogueActKind.REJECT, exclude_terms=[term]))
    if not any(
        item.kind
        in {
            DialogueActKind.ASK_ITEM,
            DialogueActKind.ASK_SET,
            DialogueActKind.REJECT,
            DialogueActKind.COMPARE,
            DialogueActKind.STANCE,
        }
        for item in acts
    ):
        topic = detect_ask_topic(raw)
        if (topic != AskTopic.OVERVIEW or _ASK_ITEM.search(raw)) and probe is None:
            acts.append(
                DialogueAct(
                    kind=DialogueActKind.ASK_ITEM,
                    referent_ranks=referent_ranks(raw, default=(1,)),
                    topic=topic,
                )
            )
    stance = detect_stance(raw)
    if stance:
        acts.append(DialogueAct(kind=DialogueActKind.STANCE, stance=stance))
    if current_query and _NOT_INEAR.search(raw):
        acts.append(
            DialogueAct(
                kind=DialogueActKind.REFINE,
                patch=IntentPatch(query=current_query, exclude_terms=["入耳", "耳塞"]),
            )
        )
    if current_query and _WANT_OVEREAR.search(raw):
        query = current_query if "头戴" in current_query else f"{current_query} 头戴"
        acts.append(DialogueAct(kind=DialogueActKind.REFINE, patch=IntentPatch(query=query)))
    filtered = parse_filter_needle(raw)
    if filtered is not None:
        acts.append(_filter_act(filtered, current_query))
    if (
        current_query
        and referent_hint(raw)
        and not any(
            item.kind
            in {
                DialogueActKind.ASK_ITEM,
                DialogueActKind.REJECT,
                DialogueActKind.ASK_SET,
                DialogueActKind.COMPARE,
            }
            for item in acts
        )
    ):
        acts.append(
            DialogueAct(
                kind=DialogueActKind.ASK_ITEM,
                referent_ranks=referent_ranks(raw, default=(1,)),
                topic=detect_ask_topic(raw),
            )
        )
    return acts


def propose_act(
    text: str,
    *,
    current_query: str | None = None,
    world: World | None = None,
) -> DialogueAct | None:
    acts = collect_acts(text, current_query=current_query, world=world)
    return acts[0] if acts else None


def parse_probe_needle(text: str) -> str | None:
    match = _PROBE.search((text or "").strip())
    if not match:
        return None
    return _clean(match.group("needle"))


def parse_filter_needle(text: str) -> str | None:
    raw = (text or "").strip()
    if not raw or _STOCK_FILTER.search(raw):
        return None
    match = _FILTER.search(raw)
    if not match:
        return None
    needle = _clean(match.group("needle"))
    if not needle or needle in _CLOSED_FILTER:
        return None
    return needle


def detect_ask_topic(text: str) -> AskTopic:
    if _ASK_WARRANTY.search(text):
        return AskTopic.WARRANTY
    if _ASK_STOCK.search(text):
        return AskTopic.STOCK
    if _ASK_WHY.search(text):
        return AskTopic.WHY
    if _ASK_TRADEOFF.search(text):
        return AskTopic.TRADEOFF
    return AskTopic.OVERVIEW


def detect_stance(text: str) -> str | None:
    if _STANCE_EXPENSIVE.search(text):
        return "too_expensive"
    if _STANCE_CHEAPER.search(text):
        return "want_cheaper"
    if _STANCE_LIGHTER.search(text):
        return "want_lighter"
    return None


def referent_hint(text: str) -> str | None:
    raw = text or ""
    if _REF_FOCUS.search(raw):
        return "focus"
    if _REF_CHEAP.search(raw):
        return "cheapest"
    token = referent_token(raw)
    if token:
        return f"token:{token}"
    if _REF_DEIXIS.search(raw):
        return "focus"
    return None


def referent_token(text: str) -> str | None:
    raw = text or ""
    if not (_REF_DEIXIS.search(raw) or _REF_FOCUS.search(raw)):
        return None
    leftover = _DEIXIS_STRIP.sub(" ", raw)
    leftover = re.sub(r"\s+", "", leftover).strip(" 的了呢啊吗？?")
    return leftover or None


def referent_ranks(text: str, *, default: tuple[int, ...]) -> list[int]:
    if _RANK_TOP2.search(text):
        return [1, 2]
    ranks: list[int] = []
    if _RANK_FIRST.search(text) or re.search(r"这款|这一款|这个", text):
        ranks.append(1)
    if _RANK_SECOND.search(text):
        ranks.append(2)
    if _RANK_THIRD.search(text):
        ranks.append(3)
    if _RANK_LAST.search(text):
        ranks.append(-1)
    return ranks or list(default)


def _filter_act(needle: str, current_query: str | None) -> DialogueAct:
    market = bind_market(needle)
    if market:
        return DialogueAct(
            kind=DialogueActKind.REFINE,
            patch=IntentPatch(query=current_query, markets=[market]),
        )
    return DialogueAct(
        kind=DialogueActKind.REFINE,
        patch=IntentPatch(query=current_query, merchants=[needle.lower()]),
        predicate=SetPredicate(attr="merchant", values=[needle.lower()], label=needle),
    )


def _clean(raw: str) -> str:
    return re.sub(r"^(?:的|了)+|(?:的|了)+$", "", (raw or "").strip(" 的了呢啊吗？?"))
