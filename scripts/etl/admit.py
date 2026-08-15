# scripts/etl/admit.py
from pathlib import Path
import sys

from pydantic import ValidationError

PROJECT_ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(PROJECT_ROOT))

from app.recall.category_kb import CategoryCard


MIN_CONFIDENCE = 0.5
MAX_SUMMARY_LEN = 200
SAMPLE_AUDIT_RATIO = 0.1  # 10% 的卡片走人工抽审


def admit(raw: dict) -> tuple[bool, str]:
    # 门 1：schema 严格校验
    try:
        card = CategoryCard(**raw)
    except ValidationError as e:
        return False, f"schema 校验失败: {e}"

    # 门 2：confidence + 长度
    if card.confidence < MIN_CONFIDENCE:
        return False, f"confidence {card.confidence} < {MIN_CONFIDENCE}"
    if len(card.summary) > MAX_SUMMARY_LEN:
        return False, f"summary 超长 {len(card.summary)}"

    # 门 3：summary 格式约定校验
    if card.card_type == "bestseller" and "：" not in card.summary:
        return False, "bestseller summary 缺少品类前缀"
    if card.card_type == "attribute" and "%" not in card.summary:
        return False, "attribute summary 缺少百分比"

    return True, "ok"
