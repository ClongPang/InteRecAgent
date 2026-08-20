# 阶段 0：BuyWhere / LLM 能力探测

**日期**：2026-08-19  
**范围**：少量真实请求，冻结字段白名单与模型 JSON 稳定性。不改产品语义，不把营销字段写成已支持能力。  
**证据**：`scripts/probe_capability.py`（可复跑）；脱敏原始统计在 `artifacts/capability-probe.json`（不入 Git）。  
**关联**：[buywhere-adapter-verification.md](./buywhere-adapter-verification.md)（2026-08-16 切片，部分结论已被本次覆盖）

## 1. 闸门结论

1. **详情 / 比较不能富化候选。** `/v1/products/{id}` 与 `/v1/products/compare` 的商品对象与搜索结果同形，`detail_adds_keys_over_search = []`。阶段 4 不得假设「对 top-K 拉详情就能得到规格、评分、品牌」。
2. **价格历史经常为空。** 本次 2 个有价商品 `history = []`、`stats` 为空。价格提醒 / 「值不值得买」不能作为对话主路径。
3. **库存字段已经出现。** 与 2026-08-16 切片不同：搜索 / 详情 / 比较均返回 `availability: { in_stock: bool, status: string }`。本次 16 条搜索全部非空；US 抽样 8 条均为 `status=in_stock`。这是**观测事实**，可以进硬过滤；当前 Adapter 的 `BuyWhereProduct` 未声明该字段，Pydantic 会丢掉，阶段 2 必须纳入归一化。

    **2026-08-20 复测**：顶层 `availability` 已从搜索 / 详情 / 比较消失。部分商户把碎片放进 `metadata`（`in_stock` 布尔、`is_available` 布尔、`availability` 字符串），覆盖不全，且只见到有货。现处理：顶层优先，否则读 metadata 白名单并标 `stock_source`；冲突则未知；`only_in_stock` 只丢掉已确认无货，未知留下。不得把 metadata 当实时库存。
4. **品牌、评分、规格、折扣仍不存在。** `brand / rating / review_count / structured_specs / comparison_attributes / original_price / discount_pct / domain` 均未出现。对话式推荐的属性批评与规格解释，只能走标题派生（并标 `derived_fields`）。
5. **`country_code` 不可靠。** 16 条搜索仅 4 条非空（覆盖率 0.25）。`country_code=US` 的请求里，商品对象经常是 `null`。不得把请求参数当成商品市场事实；展示层可回退「本次检索市场」，但必须标明不是商品自带字段。
6. **DeepSeek-V4-Flash 结构化 JSON 稳定。** 3 条 `parse_intent` 均通过 Schema。`太贵了` 没有写成 query。`帮我比前两个` 被当成意图槽位解析并追问商品名——这证明还需要 `parse_turn`，不是模型连不通。

因此：阶段 4 收缩为「派生属性 + 可选空历史降级」；阶段 2 优先接入 `availability` 与标题派生；阶段 1 的信念 / rerank 可以开始，不依赖详情接口。

## 2. 请求预算

| 调用 | 次数 | 结果 |
|---|---|---|
| `GET /v1/products/search` keyword `sony wh1000xm5 headphones` US/SG `limit=8` | 2 | 200，各 8 条 |
| `GET /v1/products/{id}` | 2 | 200，`data` 为单元素数组 |
| `GET /v1/products/compare?ids=` | 1 | 200，2 条，字段与搜索相同 |
| `GET /v1/products/{id}/prices?days=30` | 2 | 200，`history_len=0` |
| 追加 US 搜索（只统计 `availability` 取值） | 1 | 8/8 `in_stock` |
| DeepSeek `parse_intent` × 3 | 3 | 全部 Schema 通过 |

未测：`hybrid/semantic`、`deliver_to`、VN/TH/MY、429。这些不改变本次白名单。

## 3. 商品字段白名单

### 3.1 可展示的观测事实（覆盖率 ≥ 0.9）

| 字段 | 类型 | 覆盖率 | 用途 |
|---|---|---|---|
| `id` | string | 1.00 | 内部 `source_product_id` |
| `title` | string | 1.00 | 展示、标题派生、排除词 |
| `price.amount` | number \| null | 0.94 | 原币价；null 则跳过，不写成 0 |
| `price.currency` | string | 1.00 | 原币种 |
| `merchant` | string | 1.00 | 店铺级标识（`shopify`、`shopify_stereo_sg`），不是平台枚举 |
| `url` | https | 1.00 | 商户页；展示真实域名 |
| `click_url` | https | 1.00 | 常为 `api.buywhere.ai` 跳转 |
| `image_url` | https | 1.00 | 图片 |
| `updated_at` | ISO datetime | 1.00 | 新鲜度，不作保修依据 |
| `availability.in_stock` | bool | 1.00 | **新**：可进 `only_in_stock` |
| `availability.status` | string | 1.00 | 本次只见到 `in_stock`；未见到的值不得猜 |

### 3.2 可保留但不得当硬事实

| 字段 | 覆盖率 | 规则 |
|---|---|---|
| `country_code` | 0.25 | 有则展示；无则不得从请求参数回填为商品事实 |
| `region` | 0.06 | 可选展示 |
| `metadata.vendor` | 0.06 | 偶发，**不是** `brand` |
| `metadata.tags` / `product_type` / `compare_at_price` | ≤ 0.13 | 不进排序；`compare_at_price` 类型不稳定（int/str） |
| `url_last_checked_at` | 键在、值全空 | 忽略 |
| 联盟字段 | 1.00 | 不展示给用户，不进推荐理由 |

### 3.3 明确不存在（不得展示、不得排序）

`brand`、`rating`、`review_count`、`structured_specs`、`comparison_attributes`、`original_price`、`discount_pct`、`domain`、保修 / 运费 / 配送 / 正品。

### 3.4 详情与比较

与搜索同构。阶段 4 **不要**为了补规格去打详情；比较视图继续用已持久化快照即可。价格历史接口可用，但空历史必须说「暂无历史」，不能解释成价格稳定。

## 4. 对现有代码的差距（只记录，本阶段不改行为）

| 现状 | 探测结果 |
|---|---|
| `API_MISSING_FIELDS` 含 `availability` | 字段已存在，名单过期 |
| `BuyWhereProduct` 无 `availability` | 真实库存被丢掉 |
| `country_code` 当市场展示 | US 搜索常为 null |
| 主链路只 search | 合理：detail/compare 无增量 |
| `parse_intent` 处理所有用户句 | 「帮我比前两个」会被模型当成缺 query 而追问 |

## 5. LLM 探测

Provider：`deepseek` / `deepseek-v4-flash` / `https://api.deepseek.com`。

| 输入 | query | 其它 | 说明 |
|---|---|---|---|
| 通勤降噪耳机，预算 2500 元，美国 | 通勤降噪耳机 | 预算 2500，市场 US | JSON 合法 |
| 太贵了 | null | 要求澄清 | **未污染 query** |
| 帮我比前两个 | null | 追问商品名 | 应用 `parse_turn`，不要走槽位解析 |

模型仍会把「降噪」写成 `preference=noise`。阶段 3 收紧提示词：品类词 ≠ 排序偏好。

## 6. 对后续阶段的冻结决定

| 阶段 | 决定 |
|---|---|
| 1 信念 + rerank | **可以开始**。不依赖详情。批评先作用于价格、排除词、库存、已拒绝 snapshot。 |
| 2 派生属性 + 多目标分 | 接入 `availability`；品牌/颜色/型号只从标题派生并标 `derived_fields`。无规格时续航/重量仍诚实降级。 |
| 3 parse_turn | 比较 / 提问 / 批评不再进 `parse_intent`。 |
| 4 富化 | **收缩**：不把详情当富化源；价格历史仅在 `history` 非空时展示。 |
| 5 评测 | 评测集必须覆盖「库存可过滤」「无规格不编造」「空价格历史」。 |

## 7. 复跑

```bash
PYTHONPATH=. uv run python scripts/probe_capability.py
```

需要 `INTEREC_BUYWHERE_API_KEY`；LLM 段还需要已配置的 DeepSeek Key。输出不得包含完整 Key 或未脱敏 URL 路径。
