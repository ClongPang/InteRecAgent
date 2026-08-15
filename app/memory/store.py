from __future__ import annotations

import asyncio
import hashlib
import json
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Literal, Protocol

from pydantic import BaseModel, Field, model_validator


PROJECT_ROOT = Path(__file__).resolve().parents[2]
DEFAULT_STORE_PATH = PROJECT_ROOT / "data" / "memory" / "preferences.json"


PreferenceCategory = Literal["preference", "history", "blacklist"]


class PreferenceEntry(BaseModel):
    """One structured long-term memory entry for a user."""

    user_id: str
    key: str
    category: PreferenceCategory = "preference"
    content: str
    source_session: str | None = None
    created_at: str = Field(
        default_factory=lambda: datetime.now(timezone.utc).isoformat()
    )
    confidence: float = 1.0

    @model_validator(mode="before")
    @classmethod
    def _migrate_legacy_shape(cls, value: Any) -> Any:
        """Read stores written by the earlier value/source_thread_id schema."""
        if not isinstance(value, dict) or "content" in value:
            return value

        legacy_value = str(value.get("value", "")).strip()
        if not legacy_value:
            return value

        migrated = dict(value)
        migrated["content"] = legacy_value
        migrated["key"] = migrated.get("key") or make_preference_key(legacy_value)
        migrated["source_session"] = migrated.get("source_session") or migrated.get(
            "source_thread_id"
        )
        migrated["confidence"] = migrated.get("confidence") or migrated.get("weight", 1.0)
        migrated["category"] = migrated.get("category") or infer_preference_category(
            legacy_value
        )
        return migrated

    @property
    def value(self) -> str:
        """Compatibility alias for older callers."""
        return self.content

    @property
    def source_thread_id(self) -> str | None:
        """Compatibility alias for older callers."""
        return self.source_session


class PreferenceStore(Protocol):
    """Abstract preference store contract used by the Agent memory layer."""

    async def read(self, user_id: str) -> list[PreferenceEntry]:
        """Read every preference entry for one user."""
        ...

    async def write(self, user_id: str, entry: PreferenceEntry) -> None:
        """Write one preference entry, replacing an existing entry with the same key."""
        ...

    async def delete(self, user_id: str, key: str) -> None:
        """Delete one preference entry."""
        ...

    async def read_relevant(
        self,
        user_id: str,
        query: str,
        top_k: int = 5,
    ) -> list[PreferenceEntry]:
        """Read the entries most related to the current query."""
        ...


class JsonPreferenceStore:
    """Small local Store backend for bootstrap and tests.

    Production can replace this with LangGraph BaseStore + OpenSearch while
    keeping the same read/write surface.
    """

    def __init__(self, path: Path = DEFAULT_STORE_PATH) -> None:
        self.path = path
        self._lock = asyncio.Lock()

    async def read(self, user_id: str) -> list[PreferenceEntry]:
        """Read every structured preference entry for one user."""
        async with self._lock:
            raw = await asyncio.to_thread(self._read_all)
        return [
            PreferenceEntry.model_validate(item)
            for item in raw
            if item.get("user_id") == user_id
        ]

    async def write(self, user_id: str, entry: PreferenceEntry) -> None:
        """Write one entry, replacing an existing entry with the same key."""
        entry = entry.model_copy(update={"user_id": user_id})
        async with self._lock:
            raw = await asyncio.to_thread(self._read_all)
            replaced = False
            for idx, item in enumerate(raw):
                if item.get("user_id") == user_id and item.get("key") == entry.key:
                    raw[idx] = entry.model_dump()
                    replaced = True
                    break
            if not replaced:
                raw.append(entry.model_dump())
            await asyncio.to_thread(self._write_all, raw)

    async def delete(self, user_id: str, key: str) -> None:
        """Delete one preference entry when the user retracts it."""
        async with self._lock:
            raw = await asyncio.to_thread(self._read_all)
            filtered = [
                item
                for item in raw
                if not (item.get("user_id") == user_id and item.get("key") == key)
            ]
            await asyncio.to_thread(self._write_all, filtered)

    async def read_relevant(
        self,
        user_id: str,
        query: str,
        top_k: int = 5,
    ) -> list[PreferenceEntry]:
        """Read the top-k entries most related to the current query.

        This local bootstrap implementation uses deterministic lexical matching.
        A production backend can replace it with vector search behind the same
        method.
        """
        entries = await self.read(user_id)
        if top_k <= 0:
            return []
        if not query.strip():
            return entries[:top_k]

        scored = [
            (_relevance_score(entry, query), idx, entry)
            for idx, entry in enumerate(entries)
        ]
        scored.sort(key=lambda item: (-item[0], item[1]))
        return [entry for _, _, entry in scored[:top_k]]

    async def list_preferences(self, user_id: str) -> list[PreferenceEntry]:
        """Compatibility wrapper for earlier code."""
        return await self.read(user_id)

    async def add_preferences(
        self,
        user_id: str,
        values: list[str],
        source_thread_id: str | None = None,
    ) -> list[PreferenceEntry]:
        entries = [
            PreferenceEntry(
                user_id=user_id,
                key=make_preference_key(value),
                category=infer_preference_category(value),
                content=value.strip(),
                source_session=source_thread_id,
            )
            for value in values
            if value.strip()
        ]
        if not entries:
            return []

        async with self._lock:
            raw = await asyncio.to_thread(self._read_all)
            existing_content = {
                (item.get("user_id"), item.get("content") or item.get("value"))
                for item in raw
            }
            existing_key = {(item.get("user_id"), item.get("key")) for item in raw}
            written: list[PreferenceEntry] = []
            for entry in entries:
                content_key = (entry.user_id, entry.content)
                entry_key = (entry.user_id, entry.key)
                if content_key not in existing_content and entry_key not in existing_key:
                    raw.append(entry.model_dump())
                    existing_content.add(content_key)
                    existing_key.add(entry_key)
                    written.append(entry)
            await asyncio.to_thread(self._write_all, raw)
        return written

    def _read_all(self) -> list[dict[str, Any]]:
        if not self.path.exists():
            return []
        with self.path.open("r", encoding="utf-8") as f:
            data = json.load(f)
        return data if isinstance(data, list) else []

    def _write_all(self, data: list[dict[str, Any]]) -> None:
        self.path.parent.mkdir(parents=True, exist_ok=True)
        with self.path.open("w", encoding="utf-8") as f:
            json.dump(data, f, ensure_ascii=False, indent=2)


preference_store = JsonPreferenceStore()


def infer_preference_category(content: str) -> PreferenceCategory:
    blacklist_markers = ("不要", "不接受", "排除", "别推", "过滤", "避开")
    history_markers = ("上次", "之前", "买过", "搜索过", "最终选")
    if any(marker in content for marker in blacklist_markers):
        return "blacklist"
    if any(marker in content for marker in history_markers):
        return "history"
    return "preference"


def make_preference_key(content: str, prefix: str | None = None) -> str:
    normalized = " ".join(content.strip().split())
    digest = hashlib.sha1(normalized.encode("utf-8")).hexdigest()[:12]
    return f"{prefix or infer_preference_category(content)}_{digest}"


def _relevance_score(entry: PreferenceEntry, query: str) -> float:
    query_terms = _terms(query)
    content_terms = _terms(entry.content)
    if not query_terms:
        return entry.confidence

    overlap = len(query_terms & content_terms)
    substring_bonus = 1 if entry.content in query or query in entry.content else 0
    category_bonus = 0.25 if entry.category in {"blacklist", "preference"} else 0.0
    return overlap * 2 + substring_bonus + category_bonus + entry.confidence * 0.1


def _terms(text: str) -> set[str]:
    normalized = text.lower()
    terms = set()
    current = []
    for char in normalized:
        if char.isalnum():
            current.append(char)
            continue
        if current:
            terms.add("".join(current))
            current = []
    if current:
        terms.add("".join(current))
    for size in (2, 3, 4):
        terms.update(
            normalized[idx : idx + size]
            for idx in range(max(len(normalized) - size + 1, 0))
            if normalized[idx : idx + size].strip()
        )
    return terms
