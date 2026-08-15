# examples/02_quickstart.py
from pathlib import Path
import sys
from langchain_core.tools import tool

PROJECT_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(PROJECT_ROOT))
from app.agent.llm import get_llm
from langchain.agents import create_agent

@tool
def planner(user_input: str) -> str:
    """拆解用户的购物需求，提取预算、材质偏好、品类等结构化信息。"""
    # 结构化返回
    return "需求拆解：品类=旅行三件套, 预算=300, 偏好=不要塑料, 风格=小众"


@tool
def item_search(query: str) -> str:
    """搜索商品。"""
    return f"搜到 5 件匹配「{query}」的商品"


@tool
def item_picker(items: str, preference: str) -> str:
    """根据用户偏好从商品列表中精挑。"""
    return f"根据偏好「{preference}」，推荐其中 2 件：硅胶旅行瓶套装、帆布收纳袋"


# 主 AgentLoop 的 system prompt (七要素结构化模板)
SYSTEM_PROMPT = """<role>
你是 HeartShop 跨境购物 Agent。能力边界：仅负责商品搜索 + 比价 + 精挑，不做客服、不做下单、不做退换。
</role>

<workflow>
对每个用户购物意图，按 Think → Act → Observe → Reflect 推进：
1. Think: 拆解需求（品类 / 预算 / 材质偏好 / 排除项）
2. Act: 调工具搜索 / 比价
3. Observe: 检查工具返回是否覆盖用户全部约束
4. Reflect: 信息够了就输出推荐；不够就回到 Think 补
</workflow>

<tool_policy>
- 复杂需求（含多个约束词）必先调 planner，不要直接 item_search
- item_search 之后必须调 item_picker，不准跳过精挑直接给清单
- 同一个 query 不要反复调 item_search（最多 1 次，除非 Reflect 判定需要换关键词）
</tool_policy>

<termination>
满足任一即停止循环：
- 已经返回了 ≤ 5 件最终推荐
- 用户原始约束全部覆盖
- 连续 2 轮 Reflect 都判定“信息已足够”
</termination>

<output_format>
最终输出 JSON: {"items": [...], "reasoning": "..."}。
推荐理由必须显式回应用户的每一条约束（预算 / 材质 / 风格）。
</output_format>

<constraints>
- 不准编造商品名 / 价格，所有信息来自工具返回
- 用户的“排除项”（“不要 X”）是硬约束，违反即重新精挑
- 不准擅自加入用户没要求的属性筛选
</constraints>"""


agent = create_agent(
    model=get_llm(),
    tools=[planner, item_search, item_picker],
    system_prompt=SYSTEM_PROMPT,
)

result = agent.invoke({
    "messages": [("user", "想买一套旅行三件套，预算300，不要塑料的，偏小众")]
})

# 查看最终回复
for msg in result["messages"]:
    print(f"[{msg.type}] {msg.content}")
