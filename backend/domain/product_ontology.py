from __future__ import annotations

import re
from dataclasses import dataclass

from .category_contracts import CATEGORY_CONTRACTS, publishable_item_types


@dataclass(frozen=True)
class ItemTypeRule:
    item_type: str
    patterns: tuple[str, ...]


ITEM_TYPE_RULES: tuple[ItemTypeRule, ...] = (
    ItemTypeRule(
        "hearing_protection",
        (
            r"\bhearing protection\b|\bear defenders?\b|\bsafety earmuffs?\b",
            r"\bhand tools?\s*&\s*e-?tools?\b",
            r"听力防护|防护耳罩|工业耳罩",
        ),
    ),
    ItemTypeRule(
        "smartphone",
        (
            r"\b(?:apple\s+)?iphone\s*(?:se|x[rs]?|1[1-9])(?:\s*(?:pro|max|plus|mini))*\b",
            r"\bsmart\s*phones?\b|\bmobile phones?\b|\bcell phones?\b",
            r"\b(?:samsung\s+)?galaxy\s+(?:s|z|a)\d{1,3}\b|\bgoogle\s+pixel\s+\d{1,2}\b",
            r"手机|智能手机",
        ),
    ),
    ItemTypeRule(
        "headphones",
        (r"\bheadphones?\b|\bheadsets?\b|\bearbuds?\b|\bearphones?\b", r"耳机|耳麦"),
    ),
    ItemTypeRule(
        "laptop",
        (
            r"\blaptops?\b|\bnotebooks?\b|\bultrabooks?\b|\bchromebooks?\b",
            r"\bmacbook(?:\s+(?:air|pro))?\b|\bthinkpad\b|\bsurface laptop\b",
            r"笔记本(?:电脑)?|手提电脑",
        ),
    ),
    ItemTypeRule(
        "monitor",
        (r"\bmonitors?\b|\bcomputer displays?\b|\bgaming displays?\b", r"显示器|电脑屏幕"),
    ),
    ItemTypeRule(
        "camera",
        (
            r"\b(?:mirrorless|dslr|digital|action|instant) cameras?\b",
            r"\b(?:canon eos|nikon z|sony alpha|fujifilm x-)\b",
            r"相机|照相机",
        ),
    ),
    ItemTypeRule(
        "footwear",
        (r"\bshoes?\b|\bsneakers?\b|\bboots?\b|\bsandals?\b|\btrainers?\b", r"鞋|靴"),
    ),
    ItemTypeRule(
        "appliance",
        (
            r"\b(?:vacuum cleaners?|air fryers?|refrigerators?|washing machines?|"
            r"microwaves?|coffee makers?)\b",
            r"吸尘器|空气炸锅|冰箱|洗衣机|微波炉|咖啡机",
        ),
    ),
)

RELATION_PATTERNS: tuple[tuple[str, tuple[str, ...]], ...] = (
    (
        "service",
        (
            r"\b(?:applecare\+?|warranty|protection plan|installation service|insurance|subscription)\b",
            r"保修服务|安装服务|保险|订阅",
        ),
    ),
    (
        "consumable",
        (
            r"\b(?:ink|toner) cartridges?\b|\bcoffee pods?\b|\bvacuum bags?\b|\breplacement filters?\b",
            r"墨盒|硒鼓|咖啡胶囊|集尘袋|替换滤芯",
        ),
    ),
    (
        "replacement",
        (
            r"\breplacement\b|\bspare parts?\b|\bear ?pads?\b|\bcushions?\b",
            r"替换件|替换装|备用零件|耳罩|耳垫",
        ),
    ),
    (
        "accessory",
        (
            r"\b(?:cases?|covers?|cables?|chargers?|adapters?|screen protectors?|lens protectors?|tempered glass|sleeves?|stands?|holders?|"
            r"monitor arms?|wall mounts?|desk mounts?|"
            r"keyboards?|mice|mouse|stylus|strap|tripod|lens cap|camera bag|shoe laces?)\b",
            r"保护壳|保护套|配件|充电器|数据线|贴膜|钢化膜|玻璃膜|支架|键盘|鼠标|背带|三脚架|镜头盖|相机包|鞋带",
        ),
    ),
    ("bundle", (r"\b(?:bundles?|combos?|kits?)\b", r"套装|组合装|配件包")),
)


def classify_relation(text: str) -> tuple[str, str | None]:
    # "earbuds with charging case" describes the primary product and its included
    # container; treating the word case alone as an accessory creates a known
    # high-recall/low-precision failure.
    primary_bundle = re.search(
        r"\b(?:earbuds?|earphones?|headphones?)\b.*\bwith\b.*\bcharging case\b",
        text,
        re.I,
    )
    if primary_bundle:
        return "product", primary_bundle.group(0)
    for relation, patterns in RELATION_PATTERNS:
        for pattern in patterns:
            match = re.search(pattern, text, re.I)
            if match:
                return relation, match.group(0)
    return "unknown", None


def classify_item_type(*texts: str) -> tuple[str | None, str | None]:
    for rule in ITEM_TYPE_RULES:
        for text in texts:
            for pattern in rule.patterns:
                match = re.search(pattern, text, re.I)
                if match:
                    return rule.item_type, match.group(0)
    return None, None


def target_from_text(text: str) -> dict[str, str]:
    item_type, _ = classify_item_type(text)
    # User goals commonly say just "iPhone" without a model number.  Listing
    # classification remains stricter so SEO accessories are not promoted.
    if item_type is None and re.search(r"\biphone\b", text, re.I):
        item_type = "smartphone"
    if item_type is None:
        return {}
    target = {"item_type": item_type, "relation_required": "product"}
    iphone = re.search(
        r"\b(?:apple\s+)?(iphone(?:\s+(?:se|x[rs]?|1[1-9]))?"
        r"(?:\s+(?:pro(?:\s+max)?|max|plus|mini|e))?)\b",
        text,
        re.I,
    )
    if iphone:
        target["brand"] = "Apple"
        model = re.sub(r"\s+", " ", iphone.group(1)).strip()
        target["model"] = model
        target["canonical_description"] = f"Apple {model}"
        target["user_phrase"] = iphone.group(0).strip()
    return target


# V2 首个可发布垂直切片。分类规则可以为离线评估提前存在，但只有 category
# contract 声明为 canary/enabled 的品类能够进入线上资格链。
PILOT_ITEM_TYPES = frozenset(CATEGORY_CONTRACTS)
DETECTED_ITEM_TYPES = frozenset(rule.item_type for rule in ITEM_TYPE_RULES)
SUPPORTED_ITEM_TYPES = publishable_item_types(PILOT_ITEM_TYPES)
