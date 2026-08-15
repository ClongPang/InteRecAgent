from __future__ import annotations

import json
import tempfile
import unittest
from pathlib import Path

from app.memory.injector import format_preferences, maybe_write_preference
from app.memory.store import JsonPreferenceStore, PreferenceEntry, make_preference_key


class JsonPreferenceStoreTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        self.path = Path(self.tmp.name) / "preferences.json"
        self.store = JsonPreferenceStore(self.path)

    def tearDown(self) -> None:
        self.tmp.cleanup()

    async def test_write_read_relevant_and_delete_structured_entry(self) -> None:
        entry = PreferenceEntry(
            user_id="user-1",
            key="material_blacklist",
            category="blacklist",
            content="不接受塑料材质的商品",
            source_session="thread-1",
            confidence=0.9,
        )

        await self.store.write("user-1", entry)
        await self.store.write(
            "user-1",
            entry.model_copy(update={"content": "不要塑料材质", "confidence": 1.0}),
        )

        entries = await self.store.read("user-1")
        self.assertEqual(len(entries), 1)
        self.assertEqual(entries[0].content, "不要塑料材质")

        relevant = await self.store.read_relevant("user-1", "帮我搜洗漱包，不要塑料", 1)
        self.assertEqual(relevant[0].key, "material_blacklist")

        await self.store.delete("user-1", "material_blacklist")
        self.assertEqual(await self.store.read("user-1"), [])

    async def test_add_preferences_dedupes_and_infers_category(self) -> None:
        written = await self.store.add_preferences(
            user_id="user-1",
            values=["不要塑料", "不要塑料", "偏好小众设计"],
            source_thread_id="thread-1",
        )

        self.assertEqual(len(written), 2)
        entries = await self.store.read("user-1")
        self.assertEqual({entry.category for entry in entries}, {"blacklist", "preference"})
        self.assertTrue(all(entry.source_session == "thread-1" for entry in entries))

    async def test_legacy_value_shape_is_readable(self) -> None:
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self.path.write_text(
            json.dumps([
                {
                    "user_id": "user-1",
                    "value": "不接受塑料材质",
                    "source_thread_id": "thread-legacy",
                    "weight": 0.8,
                }
            ], ensure_ascii=False),
            encoding="utf-8",
        )

        entries = await self.store.read("user-1")
        self.assertEqual(entries[0].content, "不接受塑料材质")
        self.assertEqual(entries[0].source_session, "thread-legacy")
        self.assertEqual(entries[0].category, "blacklist")
        self.assertEqual(entries[0].key, make_preference_key("不接受塑料材质"))

    async def test_maybe_write_preference_and_format_preferences(self) -> None:
        import app.memory.injector as injector

        original_store = injector.preference_store
        injector.preference_store = self.store
        try:
            entry = await maybe_write_preference(
                "帮我搜旅行收纳袋，不要塑料的，最好小众一点",
                "user-1",
                "thread-1",
            )
            self.assertIsNotNone(entry)
            block = format_preferences(await self.store.read_relevant("user-1", "洗漱包", 5))
        finally:
            injector.preference_store = original_store

        self.assertIn("[blacklist]", block)
        self.assertIn("不要塑料", block)


if __name__ == "__main__":
    unittest.main()
