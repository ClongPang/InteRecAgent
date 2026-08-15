from __future__ import annotations

from app.memory.store import PreferenceEntry, make_preference_key, preference_store


async def load_preference_block(user_id: str, query: str | None = None) -> str:
    entries = (
        await preference_store.read_relevant(user_id, query, top_k=5)
        if query
        else await preference_store.read(user_id)
    )
    if not entries:
        return ""
    return format_preferences(entries)


async def remember_preferences(
    user_id: str,
    preferences: list[str],
    source_thread_id: str | None = None,
) -> list[str]:
    entries = await preference_store.add_preferences(
        user_id=user_id,
        values=preferences,
        source_thread_id=source_thread_id,
    )
    return [entry.content for entry in entries]


async def maybe_write_preference(
    user_message: str,
    user_id: str,
    source_thread_id: str | None = None,
) -> PreferenceEntry | None:
    """Persist a clear user preference using a small bootstrap rule matcher."""
    content = user_message.strip()
    if not content:
        return None

    blacklist_patterns = ("不要", "不接受", "排除", "别推")
    preference_patterns = ("喜欢", "偏好", "倾向", "习惯", "最好")
    category = None
    key_prefix = None

    if any(pattern in content for pattern in blacklist_patterns):
        category = "blacklist"
        key_prefix = "blacklist"
    elif any(pattern in content for pattern in preference_patterns):
        category = "preference"
        key_prefix = "preference"

    if category is None:
        return None

    entry = PreferenceEntry(
        user_id=user_id,
        key=make_preference_key(content, key_prefix),
        category=category,
        content=content,
        source_session=source_thread_id,
        confidence=1.0,
    )
    await preference_store.write(user_id, entry)
    return entry


def format_preferences(entries: list[PreferenceEntry]) -> str:
    return "\n".join(
        f"- [{entry.category}] {entry.content}"
        for entry in entries
        if entry.content.strip()
    )
