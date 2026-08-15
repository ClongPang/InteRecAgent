# app/recall/ann.py
import json
import os
from pathlib import Path
from typing import Any


class AnnClient:
    """FAISS ANN client for product recall.

    The index is loaded lazily so importing tools does not require ANN_INDEX_PATH,
    faiss, or numpy until item_search actually runs.
    """

    def __init__(self, index_path: Path | None = None) -> None:
        self._index_path = index_path
        self._index: Any | None = None
        self._meta: dict[int, dict[str, Any]] = {}

    def search(self, emb: list[float], top_k: int, platform: str) -> list[dict[str, Any]]:
        index = self._load_index()

        import numpy as np

        vec = np.asarray([emb], dtype=np.float32)
        scores, idxs = index.search(vec, top_k * 3)  # 多召回点用于 platform 过滤

        results: list[dict[str, Any]] = []
        for score, idx in zip(scores[0], idxs[0]):
            if idx < 0:
                continue
            meta = self._meta.get(int(idx))
            if meta and meta.get("platform") == platform:
                results.append({**meta, "score": float(score)})
            if len(results) >= top_k:
                break
        return results

    def _load_index(self) -> Any:
        if self._index is not None:
            return self._index

        index_path = self._index_path
        if index_path is None:
            raw_path = os.environ.get("ANN_INDEX_PATH")
            if not raw_path:
                raise RuntimeError("Missing ANN_INDEX_PATH")
            index_path = Path(raw_path)

        try:
            import faiss
        except ImportError as exc:
            raise RuntimeError("faiss is required to use item_search ANN recall") from exc

        self._index = faiss.read_index(str(index_path))
        self._meta = self._load_meta(index_path.with_suffix(".meta.json"))
        return self._index

    def _load_meta(self, path: Path) -> dict[int, dict[str, Any]]:
        with path.open() as f:
            raw = json.load(f)
        return {int(k): v for k, v in raw.items()}


ann_client = AnnClient()
