from __future__ import annotations

import asyncio
from collections.abc import Callable
from uuid import uuid4

from ...domain.models import utcnow
from ..dto import MissionConstraints, ShoppingMission, TurnPhase
from ..dto.dialogue import DialogueAct, DialogueActKind, ThreadView, TurnCommand
from ..dto.mission import next_constraints_version
from ..dto.public import (
    CandidateSetView,
    MissionView,
    ProductCandidate,
    RecommendationView,
    mission_view,
)
from ..errors import (
    InvalidComparison,
    MissionNotFound,
    MissionVersionConflict,
    NothingToUndo,
    RecommendationNotFound,
    RunNotRunning,
    SnapshotNotFound,
)
from ..ports import MissionEventBroker, RunDispatcher, RunTextHub, UnitOfWork
from .dialogue import preview_turn, project_thread, stage_for_phase
from .nlu import is_undo_text
from .policy import DialoguePolicy, TurnDecision, TurnInput
from .present import image_url_of, product_candidate_from_record, product_candidate_from_snapshot
from .uncertainty import moves_for_reply, select_probe


class MissionCommandService:
    """Mission 命令入口。只依赖 Application Port（uow_factory + RunDispatcher），
    不导入 backend.agent 或 backend.infrastructure（ARC-002/DEC-009）。

    每个命令打开独立事务边界，保证事件与状态变更原子提交。
    """

    def __init__(
        self,
        *,
        uow_factory: Callable[[], UnitOfWork],
        dispatcher: RunDispatcher,
        broker: MissionEventBroker | None = None,
        text_hub: RunTextHub | None = None,
    ) -> None:
        self._uow_factory = uow_factory
        self._dispatcher = dispatcher
        self._broker = broker
        self._text_hub = text_hub

    async def get_mission(self, *, owner_id: str, mission_id: str) -> ShoppingMission:
        async with self._uow_factory() as uow:
            mission = await uow.missions.get(owner_id=owner_id, mission_id=mission_id)
        if mission is None:
            raise MissionNotFound(mission_id)
        return mission

    async def get_mission_view(self, *, owner_id: str, mission_id: str) -> MissionView:
        return mission_view(await self.get_mission(owner_id=owner_id, mission_id=mission_id))

    async def list_missions(
        self, *, owner_id: str, limit: int = 20, offset: int = 0
    ) -> list[ShoppingMission]:
        async with self._uow_factory() as uow:
            return await uow.missions.list(owner_id=owner_id, limit=limit, offset=offset)

    async def create_mission(self, *, owner_id: str, title: str) -> ShoppingMission:
        async with self._uow_factory() as uow:
            mission = await uow.missions.create(owner_id=owner_id, title=title)
            await uow.commit()
            return mission

    async def submit_message(
        self,
        *,
        owner_id: str,
        mission_id: str,
        text: str,
        constraints_version: int,
        focus_snapshot_id: str | None = None,
    ) -> str:
        """薄入口：分类/路由/编排全部下沉到 Agent 图（控制反转）。

        命令层只做：乐观版本校验、置聚焦、追加 message.received、派单。撤销是事务控制
        （非意图理解），仍在派单前确定性识别后走 undo 回溯。"""
        if is_undo_text(text):
            undo_run_id, _ = await self.undo(
                owner_id=owner_id,
                mission_id=mission_id,
                constraints_version=constraints_version,
            )
            return undo_run_id
        run_id = str(uuid4())
        async with self._uow_factory() as uow:
            mission = await self._require_mission(uow, owner_id, mission_id, constraints_version)
            dialogue = mission.dialogue
            if focus_snapshot_id:
                dialogue = dialogue.model_copy(update={"focus_snapshot_id": focus_snapshot_id})
            updated = mission.model_copy(
                update={
                    "active_run_id": run_id,
                    "dialogue": dialogue,
                    "turn_phase": TurnPhase.RESPONDING,
                    "updated_at": utcnow(),
                }
            )
            await uow.missions.save(updated, expected_version=constraints_version)
            await uow.events.append(
                mission_id=mission_id,
                event_type="message.received",
                payload={
                    "run_id": run_id,
                    "text": text,
                    "constraints_version": constraints_version,
                },
            )
            await uow.commit()
        await self._dispatcher.dispatch(
            owner_id=owner_id,
            mission_id=mission_id,
            run_id=run_id,
            constraints_version=constraints_version,
        )
        return run_id

    async def update_constraints(
        self,
        *,
        owner_id: str,
        mission_id: str,
        constraints_version: int,
        constraints: MissionConstraints,
    ) -> tuple[str, int]:
        """显式修改约束（PATCH）。仅当约束内容变化时递增版本；调度带着写回后的版本。"""
        async with self._uow_factory() as uow:
            mission = await uow.missions.get(owner_id=owner_id, mission_id=mission_id)
            if mission is None:
                raise MissionNotFound(mission_id)
            if mission.constraints_version != constraints_version:
                raise MissionVersionConflict(
                    f"expected {constraints_version}, got {mission.constraints_version}"
                )
            cache = await self._cache_payload(uow, mission)
            decision = DialoguePolicy().decide(
                mission=mission,
                turn=TurnInput(command=TurnCommand.PATCH, source="filter", constraints=constraints),
                has_cache=bool(cache and cache.get("ranked")),
                cache_reuse_key=(cache or {}).get("reuse_key"),
                cache_payload=cache,
            )
            run_id, new_version = await self._persist_decision(
                uow,
                mission=mission,
                decision=decision,
                expected_version=constraints_version,
            )
            await uow.commit()
        if decision.dispatch:
            await self._dispatcher.dispatch(
                owner_id=owner_id,
                mission_id=mission_id,
                run_id=run_id,
                constraints_version=new_version,
            )
        return run_id, new_version

    async def undo(self, *, owner_id: str, mission_id: str, constraints_version: int) -> tuple[str, int]:
        """撤销最近一次可撤销条件变更。仅当恢复后的约束与当前不同时递增版本。"""
        async with self._uow_factory() as uow:
            mission = await uow.missions.get(owner_id=owner_id, mission_id=mission_id)
            if mission is None:
                raise MissionNotFound(mission_id)
            if mission.constraints_version != constraints_version:
                raise MissionVersionConflict(
                    f"expected {constraints_version}, got {mission.constraints_version}"
                )
            events = await uow.events.list_since(mission_id=mission_id)
            for event in reversed(events):
                if event["event_type"] != "constraints.updated":
                    continue
                before = MissionConstraints(**event["payload"]["before"])
                if not (before.query or "").strip():
                    continue
                run_id = str(uuid4())
                new_version = next_constraints_version(
                    mission.constraints_version, mission.constraints, before
                )
                cache = await self._cache_payload(uow, mission)
                _route, phase = preview_turn(
                    act=DialogueAct(kind=DialogueActKind.REFINE, source="command"),
                    constraints=before,
                    has_cache=bool(cache and cache.get("ranked")),
                    cache_reuse_key=(cache or {}).get("reuse_key"),
                    skip_intent_patch=True,
                )
                if mission.constraints != before and phase == TurnPhase.RESPONDING:
                    phase = TurnPhase.REFILTERING
                updated = mission.model_copy(
                    update={
                        "constraints": before,
                        "stage": stage_for_phase(phase, mission.stage),
                        "turn_phase": phase,
                        "constraints_version": new_version,
                        "dialogue": mission.dialogue.model_copy(
                            update={"last_act": DialogueActKind.UNDO.value}
                        ),
                        "active_run_id": run_id,
                        "updated_at": utcnow(),
                    }
                )
                await uow.missions.save(updated, expected_version=constraints_version)
                await uow.events.append(
                    mission_id=mission_id,
                    event_type="constraints.undo",
                    payload={
                        "run_id": run_id,
                        "restored": before.model_dump(mode="json"),
                        "constraints_version": updated.constraints_version,
                    },
                )
                await uow.commit()
                break
            else:
                raise NothingToUndo(mission_id)
        await self._dispatcher.dispatch(
            owner_id=owner_id,
            mission_id=mission_id,
            run_id=run_id,
            constraints_version=updated.constraints_version,
        )
        return run_id, updated.constraints_version

    async def set_comparison(
        self,
        *,
        owner_id: str,
        mission_id: str,
        constraints_version: int,
        snapshot_ids: list[str],
    ) -> ShoppingMission:
        """保存 2–4 件比较集合（BUS-005/FE-007）。比较不推进约束版本，但做乐观版本校验。"""
        if not 2 <= len(snapshot_ids) <= 4:
            raise InvalidComparison(f"比较集合必须是 2–4 件，收到 {len(snapshot_ids)}")
        if len(set(snapshot_ids)) != len(snapshot_ids):
            raise InvalidComparison("比较集合不能包含重复商品")
        async with self._uow_factory() as uow:
            mission = await uow.missions.get(owner_id=owner_id, mission_id=mission_id)
            if mission is None:
                raise MissionNotFound(mission_id)
            if mission.constraints_version != constraints_version:
                raise MissionVersionConflict(
                    f"expected {constraints_version}, got {mission.constraints_version}"
                )
            valid_ids = await self._comparison_id_universe(uow, mission)
            unknown = [sid for sid in snapshot_ids if sid not in valid_ids]
            if unknown:
                raise InvalidComparison("比较集合必须来自当前候选快照")
            updated = mission.model_copy(
                update={"comparison_snapshot_ids": snapshot_ids, "updated_at": utcnow()}
            )
            await uow.missions.save(updated, expected_version=constraints_version)
            await uow.events.append(
                mission_id=mission_id,
                event_type="comparison.updated",
                payload={
                    "snapshot_ids": snapshot_ids,
                    "constraints_version": constraints_version,
                },
            )
            await uow.commit()
            return updated

    async def get_candidates(self, *, owner_id: str, mission_id: str) -> CandidateSetView:
        async with self._uow_factory() as uow:
            mission = await uow.missions.get(owner_id=owner_id, mission_id=mission_id)
            if mission is None:
                raise MissionNotFound(mission_id)
            if mission.candidate_set_id is None:
                return CandidateSetView()
            payload = await uow.candidate_sets.get(mission.candidate_set_id)
            if payload:
                payload = await self._with_snapshot_images(uow, payload)
        return self._candidate_set_view(payload)

    @staticmethod
    async def _with_snapshot_images(uow: UnitOfWork, payload: dict) -> dict:
        """旧候选集没有 image_url 时，从商品快照回填。"""
        products = getattr(uow, "products", None)
        ranked = list(payload.get("ranked") or [])
        if products is None or not ranked:
            return payload
        filled: list[dict] = []
        for item in ranked:
            if not isinstance(item, dict) or image_url_of(item):
                filled.append(item)
                continue
            sid = item.get("snapshot_id")
            snap = await products.get(str(sid)) if sid else None
            url = image_url_of(item, snap)
            filled.append({**item, "image_url": url} if url else item)
        return {**payload, "ranked": filled}

    async def get_recommendation(self, *, owner_id: str, mission_id: str) -> RecommendationView:
        async with self._uow_factory() as uow:
            mission = await uow.missions.get(owner_id=owner_id, mission_id=mission_id)
            if mission is None:
                raise MissionNotFound(mission_id)
            if mission.recommendation_run_id is None:
                raise RecommendationNotFound(mission_id)
            run = await uow.recommendation_runs.get(mission.recommendation_run_id)
            if run is None or not run.get("draft_json"):
                raise RecommendationNotFound(mission_id)
            draft = run["draft_json"]
            snapshot_map: dict[str, str] = {}
            if run.get("candidate_set_id"):
                candidates = await uow.candidate_sets.get(run["candidate_set_id"])
                snapshot_map = (candidates or {}).get("snapshot_map") or {}

            async def _load(eid: str | None) -> ProductCandidate | None:
                if not eid:
                    return None
                sid = snapshot_map.get(eid, eid)
                snap = await uow.products.get(sid)
                if snap is None:
                    return None
                return product_candidate_from_snapshot(snap)

            primary = await _load(draft.get("primary_snapshot_id"))
            alternatives: list[ProductCandidate] = []
            for alt_id in draft.get("alternative_snapshot_ids") or []:
                item = await _load(alt_id)
                if item is not None:
                    alternatives.append(item)
            cited = []
            for eid in draft.get("cited_evidence_ids") or []:
                sid = snapshot_map.get(eid, eid)
                if await uow.products.get(sid):
                    cited.append(sid)
        if primary is None:
            raise RecommendationNotFound(mission_id)
        return RecommendationView(
            run_id=mission.recommendation_run_id,
            status=run["status"],
            primary=primary,
            alternatives=alternatives,
            rationale=list(draft.get("rationale") or []),
            tradeoffs=list(draft.get("tradeoffs") or []),
            cited_evidence_ids=cited,
        )

    async def get_snapshot(self, *, snapshot_id: str) -> ProductCandidate:
        async with self._uow_factory() as uow:
            snap = await uow.products.get(snapshot_id)
        if snap is None:
            raise SnapshotNotFound(snapshot_id)
        candidate = product_candidate_from_snapshot(snap)
        if candidate is None:
            raise SnapshotNotFound(snapshot_id)
        return candidate

    async def list_events(
        self, *, owner_id: str, mission_id: str, after: int = 0
    ) -> list[dict]:
        """事件流（OBS-003）。跨 owner 一律 404。"""
        async with self._uow_factory() as uow:
            mission = await uow.missions.get(owner_id=owner_id, mission_id=mission_id)
            if mission is None:
                raise MissionNotFound(mission_id)
            return await uow.events.list_since(mission_id=mission_id, sequence=after)

    async def wait_for_events(
        self, *, owner_id: str, mission_id: str, after: int, timeout: float
    ) -> bool:
        """门铃等待。无 broker 时退回短睡眠，由调用方再 list_events。"""
        del owner_id
        if self._broker is None:
            await asyncio.sleep(min(timeout, 0.5))
            return True
        return await self._broker.wait(mission_id=mission_id, after=after, timeout=timeout)

    @property
    def text_hub(self) -> RunTextHub | None:
        return self._text_hub

    async def replay_run_text(self, *, owner_id: str, mission_id: str, run_id: str) -> str | None:
        """hub 已过期时，从 durable 事件回放本轮终稿。"""
        events = await self.list_events(owner_id=owner_id, mission_id=mission_id, after=0)
        for event in reversed(events):
            payload = event.get("payload") or {}
            if str(payload.get("run_id") or "") != run_id:
                continue
            if event["event_type"] == "agent.message":
                return str(payload.get("text") or "")
            if event["event_type"] == "clarification.required":
                return str(payload.get("question") or "")
        return None

    async def cancel_run(self, *, owner_id: str, mission_id: str, run_id: str) -> str:
        mission = await self.get_mission(owner_id=owner_id, mission_id=mission_id)
        if mission.active_run_id != run_id:
            raise RunNotRunning(run_id)
        cancelled = await self._dispatcher.cancel(
            owner_id=owner_id, mission_id=mission_id, run_id=run_id
        )
        if not cancelled:
            raise RunNotRunning(run_id)
        return run_id

    async def submit_turn(
        self,
        *,
        owner_id: str,
        mission_id: str,
        constraints_version: int,
        command: TurnCommand = TurnCommand.MESSAGE,
        text: str | None = None,
        focus_snapshot_id: str | None = None,
    ) -> str:
        """用户可感知动作的入口：说话或撤销。结构化改约束走 update_constraints。"""
        if command == TurnCommand.UNDO:
            run_id, _ = await self.undo(
                owner_id=owner_id,
                mission_id=mission_id,
                constraints_version=constraints_version,
            )
            return run_id
        return await self.submit_message(
            owner_id=owner_id,
            mission_id=mission_id,
            text=(text or "").strip(),
            constraints_version=constraints_version,
            focus_snapshot_id=focus_snapshot_id,
        )

    async def get_thread(self, *, owner_id: str, mission_id: str) -> ThreadView:
        events = await self.list_events(owner_id=owner_id, mission_id=mission_id, after=0)
        mission = await self.get_mission(owner_id=owner_id, mission_id=mission_id)
        candidates = await self.get_candidates(owner_id=owner_id, mission_id=mission_id)
        return project_thread(
            events,
            has_query=bool(mission.constraints.query),
            has_candidates=bool(candidates.ranked),
            ranked=[item.model_dump(mode="json") for item in candidates.ranked],
            belief=mission.belief,
            budget_cny=mission.constraints.budget_cny,
        )

    async def _require_mission(
        self, uow: UnitOfWork, owner_id: str, mission_id: str, constraints_version: int
    ) -> ShoppingMission:
        mission = await uow.missions.get(owner_id=owner_id, mission_id=mission_id)
        if mission is None:
            raise MissionNotFound(mission_id)
        if mission.constraints_version != constraints_version:
            raise MissionVersionConflict(
                f"expected constraints_version {constraints_version}, got {mission.constraints_version}"
            )
        return mission

    async def _persist_decision(
        self,
        uow: UnitOfWork,
        *,
        mission: ShoppingMission,
        decision: TurnDecision,
        expected_version: int,
        user_text: str | None = None,
        cache_payload: dict | None = None,
    ) -> tuple[str, int]:
        run_id = str(uuid4())
        before = mission.constraints
        after = decision.constraints if decision.apply_constraints else mission.constraints
        new_version = (
            next_constraints_version(mission.constraints_version, before, after)
            if decision.apply_constraints
            else mission.constraints_version
        )
        warnings = list(dict.fromkeys([*mission.warnings, *decision.warnings]))
        updated = mission.model_copy(
            update={
                "constraints": after,
                "constraints_version": new_version,
                "stage": stage_for_phase(decision.phase, mission.stage)
                if decision.dispatch
                else mission.stage,
                "turn_phase": decision.phase if decision.dispatch else TurnPhase.IDLE,
                "dialogue": decision.dialogue,
                "belief": decision.belief,
                "warnings": warnings,
                "active_run_id": run_id if decision.dispatch else mission.active_run_id,
                "updated_at": utcnow(),
            }
        )
        await uow.missions.save(updated, expected_version=expected_version)
        if user_text:
            await uow.events.append(
                mission_id=mission.id,
                event_type="message.received",
                payload={
                    "run_id": run_id,
                    "text": user_text,
                    "act": decision.act.kind.value,
                    "topic": decision.act.topic.value if decision.act.topic else None,
                    "constraints_version": mission.constraints_version,
                    "turn_phase": updated.turn_phase.value,
                    "source": decision.act.source,
                    "turn_route": decision.route.value,
                    "act_payload": decision.act.model_dump(mode="json"),
                    "skip_intent_patch": decision.apply_constraints
                    or decision.act.kind.value
                    not in {"refine_constraints", "unknown"},
                },
            )
        if decision.apply_constraints and after != before:
            await uow.events.append(
                mission_id=mission.id,
                event_type="constraints.updated",
                payload={
                    "run_id": run_id,
                    "before": before.model_dump(mode="json"),
                    "after": after.model_dump(mode="json"),
                    "constraints_version": new_version,
                },
            )
        if decision.agent_message and not decision.dispatch:
            await uow.events.append(
                mission_id=mission.id,
                event_type="agent.message",
                payload={
                    "run_id": run_id,
                    "text": decision.agent_message,
                    "act": decision.act.kind.value,
                    "topic": decision.act.topic.value if decision.act.topic else None,
                    "constraints_version": new_version,
                    "next_moves": [
                        item.model_dump()
                        for item in moves_for_reply(
                            select_probe(
                                constraints=after,
                                belief=decision.belief,
                                ranked=list((cache_payload or {}).get("ranked") or []),
                                last_act=decision.act,
                            ),
                            kind=decision.act.kind.value,
                            topic=decision.act.topic.value if decision.act.topic else None,
                            has_query=bool(after.query),
                            has_candidates=bool((cache_payload or {}).get("ranked")),
                            ranked=list((cache_payload or {}).get("ranked") or []),
                            belief=decision.belief,
                            budget_cny=after.budget_cny,
                        )
                    ],
                },
            )
        return run_id, new_version

    @staticmethod
    async def _cache_payload(uow: UnitOfWork, mission: ShoppingMission) -> dict | None:
        if not mission.candidate_set_id or not hasattr(uow, "candidate_sets"):
            return None
        return await uow.candidate_sets.get(mission.candidate_set_id)

    @staticmethod
    def _candidate_set_view(payload: dict | None) -> CandidateSetView:
        if not payload:
            return CandidateSetView()
        ranked: list[ProductCandidate] = []
        for index, item in enumerate(payload.get("ranked") or [], start=1):
            candidate = product_candidate_from_record(item, rank=index)
            if candidate is not None:
                ranked.append(candidate)
        return CandidateSetView(
            ranked=ranked,
            fx_snapshot_ids=list(payload.get("fx_snapshot_ids") or []),
        )

    @staticmethod
    async def _comparison_id_universe(uow: UnitOfWork, mission: ShoppingMission) -> set[str]:
        """比较集只接受当前候选的 snapshot_id。"""
        if mission.candidate_set_id is None:
            return set()
        payload = await uow.candidate_sets.get(mission.candidate_set_id)
        if not payload:
            return set()
        return {
            str(item["snapshot_id"])
            for item in payload.get("ranked") or []
            if item.get("snapshot_id")
        }


