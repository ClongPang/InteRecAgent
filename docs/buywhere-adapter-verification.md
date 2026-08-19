# BuyWhere 真实链路验证报告

**日期**：2026-08-16  
**更新**：2026-08-19 阶段 0 复测见 [buywhere-capability-probe.md](./buywhere-capability-probe.md)。主要变化：搜索/详情已返回 `availability`；详情仍无增量字段；`country_code` 经常为 null。本节其余内容保留为切片当时记录。
**范围**：纵向切片——用真实 BuyWhere Key + Frankfurter(ECB) 汇率，验证"搜索 → 归一化 → 人民币换算 → 硬过滤 → 排序"最小链路，对照架构文档假设。
**关联**：[technical-architecture-and-selection.md](./technical-architecture-and-selection.md)、[cross-border-shopping-agent-prototype-design.md](./cross-border-shopping-agent-prototype-design.md)
**实现**：`backend/adapters`、`backend/domain`、`backend/service.py`、`backend/cli.py`、`tests/`（含脱敏 fixture）

## 1. 结论摘要

- 真实 API 可以支撑"搜索 → 人民币换算 → 预算过滤 → 排序"的完整链路，市场真实性成立（US/SG/VN/TH/MY 均返回当地平台商品）。
- 但**真实商品字段集远小于架构文档与前端 mock 的假设**：`rating / review_count / brand / availability / original_price / discount_pct / structured_specs / comparison_attributes` 在真实响应中全部不存在；平台字段是 `merchant` 而非 `domain`。这是本次验证最重要的发现，直接影响前端商品卡与评分设计的来源。
- `deliver_to` 参数未在 OpenAPI 声明，但 `meta.hint` 提示可用；实测 `deliver_to=CN&include_unshippable=false` 返回 0 条。切片未启用，需另行决策。
- 存在无价格商品（`price.amount: null`）与空价格历史（`history: []`），需显式降级，切片已处理。
- 汇率采用 Frankfurter(ECB)：无 key、每日更新、带汇率日期，满足"人民币换算可解释、带时间戳"的要求。

## 2. 实测事实（真实 Key，2026-08-16）

| 主题 | 实测结果 |
|---|---|
| 认证 | `x-api-key` 与 `Authorization: Bearer` 均有效；401 返回 `{"error":"invalid_api_key"}` |
| 响应容器 | `{"data":[...], "meta":{total, limit, offset, response_time_ms, cached, has_more, hint}}` |
| 真实商品字段 | `id, title, price{amount,currency}, merchant, url, image_url, region, country_code, updated_at, click_url, affiliate_redirect_url, has_affiliate_tracking, is_affiliate, affiliate_disclosure, metadata` |
| 分页 | `limit/offset/total/has_more` 正常 |
| 市场覆盖 | US/SG/VN/TH/MY 均返回商品；merchant 反映当地平台（SG→shopee/amazon.sg，VN→lazada_vn/tiki_vn） |
| 搜索模式 | `keyword` 对精确型号准确（WH1000XM5 返回本体）；`hybrid/semantic` 偏差大（配件、重复、CAD 币种） |
| 价格参数 | `min_price/max_price/currency` 生效 |
| 详情端点 | `/products/{id}` 返回 `{"data":[...]}` **数组**（非单对象） |
| 比较端点 | `/products/compare?ids=` 返回 `{"data":[...]}` 数组 |
| 价格历史 | `/products/{id}/prices?days=30` 返回 `data{current_price, history, stats}`，部分商品 `history` 为空 |
| 数据质量 | 搜索响应中存在 `price.amount: null` 的无价格商品（hybrid 模式更常见） |

## 3. 与架构文档假设的对照

| 文档假设 | 实测结果 | 判定 |
|---|---|---|
| 商品字段含 `domain`（平台） | 实际字段是 `merchant` | **需修订** |
| 商品字段含 `rating/review_count/brand/original_price/discount_pct/availability/structured_specs/comparison_attributes` | 全部不存在 | **需修订**——前端商品卡与评分设计无法从 BuyWhere 直接取数 |
| `country_code` ≠ 配送目的地 | 实测 `country_code` 是商品所在市场，配送不可推导 | **成立** ✓ |
| 首期候选市场 SG/US/VN/TH/MY | 全部返回当地平台商品 | **成立** ✓ |
| `deliver_to` 不得使用（未在 OpenAPI） | OpenAPI 未声明，但 `meta.hint` 提示可用；实测 `deliver_to=CN&include_unshippable=false` 返回 0 条 | **需补充测试与决策** |
| `keyword` 精确型号、`hybrid` 探索型 | keyword 准确，hybrid/semantic 偏差大 | **成立** ✓（切片默认 keyword） |
| 详情/比较返回商品对象 | 返回数组 | **需修订**（Adapter 已兼容取 `data[0]`） |
| 部分商品有价格历史 | 部分 `history` 为空 | **需降级**（切片尚未纳入价格历史） |
| 错误分类（401 鉴权不重试、429 限流、5xx 上游） | 与实测 401/429/5xx 响应一致 | **成立** ✓ |
| 独立 FX Adapter + 汇率时间戳快照 | Frankfurter(ECB) 落地：`FxSnapshot{base,quote,rate,date,source,fetched_at}` | **成立** ✓ |

## 4. 验证链路结果

- 离线测试：29 个用例全绿，由脱敏真实响应 fixture 驱动（`tests/fixtures/buywhere/`），不依赖网络与 Key。
- 真实冒烟（`uv run pytest -m live`）：耳机 keyword 14 商品、显示器 hybrid 29 商品（US+SG）、徒步鞋 keyword 17 商品，全部成功换算人民币。
- CLI（`uv run python -m backend.cli "sony wh1000xm5 headphones" --budget 4000 --market US,SG`）：21 商品在预算内，人民币价升序，跨市场跨币种（USD/SGD）统一比较，跳过 1 件无价格商品并记录警告。

## 5. 需据此修订的架构/设计点

1. **商品字段契约**（架构文档 §2.3、原型文档 §2.2、§7）：真实可展示字段为 `title / price{amount,currency} / merchant / country_code / url / image_url / updated_at`。`rating、reviews、specs、stock、brand` 等前端 mock 依赖字段需重新定来源——要么从 `title` 文本解析、要么标为"未提供"；不得伪造。
2. **平台字段名**：`domain` → `merchant`，且 `merchant` 是店铺级标识（如 `shopify`、`shopify_buy30620_stock`、`amazon.com`），不是单一平台，跨平台聚合与去重要基于 `merchant + country_code`。
3. **详情/比较契约**：统一 `data` 数组包裹，Adapter 层负责取首项/列表。
4. **数据质量降级**：无价格商品（跳过并计数）、空价格历史（标记"暂无历史"）、缺失 `country_code`（显示未知）——均需在展示层显式呈现。
5. **`deliver_to` 决策**：API 响应暗示参数存在但归零，需用真实目标市场测试后单独决策是否纳入；当前产品承诺不含配送，暂不启用是安全的。
6. **LLM 选型仍待决**：架构文档写 OpenAI Responses API，`.env` 实际是 DeepSeek。本次未覆盖，仍为未决项。

## 6. 切片遗留/后续

- 未接入：详情/比较/价格历史端点（Adapter 已实现解析，尚未进入 service 编排）。
- 未接入：多 market 并行搜索（当前顺序遍历）、去重后同款分组、综合推荐分（依赖不存在的 rating/specs，需重新设计特征）。
- 未接入：缓存持久化（当前 FX 为内存 TTL；BuyWhere 搜索未缓存）。
- 前端对接需先解决第 5 节第 1 点的字段契约。
