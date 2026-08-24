"""持久化决策快照节点（AGT-004/AGT-005、DAT-004）。"""
from __future__ import annotations

from collections.abc import Callable
from datetime import datetime

from ...application.dto import (
    AnswerPlan,
    CandidateQualification,
    ClaimLedger,
    DecisionBundle,
    GoalCoverage,
    MissionStage,
    RankExplanation,
    RunnerStatus,
    TurnPhase,
)
from ...application.dto.mission import next_constraints_version
from ...application.errors import MissionVersionConflict
from ...application.ports import RunTextHub, UnitOfWork
from ...application.services.answer import (
    render_recommendation_copy,
    verify_claim_ledger,
    verify_rendered_answer,
)
from ...application.services.dialogue import search_reuse_key
from ...application.services.grounded import citations_from_ranked
from ...application.services.present import candidate_record, remap_draft
from ...application.services.rec import assess_goal_coverage, eligible_candidate_markets
from ...application.services.rec.qualify import qualify_product
from ...application.services.turn_actions import ledger_constraint_event
from ...application.services.uncertainty import (
    bind_emitted_probe,
    present_probe,
    probe_event_fields,
    select_probe,
)
from ...domain.product_ontology import SUPPORTED_ITEM_TYPES
from ...infrastructure.product_sources.contract import BUYWHERE_CONTRACT_VERSION
from ..state import MissionGraphState

CONTRACT_VERSION = BUYWHERE_CONTRACT_VERSION


def _finish_text(hub: RunTextHub | None, run_id: str, text: str | None = None) -> None:
    if hub is None:
        return
    snap = hub.snapshot(run_id)
    if snap and snap["text"]:
        hub.complete(run_id)
        return
    if text:
        hub.publish(run_id, text)
    hub.complete(run_id, text=text)


def make_persist_decision_snapshot(
    uow_factory: Callable[[], UnitOfWork],
    *,
    text_hub: RunTextHub | None = None,
):
    async def persist_decision_snapshot(state: MissionGraphState) -> dict:
        mission = state["mission"]
        run_id = state["run_id"]
        run_version = state["run_version"]
        warnings = list(state.get("warnings", []))
        turn_route = state.get("turn_route") or "research"

        async with uow_factory() as uow:
            if state.get("requires_clarification") or turn_route == "clarify":
                probe = state.get("probe") or select_probe(
                    constraints=mission.constraints,
                    belief=mission.belief,
                    last_act=state.get("dialogue_act"),
                )
                belief = bind_emitted_probe(mission.belief, probe)
                question = state.get("clarification_question")
                if probe is not None:
                    question = probe.question
                answer_plan = AnswerPlan.model_validate(state.get("answer_plan") or {})
                claim_ledger = ClaimLedger.model_validate(state.get("claim_ledger") or {})
                rendered_text = str(state.get("agent_message") or question or "")
                rendered_claim_ids = list(state.get("rendered_claim_ids") or [])
                verify_claim_ledger(claim_ledger, displayed_snapshot_ids=set())
                verify_rendered_answer(
                    rendered_text,
                    claim_ledger,
                    rendered_claim_ids=set(rendered_claim_ids),
                )
                decision_bundle = DecisionBundle(
                    goal_version=mission.goal.goal_version,
                    candidate_set_id=None,
                    answer_plan=answer_plan,
                    claim_ledger=claim_ledger,
                    rendered_text=rendered_text,
                    rendered_claim_ids=rendered_claim_ids,
                )
                updated = mission.model_copy(
                    update={
                        "stage": MissionStage.CLARIFYING,
                        "turn_phase": TurnPhase.IDLE,
                        "belief": belief,
                    }
                )
                try:
                    await uow.missions.save(updated, expected_version=run_version)
                except MissionVersionConflict:
                    await uow.rollback()
                    if text_hub is not None:
                        text_hub.abort(run_id)
                    return {
                        "status": RunnerStatus.SUPERSEDED,
                        "warnings": ["运行基于旧版本约束，已标记 superseded"],
                    }
                await uow.events.append(
                    mission_id=mission.id,
                    event_type="clarification.required",
                    payload={
                        "run_id": run_id,
                        "question": question,
                        **probe_event_fields(probe),
                    },
                )
                await uow.recommendation_runs.save(
                    mission_id=mission.id,
                    run_id=run_id,
                    payload={
                        "status": "completed",
                        "final_json": {
                            "answer_plan": answer_plan.model_dump(mode="json"),
                            "claim_ledger": claim_ledger.model_dump(mode="json"),
                            "rendered_claim_ids": rendered_claim_ids,
                            "verification": "passed",
                            "decision_bundle": decision_bundle.model_dump(mode="json"),
                        },
                    },
                )
                await uow.commit()
                _finish_text(text_hub, run_id, question)
                return {"status": RunnerStatus.COMPLETED, "warnings": warnings}

            current = await uow.missions.get(owner_id=mission.owner_id, mission_id=mission.id)
            if current is None or current.constraints_version != run_version:
                await uow.events.append(
                    mission_id=mission.id,
                    event_type="run.superseded",
                    payload={"run_id": run_id, "constraints_version": run_version},
                )
                await uow.recommendation_runs.mark_superseded(
                    mission_id=mission.id, run_id=run_id
                )
                await uow.commit()
                if text_hub is not None:
                    text_hub.abort(run_id)
                return {"status": RunnerStatus.SUPERSEDED, "warnings": ["运行基于旧版本约束，已标记 superseded"]}

            constraints_version = next_constraints_version(
                current.constraints_version, current.constraints, mission.constraints
            )

            if turn_route == "talk":
                return await _persist_talk(
                    uow,
                    state=state,
                    mission=mission,
                    current=current,
                    run_id=run_id,
                    run_version=run_version,
                    constraints_version=constraints_version,
                    warnings=warnings,
                    text_hub=text_hub,
                )

            ranked = state.get("ranked", [])
            rates = state.get("rates") or {}
            snapshot_map: dict[str, str] = dict(state.get("snapshot_map") or {})
            reuse = bool(state.get("reuse_snapshots"))
            pool_products = list(state.get("pool") or [])
            to_snap = list(ranked) + [item for item in pool_products if item.id not in {p.id for p in ranked}]
            persisted_observations: list[dict] = []
            observations = {
                str(item.get("source_product_id")): item
                for item in state.get("product_observations", [])
            }
            if not reuse:
                for product in to_snap:
                    observation = observations.get(product.id)
                    if observation is None:
                        raise ValueError(
                            f"explicit V2 product is missing its observation: {product.id}"
                        )
                    observation_payload = dict(observation)
                    snap_id = await uow.products.save(
                        product=product,
                        raw_payload=observation_payload,
                        contract_version=CONTRACT_VERSION,
                        snapshot_id=snapshot_map.get(product.id),
                    )
                    snapshot_map[product.id] = snap_id
                    persisted_observations.append(
                        {**observation_payload, "snapshot_id": snap_id}
                    )
                fx_ids = [await uow.fx_snapshots.save(snapshot=s) for s in state.get("fx", [])]
            else:
                fx_ids = list(state.get("cached_fx_snapshot_ids") or [])
                for product in to_snap:
                    snapshot_map.setdefault(product.id, snapshot_map.get(product.id, product.id))
                persisted_observations = list(
                    (state.get("cache_payload") or {}).get("product_observations") or []
                )
                observations = {
                    str(item.get("source_product_id")): item
                    for item in persisted_observations
                }

            budget = mission.constraints.budget_cny
            belief = mission.belief
            ranked_records = [
                candidate_record(
                    product,
                    snapshot_id=snapshot_map[product.id],
                    fx=rates.get(product.native_currency),
                    rank=index + 1,
                    budget_cny=budget,
                    preference=mission.constraints.preference,
                    price_sensitive=getattr(belief, "price_sensitivity", None)
                    in {"too_expensive", "want_cheaper"},
                )
                for index, product in enumerate(ranked)
            ]
            for record in ranked_records:
                observed = observations.get(str(record.get("source_product_id"))) or {}
                if observed.get("observed_at"):
                    record["observed_at"] = observed["observed_at"]
            pool_records = [
                candidate_record(
                    product,
                    snapshot_id=snapshot_map[product.id],
                    fx=rates.get(product.native_currency),
                    rank=index + 1,
                    budget_cny=budget,
                    preference=mission.constraints.preference,
                    price_sensitive=getattr(belief, "price_sensitivity", None)
                    in {"too_expensive", "want_cheaper"},
                )
                for index, product in enumerate(pool_products)
                if product.id in snapshot_map
            ]
            if not pool_records:
                pool_records = list((state.get("cache_payload") or {}).get("pool") or []) or ranked_records
            configured_types = state.get("enabled_item_types")
            enabled_item_types = frozenset(
                SUPPORTED_ITEM_TYPES if configured_types is None else configured_types
            )
            vertical_qualification = mission.goal.target.item_type in enabled_item_types
            qualifications = [
                CandidateQualification.model_validate(item)
                for item in state.get("qualifications", [])
            ]
            if vertical_qualification and not qualifications:
                qualifications = [qualify_product(product, mission.goal) for product in to_snap]
            remapped_qualifications: list[CandidateQualification] = []
            for qualification in qualifications:
                source_id = qualification.candidate_id
                snapshot_id = snapshot_map.get(source_id, source_id)
                observed_at = (observations.get(source_id) or {}).get("observed_at")
                if isinstance(observed_at, str):
                    observed_at = datetime.fromisoformat(observed_at.replace("Z", "+00:00"))

                def remap_ref(
                    ref,
                    *,
                    bound_snapshot_id=snapshot_id,
                    bound_observed_at=observed_at,
                ):
                    return ref.model_copy(
                        update={
                            "snapshot_id": bound_snapshot_id,
                            "json_path": ref.json_path or ref.path,
                            "observed_at": ref.observed_at or bound_observed_at,
                        }
                    )

                profile = qualification.profile.model_copy(
                    update={
                        "evidence_refs": [
                            remap_ref(ref) for ref in qualification.profile.evidence_refs
                        ]
                    }
                )
                assessments = [
                    item.model_copy(
                        update={
                            "snapshot_id": snapshot_id,
                            "evidence_refs": [remap_ref(ref) for ref in item.evidence_refs],
                        }
                    )
                    for item in qualification.assessments
                ]
                remapped_qualifications.append(
                    qualification.model_copy(
                        update={
                            "candidate_id": snapshot_id,
                            "profile": profile,
                            "assessments": assessments,
                        }
                    )
                )
            qualifications = remapped_qualifications
            qualification_by_snapshot = {
                item.candidate_id: item for item in qualifications
            }
            for record in ranked_records:
                snapshot_id = str(record["snapshot_id"])
                matched_qualification = qualification_by_snapshot.get(snapshot_id)
                assessments = (
                    list(matched_qualification.assessments)
                    if matched_qualification
                    else []
                )
                assessment_reasons = [
                    item.reason_code for item in assessments if item.verdict == "satisfied"
                ]
                ranking_reasons = [
                    reason
                    for reason in record.get("decision_reasons", [])
                    if reason not in {"within_budget", "in_stock", "merchant_marked_in_stock"}
                ]
                evidence_refs = [
                    ref for item in assessments if item.verdict == "satisfied"
                    for ref in item.evidence_refs
                ]
                explanation = RankExplanation(
                    candidate_id=snapshot_id,
                    goal_version=mission.goal.goal_version,
                    assessment_reason_codes=list(dict.fromkeys(assessment_reasons)),
                    ranking_reason_codes=list(dict.fromkeys(ranking_reasons)),
                    feature_scores={"rank_utility": round(1 / max(1, int(record["rank"])), 4)},
                    evidence_refs=evidence_refs,
                )
                record["rank_explanation"] = explanation.model_dump(mode="json")
                record["decision_reasons"] = list(
                    dict.fromkeys([*assessment_reasons, *ranking_reasons])
                )
            coverage = (
                GoalCoverage.model_validate(state["goal_coverage"])
                if state.get("goal_coverage")
                else (
                    assess_goal_coverage(
                        qualifications,
                        goal_version=mission.goal.goal_version,
                        requested_markets=list(
                            mission.goal.retrieval_scope.markets_requested
                        ),
                        eligible_markets=eligible_candidate_markets(
                            list(state.get("pool") or state.get("products") or []),
                            qualifications,
                            snapshot_map=snapshot_map,
                        ),
                    )
                    if vertical_qualification
                    else None
                )
            )
            candidate_payload = {
                "goal_version": mission.goal.goal_version,
                "item_type": mission.goal.target.item_type,
                "snapshot_map": snapshot_map,
                "ranked": ranked_records,
                "pool": pool_records,
                "fx_snapshot_ids": fx_ids,
                "reuse_key": search_reuse_key(mission.constraints),
                "qualifications": [item.model_dump(mode="json") for item in qualifications],
                "coverage": coverage.model_dump(mode="json") if coverage else None,
                "query_trace": list(state.get("query_trace") or []),
                "search_executions": list(state.get("search_executions") or []),
                "product_observations": persisted_observations,
                "semantic_profile_proposals": dict(
                    state.get("semantic_profile_proposals") or {}
                ),
                "semantic_profile_shadow": dict(
                    state.get("semantic_profile_shadow") or {}
                ),
                "semantic_shadow_stats": dict(state.get("semantic_shadow_stats") or {}),
                "research_proposals": list(state.get("research_proposals") or []),
                "feature_flags": dict(state.get("feature_flags") or {}),
            }
            candidate_set_id = await uow.candidate_sets.save(
                mission_id=mission.id,
                run_id=run_id,
                constraints_version=constraints_version,
                payload=candidate_payload,
                candidate_set_id=state.get("candidate_set_id"),
            )

            draft = state.get("recommendation")
            stored_draft = remap_draft(draft, snapshot_map) if draft else None
            answer_plan = AnswerPlan.model_validate(state.get("answer_plan") or {})
            claim_ledger = ClaimLedger.model_validate(state.get("claim_ledger") or {})
            rendered_text = str(state.get("agent_message") or "")
            verified_claim_ids = frozenset(state.get("rendered_claim_ids") or [])
            forbidden_source_ids = {
                str(item["source_product_id"])
                for item in ranked_records
                if item.get("source_product_id")
            }
            verify_claim_ledger(
                claim_ledger,
                displayed_snapshot_ids={str(item["snapshot_id"]) for item in ranked_records},
            )
            verify_rendered_answer(
                rendered_text,
                claim_ledger,
                forbidden_source_ids=forbidden_source_ids,
                rendered_claim_ids=verified_claim_ids,
            )
            recommendation_claim_ids: frozenset[str] = frozenset()
            if stored_draft is not None:
                card_copy = render_recommendation_copy(
                    stored_draft.primary_snapshot_id,
                    claim_ledger,
                    budget_cny=mission.constraints.budget_cny,
                )
                recommendation_claim_ids = card_copy.claim_ids
                stored_draft = stored_draft.model_copy(
                    update={
                        # The model may choose among eligible IDs, but it has no
                        # user-visible factual channel.  Copy is ledger-rendered.
                        "rationale": [card_copy.rationale],
                        "tradeoffs": [card_copy.tradeoff],
                    }
                )
                verify_rendered_answer(
                    "\n".join(stored_draft.rationale + stored_draft.tradeoffs),
                    claim_ledger,
                    forbidden_source_ids=forbidden_source_ids,
                    rendered_claim_ids=recommendation_claim_ids,
                )
            decision_bundle = DecisionBundle(
                goal_version=mission.goal.goal_version,
                candidate_set_id=candidate_set_id,
                answer_plan=answer_plan,
                claim_ledger=claim_ledger,
                rendered_text=rendered_text,
                rendered_claim_ids=sorted(verified_claim_ids),
            )
            await uow.recommendation_runs.save(
                mission_id=mission.id,
                run_id=run_id,
                payload={
                    "status": "completed",
                    "candidate_set_id": candidate_set_id,
                    "draft_json": stored_draft.model_dump(mode="json") if stored_draft else None,
                    "final_json": {
                        "answer_plan": answer_plan.model_dump(mode="json"),
                        "claim_ledger": claim_ledger.model_dump(mode="json"),
                        "rendered_claim_ids": sorted(verified_claim_ids),
                        "recommendation_rendered_claim_ids": sorted(
                            recommendation_claim_ids
                        ),
                        "verification": "passed",
                        "decision_bundle": decision_bundle.model_dump(mode="json"),
                    },
                },
            )

            stage = MissionStage.READY if ranked else MissionStage.DEGRADED
            if state.get("fx_failed_currencies") or state.get("failed_markets"):
                stage = MissionStage.DEGRADED
            citations = citations_from_ranked(ranked_records)
            comparison_ids = state.get("comparison_snapshot_ids")
            agent_text = rendered_text
            probe = state.get("probe") or select_probe(
                constraints=mission.constraints,
                belief=mission.belief,
                ranked=ranked_records,
                last_act=state.get("dialogue_act"),
            )
            agent_text, _ = present_probe(probe, agent_text)
            belief = bind_emitted_probe(mission.belief, probe)
            updates = {
                "stage": stage,
                "turn_phase": TurnPhase.IDLE,
                "constraints_version": constraints_version,
                "candidate_set_id": candidate_set_id,
                "recommendation_run_id": run_id,
                "warnings": warnings,
                "dialogue": _dialogue_with_plan(mission.dialogue, citations, state.get("turn_plan")),
                "belief": belief,
            }
            if comparison_ids:
                updates["comparison_snapshot_ids"] = comparison_ids
            updated = mission.model_copy(update=updates)
            try:
                await uow.missions.save(updated, expected_version=run_version)
            except MissionVersionConflict:
                await uow.rollback()
                if text_hub is not None:
                    text_hub.abort(run_id)
                return {"status": RunnerStatus.SUPERSEDED, "warnings": ["运行基于旧版本约束，已标记 superseded"]}

            if mission.constraints != current.constraints:
                event_type, event_payload = ledger_constraint_event(
                    undo_applied=bool(state.get("undo_applied")),
                    run_id=run_id,
                    before=current.constraints,
                    after=mission.constraints,
                    version=constraints_version,
                )
                await uow.events.append(
                    mission_id=mission.id,
                    event_type=event_type,
                    payload=event_payload,
                )

            if state.get("goal_operations") and not state.get("goal_revision_committed"):
                await uow.events.append(
                    mission_id=mission.id,
                    event_type="goal.operations_committed",
                    payload={
                        "run_id": run_id,
                        "goal_version": mission.goal.goal_version,
                        "operations": list(state["goal_operations"]),
                    },
                )

            if coverage is not None:
                await uow.events.append(
                    mission_id=mission.id,
                    event_type="candidate.qualified",
                    payload={
                        "run_id": run_id,
                        "candidate_set_id": candidate_set_id,
                        "goal_version": mission.goal.goal_version,
                        "eligible_count": coverage.eligible_count,
                        "needs_evidence_count": coverage.needs_evidence_count,
                        "ineligible_count": coverage.ineligible_count,
                    },
                )
                await uow.events.append(
                    mission_id=mission.id,
                    event_type="coverage.assessed",
                    payload={
                        "run_id": run_id,
                        "candidate_set_id": candidate_set_id,
                        **coverage.model_dump(mode="json"),
                    },
                )

            await uow.events.append(
                mission_id=mission.id,
                event_type="answer.claims_verified",
                payload={
                    "run_id": run_id,
                    "candidate_set_id": candidate_set_id,
                    "claim_count": len(claim_ledger.claims),
                    "verification": "passed",
                },
                )
            await uow.events.append(
                mission_id=mission.id,
                event_type="answer.verified",
                payload={
                    "run_id": run_id,
                    "candidate_set_id": candidate_set_id,
                    "claim_count": len(claim_ledger.claims),
                    "rendered_claim_ids": sorted(verified_claim_ids),
                },
            )

            for proposal in state.get("research_proposals") or []:
                await uow.events.append(
                    mission_id=mission.id,
                    event_type="research.proposal_created",
                    payload={"run_id": run_id, **proposal},
                )

            event_type = "recommendation.ready" if stage == MissionStage.READY else "run.degraded"
            probe_fields = probe_event_fields(probe)
            await uow.events.append(
                mission_id=mission.id,
                event_type=event_type,
                payload={
                    "mission_id": mission.id,
                    "run_id": run_id,
                    "candidate_set_id": candidate_set_id,
                    "constraints_version": constraints_version,
                    "count": len(ranked_records),
                    "text": agent_text,
                    "snapshot_ids": [item["snapshot_id"] for item in citations],
                    "citations": citations,
                    "title": citations[0]["title"] if citations else None,
                    **probe_fields,
                },
            )
            await uow.events.append(
                mission_id=mission.id,
                event_type="agent.message",
                payload={
                    "run_id": run_id,
                    "text": agent_text,
                    "act": state.get("agent_act") or mission.dialogue.last_act or "refine_constraints",
                    "constraints_version": constraints_version,
                    "snapshot_ids": [item["snapshot_id"] for item in citations],
                    "citations": citations,
                    **probe_fields,
                },
            )
            await uow.commit()
            _finish_text(text_hub, run_id, agent_text)

            status = RunnerStatus.COMPLETED if stage == MissionStage.READY else RunnerStatus.DEGRADED
            return {
                "status": status,
                "candidate_set_id": candidate_set_id,
                "recommendation_run_id": run_id,
            }

    return persist_decision_snapshot


async def _persist_talk(
    uow: UnitOfWork,
    *,
    state: MissionGraphState,
    mission,
    current,
    run_id: str,
    run_version: int,
    constraints_version: int,
    warnings: list[str],
    text_hub: RunTextHub | None = None,
) -> dict:
    comparison_ids = state.get("comparison_snapshot_ids") or mission.comparison_snapshot_ids
    ranked = list((state.get("cache_payload") or {}).get("ranked") or [])
    text = state.get("agent_message") or "已根据当前候选回答。"
    probe = state.get("probe") or select_probe(
        constraints=mission.constraints,
        belief=mission.belief,
        ranked=ranked,
        last_act=state.get("dialogue_act"),
    )
    text, _ = present_probe(probe, text)
    belief = bind_emitted_probe(mission.belief, probe)
    updated = mission.model_copy(
        update={
            "stage": current.stage,
            "turn_phase": TurnPhase.IDLE,
            "constraints_version": constraints_version,
            "candidate_set_id": current.candidate_set_id,
            "recommendation_run_id": current.recommendation_run_id,
            "comparison_snapshot_ids": comparison_ids,
            "warnings": warnings or current.warnings,
            "dialogue": _dialogue_with_plan(
                mission.dialogue,
                list(state.get("agent_citations") or []),
                state.get("turn_plan"),
                snapshot_ids=list(state.get("agent_snapshot_ids") or []),
            ),
            "belief": belief,
            "active_run_id": run_id,
        }
    )
    try:
        await uow.missions.save(updated, expected_version=run_version)
    except MissionVersionConflict:
        await uow.rollback()
        if text_hub is not None:
            text_hub.abort(run_id)
        return {"status": RunnerStatus.SUPERSEDED, "warnings": ["运行基于旧版本约束，已标记 superseded"]}
    snapshot_ids = list(state.get("agent_snapshot_ids") or [])
    citations = list(state.get("agent_citations") or [])
    answer_plan = AnswerPlan.model_validate(state.get("answer_plan") or {})
    claim_ledger = ClaimLedger.model_validate(state.get("claim_ledger") or {})
    verify_claim_ledger(claim_ledger, displayed_snapshot_ids=set(snapshot_ids))
    verify_rendered_answer(
        text,
        claim_ledger,
        rendered_claim_ids=set(state.get("rendered_claim_ids") or []),
    )
    decision_bundle = DecisionBundle(
        goal_version=mission.goal.goal_version,
        candidate_set_id=current.candidate_set_id,
        answer_plan=answer_plan,
        claim_ledger=claim_ledger,
        rendered_text=text,
        rendered_claim_ids=list(state.get("rendered_claim_ids") or []),
    )
    await uow.recommendation_runs.save(
        mission_id=mission.id,
        run_id=run_id,
        payload={
            "status": "completed",
            "candidate_set_id": current.candidate_set_id,
            "final_json": {
                "answer_plan": answer_plan.model_dump(mode="json"),
                "claim_ledger": claim_ledger.model_dump(mode="json"),
                "rendered_claim_ids": list(state.get("rendered_claim_ids") or []),
                "verification": "passed",
                "decision_bundle": decision_bundle.model_dump(mode="json"),
            },
        },
    )
    await uow.events.append(
        mission_id=mission.id,
        event_type="answer.claims_verified",
        payload={
            "run_id": run_id,
            "candidate_set_id": current.candidate_set_id,
            "claim_count": len(claim_ledger.claims),
            "verification": "passed",
            "route": "talk",
        },
    )
    await uow.events.append(
        mission_id=mission.id,
        event_type="answer.verified",
        payload={
            "run_id": run_id,
            "candidate_set_id": current.candidate_set_id,
            "claim_count": len(claim_ledger.claims),
            "rendered_claim_ids": list(state.get("rendered_claim_ids") or []),
            "route": "talk",
        },
    )
    await uow.events.append(
        mission_id=mission.id,
        event_type="agent.message",
        payload={
            "run_id": run_id,
            "text": text,
            "act": state.get("agent_act"),
            "topic": state.get("agent_topic"),
            "constraints_version": constraints_version,
            "snapshot_ids": snapshot_ids,
            "citations": citations,
            **probe_event_fields(probe),
            **(
                {"next_moves": state["agent_next_moves"]}
                if state.get("agent_next_moves")
                else {}
            ),
        },
    )
    if state.get("comparison_snapshot_ids"):
        await uow.events.append(
            mission_id=mission.id,
            event_type="comparison.updated",
            payload={
                "snapshot_ids": list(state["comparison_snapshot_ids"]),
                "constraints_version": constraints_version,
            },
        )
    await uow.commit()
    _finish_text(text_hub, run_id, text)
    return {
        "status": RunnerStatus.COMPLETED,
        "candidate_set_id": current.candidate_set_id,
        "recommendation_run_id": current.recommendation_run_id,
    }


def _dialogue_with_mentions(dialogue, citations: list, snapshot_ids: list | None = None):
    ids = [
        str(item["snapshot_id"])
        for item in citations
        if isinstance(item, dict) and item.get("snapshot_id")
    ]
    if not ids:
        ids = [str(item) for item in list(snapshot_ids or []) if item]
    if not ids:
        return dialogue
    return dialogue.model_copy(update={"mentioned_snapshot_ids": ids[:4]})


def _dialogue_with_plan(dialogue, citations: list, plan, snapshot_ids: list | None = None):
    updated = _dialogue_with_mentions(dialogue, citations, snapshot_ids)
    leftover = list(getattr(plan, "leftover", None) or [])
    if not leftover:
        return updated
    return updated.model_copy(
        update={"pending_ops": [item.model_dump(mode="json") for item in leftover]}
    )
