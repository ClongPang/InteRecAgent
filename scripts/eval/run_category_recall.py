# scripts/eval/run_category_recall.py
import asyncio
import json
from pathlib import Path
import sys

PROJECT_ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(PROJECT_ROOT))

from app.eval.recall_metrics import mrr, ndcg_at_k, recall_at_k
from app.tools.category_insight import _recall_cards


EVAL_PATH = Path("data/eval/category_recall.jsonl")
TOP_K = 10


async def main() -> None:
    samples = [json.loads(line) for line in EVAL_PATH.open(encoding="utf-8")]
    recall_sum = mrr_sum = ndcg_sum = 0.0

    for sample in samples:
        cards = await _recall_cards(sample["query"], top_k=TOP_K)
        retrieved = [card.card_id for card in cards]
        recall_sum += recall_at_k(retrieved, sample["relevant"], TOP_K)
        mrr_sum += mrr(retrieved, sample["relevant"])
        ndcg_sum += ndcg_at_k(retrieved, sample["relevant"], TOP_K)

    n = len(samples)
    print(f"Recall@{TOP_K} = {recall_sum / n:.3f}")
    print(f"MRR          = {mrr_sum / n:.3f}")
    print(f"NDCG@{TOP_K}   = {ndcg_sum / n:.3f}")


if __name__ == "__main__":
    asyncio.run(main())
