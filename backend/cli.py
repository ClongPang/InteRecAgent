from __future__ import annotations

import argparse
import asyncio
import sys

from .bootstrap.container import ConfigurationError, Container
from .domain.models import SearchMode, SearchParams


def _fmt_price(p) -> str:
    if p.rmb_price is not None:
        return f"¥{p.rmb_price:,.2f}  (原币 {p.native_price_amount:g} {p.native_currency}, 汇率 {p.fx_as_of})"
    return f"¥--  汇率不可用 (原币 {p.native_price_amount:g} {p.native_currency})"


async def _run(args: argparse.Namespace) -> None:
    container = Container()
    try:
        service = container.build_search_service()
    except ConfigurationError as exc:
        print(f"配置错误: {exc}", file=sys.stderr)
        raise SystemExit(1) from exc

    params = SearchParams(
        query=args.query,
        markets=[m.strip() for m in args.market.split(",") if m.strip()],
        mode=SearchMode(args.mode),
        limit=args.limit,
        budget_cny=args.budget,
    )
    result = await service.run(params)

    print(f"\n数据源: {container.settings.data_source}")
    print(f"查询: {result.query}  市场: {','.join(result.markets)}  模式: {result.mode}")
    print(f"商品数: {len(result.products)}  降级: {'是' if result.degraded else '否'}")
    for w in result.warnings:
        print(f"  警告: {w}")
    print()
    for i, p in enumerate(result.products, 1):
        print(f"{i:>2}. {p.title[:48]}")
        print(f"     {p.merchant or '?'} · {p.country_code or '?'} · {_fmt_price(p)}")
        if p.fx_failed:
            print("      [!] 汇率换算失败，保留原币")
    if result.fx:
        print("\n汇率快照:", ", ".join(f"{f.base}→{f.quote}={f.rate:g} ({f.date})" for f in result.fx))


def main() -> None:
    parser = argparse.ArgumentParser(description="InteRecAgent 搜索 CLI（数据源由 INTEREC_DATA_SOURCE 决定）")
    parser.add_argument("query", help="搜索词，例如 sony wh1000xm5 耳机")
    parser.add_argument("--budget", type=float, default=None, help="人民币预算，如 2500")
    parser.add_argument("--market", default="US", help="市场，逗号分隔，如 US,SG")
    parser.add_argument("--mode", default="keyword", choices=[m.value for m in SearchMode])
    parser.add_argument("--limit", type=int, default=20)
    args = parser.parse_args()
    asyncio.run(_run(args))


if __name__ == "__main__":
    main()
