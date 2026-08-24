"""Cross-cutting test safeguards."""
from __future__ import annotations

import gc

import pytest


@pytest.fixture(autouse=True)
def collect_integration_resources(request):
    """Surface leaked async resources in the test that allocated them."""
    yield
    if request.node.get_closest_marker("integration") is not None:
        gc.collect()
