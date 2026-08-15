# 13 CategoryInsight 品类洞察工具与 RAG 商品知识库

来源: https://alidocs.dingtalk.com/i/nodes/wva2dxOW4YPD3NrMfkeXNoOXVbkz3BRL

本章课程目标：

- 理解 CategoryInsight 在 Globex 链路里的"前置认知层"定位——不是检索商品，而是给后面所有工具提供"这个品类长什么样"的常识。
- 第一次接 RAG 商品知识库：从知识库构建 → 检索 → 结构化输出整条管线。
- 看懂为什么 CategoryInsight 是 fork 三件事里"调用链 ≥ 3"的合理候选——它内部要做"爆款 → 属性 → 价格区间"三跳。
- 理解 RAG 不是简单"向量检索"，而是"召回 + 提炼 + 摘要"三步，给模型的是结论不是原文。

学习建议： 这一章的工程难度是 9 个工具里相对低的，但业务设计上很关键——CategoryInsight 决定了 ItemPicker 二次精挑时是否懂行。看代码时关注 RAG 检索后怎么把原文压成结构化 insight，而不是把 5 篇文档原封不动塞回模型。

## 1、本章导读

### 1.0 什么是 Tool Calling？

Tool Calling（工具调用）是指大模型在推理过程中，根据用户意图主动决定调用外部工具/函数，并将返回结果纳入后续推理的机制。

核心流程：

1. 模型判断：分析用户输入，决定是否需要调用工具、调哪个、传什么参数
2. 结构化输出：模型不直接执行，而是输出一段结构化的调用指令（函数名 + 参数 JSON）
3. 外部执行：由应用层/框架真正执行该工具（搜索、数据库查询、API 调用等）
4. 结果回传：执行结果作为新的上下文喂回模型，模型基于结果继续生成最终回答

一句话概括：模型负责"想"该调什么，外部负责"做"，做完再告诉模型结果。它让模型突破了纯文本生成的边界，能连接真实世界的数据和操作。

### 1.1 没有 CategoryInsight 会发生什么

回想第 12 章结束的状态：主 loop 拿到 Top-N 个 LandedCost，准备喂给 ItemPicker 做二次精挑。

如果直接进 ItemPicker，模型只能基于 query 文本 + 候选属性表面字段做选择。会出现这种问题：

| 场景 | 没有品类常识时的失误 |
| --- | --- |
| 用户说"旅行三件套，不要塑料" | 不知道"旅行三件套"标准包含哪 3 件，可能漏选 |
| 用户说"中性气质的咖啡杯" | 不知道这品类常用陶瓷 / 玻璃 / 不锈钢的占比与口碑差异 |
| 用户说"礼物给爱喝酒的男生" | 不知道这场景下威士忌杯 vs 鸡尾酒杯的使用差异 |

让模型"现场学品类知识"是不现实的——它的训练数据未必涉及这种垂类细节，而且每条 query 都现学一次代价巨大。

CategoryInsight 解决的就是：把每个品类的"行家常识"提前沉淀成知识库，按需检索回来。

### 1.2 本章先做什么，不做什么

要做的：

1. 设计 CategoryInsight 的工具签名：模型传品类，得到结构化 insight。
2. 构建一个最小可用的 RAG 商品知识库（爆款卡片 / 属性图谱 / 价格区间）。
3. 实现"召回 → 提炼 → 摘要"三步链路，输出结构化的 CategoryInsightOutput。
4. 解释为什么 CategoryInsight 是"调用链 ≥ 3" 触发 fork 的典型场景。

不做的：

- 知识库的离线建设流水线（爬虫、清洗、定期更新）超出本课程范围，本章给一个静态 JSONL + 向量索引的最小例子。
- ItemPicker 怎么消费这些 insight 留给第 14 章。

## 2、CategoryInsight 在工具链里的位置

### 2.1 它通常在 ItemSearch 之前还是之后

两种合理位置都存在，看用户 query 形态：

| 用户 query 形态 | CategoryInsight 触发时机 |
| --- | --- |
| "想买一套旅行三件套，预算 300，不要塑料" | 在 ItemSearch 之前——先弄清"三件套"包含什么 |
| "我已经看好这 12 件，哪几件最适合送礼" | 在 ItemPicker 之前——补品类常识用于精挑 |

第一种是 Planner 已经把品类拆出来了，主 loop 在 fork ItemSearch 之前先调一次 CategoryInsight 拿到典型组件清单。第二种是 ItemSearch 已经跑完，主 loop 在精挑之前补一次品类常识。

主 loop 通过 system prompt 自己学会判断什么时候调 CategoryInsight。

### 2.2 用三件事判断 fork 与否

| 条件 | CategoryInsight 内部 |
| --- | --- |
| 能并行 | ❌ 一次输入一次输出 |
| 上下文要隔离 | ⚠️ 中等——RAG 召回的 5-10 篇文档原文很大，不该污染主 loop |
| 调用链 ≥ 3 | ✅ 内部要"爆款检索 → 属性提取 → 价格区间统计"三跳 |

满足后两个，这是个值得 fork 的场景——主 loop 调 dispatch_tool，子 Agent 内部跑完 RAG + 提炼 + 摘要后，只回传压缩过的结构化 insight。

## 3、RAG 商品知识库的最小形态

### 3.1 知识库里放什么

不是把整个互联网的商品评测都灌进去。Globex 的知识库只放三类卡片：

| 卡片类型 | 内容样例 | 作用 |
| --- | --- | --- |
| 爆款卡片 | "旅行三件套：洗漱包 / 鞋包 / 数码线收纳" | 给 ItemSearch 拆 sub-query |
| 属性图谱卡片 | "材质：尼龙 60% / 帆布 25% / 牛津布 15%；防水占 70%" | 给 ItemPicker 判断典型属性 |
| 价格区间卡片 | "便宜款 60-150 / 中档 150-400 / 高端 400+ 多见品牌联名" | 给 ItemPicker 判断价格档位 |

每张卡片都是结构化的——不是把博主长文整段灌进去。这一点和"通用 RAG"不一样。

### 3.2 知识库 schema

```python
# app/recall/category_kb.py
from pydantic import BaseModel
from typing import Literal

class CategoryCard(BaseModel):
    card_id: str
    category: str                           # 标准化的品类名，如 "旅行三件套"
    card_type: Literal["bestseller", "attribute", "price_range"]
    summary: str                            # 已经提炼好的一段结论
    raw_evidence: list[str]                 # 支撑这条结论的 1-3 段原始证据
    last_updated: str                       # ISO 时间戳
    confidence: float                       # 0-1 的置信度（来自数据 / 来自人工标注）
```

### 3.3 知识库灌库（极简版）

本节使用 OpenSearch 作为应用层向量库，主要原因是它能同时存 knn_vector + 元数据 + 全文检索字段，检索时可走 KNN + BM25 两路 Hybrid Query 打分融合。选型论证详见 [第 4-1 章 向量基础设施选型与 OpenSearch 演进方向](04-1 向量基础设施选型与OpenSearch演进方向.md)。

```python
# scripts/build_category_kb.py
import json
import os
from pathlib import Path

import httpx
from opensearchpy import OpenSearch, helpers

CARDS_PATH = Path("data/category_cards.jsonl")
INDEX_NAME = "globex_category_kb"
VECTOR_DIM = 1024   # 与 Query 塔输出维度一致

client = OpenSearch(
    hosts=[{"host": os.environ["OPENSEARCH_HOST"], "port": 9200}],
    http_auth=(os.environ["OPENSEARCH_USER"], os.environ["OPENSEARCH_PASS"]),
    use_ssl=False,
)

# 同一份索引同时存：结构化字段 + 全文字段（ik 分词） + KNN 向量字段
INDEX_MAPPING = {
    "settings": {"index": {"knn": True}},
    "mappings": {
        "properties": {
            "card_id":      {"type": "keyword"},
            "category":     {"type": "text", "analyzer": "ik_max_word"},
            "card_type":    {"type": "keyword"},
            "summary":      {"type": "text", "analyzer": "ik_max_word"},
            "raw_evidence": {"type": "text", "analyzer": "ik_max_word"},
            "last_updated": {"type": "date"},
            "confidence":   {"type": "float"},
            "content_vector": {
                "type": "knn_vector",
                "dimension": VECTOR_DIM,
```

这一步跳过了原来“独立 meta.json + Faiss 索引文件”的双文件维护：商品卡片的元数据、全文、向量都住在同一个 OpenSearch 文档里，检索时一句 client.search(...) 全拿回。知识库构建仍是离线流程，工具运行时只读该索引。

上面这段 ETL 是“能跑”版本。真实项目里“数据从哪来 / 怎么标准化 / 怎么过入库门禁”是另一条需要展开的链路，详见 [13-1 章 §2 数据生产管线](13-1 RAG召回精排进阶：数据生产·Hybrid·Rerank·评测.md#_2、数据生产管线让卡片本身够好)。

## 4、CategoryInsight 工具签名

```python
# app/tools/category_insight.py
from langchain_core.tools import tool
from pydantic import BaseModel
from typing import Literal

class Bestseller(BaseModel):
    name: str
    typical_price_cny: float
    why_popular: str

class AttributeDist(BaseModel):
    name: str
    distribution: dict[str, float]    # {"尼龙": 0.6, "帆布": 0.25, ...}

class PriceTier(BaseModel):
    tier: Literal["budget", "mid", "premium"]
    range_cny: tuple[float, float]
    notes: str

class CategoryInsightOutput(BaseModel):
    category: str
    components: list[str]              # 这个品类典型由哪几件组成（适用于"套装"类）
    bestsellers: list[Bestseller]
    attributes: list[AttributeDist]
    price_tiers: list[PriceTier]
    confidence: float                  # 整体置信度

@tool
async def category_insight(category: str, depth: Literal["quick", "deep"] = "quick") -> CategoryInsightOutput:
    """获取一个品类的结构化常识：典型组件 / 爆款 / 属性分布 / 价格档位。
```

设计要点：

- depth 控制深度：让模型在不需要全部维度时省一次属性检索。
- 出参不带 raw_evidence：所有原文证据在工具内部消化掉，给主 loop 的只有结论。这是"RAG 给结论不给原文"。

## 5、工具实现：召回 → 提炼 → 摘要

### 5.1 三步管线

```text
1) 召回：用 category 在 OpenSearch 走 KNN + BM25 双路 Hybrid Query，得到 Top-K 张 CategoryCard
2) 提炼：按 card_type 分组，对每组卡片做结构化提取
3) 摘要：把同一组的多张卡片合并成一个结构化字段
```

### 5.2 召回部分

```python
# app/tools/category_insight.py（续）
import os

from opensearchpy import OpenSearch
from app.api.monitor import monitor
from app.recall.towers import tower_client
from app.recall.category_kb import CategoryCard

INDEX_NAME = "globex_category_kb"

_kb_client = OpenSearch(
    hosts=[{"host": os.environ["OPENSEARCH_HOST"], "port": 9200}],
    http_auth=(os.environ["OPENSEARCH_USER"], os.environ["OPENSEARCH_PASS"]),
    use_ssl=False,
)

async def _recall_cards(category: str, top_k: int) -> list[CategoryCard]:
    """Hybrid 检索：KNN 向量召回 + BM25 全文匹配，引擎层加权融合。"""
    emb = await tower_client.encode_query(category)

    body = {
        "size": top_k,
        "query": {
            "hybrid": {
                "queries": [
                    # 子路 1：KNN 向量语义召回
                    {"knn": {"content_vector": {"vector": emb, "k": top_k * 3}}},
                    # 子路 2：BM25 中文全文匹配（category 字段权重 ×2）
                    {"multi_match": {
                        "query":   category,
                        "fields":  ["category^2", "summary"],
                        "analyzer": "ik_max_word",
                    }},
                ]
```

两个关键变化：

- 从单路 Faiss.search 变成双路 Hybrid Query：在文本匹配能走清的 case（比如 category="帆布旅行背包" 与卡片 category 字段几乎一致），补上 BM25 可以明显拉高 TopK 质量；语义偏离的 case 仍然靠 KNN 兜底。
- 不再需要 idx → meta.json 二级映射：hit["_source"] 直接是完整的 CategoryCard 数据，只需隔离掉 content_vector 有效载荷即可。

这里只给 search_pipeline 的名字，完整的 normalization / combination / weights 配置与调参经验见 [13-1 章 §3 完整 Hybrid DSL 与权重调参](13-1 RAG召回精排进阶：数据生产·Hybrid·Rerank·评测.md#_3、完整-hybrid-dsl-与权重调参)。另外，粗排 Top-K 在进提炼之前还应走一次 cross-encoder rerank，主路实现与短路判定见 [13-1 章 §4 Rerank 精排](13-1 RAG召回精排进阶：数据生产·Hybrid·Rerank·评测.md#_4、rerank-精排补上-rag-的最后一公里)。

### 5.3 提炼部分

```python
def _split_by_type(cards: list[CategoryCard]) -> dict[str, list[CategoryCard]]:

    bag: dict[str, list[CategoryCard]] = {"bestseller": [ ], "attribute": [ ], "price_range": [ ]}

    for c in cards:

        bag.setdefault(c.card_type, [ ]).append(c)

    return bag

def _extract_components(bestseller_cards: list[CategoryCard]) -> list[str]:
    """从爆款卡片 summary 中提取典型组件（"套装类"才有意义）。"""
    found: set[str] = set()
    for c in bestseller_cards:
        # CategoryCard.summary 写法约定: "旅行三件套：洗漱包 / 鞋包 / 数码线收纳"
        if "：" in c.summary and "/" in c.summary:
            parts = c.summary.split("：", 1)[1]
            for token in parts.split("/"):
                token = token.strip()
                if token:
                    found.add(token)
    return sorted(found)

def _extract_bestsellers(cards: list[CategoryCard]) -> list[Bestseller]:

    out = [ ]

    for c in cards:
        # CategoryCard 在灌库时已结构化（实际见 raw_evidence 里的爬虫字段）
        evidences = c.raw_evidence
        if not evidences:
            continue
        # 极简：第一条证据按 "name | price | reason" 拆
        for line in evidences:
```

实际项目里，提炼步通常会调一次小模型做"summary → JSON"的转换。本章用规则示意，方便看清结构化思路。

### 5.4 主体函数

```python
# app/tools/category_insight.py（续）
import time

@tool
async def category_insight(category: str, depth: Literal["quick", "deep"] = "quick") -> CategoryInsightOutput:
    """获取一个品类的结构化常识。"""
    await monitor.report_tool_start("category_insight", {
        "category": category, "depth": depth,
    })
    t0 = time.time()

    top_k = 8 if depth == "quick" else 15
    cards = await _recall_cards(category, top_k)
    grouped = _split_by_type(cards)

    components = _extract_components(grouped["bestseller"])
    bestsellers = _extract_bestsellers(grouped["bestseller"])
    price_tiers = _extract_price_tiers(grouped["price_range"])

    if depth == "deep":
        attributes = _extract_attributes(grouped["attribute"])
    else:

        attributes = [ ]

    confidence = (
        sum(c.confidence for c in cards) / len(cards) if cards else 0.0
    )

    await monitor.report_tool_end("category_insight", int((time.time() - t0) * 1000))
    return CategoryInsightOutput(
        category=category,
        components=components,
        bestsellers=bestsellers,
```

### 5.5 一个简单的调用示例

摸清输入输出最快的办法是脱离 Agent 上下文、手工调一下：

```python
# scripts/try_category_insight.py
import asyncio
from app.tools.category_insight import category_insight

async def main():
    # quick 模式：Top-K=8，不跑属性提炼
    result = await category_insight.ainvoke({
        "category": "旅行三件套",
        "depth": "quick",
    })
    print(result)

if __name__ == "__main__":
    asyncio.run(main())
```

运行后会得到一个结构化的 CategoryInsightOutput（下面字段值为示意）：

```python
CategoryInsightOutput(
    category="旅行三件套",
    components=["洗漱包", "鞋包", "数码线收纳"],
    bestsellers=[
        Bestseller(name="多功能洗漱包",   typical_price_cny=89.0,  why_popular="干湿分离"),
        Bestseller(name="便携鞋包",         typical_price_cny=39.0,  why_popular="不占箱"),
        # ...共 3-5 条
    ],

    attributes=[ ],                       # quick 模式不返属性分布

    price_tiers=[
        PriceTier(tier="budget",  range_cny=(60.0, 150.0),  notes="便宜款 60—150"),
        PriceTier(tier="mid",     range_cny=(150.0, 400.0), notes="中档 150—400"),
        PriceTier(tier="premium", range_cny=(400.0, 1000.0), notes="高端 400+"),
    ],
    confidence=0.78,
)
```

把 depth 换成 "deep"，Top-K 会升到 15，额外跑一轮属性提炼，attributes 字段就会被填上：

```python
attributes=[
    AttributeDist(name="材质", distribution={"尼龙": 0.6, "帆布": 0.25, "牛津布": 0.15}),
    AttributeDist(name="容量", distribution={"小": 0.2, "中": 0.55, "大": 0.25}),
]
```

其它字段保持不变。quick / deep 的差异只在这一项上。

## 6、为什么是"调用链 ≥ 3"的 fork 候选

### 6.1 调用链拆解

CategoryInsight 内部三步：

```text
Step 1: tower_client.encode_query(category)   → 1 次 RPC
Step 2: ann.search                            → 1 次本地检索
Step 3: 三组规则提炼（实际项目通常会上小模型）→ 1-3 次 LLM 调用
```

如果用小模型做提炼，调用链长度直接 ≥ 3。

### 6.2 fork 之后主 loop 看到什么

主 loop 调 dispatch_tool(demands="给我'旅行三件套'的品类常识")，子 Agent 内部跑完三步管线，回传给主 loop 的字符串大概是这样的：

```text
旅行三件套品类常识：
- 典型组件：洗漱包 / 鞋包 / 数码线收纳
- 爆款 5 件：（清单）
- 价格档位：便宜款 60-150 / 中档 150-400 / 高端 400+
- 数据置信度 0.78
```

主 loop 不需要看 5-15 张原始 CategoryCard。它的上下文清爽得多——这就是"调用链 ≥ 3 + 上下文要隔离"两个条件叠加触发 fork 的最直接好处。

### 6.3 不 fork 行不行

也行。category_insight 作为普通工具直接被主 loop 调，把结构化结果（CategoryInsightOutput 已经压缩过原文）返回，对主 loop 上下文压力也不大。fork 不是必须——本章列出 fork 路径是为了让你看到这种判断在工程层是真的能落地的，不是只在第 3 章纸上谈兵。

实际部署时，depth="deep" 触发 fork，depth="quick" 主 loop 直接调，是个常见折衷。

## 7、和后续工具怎么协作

### 7.1 喂给 ItemPicker 的字段

第 14 章会讲 ItemPicker。这里先把"喂什么"约定好：

| ItemPicker 关心 | 来自 CategoryInsight 的哪个字段 |
| --- | --- |
| 套装类商品有没有缺组件 | components |
| 候选属性是否符合品类主流 | attributes 的 distribution 排前几位 |
| 候选价格是否落在合理档位 | price_tiers 的 range_cny |
| 决策置信度 | confidence（低于 0.5 时主 loop 应再补 WebSearch） |

### 7.2 知识库刷新策略（说明性）

| 刷新类型 | 频率 | 数据源 |
| --- | --- | --- |
| 爆款卡片 | 每周 | 内部销售榜 + 平台公开榜单 |
| 属性图谱卡片 | 每月 | 商品库属性聚合 |
| 价格区间卡片 | 每月 | 历史成交价分位数 |

刷新流程不在工具运行时——是个独立的离线任务。刷新与上线间还需要一套兜底：召回评测（Recall@K / MRR / NDCG）、冷启动 WebSearch 兜底、多语言归一、索引别名切换等详见 [13-1 章 §5 评测脚手架](13-1 RAG召回精排进阶：数据生产·Hybrid·Rerank·评测.md#_5、召回评测脚手架让升级有刹车) 与 [§6 收尾工程清单](13-1 RAG召回精排进阶：数据生产·Hybrid·Rerank·评测.md#_6、收尾工程清单)。

本章小结：

到这里，CategoryInsight 已经把"行家常识"接到 Agent 链路里。现在你应该清楚：

- CategoryInsight 不是另一个搜索工具，它是前置认知层——给 ItemSearch 拆 sub-query、给 ItemPicker 提供品类判断依据；
- RAG 商品知识库不放整篇博主长文，只放结构化卡片：爆款 / 属性图谱 / 价格区间；
- 工具内部走"召回 → 提炼 → 摘要"三步，给主 loop 的是结论而不是原文；
- 这个工具是 fork 三件事里"调用链 ≥ 3 + 上下文要隔离"两个条件叠加的典型场景，depth="deep" 时尤其适合 fork；
- CategoryInsight 输出的 components / attributes / price_tiers / confidence 是 ItemPicker 二次精挑的判据。

下一章「[主 AgentLoop 组装与同质子 AgentLoop fork 协同机制](14 主AgentLoop组装与同质子AgentLoop-fork协同机制.md)」会真正把所有工具串起来：组装主 AgentLoop、收尾 ItemPicker / ShoppingSummary、并交付一套防 fork 失控的工程兜底。
