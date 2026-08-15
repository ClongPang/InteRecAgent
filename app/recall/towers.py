# app/recall/towers.py
import os
from typing import Any

import httpx


class TowerClient:
    """Thin client for the user/query embedding towers used by recall tools."""

    def __init__(self, endpoint_env: str = "TOWER_QUERY_ENDPOINT") -> None:
        self.endpoint_env = endpoint_env

    async def encode_user(self, user_id: str) -> list[float]:
        return await self._encode("TOWER_USER_ENDPOINT", {"user_id": user_id})

    async def encode_query(self, query: str) -> list[float]:
        return await self._encode(self.endpoint_env, {"query": query})

    async def _encode(self, endpoint_env: str, payload: dict[str, str]) -> list[float]:
        endpoint = os.environ.get(endpoint_env)
        if not endpoint:
            raise RuntimeError(f"Missing {endpoint_env}")

        async with httpx.AsyncClient(timeout=5.0) as client:
            response = await client.post(endpoint, json=payload)
            response.raise_for_status()
            response_payload: dict[str, Any] = response.json()

        embedding = response_payload.get("embedding")
        if (
            embedding is None
            and isinstance(response_payload.get("data"), list)
            and response_payload["data"]
        ):
            embedding = response_payload["data"][0].get("embedding")
        if not isinstance(embedding, list):
            raise RuntimeError("Tower response did not contain an embedding list")
        return [float(value) for value in embedding]


tower_client = TowerClient()
