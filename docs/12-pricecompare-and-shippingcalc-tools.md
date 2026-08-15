# 12 PriceCompare比价工具与ShippingCalc关税运费工具

来源：钉钉文档 https://alidocs.dingtalk.com/i/nodes/PwkYGxZV3ZOp3jngU9MBxd9jWAgozOKL

本章承接四路商品候选合流后的决策流程，聚焦跨平台比价与到手价计算。通过 PriceCompare 和 ShippingCalc 两个工具，实现币种归一化排序与含运费关税的最终成本估算，阐明二者无需 fork 的工程逻辑，并展示主 loop 如何串联工具链完成高效剪枝与协作。

本章课程目标：

- 接住第 11 章 4 路候选合流后的下一段：跨平台比价 + 关税运费估算。

- 理解为什么 PriceCompare 和 ShippingCalc 在 Globex 里不需要 fork——它们是典型的"主 loop 自己处理就够了"场景。

- 掌握"币种归一 / 关税分级 / 运费分档"这些电商场景特有的工程细节。

- 看清两个工具的协作模式：PriceCompare 输出结构化对比，ShippingCalc 把"到手价"算清楚。

学习建议： 这一章是 9 个工具里最不性感但最容易翻车的两个。建议把每段代码读到具体公式——很多 bug 不是工具用错了，而是币种、关税阶梯、运费分档这种业务细节没对。

## 1、本章导读

### 1.1 上一章结束在哪里

上一章 4 路同质子 AgentLoop 各自跑完 ItemSearch，主 loop 拿到一个合流后的候选集：

```text
[
  Candidate(item_id=A1, platform=amazon,    price=39.9 USD, ...),
  Candidate(item_id=A2, platform=amazon,    price=42.5 USD, ...),
  ...
  Candidate(item_id=S1, platform=shopee,    price=158 SGD, ...),
  ...
  Candidate(item_id=X1, platform=aliexpress, price=240 CNY, ...),
  ...
  Candidate(item_id=E1, platform=ebay,      price=35.8 GBP, ...),
  ...
]   # 大约 4 × 20 = 80 件
```

接下来主 loop 在 Think 阶段会问自己一个非常具体的问题："加上运费 / 关税之后，跨平台谁最划算？"

这正是 PriceCompare + ShippingCalc 要回答的。

### 1.2 本章先做什么，不做什么

要做的：

1. 设计 PriceCompare 的工具签名和"币种归一"算法。

2. 设计 ShippingCalc 的工具签名和"关税分级 / 运费分档"算法。

3. 讲清这两个工具为什么属于"主 loop 直接调"——不满足 fork 三件事。

4. 给出主 loop 怎么"先 PriceCompare 拿到 Top-N，再让 ShippingCalc 只算 Top-N"的协作模式。

不做的：

- ItemPicker 的二次精挑、ShoppingSummary 的最终清单留给第 14 章。

- 真实关税法规细节（HS Code 层级、原产地协定）超出本课程范围，本章给出可演示的简化模型。

## 2、为什么这两个工具不 fork

### 2.1 用三件事判断对一遍

| 条件 | PriceCompare 场景 | ShippingCalc 场景 |
| --- | --- | --- |
| 能并行 | ❌ 只是一次性算一个排序 | ❌ 一次输入只对应一次输出 |
| 上下文要隔离 | ❌ 输入是 80 件 Candidate 摘要 | ❌ 输入是 Top-N 已经被 PriceCompare 筛过 |
| 调用链 ≥ 3 | ❌ 内部就是个加法 + 排序 | ❌ 内部就是查税率表 + 查运费表 |

三个条件一个都不满足。fork 反而会平白多一次主 / 子 LLM 调用，浪费延迟和 token。

### 2.2 这件事说明什么

不是所有"工具调用"都该 fork。fork 的成本不低——多一次 LLM 推理 + checkpoint + AGUI 事件路由。值不值得 fork，永远要回到"能并行 / 上下文隔离 / 链深"三件事。

PriceCompare 和 ShippingCalc 是"主 loop 自己处理就够了"的典型样本，刚好和上一章的 ItemSearch 形成对比。

## 3、PriceCompare 工具

### 3.1 它要解决的问题

跨平台比价不是"按价格排序"那么简单：

| 难点 | 例子 |
| --- | --- |
| 币种不一样 | amazon 39.9 USD / shopee 158 SGD / aliexpress 240 CNY |
| 计价单位不一样 | "一件" / "一套（3 件）" |
| 平台积分 / 优惠券 | 标价 39.9，但叠 8% 优惠券 = 36.7（暂不展开，本章先按标价比） |
| 评分和销量也要权衡 | 价格便宜 5%，但评分差 0.5 星，到底选谁 |

PriceCompare 的设计目标：输出一个跨平台、币种归一、可解释的排序，并保留足够字段让模型在 Reflect 阶段做判断。

### 3.2 工具签名

```python
# app/tools/price_compare.py
from langchain_core.tools import tool
from pydantic import BaseModel, Field
from app.tools.item_search import Candidate

class PricePoint(BaseModel):
    item_id: str
    platform: str
    title: str
    price_local: float
    currency_local: str
    price_cny: float                       # 归一后的 CNY 价格（仅商品本体，不含运费）
    rating: float | None = None
    sales: int | None = None
    note: str | None = None                # 例如 "一套 3 件，等价单件 ~80 CNY"

class PriceCompareOutput(BaseModel):
    base_currency: str = "CNY"
    ranked: list[PricePoint]
    cheapest_per_platform: dict[str, str]  # {"amazon": "A1", "shopee": "S2", ...}

@tool
async def price_compare(
    candidates: list[Candidate],
    base_currency: str = "CNY",
    top_n: int = 12,
) -> PriceCompareOutput:
    """跨平台候选商品比价，输出币种归一后的排序。

    Args:
        candidates: 来自 ItemSearch 合流后的候选集（最多接受 100 件）。
        base_currency: 归一目标币种，默认人民币。
        top_n: 仅返回排序后的前 N 件，默认 12，最大 30。
```

关键设计：

- 入参直接传 list[Candidate]：和 ItemSearch 的出参 schema 对接，模型不用做格式转换。

- top_n=12：让后续 ShippingCalc 只算 12 件，不要给 80 件全算运费——这是工具协作里的"剪枝"。

- note 字段：留给"一套 3 件"这种特殊计价场景的人类可读说明。

### 3.3 币种归一

```python
# app/recall/fx.py（汇率服务，简化为静态表）
from typing import Final

# 实际项目应接实时汇率服务并加缓存
FX_RATES: Final[dict[str, float]] = {
    "CNY": 1.0,
    "USD": 7.18,
    "SGD": 5.32,
    "GBP": 9.05,
    "EUR": 7.78,
    "JPY": 0.046,
}

def to_base(amount: float, currency: str, base: str = "CNY") -> float:
    if currency not in FX_RATES or base not in FX_RATES:
        raise ValueError(f"未知币种: {currency} 或 {base}")
    return amount * FX_RATES[currency] / FX_RATES[base]
```

### 3.4 主体实现

```python
# app/tools/price_compare.py（续）
import time
from app.api.monitor import monitor
from app.recall.fx import to_base

@tool
async def price_compare(
    candidates: list[Candidate],
    base_currency: str = "CNY",
    top_n: int = 12,
) -> PriceCompareOutput:
    """跨平台候选商品比价。"""
    top_n = min(top_n, 30)
    candidates = candidates[:100]
    await monitor.report_tool_start("price_compare", {
        "candidates_count": len(candidates),
        "base_currency": base_currency,
    })
    t0 = time.time()

    points: list[PricePoint] = [ ]

    for c in candidates:
        try:
            price_base = to_base(c.price, c.currency, base_currency)
        except ValueError:
            continue
        points.append(PricePoint(
            item_id=c.item_id,
            platform=c.platform,
            title=c.title,
            price_local=c.price,
            currency_local=c.currency,
            price_cny=round(price_base, 2),
```

### 3.5 排序里没有的两件事

不在 PriceCompare 里做的事：

1. 不直接用评分 / 销量给商品打综合分——那是 ItemPicker 的职责。

2. 不算运费和关税——那是 ShippingCalc 的职责。

让一个工具只做一件事，主 loop 才能有意义地调用它们的组合。

## 4、ShippingCalc 工具

### 4.1 它要解决的问题

到手价 ≠ 商品价。一件 39.9 USD 的商品，从美国邮到中国，可能再加 12 USD 国际运费 + 13% 综合税。如果用户不知道这个差额，"最便宜平台"会看走眼。

ShippingCalc 要算的是 (商品价 + 运费 + 关税) 折成 base_currency。

### 4.2 工具签名

```python
# app/tools/shipping_calc.py
from langchain_core.tools import tool
from pydantic import BaseModel
from typing import Literal
from app.tools.price_compare import PricePoint

class LandedCost(BaseModel):
    item_id: str
    platform: str
    price_cny: float
    shipping_cny: float
    duty_cny: float
    landed_cny: float                # 到手价 = 商品 + 运费 + 关税
    eta_days: int                    # 物流时效预估
    duty_tier: Literal["免征", "标准", "高税"]

class ShippingCalcOutput(BaseModel):
    destination: str
    items: list[LandedCost]

@tool
async def shipping_calc(
    points: list[PricePoint],
    destination: str = "CN",
) -> ShippingCalcOutput:
    """为已比价的候选估算到手价（含国际运费 + 综合税）。

    Args:
        points: 来自 PriceCompare.ranked 的子集（建议直接传 ranked，不超过 30 件）。
        destination: 收货国家 ISO 码，默认中国大陆。

    Returns:
        items: 每件候选的 LandedCost，按 landed_cny 升序。
```

注意 ShippingCalc 不接受原始 Candidate，只接受 PriceCompare 算过币种归一的 PricePoint。这是工具链路里的"约定"——上游已经做过的事下游不重做。

### 4.3 关税与运费的简化模型

```python
# app/recall/duty.py
from typing import Literal

# 极简的"通用税率表"，实际应按 HS Code + 原产地查
DUTY_TABLE: dict[str, tuple[float, Literal["免征", "标准", "高税"]]] = {
    "amazon":     (0.13, "标准"),
    "shopee":     (0.06, "免征"),  # 走跨境直邮单笔免税额度
    "aliexpress": (0.13, "标准"),
    "ebay":       (0.20, "高税"),  # 假设非 EPR 商家
}

def estimate_duty(price_cny: float, platform: str) -> tuple[float, str]:
    rate, tier = DUTY_TABLE.get(platform, (0.13, "标准"))
    return round(price_cny * rate, 2), tier
```

```python
# app/recall/shipping.py
# 按平台 + 重量分档的简化运费表（CNY）
SHIPPING_TABLE: dict[str, list[tuple[float, float, int]]] = {
    # platform: [(min_weight_kg, fee_cny, eta_days), ...]
    "amazon":     [(0,  85, 12), (0.5, 130, 10), (2.0, 240, 8)],
    "shopee":     [(0,  35,  9), (0.5,  60,  9), (2.0, 120, 7)],
    "aliexpress": [(0,  20, 25), (0.5,  40, 22), (2.0,  90, 18)],
    "ebay":       [(0,  90, 14), (0.5, 150, 12), (2.0, 300, 10)],
}

def estimate_shipping(weight_kg: float, platform: str) -> tuple[float, int]:
    table = SHIPPING_TABLE.get(platform, SHIPPING_TABLE["amazon"])
    fee, eta = table[0][1], table[0][2]
    for min_w, f, days in table:
        if weight_kg >= min_w:
            fee, eta = f, days
    return fee, eta
```

### 4.4 主体实现

```python
# app/tools/shipping_calc.py（续）
import time
from app.api.monitor import monitor
from app.recall.duty import estimate_duty
from app.recall.shipping import estimate_shipping

@tool
async def shipping_calc(
    points: list[PricePoint],
    destination: str = "CN",
) -> ShippingCalcOutput:
    """为已比价的候选估算到手价。"""
    await monitor.report_tool_start("shipping_calc", {
        "items_count": len(points), "destination": destination,
    })
    t0 = time.time()

    landed: list[LandedCost] = [ ]

    for p in points:
        weight = _guess_weight_kg(p)
        shipping_cny, eta = estimate_shipping(weight, p.platform)
        duty_cny, duty_tier = estimate_duty(p.price_cny, p.platform)
        total = round(p.price_cny + shipping_cny + duty_cny, 2)
        landed.append(LandedCost(
            item_id=p.item_id,
            platform=p.platform,
            price_cny=p.price_cny,
            shipping_cny=shipping_cny,
            duty_cny=duty_cny,
            landed_cny=total,
            eta_days=eta,
            duty_tier=duty_tier,
        ))
```

### 4.5 边界情况

| 情况 | 处理 |
| --- | --- |
| 重量未知 | 退到品类默认值（第 13 章会补） |
| 平台未在税率表 | 走"标准 13%"兜底 |
| 运费表全部超出（巨重商品） | 走最高档 + 加日志，下次调权 |

不要为了完美而阻塞链路——电商场景里"大致对的到手价"比"不返回"对用户体验更友好。

## 5、主 loop 的协作模式

### 5.1 Think 阶段的话术

主 loop 的 LLM 在 Think 阶段会产出这样的内部独白（这是 system prompt 引导的结果）：

```text
我已经拿到 4 个平台合流后的 80 件候选。
下一步要选最划算的。直接按标价排会被运费坑，所以：
  1. 先 price_compare 拿币种归一后的 Top-12
  2. 再 shipping_calc 算这 12 件的到手价
  3. 把 landed_cny 最低的几件交给 item_picker 二次精挑
```

### 5.2 工具调用顺序

```python
# 主 loop 的等价 Python 视角（实际由 LLM 决定）
pc_out = await price_compare(candidates=合流候选, top_n=12)
sc_out = await shipping_calc(points=pc_out.ranked, destination="CN")
# sc_out.items 已经按 landed_cny 升序，直接喂给 ItemPicker
```

注意 ShippingCalc 只算 12 件，不算 80 件。这是"上游剪枝下游计算"的工程意识。

### 5.3 AGUI 事件流前端怎么显示

```text
[tool_start] price_compare 正在比价...
[tool_end]   price_compare 完成（126 ms）
[tool_start] shipping_calc 正在算运费 / 关税...
[tool_end]   shipping_calc 完成（38 ms）
```

注意没有 fork 事件——这两个工具确实没 fork。前端面板可以渲染成"主 loop 直接调"的样子，让用户看清楚"什么时候 Globex 自己干、什么时候它叫了一群分身"。

## 6、容易踩的两个坑

### 6.1 不要在 PriceCompare 里偷偷算运费

很多新手会想"反正都要算到手价，不如一步到位"。这样做有三个问题：

| 坏处 | 后果 |
| --- | --- |
| 工具职责模糊 | 模型不知道单调 PriceCompare 是不是已经算运费 |
| 主 loop 没法做 Top-N 剪枝 | 每次都要算 80 件运费，浪费 |
| AGUI 事件粒度变粗 | 前端不知道哪一步在比价、哪一步在算运费 |

让一个工具只做一件事，会比"少调一次工具"重要得多。

### 6.2 不要让 ShippingCalc 去查 ItemSearch

也有人会想"运费需要重量，重量在 Candidate 里，让 ShippingCalc 自己反查 ItemSearch 拿到 attributes"。

这违反了工具单向数据流：上游产出的字段，下游应该要么用要么忽略，不能反向去叫上游。如果重量信息丢了，要么在 PriceCompare 把 weight 透传到 PricePoint，要么用品类默认值兜底——绝不让下游工具反过来"找"上游。

## 本章小结

到这里，4 路候选合流之后的两步处理已经做完。现在你应该清楚：

- PriceCompare 和 ShippingCalc 都不需要 fork——它们都不满足"能并行 / 上下文隔离 / 链深 ≥ 3"任一条件，主 loop 直接调最划算；

- PriceCompare 只做"币种归一 + 排序"，ShippingCalc 只做"到手价"，互不重叠；

- 工具间通过 Pydantic schema（Candidate → PricePoint → LandedCost）做单向数据流，上游剪枝、下游消费；

- 简化的关税分级 / 运费分档可以让 demo 跑起来，真实项目按 HS Code + 原产地接合规服务即可；

- AGUI 事件流里这两步是直链，没有 fork——这正是"什么时候 Globex 自己干、什么时候叫分身"的最直观对比。

下一章「[CategoryInsight 品类洞察工具与 RAG 商品知识库](13 CategoryInsight品类洞察工具与RAG商品知识库.md)」会做品类洞察——把"这个品类下当前热卖什么、典型属性怎么分布"接进来，作为 ItemPicker 二次精挑的判断依据。
