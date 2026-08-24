"""OpenAI 兼容 Chat Completions（DeepSeek 官方协议）。

默认对接 https://api.deepseek.com + deepseek-v4-flash。
只返回已校验的 IntentPatch / RecommendationDraft；非法结构或上游失败
转为 ModelUnavailableError，由 Agent 走确定性 fallback。
"""
from __future__ import annotations

import json
import re
from typing import Any

import httpx
from tenacity import AsyncRetrying, retry_if_exception, stop_after_attempt

from ...application.dto import (
    AssistantTurn,
    ChatMessage,
    DialogueAct,
    DialogueActKind,
    IntentPatch,
    RecommendationDraft,
    SlotId,
    ToolCall,
    ToolSpec,
    TurnPlan,
)
from ...application.dto.belief import SoftPref
from ...application.dto.dialogue import AskTopic
from ...application.dto.probe import Uncertainty
from ...application.errors import ModelUnavailableError, UpstreamUnavailableError
from ...application.services.parse_intent import canonicalize_spec_gates
from ...application.services.parse_intent import parse_intent as deterministic_parse_intent
from ...domain.models import VALID_MARKETS
from ..retry import is_retryable, retry_wait

DEFAULT_BASE_URL = "https://api.deepseek.com"
DEFAULT_MODEL = "deepseek-v4-flash"
_VALID_PREFERENCES = frozenset({"balanced", "battery", "noise", "lowest"})
_JSON_FENCE = re.compile(r"```(?:json)?\s*(.*?)\s*```", re.S)


def completions_url(base_url: str) -> str:
    base = (base_url or DEFAULT_BASE_URL).rstrip("/")
    if base.endswith("/chat/completions"):
        return base
    return f"{base}/chat/completions"


def _parse_retry_after(resp: httpx.Response) -> float | None:
    value = resp.headers.get("Retry-After")
    if not value:
        return None
    try:
        return float(value)
    except ValueError:
        return None


def extract_json_object(text: str) -> dict[str, Any]:
    raw = (text or "").strip()
    fenced = _JSON_FENCE.search(raw)
    if fenced:
        raw = fenced.group(1).strip()
    try:
        payload = json.loads(raw)
    except json.JSONDecodeError:
        start, end = raw.find("{"), raw.rfind("}")
        if start < 0 or end <= start:
            raise ValueError("模型未返回 JSON 对象") from None
        payload = json.loads(raw[start : end + 1])
    if not isinstance(payload, dict):
        raise ValueError("模型 JSON 根节点必须是对象")
    return payload


_VALID_STANCES = frozenset({"too_expensive", "want_cheaper", "want_lighter"})
_TALK_KINDS = frozenset(
    {
        DialogueActKind.ASK_ITEM,
        DialogueActKind.ASK_SET,
        DialogueActKind.COMPARE,
        DialogueActKind.REJECT,
        DialogueActKind.STANCE,
        DialogueActKind.META,
        DialogueActKind.UNDO,
    }
)


_RESERVED_SOFT_ATTRS = frozenset({"price", "weight"})
_MAX_SOFT_PREFS = 4
_MAX_SOFT_CUES = 8


def _sanitize_soft_prefs(dims: list[SoftPref] | None) -> list[SoftPref] | None:
    """收紧 LLM 产出的开放式软偏好：去空、限量、方向合法、状态强制 active。

    price/weight 有各自专门通道，不接受 LLM 从这里改写。"""
    if not dims:
        return None
    cleaned: list[SoftPref] = []
    seen: set[str] = set()
    for dim in dims:
        attr = (dim.attr or "").strip()
        if not attr or attr in _RESERVED_SOFT_ATTRS or attr in seen:
            continue
        seen.add(attr)
        direction = dim.direction if dim.direction in {"higher", "lower"} else "higher"
        cues = [c.strip() for c in (dim.cues or []) if c and c.strip()][:_MAX_SOFT_CUES]
        cleaned.append(SoftPref(attr=attr, direction=direction, status="active", cues=cues))
        if len(cleaned) >= _MAX_SOFT_PREFS:
            break
    return cleaned or None


def sanitize_intent_patch(patch: IntentPatch) -> IntentPatch:
    markets = None
    if patch.markets:
        markets = [code for code in patch.markets if code in VALID_MARKETS] or None
    preference = patch.preference if patch.preference in _VALID_PREFERENCES else None
    query = (patch.query or "").strip() or None
    clarification_updates = (
        {"requires_clarification": False, "clarification_question": None}
        if query
        else {}
    )
    return patch.model_copy(
        update={
            "query": query,
            "markets": markets,
            "preference": preference,
            "soft_prefs": _sanitize_soft_prefs(patch.soft_prefs),
            "source": "model",
            **clarification_updates,
        }
    )


def merge_deterministic_intent(
    model_patch: IntentPatch,
    text: str,
    *,
    current_query: str | None = None,
) -> IntentPatch:
    """Make directly parsed user facts authoritative over stochastic output.

    The model may enrich open-ended preferences, but it must not erase or
    contradict a target, budget, market, stock request, use case, or hard spec
    gate that the deterministic parser observed in the same utterance.
    Clarification is derived after that merge so a transient model omission
    cannot turn a fully specified request into an unnecessary question.
    """
    patch = sanitize_intent_patch(model_patch)
    baseline = deterministic_parse_intent(text, current_query=current_query)
    updates: dict[str, Any] = {}
    normalized_model_gates = canonicalize_spec_gates(list(patch.spec_gates or []))
    if normalized_model_gates != list(patch.spec_gates or []):
        updates["spec_gates"] = normalized_model_gates or None
    for field in (
        "query",
        "budget_cny",
        "markets",
        "preference",
        "only_in_stock",
        "exclude_terms",
        "use_case",
        "spec_gates",
    ):
        value = getattr(baseline, field)
        if value is not None:
            updates[field] = value
    known_target = bool(updates.get("query") or patch.query or current_query)
    if known_target:
        updates.update(
            requires_clarification=False,
            clarification_question=None,
        )
    elif baseline.requires_clarification:
        updates["requires_clarification"] = True
        if not patch.clarification_question:
            updates["clarification_question"] = baseline.clarification_question
    return patch.model_copy(update=updates)


def sanitize_dialogue_act(act: DialogueAct) -> DialogueAct:
    patch = sanitize_intent_patch(act.patch) if act.patch is not None else None
    if act.kind in _TALK_KINDS and patch is not None:
        patch = patch.model_copy(update={"query": None, "requires_clarification": False})
    stance = act.stance if act.stance in _VALID_STANCES else None
    topic = act.topic if act.topic in set(AskTopic) else None
    return act.model_copy(
        update={
            "patch": patch,
            "stance": stance,
            "topic": topic,
            "source": "model",
        }
    )


def turn_plan_from_payload(payload: dict[str, Any]) -> TurnPlan:
    """``{ops:[...]}`` 或单 act JSON → TurnPlan。"""
    raw_ops = payload.get("ops")
    acts: list[DialogueAct] = []
    if isinstance(raw_ops, list) and raw_ops:
        for item in raw_ops:
            if not isinstance(item, dict):
                raise ValueError("模型决策 ops 项不是对象")
            acts.append(sanitize_dialogue_act(DialogueAct.model_validate(item)))
    else:
        acts.append(sanitize_dialogue_act(DialogueAct.model_validate(payload)))
    if not acts:
        raise ValueError("模型决策未给出可用 ops")
    return TurnPlan(ops=acts, leftover=[], lead=acts[0])


def _as_jsonable(value: object) -> Any:
    dump = getattr(value, "model_dump", None)
    if callable(dump):
        return dump(mode="json")
    if isinstance(value, list):
        return [_as_jsonable(item) for item in value]
    if isinstance(value, dict):
        return value
    return str(value)


def _candidate_brief(item: object) -> dict[str, Any]:
    data = _as_jsonable(item)
    if not isinstance(data, dict):
        return {"value": data}
    return {
        "id": data.get("id"),
        "title": data.get("title"),
        "merchant": data.get("merchant"),
        "country_code": data.get("country_code"),
        "rmb_price": data.get("rmb_price"),
        "native_price_amount": data.get("native_price_amount"),
        "native_currency": data.get("native_currency"),
        "fx_failed": data.get("fx_failed"),
        "unavailable": data.get("unavailable"),
    }


_SOFT_PREFS_RULE = """- soft_prefs 表达枚举 preference 之外的开放式偏好维度（防水、轻便、送礼、老人易用、
  游戏低延迟、大电池、更好散热…），是一个数组，每项 {attr, direction, cues}：
  - attr：该维度的简短标签（如「防水」「低延迟」）；
  - direction：higher 表示越强越好，lower 表示越低越好（默认 higher）；
  - cues：用于在商品标题里匹配该维度的线索词，务必给出中英文同义词与常见型号/术语
    （如防水→["防水","waterproof","ip67","ipx"]），以便确定性打分跨语言命中。
  - 不要把 price/weight 放进 soft_prefs（各有专门通道）；用户没提开放式偏好时省略或给空数组。"""

_INTENT_SYSTEM = f"""你是跨境购物意图解析器。只输出一个 JSON 对象，不要解释。
字段：query, budget_cny, markets, preference, only_in_stock, exclude_terms, soft_prefs,
confidence, requires_clarification, clarification_question。
规则：
- 未出现的字段用 null 或省略；不要编造用户没说的预算、市场或品类。
- query 只在用户明确商品/品类/型号时填写；「太贵了」「再便宜一点」不得写成 query。
- markets 只能是 US、SG、VN、TH、MY。
- preference 只能是 balanced、battery、noise、lowest。
- preference=noise 仅当用户说「优先降噪」；query 里的「降噪耳机」不是 preference。
{_SOFT_PREFS_RULE}
- 无法判断要买什么时 requires_clarification=true，并给一句中文追问。
- 不得输出价格、库存、链接或汇率。"""

_TURN_SYSTEM = """你是跨境购物对话行为分类器。只输出一个 JSON 对象，不要解释。
字段：kind, patch, referent_ranks, exclude_terms, stance, topic, confidence。
kind 只能是：refine_constraints, ask_about_item, ask_about_set, compare_items, reject_item,
express_stance, undo, meta, unknown。
规则：
- 比较、提问、否定、态度、撤销、能力询问不得改 query。这些 kind 的 patch.query 必须为 null。
- 「帮我比前两个 / 对比一下」→ compare_items，referent_ranks=[1,2]。
- 「这款保修吗 / 为什么推荐 / 有货吗」→ ask_about_item，并填 topic：warranty|why|stock|tradeoff|overview。
- 「有某平台/商户吗」→ ask_about_set，predicate.values 填用户原词，不要收成 ask_about_item，不要查平台名单。
- 「只要某平台」→ refine_constraints，patch.merchants 填用户原词；「只要美国」才写 patch.markets。
- 「不要这款 / 不要这个」→ reject_item，referent_ranks=[1]，不要把「这款」写成 exclude_terms。
- 「不要索尼」→ reject_item，exclude_terms=["索尼"]。
- 「太贵了 / 再便宜一点」→ express_stance，stance=too_expensive|want_cheaper，不得写成 query。
- 「更轻」→ express_stance，stance=want_lighter。
- 「降噪」出现在品类里不是 preference=noise；只有「优先降噪」才是。
- 用户提出「要防水 / 更轻便 / 送礼 / 游戏低延迟」等开放式偏好时，用 refine_constraints，
  在 patch.soft_prefs 里给出 {attr, direction, cues}（cues 需含中英文同义词），不要塞进 preference 枚举。
- 无法判断时 kind=unknown，patch.requires_clarification=true。
- 不得输出价格、库存、链接或汇率。"""

_DECISION_SYSTEM = """你是跨境购物口语决策器。只输出一个 JSON 对象，不要解释。
优先输出 {"ops": [DialogueAct, ...]}。一句里有多个动作时全部写入 ops，不要只留一个。
例如「帮我比前两个，不要入耳」→
{"ops":[{"kind":"compare_items","referent_ranks":[1,2]},{"kind":"reject_item","exclude_terms":["入耳"]}]}
若只有一个动作，也可直接输出该 DialogueAct（兼容单对象）。
每个 DialogueAct 字段：kind, patch, referent_ranks, exclude_terms, stance, topic, confidence。
kind 只能是：refine_constraints, ask_about_item, ask_about_set, compare_items, reject_item,
express_stance, undo, meta, unknown。
规则：
- 比较、提问、否定、态度、撤销、能力询问不得改 query。这些 kind 的 patch.query 必须为 null。
- 「帮我比前两个 / 对比一下」→ compare_items，referent_ranks=[1,2]。
- 「这款保修吗 / 为什么推荐 / 有货吗」→ ask_about_item，并填 topic：warranty|why|stock|tradeoff|overview。
- 「有某平台/商户吗」→ ask_about_set，predicate.values 填用户原词，不要收成 ask_about_item，不要查平台名单。
- 「只要某平台」→ refine_constraints，patch.merchants 填用户原词；「只要美国」才写 patch.markets。
- 「不要这款 / 不要这个」→ reject_item，referent_ranks=[1]，不要把「这款」写成 exclude_terms。
- 「不要索尼」→ reject_item，exclude_terms=["索尼"]。
- 「太贵了 / 再便宜一点」→ express_stance，stance=too_expensive|want_cheaper，不得写成 query。
- 「更轻」→ express_stance，stance=want_lighter。
- 「降噪」出现在品类里不是 preference=noise；只有「优先降噪」才是。
- 用户提出「要防水 / 更轻便 / 送礼 / 游戏低延迟」等开放式偏好时，用 refine_constraints，
  在 patch.soft_prefs 里给出 {attr, direction, cues}（cues 需含中英文同义词），不要塞进 preference 枚举。
- 「我反悔了 / 回到上一档 / 撤销刚才」→ undo，不要收成 refine 或概述第一件。
- 无法判断时 kind=unknown，patch.requires_clarification=true。
- 不得输出价格、库存、链接或汇率。"""

_PROBE_PICK_SYSTEM = """你是跨境购物追问选题器。只输出一个 JSON 对象：{"slot": "<id>"}。
slot 必须来自输入候选，只能是 query、budget、split、reject_reason。
不得选择直邮、保修、评分或列表外的槽。无法判断时 slot 用 null。"""

_DRAFT_SYSTEM = """你是证据约束的推荐起草器。只输出一个 JSON 对象，不要解释。
字段：primary_snapshot_id, alternative_snapshot_ids, rationale, tradeoffs, cited_evidence_ids。
规则：
- 所有 ID 必须来自输入候选的 id，禁止编造。
- rationale / tradeoffs 只能引用输入里已有的价格、市场、商户、缺失字段。
- 不得声称保修、配送、正品、评分或库存（除非 unavailable 未包含该字段且输入给了值）。
- alternative_snapshot_ids 最多 2 个。"""


class OpenAICompatModelBackend:
    """DeepSeek / 任意 OpenAI 兼容网关。httpx 调用，不引入 openai SDK。"""

    def __init__(
        self,
        api_key: str,
        *,
        base_url: str = DEFAULT_BASE_URL,
        model: str = DEFAULT_MODEL,
        timeout: float = 30.0,
        client: httpx.AsyncClient | None = None,
        max_retries: int = 2,
    ) -> None:
        self._api_key = api_key
        self._base_url = base_url or DEFAULT_BASE_URL
        self._model = model or DEFAULT_MODEL
        self._timeout = timeout
        self._max_retries = max_retries
        self._client = client or httpx.AsyncClient(timeout=timeout)

    def is_configured(self) -> bool:
        return bool(self._api_key)

    def supports_tools(self) -> bool:
        return bool(self._api_key)

    async def aclose(self) -> None:
        await self._client.aclose()

    async def chat(
        self, *, messages: list[ChatMessage], tools: list[ToolSpec]
    ) -> AssistantTurn:
        """原生 function/tool calling 一步。模型发起 tool_call 或给出终稿文本。"""
        if not self._api_key:
            raise ModelUnavailableError("LLM API Key 未配置")
        payload: dict[str, Any] = {
            "model": self._model,
            "messages": [_encode_message(m) for m in messages],
            "tools": [_encode_tool(t) for t in tools],
            "tool_choice": "auto",
            "stream": False,
        }
        try:
            body = await self._post(payload)
        except UpstreamUnavailableError as exc:
            raise ModelUnavailableError("模型上游不可用") from exc
        except httpx.HTTPError as exc:
            raise ModelUnavailableError("无法连接模型服务") from exc
        return _decode_turn(body)

    async def complete_json(self, *, system: str, user: str) -> dict[str, Any]:
        return await self._complete_json(system=system, user=user)

    async def parse_intent(
        self, text: str, *, current_query: str | None = None, context: dict | None = None
    ) -> IntentPatch:
        extra = f"\n当前检索词：{current_query or '（无）'}"
        if context:
            extra += "\n上下文：" + json.dumps(
                {
                    "dst": context.get("dst") or context.get("belief"),
                    "last_user": context.get("last_user"),
                    "use_case": (context.get("dst") or {}).get("use_case")
                    if isinstance(context.get("dst"), dict)
                    else None,
                },
                ensure_ascii=False,
            )
        payload = await self._complete_json(
            system=_INTENT_SYSTEM,
            user=f"用户输入：{text.strip()}{extra}",
        )
        try:
            patch = IntentPatch.model_validate(payload)
        except Exception as exc:
            raise ModelUnavailableError("模型意图结构无法通过 Schema 校验") from exc
        return merge_deterministic_intent(patch, text, current_query=current_query)

    async def parse_turn(
        self, text: str, *, current_query: str | None = None, context: dict | None = None
    ) -> DialogueAct:
        extra = ""
        if context:
            extra = "\n上下文：" + json.dumps(
                {
                    "dst": context.get("dst"),
                    "comparison": context.get("comparison"),
                    "focus": context.get("focus"),
                    "last_user": context.get("last_user"),
                    "last_agent": context.get("last_agent"),
                    "last_act": context.get("last_act"),
                    "ranked": context.get("ranked"),
                },
                ensure_ascii=False,
            )
        user = f"当前检索词：{current_query or '（无）'}\n用户输入：{text.strip()}{extra}"
        payload = await self._complete_json(system=_TURN_SYSTEM, user=user)
        try:
            act = DialogueAct.model_validate(payload)
        except Exception as exc:
            raise ModelUnavailableError("模型对话行为无法通过 Schema 校验") from exc
        return sanitize_dialogue_act(act)

    async def parse_decision(
        self, text: str, *, current_query: str | None = None, context: dict | None = None
    ) -> TurnPlan:
        extra = ""
        if context:
            extra = "\n上下文：" + json.dumps(
                {
                    "dst": context.get("dst"),
                    "comparison": context.get("comparison"),
                    "focus": context.get("focus"),
                    "last_user": context.get("last_user"),
                    "last_agent": context.get("last_agent"),
                    "last_act": context.get("last_act"),
                    "ranked": context.get("ranked"),
                },
                ensure_ascii=False,
            )
        user = f"当前检索词：{current_query or '（无）'}\n用户输入：{text.strip()}{extra}"
        payload = await self._complete_json(system=_DECISION_SYSTEM, user=user)
        try:
            return turn_plan_from_payload(payload)
        except Exception as exc:
            raise ModelUnavailableError("模型对话决策无法通过 Schema 校验") from exc

    async def pick_probe(self, uncertainties: list[Uncertainty]) -> SlotId | None:
        offered = [
            {
                "slot": item.slot.value,
                "observation": item.observation,
                "question": item.question,
            }
            for item in uncertainties
        ]
        payload = await self._complete_json(
            system=_PROBE_PICK_SYSTEM,
            user=json.dumps({"candidates": offered}, ensure_ascii=False),
        )
        raw = payload.get("slot")
        if raw is None:
            return None
        try:
            return SlotId(str(raw))
        except ValueError as exc:
            raise ModelUnavailableError("模型追问槽不在封闭 SlotId 内") from exc

    async def draft_recommendation(
        self,
        *,
        constraints: object,
        candidates: list[object],
        evidence: object,
    ) -> RecommendationDraft:
        user = json.dumps(
            {
                "constraints": _as_jsonable(constraints),
                "candidates": [_candidate_brief(item) for item in candidates],
                "deterministic_draft": _as_jsonable(evidence) if evidence is not None else None,
            },
            ensure_ascii=False,
        )
        payload = await self._complete_json(system=_DRAFT_SYSTEM, user=user)
        try:
            return RecommendationDraft.model_validate(payload)
        except Exception as exc:
            raise ModelUnavailableError("模型推荐草稿无法通过 Schema 校验") from exc

    async def _complete_json(self, *, system: str, user: str) -> dict[str, Any]:
        if not self._api_key:
            raise ModelUnavailableError("LLM API Key 未配置")
        parse_error: ValueError | json.JSONDecodeError | None = None
        request_system = system
        for attempt in range(2):
            try:
                body = await self._request(system=request_system, user=user)
            except UpstreamUnavailableError as exc:
                raise ModelUnavailableError("模型上游不可用，改用确定性解析") from exc
            except httpx.HTTPError as exc:
                raise ModelUnavailableError("无法连接模型服务") from exc
            text = _message_text(body)
            try:
                return extract_json_object(text)
            except (ValueError, json.JSONDecodeError) as exc:
                parse_error = exc
                if attempt == 0:
                    request_system = (
                        system
                        + "\n上一次输出不是完整可解析的 JSON。"
                        "请重新输出一个完整 JSON 对象，确保引号、方括号和花括号全部闭合。"
                    )
        raise ModelUnavailableError("模型未返回可用 JSON") from parse_error

    async def _request(self, *, system: str, user: str) -> dict[str, Any]:
        payload = {
            "model": self._model,
            "messages": [
                {"role": "system", "content": system},
                {"role": "user", "content": user},
            ],
            "stream": False,
            "response_format": {"type": "json_object"},
            "thinking": {"type": "disabled"},
        }
        return await self._post(payload)

    async def _post(self, payload: dict[str, Any]) -> dict[str, Any]:
        headers = {
            "Authorization": f"Bearer {self._api_key}",
            "Accept": "application/json",
            "Content-Type": "application/json",
        }
        async for attempt in AsyncRetrying(
            retry=retry_if_exception(is_retryable),
            wait=retry_wait,
            stop=stop_after_attempt(self._max_retries),
            reraise=True,
        ):
            with attempt:
                try:
                    resp = await self._client.post(
                        completions_url(self._base_url),
                        headers=headers,
                        json=payload,
                    )
                except httpx.HTTPError as exc:
                    raise UpstreamUnavailableError(
                        code="upstream_error",
                        category="upstream",
                        retryable=True,
                        user_message="无法连接模型服务",
                    ) from exc
                if resp.status_code == 401:
                    raise UpstreamUnavailableError(
                        code="auth_error",
                        category="system",
                        retryable=False,
                        status_code=401,
                    )
                if resp.status_code == 429:
                    raise UpstreamUnavailableError(
                        code="rate_limited",
                        category="upstream",
                        retryable=True,
                        status_code=429,
                        retry_after=_parse_retry_after(resp),
                    )
                if resp.status_code >= 500:
                    raise UpstreamUnavailableError(
                        code="upstream_error",
                        category="upstream",
                        retryable=True,
                        status_code=resp.status_code,
                    )
                if resp.status_code >= 400:
                    raise UpstreamUnavailableError(
                        code="invalid_request",
                        category="model",
                        retryable=False,
                        status_code=resp.status_code,
                    )
                try:
                    return resp.json()
                except ValueError as exc:
                    raise UpstreamUnavailableError(
                        code="parse_error", category="upstream", retryable=True
                    ) from exc
        raise UpstreamUnavailableError(code="upstream_error", retryable=True)


def _encode_tool(tool: ToolSpec) -> dict[str, Any]:
    return {
        "type": "function",
        "function": {
            "name": tool.name,
            "description": tool.description,
            "parameters": tool.parameters,
        },
    }


def _encode_message(message: ChatMessage) -> dict[str, Any]:
    encoded: dict[str, Any] = {"role": message.role}
    if message.content is not None:
        encoded["content"] = message.content
    if message.tool_calls:
        encoded["tool_calls"] = [
            {
                "id": call.id,
                "type": "function",
                "function": {
                    "name": call.name,
                    "arguments": json.dumps(call.arguments, ensure_ascii=False),
                },
            }
            for call in message.tool_calls
        ]
    if message.tool_call_id:
        encoded["tool_call_id"] = message.tool_call_id
    if message.name:
        encoded["name"] = message.name
    return encoded


def _decode_turn(body: dict[str, Any]) -> AssistantTurn:
    choices = body.get("choices")
    if not isinstance(choices, list) or not choices:
        raise ModelUnavailableError("模型响应缺少 choices")
    message = choices[0].get("message") if isinstance(choices[0], dict) else None
    if not isinstance(message, dict):
        raise ModelUnavailableError("模型响应缺少 message")
    calls: list[ToolCall] = []
    for index, raw in enumerate(message.get("tool_calls") or []):
        if not isinstance(raw, dict):
            continue
        fn = raw.get("function") or {}
        name = fn.get("name")
        if not name:
            continue
        arguments = _decode_arguments(fn.get("arguments"))
        calls.append(ToolCall(id=str(raw.get("id") or f"call_{index}"), name=str(name), arguments=arguments))
    content = message.get("content")
    return AssistantTurn(content=content if isinstance(content, str) else None, tool_calls=calls)


def _decode_arguments(raw: Any) -> dict[str, Any]:
    if isinstance(raw, dict):
        return raw
    if isinstance(raw, str) and raw.strip():
        try:
            parsed = json.loads(raw)
        except json.JSONDecodeError:
            return {}
        return parsed if isinstance(parsed, dict) else {}
    return {}


def _message_text(body: dict[str, Any]) -> str:
    choices = body.get("choices")
    if not isinstance(choices, list) or not choices:
        raise ModelUnavailableError("模型响应缺少 choices")
    message = choices[0].get("message") if isinstance(choices[0], dict) else None
    if not isinstance(message, dict):
        raise ModelUnavailableError("模型响应缺少 message")
    content = message.get("content")
    if isinstance(content, str) and content.strip():
        return content
    raise ModelUnavailableError("模型响应内容为空")
