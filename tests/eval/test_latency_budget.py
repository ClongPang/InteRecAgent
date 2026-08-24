from __future__ import annotations

from statistics import quantiles
from time import perf_counter

from backend.application.dto import GoalTarget, ShoppingGoal
from backend.application.services.rec import assess_goal_coverage
from backend.application.services.rec.qualify import qualify_product
from backend.domain.models import NormalizedProduct


def test_qualification_coverage_p95_stays_within_reviewed_ci_budget() -> None:
    """Deterministic V2 decision kernel budget; provider/network latency is separate."""
    goal = ShoppingGoal(target=GoalTarget(item_type="headphones"))
    products = [
        NormalizedProduct(
            id=f"p-{index}",
            title=f"Wireless Headphones {index}",
            merchant="fixture",
            native_price_amount=100 + index,
            native_currency="USD",
            rmb_price=700 + index,
        )
        for index in range(50)
    ]
    samples: list[float] = []
    for _ in range(40):
        started = perf_counter()
        qualifications = [qualify_product(item, goal) for item in products]
        assess_goal_coverage(qualifications, goal_version=goal.goal_version)
        samples.append((perf_counter() - started) * 1000)
    p95_ms = quantiles(samples, n=20)[18]
    assert p95_ms < 100, f"qualification/coverage P95 {p95_ms:.1f}ms exceeds 100ms"
