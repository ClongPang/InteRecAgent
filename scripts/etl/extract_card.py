# scripts/etl/extract_card.py
import json
from pathlib import Path
import sys

PROJECT_ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(PROJECT_ROOT))

from app.agent.llm import get_judge_llm


EXTRACT_PROMPT = """
你是 Globex 品类知识库的卡片抽取器。

输入：一段关于品类 {category} 的原始资料（评测 / 销售榜 / 商品库聚合）。
输出：一张严格按格式写的 CategoryCard.summary。

约定格式（任选一种，根据 card_type）：
  bestseller:  "{{category}}：{{组件1}} / {{组件2}} / {{组件3}}"
  attribute:   "材质：尼龙 60% / 帆布 25% / 牛津布 15%"
  price_range: "便宜款 60-150 / 中档 150-400 / 高端 400+ 多见品牌联名"

raw_evidence 字段额外输出 1-3 条原始文本，每条不超过 80 字。
confidence: 0-1 之间，基于"原始数据量"和"措辞确定性"自评。

只输出 JSON，不要解释。
"""


async def extract_card(category: str, raw_text: str, card_type: str) -> dict:
    llm = get_judge_llm()
    resp = await llm.ainvoke([
        ("system", EXTRACT_PROMPT.format(category=category)),
        ("user", f"card_type={card_type}\n\n资料：\n{raw_text}"),
    ])
    return json.loads(resp.content)
