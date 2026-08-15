# 13-1 RAG 召回精排进阶：数据生产、Hybrid、Rerank、评测

来源：https://alidocs.dingtalk.com/i/nodes/pYLaezmVNe26kznBHPL0324zWrMqPxX6

作者：会敲代码的泡

创建时间：06-15 15:10

## AI 概览

本章是在第 13 章 CategoryInsight RAG 知识库基础上的工程化补强。目标不是只把 RAG demo 跑通，而是补齐线上系统真正需要的四个环节：数据生产、Hybrid 召回权重调参、cross-encoder Rerank 精排、召回评测与发布门禁。

核心变化是把 CategoryInsight 从“能返回一些卡片”推进到“召回质量可控、升级有指标、上线有兜底”的状态。

## 本章课程目标

- 把第 13 章的最小 RAG 链路升级到可上线版本。
- 明确 CategoryCard 的离线生产流程，避免把低质量卡片直接灌入 OpenSearch。
- 用完整的 OpenSearch `search_pipeline` 配置实现 KNN 与 BM25 的归一、加权融合。
- 在 Top-30 粗排结果上接入 cross-encoder Rerank，再保留 Top-8 或 Top-15。
- 搭建小规模召回评测集，用 `Recall@K`、`MRR`、`NDCG@K` 作为模块级回归门禁。

## 1、本章导读

第 13 章主要解决“链路跑通”，但为了快速推进，很多关键工程问题只是占位：

| 第 13 章处理方式 | 真实工程风险 |
| --- | --- |
| 默认卡片已经存在 | 卡片质量决定召回上限，没有生产管线就没有稳定质量 |
| `search_pipeline` 只给名字 | 不知道 normalization、combination、weights 是否合理 |
| Hybrid 粗排后直接提炼 | Top-K 中混入跑题卡片会污染 insight 结构 |
| 提炼结果直接交给主 loop | 无法判断一次升级是整体变好还是局部样例变好 |

本章按五段展开：

1. 数据生产管线：让卡片本身够用。
2. Hybrid DSL 调参：让粗排足够准。
3. Rerank 精排：让 Top-K 更干净。
4. 召回评测脚手架：让升级有客观刹车。
5. 工程收尾清单：多语言、冷启动、缓存、兜底、指标。

## 2、数据生产管线：让卡片本身够好

### 2.1 数据来源

Globex 的品类知识库主要有三类卡片：爆款卡片、属性图谱卡片、价格区间卡片。它们来自多路原始数据：

| 数据源 | 目标卡片 | 建议频率 |
| --- | --- | --- |
| 内部销售榜 | 爆款卡片 | 周 |
| 平台公开榜单 | 爆款卡片 | 周 |
| 商品库属性聚合 | 属性图谱卡片 | 月 |
| 历史成交价分位 | 价格区间卡片 | 月 |

这些来源的原始格式不同，可能是 CSV、API、数仓查询或爬虫结果。工程上不应直接写入 OpenSearch，而应先离线收敛成统一的 `CategoryCard` 结构。

### 2.2 ETL 三步

```text
原始数据
  -> Step 1: 标准化字段与品类名
  -> Step 2: 用小模型抽取 summary 与 raw_evidence
  -> Step 3: schema、confidence、格式约定与抽审门禁
  -> CategoryCard 写入 OpenSearch
```

### 2.3 字段标准化

第一步是品类名归一。不同数据源可能把同一类商品写成“旅行收纳”“旅行三件套”“便携收纳包”，但最终应指向同一个标准品类。

实现上可以维护一张人工与商品图谱共同维护的别名表：

```python
CATEGORY_ALIASES = {
    "旅行收纳": "旅行三件套",
    "便携收纳包": "旅行三件套",
    "出差三件套": "旅行三件套",
    "马克杯": "咖啡杯",
}


def normalize_category(raw: str) -> str:
    key = raw.strip().lower()
    return CATEGORY_ALIASES.get(key, key)
```

这里不要让 LLM 在线猜品类映射。归一表是数据侧的 ground truth，LLM 只负责后续结构化抽取。

### 2.4 小模型抽取

`CategoryCard.summary` 需要按固定格式生成，后续规则提炼才能稳定解析。抽取模型的输入是某个品类的一段原始资料，输出是严格 JSON：

| 字段 | 说明 |
| --- | --- |
| `summary` | 按卡片类型生成固定句式 |
| `raw_evidence` | 保留 1-3 条原始证据 |
| `confidence` | 基于资料量和措辞确定性给 0-1 自评分 |

三类卡片的 summary 可以约定为：

| 卡片类型 | summary 形态 |
| --- | --- |
| `bestseller` | `品类：组件1 / 组件2 / 组件3` |
| `attribute` | `材质：尼龙 60% / 帆布 25% / 牛津布 15%` |
| `price_range` | `便宜款 60-150 / 中档 150-400 / 高端 400+` |

抽取完成后必须立即做格式校验。格式不对的卡片直接拒绝进入下一步，而不是把解析压力留给在线链路。

### 2.5 入库门禁

入库前建议串行三道门：

| 门禁 | 检查点 |
| --- | --- |
| Schema | `CategoryCard` 模型严格校验 |
| 质量阈值 | `confidence >= 0.5`，`summary` 不超过约定长度 |
| 格式约定 | 爆款卡片要有品类前缀，属性卡片要有百分比等结构信号 |

同时保留 10% 左右样本进入人工抽审队列。抽审不阻塞主流程，但它会给后续评测集提供高质量样本来源。

### 2.6 数据生产产出

一轮全量 ETL 的规模可以按下面这个量级估算：

| 阶段 | 数量级 |
| --- | --- |
| 原始资料 | 约 50000 段 |
| 标准化通过 | 约 32000 段 |
| 抽取草卡 | 约 28000 张 |
| 门禁通过 | 约 21000 张 |
| 实际入库 | 约 21000 张 |
| 人工抽审 | 约 2100 张 |

## 3、完整 Hybrid DSL 与权重调参

### 3.1 OpenSearch pipeline

第 13 章只使用了 `search_pipeline=globex_hybrid_pipeline` 这个名字。本章补齐 pipeline 的关键配置：先归一 KNN 与 BM25 的分数，再按权重融合。

```json
{
  "description": "KNN + BM25 双路召回的归一与加权融合",
  "phase_results_processors": [
    {
      "normalization-processor": {
        "normalization": { "technique": "min_max" },
        "combination": {
          "technique": "arithmetic_mean",
          "parameters": { "weights": [0.7, 0.3] }
        }
      }
    }
  ]
}
```

关键点：

| 配置 | 作用 |
| --- | --- |
| `normalization=min_max` | 把 KNN 余弦分和 BM25 文本分归一到同一量纲 |
| `combination=arithmetic_mean` | 用算术平均做稳定、可解释的融合 |
| `weights=[0.7, 0.3]` | 默认 KNN 占 0.7，BM25 占 0.3 |

注意：`weights` 的顺序必须和 hybrid 查询里两个子 query 的顺序一致，否则会把 KNN 和 BM25 的权重调反。

### 3.2 权重经验值

不同 query 形态适合不同权重：

| Query 形态 | 建议 `[KNN, BM25]` | 原因 |
| --- | --- | --- |
| 名词为主，如“咖啡杯” | `[0.5, 0.5]` | 字面匹配本身较可靠 |
| 属性约束，如“防水旅行三件套” | `[0.7, 0.3]` | KNN 处理语义，BM25 兜长尾词 |
| 气质形容，如“中性气质的咖啡杯” | `[0.9, 0.1]` | 语义特征主导，BM25 命中弱 |
| 完全口语，如“想送男朋友的礼物” | `[1.0, 0.0]` | 纯语义召回更稳 |

Globex v1 默认 `[0.7, 0.3]`，覆盖最常见的“品类 + 属性”查询。如果后续要做自适应权重，可以在主 loop 的 Think 阶段判断 query 类型，再动态覆盖召回参数。

### 3.3 什么时候关闭 BM25

对完全语义化的 query，BM25 很容易只按字面词命中杂项卡片，反而把 KNN 准确召回的风格类卡片挤出 Top-K。

可以在召回前做一个轻量判定：

```python
SEMANTIC_TOKENS = {"气质", "感觉", "风格", "感", "适合", "送", "氛围"}


def should_disable_bm25(category: str) -> bool:
    return any(token in category for token in SEMANTIC_TOKENS)
```

命中这类 token 时，Hybrid body 可以不塞 BM25 子路，或者把 BM25 权重降到 0。

## 4、Rerank 精排：补上 RAG 的最后一公里

### 4.1 为什么 Hybrid 之后还不够

Hybrid Top-8 中经常会夹 1-2 张“相关但跑题”的卡片。比如查询“旅行三件套”，粗排可能混入“旅行洗漱包”的属性卡。它有“旅行”相关性，但不是目标套装，会让规则提炼阶段产生错误字段。

解决方式是两段式召回：

```text
Hybrid 粗排 Top-30
  -> cross-encoder Rerank
  -> 保留 Top-8 或 Top-15
```

双塔模型适合做百级候选的快速粗排；cross-encoder 把 query 与候选拼到同一个模型里判断相关性，判断更细，但成本更高，所以只用于小候选集精排。

### 4.2 模型选型

| 候选 | 优点 | 缺点 | 推荐场景 |
| --- | --- | --- | --- |
| BGE-Reranker-v2-m3 | 开源、多语言、效果稳定 | 需要本地或自建服务 | Globex 默认 |
| Cohere Rerank v3 | API 即用，多语言能力强 | 付费，存在数据出境问题 | 个人项目或早期 demo |
| LLM-as-Reranker | 灵活、可解释 | 慢且贵 | 课程外延伸 |

本章默认方案是 BGE-Reranker-v2-m3 加本地服务，对中英混合的跨境购物 query 更友好。

### 4.3 Reranker 客户端

Reranker 客户端只需要一个窄接口：

```python
class RerankerClient:
    """调用 /rerank，返回与 candidates 同序的 scores。"""

    async def score(self, query: str, candidates: list[str]) -> list[float]:
        ...
```

工程约定：

- `RERANKER_ENDPOINT` 从环境变量读取。
- 请求体包含 `query` 和 `candidates`。
- 响应只需要返回 `scores`。
- 超时要短，避免精排把整个主链路拖慢。

### 4.4 接入 `_recall_cards`

第 13 章的 `_recall_cards` 可以从“直接 Top-K”改成“粗排 30、精排 K”：

```python
COARSE_K = 30
FINE_K_QUICK = 8
FINE_K_DEEP = 15
RERANK_BYPASS_TOP_SCORE = 0.92


async def _recall_cards(category: str, top_k: int) -> list[CategoryCard]:
    hits = await hybrid_recall(category, coarse_k=COARSE_K)
    if not hits:
        return []

    if hits[0]["_score"] >= RERANK_BYPASS_TOP_SCORE:
        return to_cards(hits[:top_k])

    if len(hits) <= top_k:
        return to_cards(hits)

    scores = await reranker.score(category, [h["_source"]["summary"] for h in hits])
    ranked = sorted(zip(scores, hits), key=lambda item: item[0], reverse=True)
    return to_cards([hit for _, hit in ranked[:top_k]])
```

两个短路条件很重要：

| 短路条件 | 意义 |
| --- | --- |
| 粗排首位分数足够高 | 粗排已经很确定，跳过 Rerank 节省约 50ms |
| 粗排候选数不超过 Top-K | 没有排序压力，Rerank 没有明显增量 |

### 4.5 实测变化

| 指标 | 仅 Hybrid 粗排 | 粗排 + Rerank | 备注 |
| --- | --- | --- | --- |
| `Recall@8` | 约 0.62 | 约 0.81 | 主要收益 |
| `MRR` | 约 0.55 | 约 0.74 | 第一条结果更准 |
| P50 延迟 | 约 25ms | 约 75ms | Rerank 增加约 50ms |
| P99 延迟 | 约 80ms | 约 140ms | 短路命中率约 30% |

对 RAG 子链路来说，P50 增加约 50ms 通常可以接受，因为主 loop 的一轮 Think 本来就会消耗数百毫秒。

## 5、召回评测脚手架：让升级有刹车

### 5.1 评测层级

Globex 有两种评测：

| 评测类型 | 评测对象 | 特点 |
| --- | --- | --- |
| Rubric Agent 评测 | 整体购物清单质量 | 慢、贵、需要 judge LLM |
| 召回评测 | CategoryInsight 单点 | 快、便宜、结构化指标 |

CategoryInsight 改 weights、换 reranker、调 `coarse_k` 时，不应该每次都跑整条 Agent 评测。召回评测是这个模块的日常体检。

### 5.2 标注集

v1 不需要几千条样本，先准备 50 条典型 query：

- 覆盖名词类、属性类、气质类、口语类四种查询形态。
- 每条 query 人工挑 5 张应该召回的 `CategoryCard`。
- 这 250 个 `(query, card_id)` 对就是 ground truth。

建议存储为 JSONL：

```json
{"query": "旅行三件套", "relevant": ["c_001", "c_017", "c_042", "c_088", "c_101"]}
{"query": "中性气质的咖啡杯", "relevant": ["c_220", "c_233", "c_251", "c_268", "c_271"]}
```

### 5.3 核心指标

| 指标 | 关注点 | 适用场景 |
| --- | --- | --- |
| `Recall@K` | 标注相关卡片是否被找回 | 召回底线 |
| `MRR` | 第一张相关卡片的位置 | Top-1 对后续 ItemPicker 影响大时 |
| `NDCG@K` | 排序质量 | 既看命中，也看高质量卡片是否靠前 |

指标实现可以放在 `app/eval/recall_metrics.py`：

```python
def recall_at_k(retrieved: list[str], relevant: list[str], k: int) -> float:
    return len(set(retrieved[:k]) & set(relevant)) / max(len(relevant), 1)


def mrr(retrieved: list[str], relevant: list[str]) -> float:
    rel = set(relevant)
    for rank, card_id in enumerate(retrieved, start=1):
        if card_id in rel:
            return 1.0 / rank
    return 0.0
```

`NDCG@K` 额外使用人工标注顺序作为 gain，能衡量相关卡片是否排在更靠前的位置。

### 5.4 跑测脚本

跑测脚本读取 `data/eval/category_recall.jsonl`，逐条调用 `_recall_cards(query, top_k=10)`，再聚合三项指标：

```text
for sample in samples:
  cards = _recall_cards(sample.query, top_k=10)
  retrieved = [card.card_id for card in cards]
  accumulate Recall@10 / MRR / NDCG@10

print averaged metrics
```

50 条样本的完整评测大约 5 秒量级，适合放入 CI。

### 5.5 回归门禁

| 门禁 | Globex v1 阈值 | 处理 |
| --- | --- | --- |
| `Recall@10` | `>= 0.75` | 低于则阻断发版 |
| `MRR` | `>= 0.65` | 低于则阻断发版 |
| `NDCG@10` | `>= 0.70` | 低于则告警并评审 |

任何修改 weights、`coarse_k`、Rerank 阈值或模型版本的 PR，都应先跑召回评测。

## 6、收尾工程清单

### 6.1 多语言对齐

| 路径 | 优点 | 缺点 | 建议 |
| --- | --- | --- | --- |
| query 翻译归一到中文索引 | 索引便宜，维护轻 | 翻译可能丢长尾语义 | Globex 默认 |
| 多语言并行建索引 | 召回更准，不丢长尾 | 索引膨胀，维护成本高 | 业务规模上来后再做 |

跨境购物会天然遇到中英混合 query。v1 先用翻译归一控制复杂度。

### 6.2 冷启动

新品类没有卡片时，不要在线写库。推荐退化链路：

```text
Recall 命中 0
  -> 主 loop 收到空 insight
  -> Think 阶段判断 components/bestsellers 为空
  -> 调用 WebSearch 兜底
  -> 用同样抽取规则生成草卡
  -> 草卡只在本轮使用，不入库
```

入库仍交给离线 ETL 和门禁流程，避免在线工具污染知识库。

### 6.3 query 级缓存

同一个 category 在短时间内反复查询时，不需要每次都跑 Hybrid + Rerank。可以用 Redis 做一层轻缓存：

```python
cache_key = f"cinsight:{category}:{depth}"
cached = await redis.get(cache_key)
if cached:
    return CategoryInsightOutput.model_validate_json(cached)

result = await run_recall_pipeline(category, depth)
await redis.setex(cache_key, 3600, result.model_dump_json())
```

`3600s` TTL 与卡片按周或按月刷新的节奏相匹配。

### 6.4 异常与空召回兜底

| 异常 | 兜底 |
| --- | --- |
| OpenSearch 不可用 | 返回 `confidence=0` 的空 insight 并上报 |
| Reranker 超时 | 跳过精排，直接用粗排 Top-K |
| Tower 不可用 | 退化到纯 BM25 |
| 召回为空 | 走 WebSearch 冷启动兜底 |

兜底策略不应向上抛硬异常，而是给主 loop 一个低置信度结构化结果，由主 loop 决定继续检索、WebSearch 兜底或与用户对齐。

### 6.5 工程指标看板

| 指标 | Globex v1 期望 |
| --- | --- |
| `Recall@10` | `>= 0.75` |
| P50 延迟 | `<= 80ms` |
| P99 延迟 | `<= 200ms` |
| Rerank 短路命中率 | `>= 25%` |
| 空召回率 | `<= 2%` |
| Cache 命中率 | `>= 30%` |

任意指标跌出约定波动区间时触发告警。

## 本章小结

这一章把 CategoryInsight 的 RAG 链路从“跑通”推进到“可上线”：

- 数据生产管线通过标准化、抽取和入库门禁保证卡片质量。
- Hybrid pipeline 通过 `min_max` 归一、算术平均和默认 `[0.7, 0.3]` 权重获得稳定粗排。
- 语义化 query 可以关闭或弱化 BM25，避免字面匹配干扰。
- Rerank 使用 BGE-Reranker-v2-m3，在 Top-30 上精排再取 Top-K，并通过短路控制延迟。
- 召回评测用 50 条人工标注样本和三项指标建立模块级发布门禁。
- 上线前补齐多语言、冷启动、缓存、异常兜底和指标看板。

读完本章再回看第 13 章的 `_recall_cards`，就能清楚看到：第 13 章是脚手架，本章才是可以持续迭代和上线的工程版本。
