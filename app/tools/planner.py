# app/tools/planner.py
from pydantic import BaseModel, Field
from langchain_core.tools import tool


class MaterialPreference(BaseModel):
    exclude: list[str] = Field(default_factory=list)
    prefer: list[str] = Field(default_factory=list)


class PlannerOutput(BaseModel):
    budget: float | None = None
    category: str | None = None
    material_pref: MaterialPreference = Field(default_factory=MaterialPreference)
    style_pref: str | None = None
    platforms: list[str] = Field(default_factory=list)
    hard_constraints: list[str] = Field(default_factory=list)
    soft_preferences: list[str] = Field(default_factory=list)


@tool
async def planner(user_query: str) -> PlannerOutput:
    """拆解用户购物意图为结构化字段。

    Use when: 用户意图复杂、首轮信息量大，或同时包含预算、材质、
    风格、平台等 2 个及以上约束。
    Do not use when: 用户只是单一、明确的单品查询；这类请求直接走
    ItemSearch，避免浪费一轮规划。
    """
    return PlannerOutput(category=user_query)
