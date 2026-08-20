"""真实 Key 的 live 冒烟：验证控制反转后新架构对 LLM 的三条依赖契约。

三段都打真实模型（Key/BaseURL/Model 来自 .env → Settings），不入库、不打 BuyWhere；
商品用脱敏 fixture、汇率用固定源，只把「LLM 是否真的能驱动新链路」暴露出来：
  1. parse_intent 抽取开放式 soft_prefs（Phase 2）。
  2. parse_turn 分类 + 开放式 soft_prefs（Phase 2/3）。
  3. complete_json 探针 + run_agent 端到端研究环（keep / 改写 / TopK）。

用法（PowerShell）：uv run python scripts/live_smoke.py
"""
from __future__ import annotations

import asyncio
from pathlib import Path

from backend.agent.loop import run_agent
from backend.agent.tools import ResearchContext, ResearchTools
from backend.application.dto.mission import MissionConstraints, ShoppingMission
from backend.application.services.rec import plan_search, rec_state_from_mission
from backend.bootstrap.settings import Settings
from backend.infrastructure.fx_sources.fixed import FixedFxSource
from backend.infrastructure.llm.factory import build_model_backend
from backend.infrastructure.product_sources.fixture import FixtureProductSource

FIXTURES = Path(__file__).resolve().parents[1] / "tests" / "fixtures" / "buywhere"


def _dims(soft_prefs) -> list[tuple]:
    return [(d.attr, d.direction, list(d.cues or [])) for d in (soft_prefs or [])]


async def main() -> int:
    s = Settings()
    print(f"== live smoke ==\nprovider={s.llm_provider} model={s.llm_model} base={s.llm_base_url}")
    if s.llm_provider == "unconfigured" or not s.llm_api_key:
        print("!! 未配置 INTEREC_LLM_API_KEY，退出（这是无 Key 提示，非失败）")
        return 0
    backend = build_model_backend(
        provider=s.llm_provider,
        api_key=s.llm_api_key,
        base_url=s.llm_base_url,
        model=s.llm_model,
        timeout=s.llm_timeout,
        max_retries=s.llm_max_retries,
    )
    print(f"is_configured={backend.is_configured()} supports_tools={backend.supports_tools()}")
    failures: list[str] = []
    try:
        # 1) parse_intent 开放式软偏好
        print("\n[1] parse_intent '游戏笔记本，预算 9000 元，散热好一点、要能长续航'")
        patch = await backend.parse_intent("游戏笔记本，预算 9000 元，散热好一点、要能长续航")
        print(f"    source={patch.source} query={patch.query!r} budget={patch.budget_cny} markets={patch.markets}")
        print(f"    soft_prefs={_dims(patch.soft_prefs)}")
        if not patch.soft_prefs:
            failures.append("[1] parse_intent 未产出 soft_prefs（开放式偏好通道未激活）")

        # 2) parse_turn 分类 + 软偏好
        print("\n[2a] parse_turn '要防水的' (current_query='通勤降噪耳机')")
        act = await backend.parse_turn("要防水的", current_query="通勤降噪耳机")
        sp = act.patch.soft_prefs if act.patch else None
        print(f"    kind={act.kind.value} soft_prefs={_dims(sp)}")
        if act.kind.value != "refine_constraints" or not sp:
            failures.append("[2a] '要防水的' 未走 refine_constraints+soft_prefs")

        print("\n[2b] parse_turn '帮我比前两个' (current_query='通勤降噪耳机')")
        act2 = await backend.parse_turn("帮我比前两个", current_query="通勤降噪耳机")
        print(f"    kind={act2.kind.value} referent_ranks={act2.referent_ranks} patch_query={act2.patch.query if act2.patch else None}")
        if act2.kind.value != "compare_items":
            failures.append("[2b] '帮我比前两个' 未分类为 compare_items")

        # 3) 研究循环
        mission = ShoppingMission(
            owner_id="smoke",
            title="live",
            constraints=MissionConstraints(query="降噪耳机", budget_cny=4000, markets=["US"]),
        )
        plan = plan_search(rec_state_from_mission(mission))
        tools = ResearchTools(FixtureProductSource(FIXTURES), FixedFxSource())

        print("\n[3a] complete_json keep 探针")
        judged = await backend.complete_json(
            system="只输出 JSON：{\"keep\":[\"id1\"]}。只能勾选输入 id。",
            user='{"task":"keep","query":"降噪耳机","candidates":[{"id":"x1","title":"Sony WH-1000XM5"}]}',
        )
        print(f"    keep={judged}")
        if "keep" not in judged:
            failures.append("[3a] complete_json 未返回 keep 字段")

        print("\n[3b] run_agent 端到端（后端控环 + fixture 商品/固定汇率）")
        ctx = ResearchContext(mission=mission, plan=plan)
        await run_agent(ctx, tools, backend)
        over_budget = [p.rmb_price for p in ctx.ranked if p.rmb_price and p.rmb_price > 4000]
        print(f"    searched={ctx.searched} converted={ctx.converted} finalized={ctx.finalized} stale={ctx.stale}")
        print(f"    ranked_count={len(ctx.ranked)} budget_respected={not over_budget}")
        for p in ctx.ranked[:3]:
            print(f"      - {p.id} {p.title!r} rmb={p.rmb_price}")
        if ctx.warnings:
            print(f"    warnings={ctx.warnings}")
        if not ctx.ranked:
            failures.append("[3b] run_agent 未产出任何排序候选")
        if over_budget:
            failures.append(f"[3b] 排序候选超预算 4000：{over_budget}")
    finally:
        await backend.aclose()

    print("\n== 结论 ==")
    if failures:
        for f in failures:
            print(f"  FAIL {f}")
        return 1
    print("  PASS 全部 live 契约通过")
    return 0


if __name__ == "__main__":
    raise SystemExit(asyncio.run(main()))
