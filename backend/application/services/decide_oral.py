"""口语单一决策点：一次模型 JSON 或规则 fallback，再只做绑定。

不在这里改 kind。规则 propose_plan 只在模型不可用时出 ops，不再盖模型 lead。
"""
from __future__ import annotations

from ..dto.dialogue import DialogueAct, DialogueActKind, TurnPlan, TurnRoute
from ..dto.runner import IntentPatch
from ..errors import ModelUnavailableError
from ..ports import ModelBackend
from .nlu import ground_dialogue_act
from .plan import propose_plan
from .world import World

_TALK = {
    DialogueActKind.ASK_ITEM,
    DialogueActKind.ASK_SET,
    DialogueActKind.COMPARE,
    DialogueActKind.META,
}


async def decide_oral_turn(
    text: str,
    *,
    current_query: str | None,
    context: dict,
    ranked: list[dict],
    backend: ModelBackend,
) -> TurnPlan:
    world = World.from_ranked(ranked)
    if backend.is_configured():
        try:
            plan = await backend.parse_decision(
                text, current_query=current_query, context=context
            )
        except ModelUnavailableError:
            plan = propose_plan(text, current_query=current_query, world=world)
    else:
        plan = propose_plan(text, current_query=current_query, world=world)
    return bind_oral_plan(plan, text, current_query=current_query, ranked=ranked)


def bind_oral_plan(
    plan: TurnPlan,
    text: str,
    *,
    current_query: str | None,
    ranked: list[dict],
) -> TurnPlan:
    ops = [
        ground_dialogue_act(item, text, current_query=current_query, ranked=ranked)
        for item in (plan.ops or [plan.primary])
    ]
    leftover = [
        ground_dialogue_act(item, text, current_query=current_query, ranked=ranked)
        for item in plan.leftover
    ]
    lead: DialogueAct | None
    if plan.lead is not None:
        lead = ground_dialogue_act(plan.lead, text, current_query=current_query, ranked=ranked)
    else:
        lead = ops[0] if ops else None
    return TurnPlan(ops=ops, leftover=leftover, lead=lead)


def constraint_ops(plan: TurnPlan) -> list[DialogueAct]:
    return [
        item
        for item in plan.ops
        if item.kind not in _TALK and item.kind != DialogueActKind.UNDO
    ]


def fold_constraint_patch(constraints, plan: TurnPlan) -> IntentPatch:
    """把本轮全部约束 op 折成一条 IntentPatch，供 merge 一次写入。"""
    added: list[str] = []
    query = None
    budget = None
    markets = None
    preference = None
    only_in_stock = None
    merchants = None
    use_case = None
    spec_gates = None
    soft_prefs = None
    clarify = False
    question = None
    source = "deterministic"
    for op in constraint_ops(plan):
        patch = op.patch or IntentPatch()
        if op.source == "model" or patch.source == "model":
            source = "model"
        for term in list(patch.exclude_terms or []) + list(op.exclude_terms):
            if term and term not in constraints.excluded_terms and term not in added:
                added.append(term)
        if patch.query:
            query = patch.query
        if patch.budget_cny is not None:
            budget = patch.budget_cny
        if patch.markets:
            markets = list(patch.markets)
        if patch.preference:
            preference = patch.preference
        if patch.only_in_stock is not None:
            only_in_stock = patch.only_in_stock
        if patch.merchants is not None:
            merchants = list(patch.merchants)
        if patch.use_case:
            use_case = patch.use_case
        if patch.spec_gates:
            spec_gates = list(patch.spec_gates)
        if patch.soft_prefs:
            soft_prefs = list(patch.soft_prefs)
        if patch.requires_clarification:
            clarify = True
            question = patch.clarification_question
    return IntentPatch(
        query=query,
        budget_cny=budget,
        markets=markets,
        preference=preference,
        only_in_stock=only_in_stock,
        merchants=merchants,
        exclude_terms=added or None,
        use_case=use_case,
        spec_gates=spec_gates,
        soft_prefs=soft_prefs,
        source=source,
        requires_clarification=clarify and not (query or constraints.query),
        clarification_question=question,
    )


def leftover_after_route(plan: TurnPlan, route: TurnRoute) -> TurnPlan:
    talk = [item for item in plan.ops if item.kind in _TALK]
    work = [item for item in plan.ops if item.kind not in _TALK]
    if route == TurnRoute.TALK:
        return TurnPlan(ops=talk or plan.ops, leftover=work, lead=talk[0] if talk else plan.lead)
    return TurnPlan(ops=work or plan.ops, leftover=talk, lead=work[0] if work else plan.lead)
