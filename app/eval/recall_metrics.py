# app/eval/recall_metrics.py
from typing import Sequence


def recall_at_k(retrieved: Sequence[str], relevant: Sequence[str], k: int) -> float:
    """Top-K 召回里覆盖了多少标注。"""
    top_k = set(retrieved[:k])
    rel = set(relevant)
    if not rel:
        return 0.0
    return len(top_k & rel) / len(rel)


def mrr(retrieved: Sequence[str], relevant: Sequence[str]) -> float:
    """首条相关卡片的倒数排名。"""
    rel = set(relevant)
    for i, rid in enumerate(retrieved, start=1):
        if rid in rel:
            return 1.0 / i
    return 0.0


def ndcg_at_k(retrieved: Sequence[str], relevant: Sequence[str], k: int) -> float:
    """NDCG@K：考虑位置 + 标注序的 gain。"""
    import math

    rel_rank = {rid: len(relevant) - i for i, rid in enumerate(relevant)}
    dcg = sum(
        rel_rank.get(rid, 0) / math.log2(i + 2)
        for i, rid in enumerate(retrieved[:k])
    )
    ideal = sum(
        rel_rank[rid] / math.log2(i + 2)
        for i, rid in enumerate(relevant[:k])
    )
    return dcg / ideal if ideal else 0.0
