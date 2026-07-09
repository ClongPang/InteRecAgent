from __future__ import annotations

import hashlib
import json
import os
from collections.abc import Callable
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any
from urllib import request

from pydantic import BaseModel, ValidationError


DEFAULT_DEEPSEEK_BASE_URL = "https://api.deepseek.com/v1"


class LLMAdapterError(RuntimeError):
    pass


def _read_dotenv(path: Path = Path(".env")) -> dict[str, str]:
    if not path.exists():
        return {}
    values: dict[str, str] = {}
    for line in path.read_text(encoding="utf-8").splitlines():
        stripped = line.strip()
        if not stripped or stripped.startswith("#") or "=" not in stripped:
            continue
        key, value = stripped.split("=", 1)
        values[key.strip()] = value.strip().strip('"').strip("'")
    return values


def _env_value(name: str, default: str | None = None) -> str | None:
    return os.getenv(name) or _read_dotenv().get(name) or default


def _looks_like_secret(value: str | None) -> bool:
    if not value:
        return False
    return value.startswith(("sk-", "sk_"))


@dataclass
class LLMAdapter:
    mode: str = "mock"
    cache: dict[str, dict[str, Any]] = field(default_factory=dict)
    model: str | None = None
    base_url: str | None = None
    api_key: str | None = None
    transport: Callable[[dict[str, Any]], dict[str, Any]] | None = None

    def generate_json(self, prompt: str, schema: type[BaseModel]) -> BaseModel:
        raw = self._live_response(prompt) if self.mode == "live" else self._raw_response(prompt)
        try:
            return schema.model_validate(raw)
        except ValidationError as exc:
            raise LLMAdapterError("LLM output failed schema validation") from exc

    def _raw_response(self, prompt: str) -> dict[str, Any]:
        key = hashlib.sha256(prompt.encode("utf-8")).hexdigest()
        if self.mode == "cached" and key in self.cache:
            return self.cache[key]
        response = {
            "ordered_product_ids": [],
            "rationale": "mock schema-validated response",
        }
        if self.mode == "cached":
            self.cache[key] = response
        return response

    def _live_response(self, prompt: str) -> dict[str, Any]:
        payload = {
            "model": self.model or _env_value("DeepSeek_MODEL", "deepseek-chat"),
            "messages": [
                {
                    "role": "system",
                    "content": "Return only valid JSON matching the requested schema.",
                },
                {"role": "user", "content": prompt},
            ],
            "response_format": {"type": "json_object"},
        }
        completion = self.transport(payload) if self.transport else self._post_live(payload)
        try:
            content = completion["choices"][0]["message"]["content"]
        except (KeyError, IndexError, TypeError) as exc:
            raise LLMAdapterError("live LLM response did not include message content") from exc
        try:
            return json.loads(content)
        except json.JSONDecodeError as exc:
            raise LLMAdapterError("live LLM response was not valid JSON") from exc

    def _post_live(self, payload: dict[str, Any]) -> dict[str, Any]:
        configured_base_url = self.base_url or _env_value("DeepSeek_BASE_URL")
        api_key = self.api_key or _env_value("DeepSeek_API_KEY")
        if _looks_like_secret(configured_base_url) and not api_key:
            api_key = configured_base_url
            configured_base_url = DEFAULT_DEEPSEEK_BASE_URL

        base_url = (configured_base_url or "").rstrip("/")
        if not base_url.startswith(("http://", "https://")):
            raise LLMAdapterError("live LLM base URL must be configured as an http(s) endpoint")
        endpoint = f"{base_url}/chat/completions"
        headers = {"Content-Type": "application/json"}
        if api_key:
            headers["Authorization"] = f"Bearer {api_key}"
        req = request.Request(
            endpoint,
            data=json.dumps(payload).encode("utf-8"),
            headers=headers,
            method="POST",
        )
        with request.urlopen(req, timeout=30) as response:
            return json.loads(response.read().decode("utf-8"))


class RerankPlan(BaseModel):
    ordered_product_ids: list[str]
    rationale: str
