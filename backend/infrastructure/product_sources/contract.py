from __future__ import annotations

import hashlib
import json
from dataclasses import dataclass
from typing import Any

BUYWHERE_CONTRACT_VERSION = "bw-2026-08-v2"

REQUIRED_PRODUCT_FIELDS = frozenset({"id", "title", "price"})
KNOWN_PRODUCT_FIELDS = frozenset(
    {
        "id",
        "title",
        "price",
        "merchant",
        "url",
        "image_url",
        "region",
        "country_code",
        "updated_at",
        "click_url",
        "affiliate_redirect_url",
        "has_affiliate_tracking",
        "is_affiliate",
        "affiliate_disclosure",
        "availability",
        "url_last_checked_at",
        "metadata",
    }
)

CAPABILITY_MATRIX: dict[str, dict[str, str]] = {
    "identity": {"path": "id/title", "level": "required"},
    "price": {"path": "price.amount/currency", "level": "observed_nullable"},
    "merchant": {"path": "merchant", "level": "observed_nullable"},
    "availability": {"path": "availability or metadata", "level": "unreliable"},
    "brand": {"path": "metadata.brand/vendor", "level": "partial"},
    "category": {"path": "metadata.category/product_type/tags", "level": "partial"},
    "structured_specs": {"path": "none", "level": "unavailable"},
    "rating": {"path": "metadata.rating", "level": "unreliable"},
    "review_count": {"path": "metadata.rating_count", "level": "unreliable"},
}

BUYWHERE_CONTRACT_FINGERPRINT = hashlib.sha256(
    json.dumps(
        {
            "version": BUYWHERE_CONTRACT_VERSION,
            "required": sorted(REQUIRED_PRODUCT_FIELDS),
            "known": sorted(KNOWN_PRODUCT_FIELDS),
            "capabilities": CAPABILITY_MATRIX,
        },
        sort_keys=True,
    ).encode("utf-8")
).hexdigest()


@dataclass(frozen=True)
class ContractAssessment:
    version: str = BUYWHERE_CONTRACT_VERSION
    breaking_paths: tuple[str, ...] = ()
    additive_fields: tuple[str, ...] = ()
    observed_count: int = 0

    @property
    def compatible(self) -> bool:
        return not self.breaking_paths


def assess_buywhere_payload(payload: Any) -> ContractAssessment:
    if not isinstance(payload, dict) or not isinstance(payload.get("data"), list):
        return ContractAssessment(breaking_paths=("data[]",))
    breaking: list[str] = []
    additive: set[str] = set()
    items = payload["data"]
    for index, item in enumerate(items):
        if not isinstance(item, dict):
            breaking.append(f"data[{index}]")
            continue
        for field in REQUIRED_PRODUCT_FIELDS - item.keys():
            breaking.append(f"data[{index}].{field}")
        additive.update(item.keys() - KNOWN_PRODUCT_FIELDS)
    return ContractAssessment(
        breaking_paths=tuple(sorted(breaking)),
        additive_fields=tuple(sorted(additive)),
        observed_count=len(items),
    )
