# scripts/try_category_insight.py
import asyncio
from pathlib import Path
import sys

PROJECT_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(PROJECT_ROOT))

from app.tools.category_insight import category_insight


async def main() -> None:
    # quick 模式：Top-K=8，不跑属性提炼
    result = await category_insight.ainvoke({
        "category": "旅行三件套",
        "depth": "quick",
    })
    print(result)


if __name__ == "__main__":
    asyncio.run(main())
