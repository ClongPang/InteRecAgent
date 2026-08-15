from __future__ import annotations

import json
import sys
from pathlib import Path


PROJECT_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(PROJECT_ROOT))

from app.compress.breakpoint import compute_breakpoint
from app.compress.compressor import compress_after_breakpoint


def main() -> None:
    messages = [
        {"role": "system", "content": "HeartShop system prompt"},
        {"role": "user", "content": "旅行三件套，预算 300，不要塑料。"},
        {"role": "assistant", "content": "我先拆解需求。"},
        {"role": "tool", "content": "planner: budget=300, constraints=不要塑料"},
        {"role": "assistant", "content": "开始检索候选商品。"},
        {"role": "tool", "content": "item_search: " + "候选商品A;" * 900},
        {"role": "assistant", "content": "继续比价。"},
        {"role": "tool", "content": "price_compare: " + "价格行;" * 900},
    ]

    breakpoint_idx = compute_breakpoint(messages, keep_recent=2)
    compressed = compress_after_breakpoint(
        messages,
        breakpoint_idx,
        max_tool_result_chars=160,
    )

    print(f"Cache Breakpoint index: {breakpoint_idx}")
    print(json.dumps(compressed, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
