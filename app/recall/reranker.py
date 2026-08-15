# app/recall/reranker.py
import os
from typing import Sequence

import httpx


class RerankerClient:
    """BGE-Reranker-v2-m3 的极简客户端。

    要求服务端暴露 /rerank：
      入参 {query: str, candidates: list[str]}
      出参 {scores: list[float]} 与 candidates 同序
    """

    def __init__(self, endpoint_env: str = "RERANKER_ENDPOINT") -> None:
        self.endpoint_env = endpoint_env

    async def score(self, query: str, candidates: Sequence[str]) -> list[float]:
        endpoint = os.environ.get(self.endpoint_env)
        if not endpoint:
            raise RuntimeError(f"Missing {self.endpoint_env}")

        async with httpx.AsyncClient(timeout=3.0) as client:
            response = await client.post(
                endpoint,
                json={"query": query, "candidates": list(candidates)},
            )
            response.raise_for_status()
            return response.json()["scores"]


reranker = RerankerClient()
