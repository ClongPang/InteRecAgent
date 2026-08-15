from __future__ import annotations

import json
from typing import Any

from pydantic import BaseModel, TypeAdapter, ValidationError

from app.tools.category_insight import CategoryInsightOutput
from app.tools.item_picker import ItemPickerOutput
from app.tools.item_search import ItemSearchOutput
from app.tools.price_compare import PriceCompareOutput
from app.tools.shipping_calc import LandedCost
from app.tools.shopping_summary import ShoppingSummaryOutput


TOOL_SCHEMAS: dict[str, Any] = {
    "item_search": ItemSearchOutput,
    "price_compare": PriceCompareOutput,
    "shipping_calc": TypeAdapter(list[LandedCost]),
    "category_insight": CategoryInsightOutput,
    "item_picker": ItemPickerOutput,
    "shopping_summary": ShoppingSummaryOutput,
}


async def check_schema(context: dict[str, Any]) -> dict[str, Any] | None:
    """Validate tool output against the expected Pydantic schema."""
    tool_name = str(context.get("tool_name") or "")
    expected_schema = TOOL_SCHEMAS.get(tool_name)
    if expected_schema is None:
        return None

    try:
        data = _decode_tool_result(context.get("tool_result"))
        _validate(expected_schema, data)
    except (json.JSONDecodeError, TypeError, ValidationError, ValueError) as exc:
        failures = list(context.get("assertions_failed") or [])
        failures.append({
            "type": "schema",
            "tool": tool_name,
            "reason": str(exc),
        })
        return {"assertions_failed": failures}
    return None


def _decode_tool_result(result: Any) -> Any:
    if isinstance(result, BaseModel):
        return result
    if isinstance(result, str):
        return json.loads(result)
    return result


def _validate(schema: Any, data: Any) -> None:
    if isinstance(schema, TypeAdapter):
        schema.validate_python(data)
        return
    if isinstance(data, schema):
        return
    schema.model_validate(data)
