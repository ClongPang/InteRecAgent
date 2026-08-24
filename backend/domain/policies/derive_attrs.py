"""从标题做确定性派生。结果必须进入 derived_fields，不得写成商家声明。"""
from __future__ import annotations

import re

from ..models import NormalizedProduct

_BRANDS = (
    ("sony", "Sony"),
    ("bose", "Bose"),
    ("apple", "Apple"),
    ("samsung", "Samsung"),
    ("lg", "LG"),
    ("dell", "Dell"),
    ("asus", "Asus"),
    ("lenovo", "Lenovo"),
    ("salomon", "Salomon"),
    ("sennheiser", "Sennheiser"),
    ("jbl", "JBL"),
    ("xiaomi", "Xiaomi"),
    ("华为", "Huawei"),
    ("索尼", "Sony"),
)

_COLORS = (
    ("black", "black"),
    ("white", "white"),
    ("blue", "blue"),
    ("silver", "silver"),
    ("rose", "rose"),
    ("red", "red"),
    ("黑", "black"),
    ("白", "white"),
    ("蓝", "blue"),
)

_MODEL = re.compile(r"\b(wh-?1000xm[45]|qc\s*ultra|x ultra 4|ultrawide|4k)\b", re.I)


def derive_title_attrs(product: NormalizedProduct) -> NormalizedProduct:
    title = product.title or ""
    lowered = title.lower()
    attrs = dict(product.attrs)
    derived = list(product.derived_fields)
    if "brand" not in attrs:
        for needle, label in _BRANDS:
            if needle in lowered or needle in title:
                attrs["brand"] = label
                if "brand" not in derived:
                    derived.append("brand")
                break
    for needle, label in _COLORS:
        if needle in lowered or needle in title:
            attrs["color"] = label
            if "color" not in derived:
                derived.append("color")
            break
    model = _MODEL.search(title)
    if model:
        attrs["model"] = re.sub(r"\s+", "", model.group(1)).upper()
        if "model" not in derived:
            derived.append("model")
    return product.model_copy(update={"attrs": attrs, "derived_fields": derived})
