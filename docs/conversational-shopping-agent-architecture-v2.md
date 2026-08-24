# 对话式购物推荐 Agent V2：可验证闭环架构与实施方案

**状态**：实施提案
**日期**：2026-08-23
**适用项目**：InteRecAgent
**商品数据源**：BuyWhere
**形成方式**：对话/Agent 架构与推荐/数据架构双视角独立设计、交叉评审后收敛

## 1. 决策摘要

本次不推倒 FastAPI、Mission、事件账本、快照、UoW、SSE 与 BuyWhere Adapter，也不直接改成多自治 Agent。重构集中在现有系统的认知与决策内核。

目标链路统一为：

```text
ShoppingGoal
→ GoalConstraint
→ SearchExecution
→ ProductObservation
→ SemanticProfile
→ ConstraintAssessment
→ CandidateQualification
→ RankExplanation
→ AnswerPlan / ClaimLedger
```

核心原则：

1. 用户目标与供应商 listing 是两个世界，通过 constraint assessment 与 evidence ref 连接。
2. BuyWhere 是高召回、弱结构、字段会漂移的 listing source，不是完整商品知识库。
3. 模型负责开放语义理解、query 提议和受控分类；代码负责金额、市场、状态提交、硬约束、资格聚合与事实验证。
4. `UNKNOWN` 不等于满足。价格低不能补偿品类错误或硬约束失败。
5. 控制环按可行商品和证据覆盖率停止，不按原始候选数量停止。
6. 回复必须先形成回答义务和事实账本，渲染器不得增加新事实。
7. 第一版只用 smartphone/iPhone 与 headphones 两类完成垂直切片，验证后再扩品类。

## 2. 已验证的问题与根因

2026-08-23 使用 live BuyWhere、FX 与 DeepSeek，对 5 个隔离用户执行 14 个有效多轮对话，复现：

- 英文 `CNY 6000` 等预算没有写入目标，结构化 PATCH 却能生效；
- `my mother`、`my maximum`、`My budget` 被解析成市场 `MY`；
- iPhone 请求推荐 stroller kit 与 poncho 等配件；
- laptop 请求混入手机；
- 排除书籍并要求园艺工具后推荐纸杯蛋糕礼盒；
- 平台与库存复合问题连续两轮没有被回答；
- API 展示 6 件但回复声称当前集合有 17 件；
- 用户纠错被压缩为 `reject_item` 或追加 `excluded_terms`，没有重建正向目标；
- 推荐理由主要退化为最低价，缺少用户偏好证据。

根因不是单个 Prompt，而是：

- `MissionConstraints + PreferenceBelief + DialogueState` 不是统一、版本化的购物目标；
- 混合话轮被单个 `DialogueAct.kind` 和 primary route 压缩；
- 标题关键词过滤承担商品身份判定；
- 召回后缺少逐约束的三值资格矩阵；
- research 以候选数而非任务完成度收环；
- `TALK` 路由没有结构化回答义务；
- 生成回复之前没有逐 claim 证据校验。

## 3. BuyWhere 当前真实能力边界

项目于 2026-08-23 复跑 `scripts/probe_capability.py`，共执行 7 次脱敏请求。结果保存于 `artifacts/capability-probe.json`。

### 3.1 当前可依赖

- 搜索结果通常提供 `id/title/price/merchant/url/click_url/image_url/updated_at`；
- `price.amount` 允许为 null，必须跳过或进入未知，不能写成 0；
- 响应 meta 出现 `total/limit/offset/has_more/response_time_ms/cached/hint`；
- US/SG 同 query 的召回量可能高度不均衡；
- DeepSeek 当前结构化 JSON 调用可用。

### 3.2 不可作为稳定事实

- 顶层 `availability` 本次不存在；过去曾出现后又消失；
- `metadata.brand/rating/rating_count/product_type/vendor` 仅零散出现；
- `country_code` 历史覆盖不稳定，请求市场不能回填成商品自身市场事实；
- merchant 常为店铺或抓取来源标识，不天然等价于用户认知的平台；
- metadata 只能作为 provider-specific weak evidence，必须记录来源、提取器版本与观测时间。

### 3.3 当前不能依赖

- 顶层 brand、rating、review_count、structured specs、comparison attributes；
- 详情与 compare 的字段增量：本次 `detail_adds=[]`；
- 稳定的价格历史；
- 实时库存、配送资格、运费、税费、正品和保修；
- offset 分页、deliver_to、include_unshippable 的实际语义，尚需专项探针确认。

因此，V2 不能把详情接口当默认富化步骤，也不能把 metadata 缺失解释为否定或把 metadata 值直接升级成稳定产品事实。

## 4. 目标领域模型

### 4.1 ShoppingGoal V2

`ShoppingGoal` 是唯一权威购物目标。现有 `MissionConstraints` 暂时作为兼容投影，不能长期保留为第二事实源。

```text
ShoppingGoal
  goal_version
  target
    category_id?
    item_type?
    brand?
    model?
    condition?
    relation_required: product | accessory | bundle | unknown
    canonical_description
    user_phrase
  constraints[]
  preferences[]
  retrieval_scope
    markets_requested[]
    platforms[]
    merchants[]
    query_language?
    delivery_destination?   # 与检索市场严格分离
  unresolved[]
  rejected_entities[]
```

第一版不实现任意约束 DSL，只支持已有 evaluator 的类型：

- item type / relation；
- budget；
- brand / model；
- stock；
- platform / merchant；
- 少量可由标题明确派生的规格。

每个 `GoalConstraint` 至少包含：

```text
constraint_id
facet
operator
typed_value + unit
hardness: hard | soft
unknown_policy: block | disclose | allow
evidence_threshold
status: active | superseded | retracted
confidence
source_turn_id + source_span
supersedes_id?
```

`query` 不是权威目标字段，而是 QueryPlanner 从 Goal 生成的易失执行产物。

### 4.2 GoalOperations

自然语言话轮编译成有序操作，而不是单个 intent：

```text
SetTarget
UpsertConstraint
RetractConstraint
SetRetrievalScope
AddPreference
RejectCandidate
CorrectUnderstanding
AskFact
CompareCandidates
Undo
RequestResearch
```

每个操作带 `op_id/source_turn_id/source_span/confidence/precondition_goal_version`。执行顺序必须可重放，整批操作经过确定性校验后原子提交并产生新 `goal_version`。

确定性 parser 先处理金额、货币、严格市场 token 与显式枚举；LLM 只提出开放语义操作。二者冲突时不得静默覆盖，应进入 conflict policy 或澄清。

## 5. 商品观察、语义画像与资格判断

### 5.1 SearchExecution

每次供应商调用记录：

```text
execution_id / goal_version
query / market / mode / offset? / limit
requested_params
response_meta
latency / status / fetched_at
contract_fingerprint
query_fingerprint
```

ProductSource Port 需要返回 `products + SearchPageMeta`。offset 先作为可选 capability；在专项探针验证接受度、第二页稳定性、重复率、has_more/total 可信度和限流之前，`continuation=None`。

### 5.2 ProductObservation

供应商观察必须与本地派生分离：

```text
ProductObservation
  snapshot_id / source_product_id
  sanitized_raw_item
  normalized_facts
  field_provenance
  retrieval_context
  fetched_at / contract_version
```

当前 `ProductSnapshot.raw_json` 实际保存归一化对象，不是真正 BuyWhere observation。V2 应在白名单、大小限制与敏感字段清洗后保存进入 pool 或被引用 listing 的原始 item；不保存 API key、整页 header 或无限期全量响应。调试原始响应可进入有保留期的 fixture/debug 存储。

### 5.3 ProductSemanticProfile

语义画像可重算，不得污染供应商事实：

```text
target_type / category
brand / model
relation: product | accessory | bundle | service | unknown
derived_attrs
method: rule | model
confidence
evidence_spans
classifier_version
```

高精度规则先识别强反证；结构化模型只看 observation，输出 evidence span 和 confidence。模型不得生成 BuyWhere 没有提供的规格。低置信或矛盾一律 `UNKNOWN`。

### 5.4 ConstraintAssessment

每个 candidate × active constraint 都产生：

```text
SATISFIED | VIOLATED | UNKNOWN
reason_code
evidence_refs[]
evaluator_version
goal_version
```

资格聚合是确定性纯函数：

```text
任一 hard VIOLATED              → INELIGIBLE
无违反且存在 blocking UNKNOWN   → NEEDS_EVIDENCE
required hard 全部 SATISFIED     → ELIGIBLE
soft constraint                 → 不参与 eligibility
```

`NEEDS_EVIDENCE` 必须与推荐可行集分开展示，不得靠免责声明混入 TopK。

库存证据等级至少分为：

```text
authoritative / provider_top_level / metadata_hint / absent / conflict
```

当用户要求“确认有货”时，只有达到配置阈值的证据才能判定 SATISFIED；BuyWhere metadata hint 默认不能满足“实时确认”。

## 6. 有界 Agent 控制图

```text
ReceiveTurn
→ CompileGoalOps
→ ValidateResolveOps
→ AtomicCommitGoalRevision
→ AssessNextAction
   ├─ AnswerFromEvidence
   ├─ ClarifyOneSlot
   └─ PlanResearch
       → RetrieveBuyWhere
       → NormalizeObservation
       → BuildSemanticProfile
       → QualifyCandidates
       → AssessCoverage
          ├─ enough → RankFeasible
          ├─ improvable + budget remains → PlanResearch
          ├─ user decision required → ClarifyOneSlot
          └─ exhausted → NoFeasibleResult
→ BuildAnswerPlan
→ VerifyClaims
→ RenderResponse
→ CompletionCheck
→ PersistTrace
```

所有 artifact 必须绑定 `goal_version`；旧版本结果不得写回新目标。

### 6.1 Coverage 与停止条件

Coverage 不是一个候选数量百分比，至少包括：

- identity purity；
- eligible count；
- required hard constraint evidence coverage；
- market/query attempts；
- remaining request/time/token budget；
- 每轮新增 unique observations 与 eligible 的边际收益。

首版停止规则：

```text
eligible >= K 且 TopK required hard constraints 全 SAT → 成功
达到请求/时间预算                                → 停止并诚实降级
连续两次无新增 eligible                          → 停止
缺口只能由用户决定                              → 澄清一个高影响问题
```

首版不实现学习型 VOI。澄清采用可解释策略表，每轮最多问一个会显著改变搜索空间、可行性或 TopK 的问题。

### 6.2 QueryPlanner 边界

- 模型可以提出 2–4 个短 query variant；
- 市场、硬预算、分页和调用预算由代码注入；
- 模型不得擅自放宽硬约束；
- query 必须限长、去重并记录 fingerprint；
- 首个垂直切片建议最多 `2 queries × 2 markets × 1 page`，并发上限 3；
- 只有首轮 eligible 不足且仍存在可改善缺口时，才追加一次改写或已验证分页。

## 7. 可行集排序

排序只接收 `ELIGIBLE`：

```text
Feasibility gate
→ soft preference utility
→ price utility
→ freshness
→ merchant/entity diversity
```

缺失特征从权重分母移除并记录 coverage，不得自动加分或减分。价格永远不能补偿品类、relation 或其他硬约束失败。

`RankExplanation` 复用 qualification assessments，不允许另一次 LLM 自由生成推荐理由。

第一版采用可解释 feature scoring，不做端到端 learned ranker。

## 8. AnswerPlan 与 ClaimLedger

复合问题先拆成回答义务：

```text
AnswerPlan
  goal_version
  question_intents[]
  obligations[]
  scope_candidate_set_id
  required_facets[]
  missing_facets[]
  proposed_next_action
```

每个 obligation 状态为 `answered | unknown | needs_research`。

用户可见事实进入轻量 ClaimLedger：

```text
claim_id
subject
predicate / value / polarity
EvidenceRef(snapshot_id, json_path, source, observed_at,
            evidence_level, derivation_version)
wording_policy
```

最终决策以不可变 `DecisionBundle` 为权威制品，统一绑定
`goal_version/candidate_set_id/AnswerPlan/ClaimLedger/rendered_claim_ids/verification`。
兼容字段可以从 bundle 投影，但持久化层不得重新规划、重新生成 claim 或重新渲染。

ClaimVerifier 门禁：

- 所有外部事实都有 evidence ref；
- unknown 不得被写成肯定；
- 引用商品属于 canonical displayed candidate set；
- 集合数量来自同一 candidate set；
- 禁止 source_product_id 泄漏；
- Renderer 输出的事实集合不得超出 verified claim set。

Renderer 只消费已验证 ledger，模型可润色表达但不能增加数字、规格和事实。

## 9. 模块落点

建议新增或重组：

```text
backend/application/dto/
  goal.py
  goal_ops.py
  observation.py
  qualification.py
  answer.py

backend/application/services/
  goal/compiler.py
  goal/validator.py
  goal/reducer.py
  goal/projection.py
  planning/assess.py
  planning/coverage.py
  planning/search_plan.py
  rec/profile.py
  rec/qualify.py
  rec/feasible_rank.py
  answer/planner.py
  answer/ledger.py
  answer/verifier.py
  answer/renderer.py
```

LangGraph 节点按第 6 节显式化。现有 `execute_ops` 在迁移期保留为 feature-flagged legacy path。

持久化首版不建立大量关系表：

- `shopping_missions` 增加 `goal_json/goal_version/schema_version`；
- `product_snapshots` 保存受控 observation、normalized facts 与 schema version；
- `candidate_sets` 保存 goal version、search execution、semantic profiles 与 assessments；
- `recommendation_runs` 保存 answer plan、claim ledger、verifier result；
- 事件增加 `goal.operations_proposed/committed`、`candidate.qualified`、`coverage.assessed`、`answer.verified`。

等查询与规模证明 JSONB 不足后再拆表。

## 10. 分阶段实施

### Phase 0：基线、契约与数据集（1 周）

交付：

- 将 5 用户 14 轮有效轨迹固化为脱敏 trajectory replay；
- 建立 smartphone/iPhone 与 headphones 的 SEO 对抗样本；
- 保存版本化 BuyWhere raw fixtures 与字段覆盖报告；
- 扩展能力探针验证 offset、has_more、最大 limit、重复率、缓存、限流；
- 修复 live smoke 对 `INTEREC_BUYWHERE_API_KEY` 的识别；
- 建立 run trace schema 与现网质量基线。

退出门槛：fixture 可重复、trace 可串起完整 run、测试集有人审标签、普通 CI 不依赖真实网络。

### Phase 1a：Goal V2 与观察链 shadow（1–2 周）

交付：

- GoalOperations compiler、validator、reducer；
- Goal V2 双写但不影响线上决策；
- MissionConstraints 兼容投影；
- 最小 SearchPlan/SearchExecution；
- ProductObservation 与 provenance；
- 最小 Answer obligation schema。

退出门槛：

- 金额、货币、市场确定性 corpus 100% 通过；
- 关键 budget/market/correction operation recall ≥ 98%；
- reducer 幂等、冲突、supersession、undo property tests 通过；
- event replay 结果 100% 稳定；
- 新旧状态差异 100% 可解释。

### Phase 1b：语义画像与资格矩阵 shadow（约 2 周）

交付：

- 两品类小型 taxonomy；
- ProductSemanticProfile；
- type/relation/budget/brand/stock/channel evaluators；
- ConstraintAssessment 与 CandidateQualification shadow；
- 人工标注 qualification golden set。

退出门槛：

- unknown 被提升为 SAT 的违规数为 0；
- 关键品类 identity precision ≥ 99%；
- accessory/wrong-type 进入“判定可行”的比例 < 1%；
- eligible recall ≥ 90%，防止通过全判 unknown/拒绝作弊；
- 所有 verdict 可追溯到 evidence ref 与 evaluator version。

### Phase 2：Qualification gate 上线（约 2 周）

先阻断明确 VIOLATED，观测误杀；随后将 blocking UNKNOWN 分流到 `NEEDS_EVIDENCE`。旧排序只能读取 ELIGIBLE。

退出门槛：

- Top3 硬约束 violation = 0；
- 明确 accessory/wrong-type 推荐 = 0；
- 强制确认库存时 unknown 推荐 = 0；
- 无可行商品时能诚实返回，不从旁路候选捞回错误结果；
- feature flag 只能缩小已批准品类集合。

### Phase 3：Coverage 驱动的 QueryPlanner（1–2 周）

交付有界多 query、多市场、可选已验证分页以及显式 Coverage 回边。

退出门槛：

- loop termination = 100%；
- 每次 run 调用数不超过配置预算；
- 连续无增益停止 = 100%；
- 有可行商品样本 eligible@3 ≥ 0.8；
- P95 延迟相对基线增加不超过 30%，或满足经评审的产品预算。

### Phase 4：可行集排序与可验证回答（1–2 周）

先迁移平台/库存/比较回答，再迁移推荐回复。

退出门槛：

- question obligation coverage = 100%；
- unsupported factual claim = 0；
- canonical set 数量不一致 = 0；
- 内部 ID 泄漏 = 0；
- Renderer claim set 不扩张 = 100%；
- 排序解释全部复用 assessments。

### Phase 5：Goal 切为权威状态并扩品类（约 1 周起）

双写 shadow 稳定后切换读路径，旧 `IntentPatch/MissionConstraints/PreferenceBelief` 逐步降为兼容层。只有新类别完成 gold、qualification 和 trajectory 门槛后才开放。

## 11. 测试与验证矩阵

### 单元与性质测试

- GoalOperation 顺序、幂等、冲突、retract、supersession、undo；
- 金额、单位、币种、市场 fuzz，必须覆盖 `my != MY`；
- 三值真值表与 eligibility 纯函数；
- FX/预算边界与缺失价格；
- metadata/top-level 冲突库存必须 UNKNOWN；
- 排序永不越过资格门。

### BuyWhere 契约测试

- 版本化脱敏 raw fixtures；
- null、新字段、字段消失、类型漂移、重复 listing；
- 搜索 meta、分页能力、价格为空、country_code 缺失；
- schema fingerprint 和字段 coverage drift 告警；
- 每日/定时 live canary，普通 CI 只跑 fixture。

### Qualification golden set

- smartphone/product、phone accessory、bundle、unknown；
- headphones/headset/earbuds 及配件；
- 对抗性 SEO 标题；
- 错品类、正确品类但硬规格未知、metadata 冲突；
- 同时度量污染和误杀，禁止通过全拒绝获得漂亮指标。

### Trajectory regression

- 首轮模糊需求应澄清；
- 一句话同时修改目标、预算、市场并拒绝候选；
- 用户纠错后恢复；
- 平台和库存复合问题；
- 无可行商品；
- 证据缺失；
- 比较、撤销、版本冲突与跨用户隔离。

主要指标：goal state accuracy、operation recall、recovery turns、eligible@K、hard violation、answer obligation coverage、claim support、loop cost/latency。

### 变形测试

- 同义改写、语序、大小写和中英混合不改变目标；
- 预算收紧不能增加可行集；
- 新增硬约束不能使 violated 候选晋级；
- evidence 等级降低不能使 UNKNOWN 变 SAT；
- 排序权重变化不能让 INELIGIBLE 进入 TopK。

## 12. 发布与回滚

```text
offline replay
→ shadow（达到分品类有效样本与质量门槛）
→ 人工审计
→ 部署显式 V2 单路径
→ 发布健康检查
→ 达标后按 CategoryContract 扩品类
```

运行时不保留旧推荐路径或流量分桶。故障通过部署系统回滚到上一个通过验收的显式 V2 版本；品类开关只能缩小已批准集合。无法满足硬约束时必须返回无可行结果，不能为了“页面有商品”切换实现或回退到错误推荐。

## 13. 明确推迟的事项

- 多自治 Agent；
- 通用约束 DSL 与全品类 ontology；
- 学习型 VOI；
- 端到端 learned ranker；
- 向量数据库和商品知识图谱；
- 完美跨商户商品实体聚类；
- 实时网页二次抓取；
- 未经验证的配送推断；
- 依赖空价格历史的价值判断；
- 无限 query rewrite 或全页抓取。

## 14. 止血补丁与架构工作的边界

应立即单独修复：

- CNY 英文金额与市场词边界；
- SSE 删除 Mission 后的异常收尾；
- 禁止回复内部 ID；
- 集合数量统一读取 canonical candidate set；
- 平台/库存的确定性回答；
- live smoke 环境变量识别。

这些修复不替代 Goal V2、Qualification、Coverage loop 和 ClaimLedger。继续增加 intent、正则、品类词表、配件黑名单或模板，只能作为高精度第一层 guardrail，不能继续承担开放世界语义判断。

## 15. 首个最小垂直切片 Definition of Done

在 smartphone/iPhone 与 headphones 两类上，完整实现：

1. GoalOperations 能表达 item type、relation、brand、budget、market、platform 和纠错；
2. BuyWhere observation 有受控 raw evidence 与版本化 provenance；
3. SemanticProfile 能区分 product/accessory/bundle/unknown；
4. 每条硬约束产生三值 assessment；
5. eligible、needs evidence、ineligible 三集合严格分离；
6. coverage 不足最多改写一次且受调用预算约束；
7. 平台/库存问题按 obligation 回答；
8. 所有用户可见事实通过 ClaimVerifier；
9. 现有真实失败轨迹全部成为自动回归；
10. 达到 Phase 1a–4 对应硬门后，才允许扩展第三个品类。

这个切片是架构是否成立的证明。若它不能稳定消除配件污染、预算丢失、答非所问和无证据断言，则不应继续扩大系统复杂度。

## 16. 反 bad-case 规则堆积：语义编译与品类发布契约

### 16.1 问题本质

对话式推荐的核心矛盾不是规则数量不足，而是开放式用户语言、弱结构 listing 与确定性业务决策之间缺少稳定的语义接口。失败样本可能来自目标解析、检索污染、语义分类、证据缺失、资格聚合、排序越权或回答扩写。若不先归因便把每个失败样本转成正则、黑名单或特殊分支，系统会形成不可校准、不可解释且跨品类互相冲突的规则网络。

因此，bad case 默认是评测资产，不是生产规则需求。只有同时满足以下条件时，失败模式才允许沉淀为规则：

- 它代表稳定、可解释、跨 listing 重复出现的业务概念；
- 规则具有明确适用品类、证据字段和版本；
- 在人工标注集上证明污染下降，且误杀、UNKNOWN 和 eligible recall 未越过门槛；
- 能够回滚，且不会把弱证据提升为事实。

### 16.2 目标架构

语义链收敛为：

```text
ProductObservation
→ HighPrecisionRuleGuard
→ StructuredSemanticClassifier
→ ProfileAdjudicator
→ ProductSemanticProfile
→ ConstraintAssessment
→ CandidateQualification
```

职责边界如下：

1. `HighPrecisionRuleGuard` 只识别强反证、明确实体、证据冲突和稳定格式，不承担开放世界正向分类。
2. `StructuredSemanticClassifier` 只能观察受控 observation，并输出 schema 约束的 `item_type/relation/brand/model/derived_attrs/confidence/evidence_spans`。它是语义提案器，不是事实源。
3. `ProfileAdjudicator` 是确定性纯函数。规则与模型冲突、模型低置信、缺少 evidence span 或 provider 字段冲突时，一律降为 `UNKNOWN`。
4. `ConstraintAssessment` 和资格聚合只消费裁决后的 profile 与 observation evidence；模型不得直接输出 `ELIGIBLE`。
5. 排序只接受 `ELIGIBLE`；回答只接受已验证 ClaimLedger。

模型不可用时，系统允许高精度规则 fallback，但必须提高 UNKNOWN，而不是用更多弱规则恢复召回。模型上线前先 shadow 保存提案和裁决差异，不影响线上资格结果。

### 16.3 CategoryContract

“能够识别一个品类”与“允许在线推荐该品类”必须分离。每个品类建立版本化发布契约：

```text
CategoryContract
  category_id
  lifecycle: offline | shadow | canary | enabled
  semantic_profile_mode: rule_only | shadow | adjudicated
  allowed_relations[]
  required_evidence_facets[]
  supported_constraint_facets[]
  taxonomy_version
  qualification_profile_version
  gold_dataset_version
```

运行时 feature flag 只能缩小已批准集合，不能把 `offline/shadow` 品类提升为线上品类。启动时必须校验 detector、evaluator、evidence facet 与 qualification profile version；资格链必须实际消费 `allowed_relations` 和 `supported_constraint_facets`。生命周期升级必须经过代码评审、离线门槛、shadow 样本审计、人工审计和 canary。首个发布切片仍只包括 smartphone 与 headphones；monitor 可保留离线 taxonomy 和 gold 数据，但在 contract 晋级前不得进入线上资格链。

### 16.4 错误归因与修复所有权

每个回归样本必须标注唯一主因和可选次因：

```text
goal_compile | retrieval | semantic_profile | evidence
qualification | ranking | answer_claim | state_version
```

修复必须落在拥有该不变量的层：金额/市场错误修 Goal compiler，错品类修 semantic profile，未知库存被推荐修 qualification，事实扩写修 ClaimVerifier。禁止用 query 词表修回答问题，或用 renderer 免责声明掩盖 qualification 问题。

### 16.5 语义质量指标

除 eligible precision/recall 外，新增：

- abstention rate：UNKNOWN 比例及其人工正确率；
- conflict rate：规则、模型、URL/metadata 的冲突率；
- evidence span validity：分类证据是否真实存在于 observation；
- bad-case rule growth：生产规则数量与覆盖样本数，防止单样本单规则；
- per-category pollution / false rejection；
- profile version drift：同一 observation 在版本升级前后的裁决差异。

UNKNOWN 不是失败指标。只有在保证污染为零或低于发布门槛后，才优化 UNKNOWN 和 recall。

## 17. 实现与发布验收补充

### 17.1 实现顺序

1. 引入 `CategoryContract`，切断环境变量对离线品类的提升权限。
2. 扩展 `ProductSemanticProfile`，持久化 `category_id/derived_attrs/method/conflict_reason_codes/classifier_version`。
3. 抽出 `RuleGuard + ProfileAdjudicator` 纯函数；现有规则作为可审计 fallback。
4. 增加结构化模型 classifier adapter，先 shadow 记录 proposal，不改变资格结论。
5. shadow 达标后启用 adjudicated profile；冲突和低置信仍 UNKNOWN。
6. AnswerPlan、ClaimLedger、VerifyClaims、RenderResponse 已收敛为图上的单一路径，双渲染已删除。

### 17.2 单元与性质门槛

- offline 品类不能被任意 feature flag 提升；
- publishable contract 的 qualification profile version 与运行时版本一致；
- 模型低置信、缺证据或与 guard 冲突时必为 UNKNOWN；
- evidence 等级下降不能使 UNKNOWN 变 SAT；
- 每条 assessment 绑定 candidate 与 goal version；
- taxonomy 扩展不能改变已发布品类 gold 结论；
- 排序和模型 keep 不得提升 NEEDS_EVIDENCE/INELIGIBLE。

### 17.3 Shadow 与 canary 门槛

- model proposal schema validity = 100%；
- evidence span validity = 100%；
- 明确 accessory/wrong-type 晋级 ELIGIBLE = 0；
- unknown promoted to SAT = 0；
- 已发布品类 identity precision ≥ 99%，eligible recall ≥ 90%；
- 每个品类独立满足有效样本量、质量指标和人工审计；日历跨度只作诊断，不参与晋级；
- contract、taxonomy、classifier 或 evaluator 版本变化后，旧版本样本不得计入新版本晋级证据。

这套机制允许并行研发和离线评估多个品类，但线上发布权始终由可验证的 CategoryContract 与运行证据决定，而不是由词表、环境变量或单个 bad case 决定。

### 17.4 真实上游背压、时间预算与 2026-08-24 验收结论

真实流量验收必须把运行环境故障、供应商故障、零召回和资格拒绝分开记录。不得把
`upstream_error`、空 `ProductSearchResult` 或 `time_budget_exhausted` 误归因为品类语义失败，
更不得用放宽资格门槛来掩盖召回层问题。

进程级 `BuyWhereProductSource` 是供应商配额与连接池的所有者，因此它维护跨 Mission 共享的
并发门；`gather_market_products` 的并发门只负责单次研究内部的市场扇出。两层限制解决的是不同
问题，不能互相替代。供应商重试必须占用同一个进程级槽位，避免失败风暴放大上游压力。
`INTEREC_BUYWHERE_MAX_CONCURRENCY` 控制供应商级并发，默认值为 3。

研究循环的时间预算必须覆盖“首轮按原币预算召回、必要时去原币价格上限再召回、语义 Shadow、
资格聚合与排序”的完整最小闭环。该预算由 `INTEREC_RESEARCH_MAX_WALL_TIME_MS` 配置，当前默认
45 秒；它仍受最大搜索次数、总请求数、模型调用数、Token 和连续无增益门槛共同约束，不代表
允许无限等待。预算调整依据真实 P95/最坏路径耗时，而不是按品类写特殊超时。

2026-08-24 的真实 BuyWhere + DeepSeek 并发黑盒验收结果：

- 四个隔离用户并发场景整体通过；耳机返回 6 个合格候选；
- 未发布的显示器和笔记本品类保持澄清，不被环境变量提升；
- iPhone “只看有货”在缺少可靠库存证据时安全降级为空，没有用 UNKNOWN 补足页面；
- 跨用户隔离、canonical snapshot、商户链接、金额与引用约束均通过；
- 首批耳机语义 Shadow 有 29 个 proposal，schema 无非法 proposal，模型未直接影响线上资格；
- evidence span 有效数为 45/47，且 smartphone 尚无有效 Shadow observation，因此语义模型仍不具备晋级条件；
- 当时的发布审计因样本量、延迟样本量和人工审计未完成而阻断；该记录只描述当时证据状态。

晋级门槛只看版本一致的有效样本数量、质量指标和人工审计，不要求固定覆盖 7 个自然日。
日历跨度只作为诊断分布展示，不参与 `release_healthy` 判定。

### 17.5 2026-08-24 全量发布决策

产品所有者在已知默认发布审计仍因样本量、延迟样本量和人工审计未完成而阻断的情况下，明确授权
将显式 V2 决策图全量发布。该决策属于有记录的风险接受，不得表述为自动门槛已经通过。
发布范围仅包含显式 V2 图；结构化语义分类器继续保持 Shadow，资格判定、UNKNOWN 降级、
ClaimVerifier 和 CategoryContract 均不得绕过。随后按第 18 节完成单实现收敛；紧急处置只能回滚部署版本或缩小品类集合。
## 18. 单实现收敛决议（2026-08-24）

### 18.1 决议

全量发布后，推荐运行时只允许一套实现：

```text
Input adapters
→ Goal-owned world transition
→ AssessNextAction
→ Clarify / AnswerFromEvidence / Research
→ NormalizeObservation
→ SemanticProfile
→ CandidateQualification
→ Coverage
→ RankFeasible
→ AnswerPlan
→ ClaimLedger verification
→ RenderResponse
→ PersistDecisionSnapshot
```

旧 `execute_ops` 图、`CanaryMissionRunner`、mission 哈希分桶、0/5/100 流量开关、旧模型文案生成链和 Persist 内的 AnswerPlan/ClaimLedger/observation 补造逻辑均属于技术债，必须删除，不得以“紧急回滚”名义保留隐藏入口。故障回滚是部署版本回滚，目标版本也必须满足本节单路径契约。

### 18.2 唯一权威与兼容边界

- `ShoppingGoal + GoalOperations + goal_version` 是内部目标状态与变更的唯一写权威。
- `MissionConstraints`、`IntentPatch` 可以继续作为 HTTP、LLM 或历史存储的输入/输出 DTO，但只能单向编译为 GoalOperations，或由 ShoppingGoal 派生为只读视图；它们不得独立驱动资格、排序或持久化决策。
- `ProductObservation` 必须在 provider/检索边界产生。Persist 缺少 observation 时必须 fail closed，不能根据 NormalizedProduct 伪造来源记录。
- `AnswerPlan` 与 `ClaimLedger` 必须由显式图节点产生。Persist 只校验并原子写入 `DecisionBundle`，不得重新生成、修补或扩张事实。
- 结构化语义分类器的 shadow proposal 是同一资格链中的旁路观测，不是第二套推荐实现；在晋级前不得影响线上资格结论。

### 18.3 精确删除与保留清单

| 对象 | 处理 | 理由 |
|---|---|---|
| 旧 execute graph / `make_execute_ops` | 删除 | 与显式 V2 图形成双执行语义 |
| `CanaryMissionRunner`、cohort、percent 配置 | 删除 | 全量后仍可路由旧实现，制造新老冲突 |
| 模型直出 RecommendationDraft 的旧 compose 链 | 删除 | 绕过 AnswerPlan/ClaimLedger 的唯一回答契约 |
| Persist 中 observation、AnswerPlan、ClaimLedger fallback | 删除 | 在事实落库边界补造上游产物，掩盖契约缺失 |
| `MissionConstraints` / `IntentPatch` DTO | 保留为适配层 | 外部协议仍需兼容，但不拥有内部决策权 |
| deterministic rule guard | 保留 | 模型不可用时安全降级，输出 UNKNOWN 而非另一路资格结论 |
| CategoryContract 的 offline/shadow/canary/enabled | 保留 | 这是品类能力发布状态，不是推荐图流量分桶 |
| 历史旧路径事件 | 只读保留 | 审计数据不可改写，但不计入当前发布健康样本 |

### 18.4 发布后的验收与防回归

发布健康检查只接纳 `execution_path=explicit_v2` 且 `release_state=full` 的当前版本样本，不再和旧实现比较。P95 使用经评审的绝对延迟预算；样本量、品类覆盖、失败运行、安全不变量和人工签核仍是独立门槛，不要求固定七天。

架构测试必须阻止以下回归：重新出现旧执行模块或 Canary runner；图构造函数重新接受 legacy 分支；Persist 重新导入回答构造器或生成 normalized observation；容器重新读取执行图百分比配置。任何新增 fallback 都必须证明它只降低能力或返回 UNKNOWN/明确失败，不能形成第二个状态权威、第二套候选集或第二条答案生成链。
