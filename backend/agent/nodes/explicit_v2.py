"""Explicit Goal V2 graph stages.

The bounded research controller remains responsible for its coverage back-edge,
while every externally meaningful artifact boundary is now visible in LangGraph.
"""

from __future__ import annotations

from collections.abc import Callable
from uuid import uuid4

from ...application.dto import (
    AnswerObligation,
    AnswerPlan,
    CandidateQualification,
    ClaimLedger,
    ObligationStatus,
    RunnerStatus,
)
from ...application.ports import FxSource, ModelBackend, ProductSource, UnitOfWork
from ...application.services.answer import (
    build_candidate_claim_ledger,
    build_recommendation_answer_plan,
    render_answer_from_ledger,
    verify_claim_ledger,
    verify_rendered_answer,
)
from ...application.services.goal import constraint_view_from_goal, ensure_goal_authority
from ...application.services.present import candidate_record
from ...application.services.rec import assess_goal_coverage, plan_search, run_filter, run_rank
from ...application.services.rec.pipeline import MAX_RANKED_CANDIDATES
from ...application.services.rec.qualify import profile_product, qualify_product
from ...application.services.rec.state import rec_state_from_mission
from ...application.services.uncertainty import choose_probe
from ...application.services.working_set import select_decision_set
from ..state import MissionGraphState
from .dialogue import make_compose_grounded_reply, make_load_cached_candidates
from .evidence import make_verify_evidence
from .research import make_research


async def assess_next_action(state: MissionGraphState) -> dict:
    return {"next_action": str(state.get("turn_route") or "research")}


def _select_ranked(products: list) -> list:
    views = [
        {
            "snapshot_id": item.id,
            "title": item.title,
            "merchant": item.merchant,
            "market": item.country_code,
        }
        for item in products
    ]
    selected = select_decision_set(views, limit=MAX_RANKED_CANDIDATES)
    by_id = {item.id: item for item in products}
    return [by_id[str(item["snapshot_id"])] for item in selected]


def make_clarify_one_slot(model_backend: ModelBackend):
    async def clarify(state: MissionGraphState) -> dict:
        if state.get("probe") is not None:
            existing_probe = state["probe"]
            return {"agent_message": existing_probe.question}
        mission = state["mission"]
        probe = await choose_probe(
            constraints=mission.constraints,
            belief=mission.belief,
            ranked=list((state.get("cache_payload") or {}).get("ranked") or []),
            last_act=state.get("dialogue_act"),
            backend=model_backend,
        )
        if probe is not None:
            return {"probe": probe, "agent_message": probe.question}
        question = str(state.get("clarification_question") or "请补充你想购买的商品类型。")
        return {"agent_message": question}

    return clarify


def make_answer_from_evidence():
    load = make_load_cached_candidates()
    compose = make_compose_grounded_reply()

    async def answer(state: MissionGraphState) -> dict:
        loaded = await load(state)
        replied = await compose({**state, **loaded})
        return {**loaded, **replied}

    return answer


def make_reuse_evidence(*, enabled_item_types: frozenset[str]):
    load = make_load_cached_candidates()

    async def reuse(state: MissionGraphState) -> dict:
        loaded = await load(state)
        current = {**state, **loaded}
        products = current.get("products") or []
        warnings: list[str] = []
        if state.get("turn_route") == "refilter":
            mission = state["mission"]
            goal = ensure_goal_authority(
                mission.goal,
                mission.constraints,
                version=max(mission.goal.goal_version, mission.constraints_version),
                belief=mission.belief,
            )
            rec = rec_state_from_mission(mission.model_copy(update={"goal": goal}))
            products, warnings = run_filter(
                constraint_view_from_goal(goal, fallback=mission.constraints),
                products,
                rejected_snapshot_ids=set(rec.rejected_snapshot_ids),
                rejected_listing_keys=set(rec.rejected_listing_keys),
                goal=goal,
                enabled_item_types=enabled_item_types,
                snapshot_map=current.get("snapshot_map") or {},
            )
        ranked, rank_warnings = run_rank(
            state["mission"],
            products,
            snapshot_map=current.get("snapshot_map") or {},
            limit=None,
        )
        ranked = _select_ranked(ranked)
        return {
            **loaded,
            "products": products,
            "pool": products,
            "ranked": ranked,
            "warnings": [*warnings, *rank_warnings],
        }

    return reuse


async def plan_research(state: MissionGraphState) -> dict:
    plan = plan_search(rec_state_from_mission(state["mission"]))
    return {"search_plan": plan}


def make_retrieve_buywhere(
    products: ProductSource,
    fx: FxSource,
    model_backend: ModelBackend,
    uow_factory: Callable[[], UnitOfWork],
    *,
    max_concurrency: int,
    enabled_item_types: frozenset[str],
    max_wall_time_ms: int = 20_000,
):
    research = make_research(
        products,
        fx,
        model_backend,
        uow_factory,
        max_concurrency,
        enabled_item_types=enabled_item_types,
        max_wall_time_ms=max_wall_time_ms,
    )

    async def retrieve(state: MissionGraphState) -> dict:
        return await research(state)

    return retrieve


async def normalize_observation(state: MissionGraphState) -> dict:
    goal_version = state["mission"].goal.goal_version
    stale = [
        item
        for item in state.get("search_executions", [])
        if item.get("goal_version") != goal_version
    ]
    if stale:
        return {
            "status": RunnerStatus.SUPERSEDED,
            "warnings": ["检索结果绑定了旧目标版本，已阻止写回"],
            "completion_blocked": True,
        }
    return {"normalized_observation_count": len(state.get("product_observations", []))}


async def build_semantic_profile(state: MissionGraphState) -> dict:
    products = list(state.get("pool") or state.get("products") or [])
    return {
        "semantic_profiles": {
            item.id: profile_product(item).model_dump(mode="json") for item in products
        }
    }


async def qualify_candidates(state: MissionGraphState) -> dict:
    products = list(state.get("pool") or state.get("products") or [])
    goal = state["mission"].goal
    qualifications = [qualify_product(item, goal) for item in products]
    return {"qualifications": [item.model_dump(mode="json") for item in qualifications]}


async def assess_coverage(state: MissionGraphState) -> dict:
    qualifications = [
        CandidateQualification.model_validate(item) for item in state.get("qualifications", [])
    ]
    previous = state.get("goal_coverage") or {}
    products = list(state.get("pool") or state.get("products") or [])
    markets_by_id = {item.id: item.country_code for item in products if item.country_code}
    coverage = assess_goal_coverage(
        qualifications,
        goal_version=state["mission"].goal.goal_version,
        search_attempt_count=int(previous.get("search_attempt_count") or 0),
        request_count=int(previous.get("request_count") or 0),
        request_budget=int(previous.get("request_budget") or 0),
        remaining_time_ms=previous.get("remaining_time_ms"),
        model_call_count=int(previous.get("model_call_count") or 0),
        model_call_budget=previous.get("model_call_budget"),
        estimated_token_count=int(previous.get("estimated_token_count") or 0),
        token_budget=previous.get("token_budget"),
        marginal_unique_observations=int(previous.get("marginal_unique_observations") or 0),
        marginal_eligible_count=int(previous.get("marginal_eligible_count") or 0),
        consecutive_no_gain=int(previous.get("consecutive_no_gain") or 0),
        requested_markets=list(state["mission"].goal.retrieval_scope.markets_requested),
        eligible_markets=[
            markets_by_id.get(item.candidate_id, "")
            for item in qualifications
            if item.eligibility == "eligible"
        ],
    )
    if previous.get("stop_reason") and not (
        previous["stop_reason"] == "coverage_sufficient"
        and coverage.status != "sufficient"
    ):
        coverage = coverage.model_copy(update={"stop_reason": previous["stop_reason"]})
    return {"goal_coverage": coverage.model_dump(mode="json")}


async def rank_feasible(state: MissionGraphState) -> dict:
    qualifications = [
        CandidateQualification.model_validate(item) for item in state.get("qualifications", [])
    ]
    eligible = {item.candidate_id for item in qualifications if item.eligibility == "eligible"}
    products = [
        item
        for item in list(state.get("pool") or state.get("products") or [])
        if item.id in eligible
    ]
    ranked, warnings = run_rank(state["mission"], products, snapshot_map={}, limit=None)
    ranked = _select_ranked(ranked)
    return {"products": products, "ranked": ranked, "warnings": warnings}


async def build_answer_plan(state: MissionGraphState) -> dict:
    if state.get("answer_plan"):
        return {}
    route = str(state.get("turn_route") or "research")
    ranked = list(state.get("ranked") or [])
    if route == "clarify":
        status = ObligationStatus.NEEDS_RESEARCH
        missing = ["user_decision"]
    else:
        status = ObligationStatus.ANSWERED if ranked else ObligationStatus.UNKNOWN
        missing = [] if ranked else ["eligible_candidates"]
    mission = state["mission"]
    if route == "clarify":
        plan = AnswerPlan(
            goal_version=mission.goal.goal_version,
            question_intents=[route],
            obligations=[AnswerObligation(facet="recommendation", status=status)],
            required_facets=["eligible_candidates"],
            missing_facets=missing,
            proposed_next_action="clarify",
        )
        ledger = ClaimLedger(goal_version=mission.goal.goal_version)
        return {
            "answer_plan": plan.model_dump(mode="json"),
            "claim_ledger": ledger.model_dump(mode="json"),
            "rendered_claim_ids": [],
        }

    candidate_set_id = str(state.get("candidate_set_id") or uuid4())
    snapshot_map = dict(state.get("snapshot_map") or {})
    for product in [*list(state.get("pool") or []), *ranked]:
        snapshot_map.setdefault(product.id, str(uuid4()))
    rates = state.get("rates") or {}
    records = [
        candidate_record(
            product,
            snapshot_id=snapshot_map[product.id],
            fx=rates.get(product.native_currency),
            rank=index + 1,
            budget_cny=mission.constraints.budget_cny,
            preference=mission.constraints.preference,
            price_sensitive=getattr(mission.belief, "price_sensitivity", None)
            in {"too_expensive", "want_cheaper"},
        )
        for index, product in enumerate(ranked)
    ]
    plan = build_recommendation_answer_plan(
        candidate_set_id,
        records,
        goal_version=mission.goal.goal_version,
    )
    ledger = build_candidate_claim_ledger(
        candidate_set_id,
        records,
        goal_version=mission.goal.goal_version,
    )
    return {
        "candidate_set_id": candidate_set_id,
        "snapshot_map": snapshot_map,
        "agent_snapshot_ids": [str(record["snapshot_id"]) for record in records],
        "answer_plan": plan.model_dump(mode="json"),
        "claim_ledger": ledger.model_dump(mode="json"),
    }


def make_verify_claims():
    verify_evidence = make_verify_evidence()

    async def verify(state: MissionGraphState) -> dict:
        ledger = ClaimLedger.model_validate(state.get("claim_ledger") or {})
        verify_claim_ledger(
            ledger,
            displayed_snapshot_ids=set(state.get("agent_snapshot_ids") or []),
        )
        return {**await verify_evidence(state), "claims_verified": True}

    return verify


def make_render_response():
    async def render(state: MissionGraphState) -> dict:
        if state.get("agent_message"):
            ledger = ClaimLedger.model_validate(state.get("claim_ledger") or {})
            verify_rendered_answer(
                str(state["agent_message"]),
                ledger,
                rendered_claim_ids=set(state.get("rendered_claim_ids") or []),
            )
            return {"response_rendered": True}
        if state.get("answer_plan") and state.get("claim_ledger"):
            plan = AnswerPlan.model_validate(state["answer_plan"])
            ledger = ClaimLedger.model_validate(state["claim_ledger"])
            rendered = render_answer_from_ledger(plan, ledger)
            verify_rendered_answer(
                rendered.text,
                ledger,
                rendered_claim_ids=rendered.claim_ids,
            )
            return {
                "agent_message": rendered.text,
                "agent_snapshot_ids": [
                    str((state.get("snapshot_map") or {}).get(item.id, item.id))
                    for item in state.get("ranked") or []
                ],
                "rendered_claim_ids": sorted(rendered.claim_ids),
                "response_rendered": True,
            }
        raise ValueError("explicit V2 response artifacts are incomplete")

    return render


async def completion_check(state: MissionGraphState) -> dict:
    if state.get("completion_blocked"):
        return {"completion_ok": False}
    return {"completion_ok": True}
