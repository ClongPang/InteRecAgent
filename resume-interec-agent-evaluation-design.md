# InteRecAgent 简历量化评测设计

本文定义 `resume-interec-agent-target.md` 中所有指标的任务、运行、判分和投递口径。目标是在复用现有 Conversation、Turn、WorkingSet、Claim–Evidence、Provider 治理和 PostgreSQL attempt 机制的前提下，形成真实可运行、可复现且能直接支撑简历主张的评测。

## 一、评测原则

1. **以完整 task/trial 为基本单位**：task 包含用户目标、环境初态、对话脚本、工具、Provider 数据、业务规则和通过条件；同一 task 的一次完整运行记为一个 trial。
2. **真实模型与可变外部数据解耦**：核心 Gold Set 使用真实 DeepSeek 与冻结的 BuyWhere/FX replay fixture，避免实时库存变化破坏可重复性；真实 BuyWhere 只做独立 live smoke，不参与质量百分比。
3. **同版本重复运行**：固定代码提交、prompt/skill、模型 ID、模型参数、Provider fixture 和数据库 migration，每个 task 独立运行 3 次。
4. **先确定性判分，再人工复核**：状态、操作、调用和 Claim–Evidence 用确定性规则评分；全部失败 trial 和固定随机抽取至少 20% 的成功 trial 由人工复核。
5. **质量、可靠性、成本分开报告**：不把任务成功、故障恢复、tokens、延迟和成本合成为自创总分。
6. **数据库与外部副作用分开**：故障评测分别报告状态重复提交和 Provider 重复调用，不宣称外部 exactly-once。

## 二、真实模型 Gold Set

### 2.1 规模与覆盖

- 13 类核心场景，与产品 contract 的能力矩阵逐项对应；
- 每类 3 个语义和数据不同的 task，共 39 个 task；
- 每个 task 运行 `k=3` 次，共 117 个 trial；
- 每个 task 包含 2～4 个 Turn，必须具备跨轮状态变化或工具行为；
- 所有 trial 使用同一实现版本和模型版本，运行顺序随机化，每次从隔离的 Conversation 初态开始。

正式运行前冻结 manifest，为每个 task 预分配 `run_index=1..3` 和 trial ID，关闭模型响应缓存。不得只重跑失败 trial，也不得在看到结果后修改 prompt、fixture、模型或评分器并与旧结果混算。

39 个 task 足以报告绝对数和比例，但仍需同时提供失败明细；当前阶段不使用置信区间包装结果。

### 2.2 十三类任务

| 类别 | 主要能力 | 核心通过条件 |
| --- | --- | --- |
| 澄清后继续 | 缺口识别、同一任务恢复 | 只询问高影响缺口；回答后清除 pending 状态并继续研究 |
| 多市场研究 | 目标、预算、市场和研究授权 | Goal 正确；只调用授权市场；形成合格候选或正确无匹配结论 |
| 复合操作 | 一句话包含修改、拒绝和追问 | 必需操作全部执行，来源序数在变更前稳定绑定 |
| 已有候选比较 | 序数指代、证据内回答 | 引用正确候选；不重复调用报价 Provider；只陈述已有事实 |
| 市场过滤 | Goal 修改、WorkingSet 复用 | 展示范围正确；proof pool 保留；无显式刷新时不重新研究 |
| 偏好重排 | 软偏好与候选排序 | pool 成员不变；展示顺序按偏好变化；不重新研究 |
| 目标纠正 | 正向修正与必要重查 | 新目标写入 Goal；旧目标候选不混入；触发必要研究 |
| 拒绝与 undo | 反馈账本、精确版本恢复 | 被拒候选从展示移除；undo 后 Goal 与 WorkingSet 等于目标 revision |
| 焦点与刷新恢复 | UI focus、稳定引用、持久状态 | 刷新或 worker 重启后仍引用正确候选，无进程内记忆依赖 |
| 未知事实处理 | 解释、库存/保修等未知项 | 已知事实有证据；未知保持未知；不得补写无来源事实 |
| Provider 部分失败 | 部分结果、失败披露 | 可用市场证据保留；不可用市场明确披露；不能误报为无商品 |
| 中断与抢占恢复 | supersede、消息批次继承 | 旧 attempt 失去提交权；下一 Turn 完整消费未处理消息并保留修正依据 |
| 能力分级 | VERIFIED 与 DISCOVERY | 增强品类严格准入；开放品类不得冒充正式推荐并披露未验证项 |

每类三个 task 从商品、市场、预算、表达方式、候选排列和环境动作中至少改变两个预登记变化轴；同一 family 整体应覆盖多种表达和数据条件，但不要求每个场景机械改变全部维度。

在建立 task 前先维护“产品 invariant/capability → family → task_id”覆盖矩阵。已有 product contract、离线轨迹以及开发过程中看过的任何 task 均属于开发集。最终 39 个 Gold task 由独立审核方在实现与 prompt 冻结后，从预登记模板和 fixture pool 中组装并密封，作者在正式运行前不能查看具体 task 或 Gold 标签。

sealed Gold v1 的首次运行结果和证据包永久冻结保留。结果一旦揭示，只能用于该冻结实现的最终报告；若根据失败修改系统，v1 立即降为回归集，后续运行只能标记为 regression。新的投递指标必须来自独立审核方建立、作者未查看的 sealed Gold v2，并完整运行；不能仅修改实现或 Gold 版本号恢复独立性。

### 2.3 Task 记录结构

每个 task 至少记录：

```text
task_id
scenario_family
initial_conversation_state
provider_fixture_version
user_turns
turn_steps:
  user_input
  ui_context
  environment_actions_before_after
  allowed_routes
  required_operation_predicates
  allowed_optional_operation_predicates
  forbidden_operation_predicates
  expected_provider_calls_by_type
  expected_state_delta
  expected_outcome
expected_goal_constraints
forbidden_goal_constraints
expected_referents
expected_candidate_refs
fixture_has_qualified_offer
required_answer_slots
required_claims
expected_no_match_reason
required_disclosures
forbidden_claims
metric_eligibility
independent_listing_gold
```

每个 trial 还需记录：

```text
trial_id
task_id
run_index
run_seed
trial_status: VALID | INVALID
invalid_reason
implementation_version
model_id
model_parameters
prompt_or_skill_version
evaluator_version
replay_or_live
started_at / completed_at
all_messages
model_calls / tokens
operations
provider_calls
state_revisions
claims / evidence_refs
final_outcome
latency / cost
deterministic_scores
human_review
```

`run_seed` 在模型支持时固定并记录，不支持时记为 `null`；`run_index` 仍必须固定。`metric_eligibility` 明确该 task 是否计入状态、指代、undo、零 Provider、资格、披露等分项指标，禁止运行后根据结果更改分母。

`required_answer_slots` 和 `required_claims` 防止 Agent 通过少回答获得 100% grounding；fixture 存在合格候选时，错误返回 `NO_MATCH` 必须失败，fixture 无合格候选时正式推荐必须失败。`independent_listing_gold` 由人工从原始 fixture 标注每条 listing 的期望身份、资格、结果层级、失败原因和原始 JSON path/value，不得直接复用生产 qualifier 作为 Gold。

### 2.4 Provider 调用预算

每个 Turn 按类型记录 Provider 预算，不能用市场数直接推导物理调用次数：

```text
buywhere:
  allowed_markets
  min_max_query_attempts
  allowed_retries
  min_max_physical_calls
fx:
  expected_currencies
  min_max_calls
cache:
  expected_source: PROVIDER | LOCAL_CACHE | EITHER
```

全文“报价 Provider”仅指 BuyWhere；模型调用、FX 与 BuyWhere 分开计数。评分器按 task 允许的 query wave、retry 和 cache 模式判断，不把合法研究波次误计为重复调用。

### 2.5 Trial 有效性、隔离与补跑

- 模型超时、协议错误、错误路由、Provider 策略拒绝和应用自身异常均属于有效失败，不能标为 `INVALID`；
- 只有评测 Harness 在请求发出前损坏、原始轨迹不可恢复或与被测系统无关的统一基础设施事故，才能按预登记规则判为 `INVALID`；
- `INVALID` trial 必须保留原始记录，并以同一 task、同一 `run_index` 补跑；
- 只有取得 117 个有效 trial 后才能计算 Gold 指标；
- 人工或脚本发现评分器缺陷时，必须发布新 evaluator 版本并重算全部 117 个 trial，不能只修改个别样本标签。

每个 trial 使用独立 tenant/schema/database，或在 manifest 中证明已清空 `observed_candidates`、Provider permit/quota、circuit breaker、outbox 和所有跨 Conversation 缓存。评测时钟、artifact `observedAt`、FX snapshot 与 expiry policy 一并冻结并注入；不能让前一 trial 的缓存或真实日期影响后一 trial。

模型 API 只在能够取得不可变版本指纹时声明固定模型版本；否则只能记录固定 model ID、参数和运行时间窗口。API 级重试、429、超时和统一供应商故障的有效/无效规则必须在 manifest 冻结前登记。

## 三、任务级通过条件

一个 trial 只有同时满足以下条件才算成功：

1. 最终 Goal 中的目标、预算、市场和硬性条件与 Gold 一致；
2. 所有必需操作被执行，且没有执行禁止或阶段外操作；
3. 所有需要解析的序数、焦点或比较对象绑定到 Gold `offerRef`；
4. 报价 Provider 调用满足任务预算，零调用 Turn 不产生冗余检索；
5. 正式推荐候选通过品类、身份、硬性条件和必需商业事实校验；
6. fixture 存在合格候选时完成要求的推荐或比较；不存在时给出正确的无匹配原因，不能用保守拒答规避任务；
7. 用户要求的 answer slot 和正向事实被完整回答，未知事实显式保持未知；
8. 最终 outcome 属于 task 允许集合，部分失败和 Discovery 披露正确；
9. 所有可验证回复事实具有有效 Claim–Evidence 链，无越界引用或无依据事实；
10. 环境动作后的状态恢复、supersede 和消息批次继承满足逐 Turn Gold；
11. Conversation、Turn 和 AssistantMessage 进入预期持久状态。

任一关键条件失败，整个 trial 判为失败。不能用多个局部高分掩盖端到端任务失败。

## 四、指标定义与门槛

### 4.1 总体任务指标

| 指标 | 公式 | 建议投递门槛 |
| --- | --- | ---: |
| 端到端任务成功率 | 成功 trial 数 / 117；39 个 task 权重相同且各运行 3 次 | ≥100/117（约 85.5%） |
| 三次稳定通过率 | 3 次 trial 全部成功的 task 数 / 39 | ≥28/39（约 71.8%） |
| 有失败任务数 | 至少一次失败的 task 数，报告 `N/39` | 报绝对数和明细，不隐藏 |

报告内部可将 trial 成功率标记为 balanced three-repeat `pass@1` 估计，将连续三次全部通过率标记为 `pass^3`；简历优先使用中文含义。`pass@3` 表示三次中至少一次成功，不适合证明稳定性，本项目不把它作为核心简历指标。

同时设置 family-level 门禁：每个 family 报告成功 trial 绝对数，至少 2/3 task 达到三次全通过。中断恢复、事实安全、能力分级和零报价 Provider 等跨任务关键能力切片需要预登记对应 task/Turn，并单独汇总，不能把它们误称为独立 family；关键能力切片不允许出现整组失败或安全违规。由于每类只有 9 个 trial，不包装成高精度类别百分比。

### 4.2 跨轮状态与指代

| 指标 | 公式 | 建议门槛 |
| --- | --- | ---: |
| 多轮约束状态准确率 | 最终 Goal 通过 canonical comparator 的 `goal_state` eligible trial / 全部 `goal_state` eligible trial | ≥98%，同时报告正确数/适用 trial 数 |
| 候选指代准确率 | 正确绑定 Gold `offerRef` 的单个 referent / 全部 Gold referent | ≥98%，一次操作包含多个对象时逐对象计数 |
| undo 精确恢复率 | Goal 与 WorkingSet 均等于目标 revision 的 undo trial / undo trial | 100% |
| Replay 报价 Provider 合规率 | 应为零调用且 Replay Provider adapter 实际为零的 Turn / 全部 zero-provider Turn | 100%，同时报告违规绝对数 |

“指代正确率”只统计模型参与的真实 trial；确定性 Host 轨迹单独报告，不混入该比例。

Goal comparator 对 required fields 做规范化相等检查，对 forbidden fields 检查不存在；市场等 set-like 字段按集合比较，金额、型号和 condition 按独立 Gold 规范值比较，ignored fields 与合法但未列出的软偏好不影响该指标。

### 4.3 计划与工具授权

| 指标 | 公式 | 建议门槛 |
| --- | --- | ---: |
| 必需操作执行覆盖率 | 与 Gold 必需操作一对一匹配的已执行操作 / Gold 必需操作；每个 Gold 操作最多计一次 | ≥95% |
| 未授权操作执行 | 实际执行的 forbidden/stage-invalid operation 数 | 0 |
| Goal 参数来源违规 | 未被 Host 丢弃或归一化的无原文支持预算、市场、型号、成色参数数 | 0 |
| 协议预算降级正确率 | 超出协议预算后进入确定性降级且无状态污染的 trial / 协议超限 trial | 100% |
| 协议对抗场景安全处置率 | 进入预期拒绝、丢弃、有限修复或无状态污染降级结果的 adversarial case / 30 | 30/30 |

Gold 不要求唯一有效操作顺序；task 需要分别声明 required、allowed optional 和 forbidden operation predicate，包括操作 kind、关键参数、绑定后的 `offerRef`、依赖顺序和最终 `APPLIED` 状态。重复执行同一必需操作不能提高召回率；额外操作只按可观察的重复语义操作、Provider 预算超限、forbidden operation 或无消费者外部副作用单列，不计算依赖反事实判断的“泛化冗余率”。

真实模型 Gold 不一定主动触发阶段外工具或协议耗尽，因此另建 30 项脚本对抗协议集：阶段外工具、重复提交/发布、越界消息 ordinal、无原文 Goal 参数、连续无工具回复和无效 Claim/引用各 5 项。该结果不混入 117 个真实模型 trial 成功率，但用于证明 Host 授权和降级边界。

### 4.4 报价准入与事实可信

| 指标 | 公式 | 建议门槛 |
| --- | --- | ---: |
| 有合格报价任务正确产出率 | `fixture_has_eligible_offer=true` 且 Gold 要求推荐或比较时，至少产出一个独立 Gold 判定合格候选并满足预期结果层级的 trial / 全部此类 trial | ≥90%；manifest 至少预登记 18 个此类 task（54 个 trial） |
| 推荐候选准入精确率 | 独立 listing Gold 判定合格的推荐候选 / 全部推荐候选 | 100%，且推荐候选分母必须大于 0 |
| 正式推荐硬性条件违规 | 正式推荐中违反用户硬条件的候选数 / 正式推荐候选数 | 0；分母为 0 时报告 N/A |
| 错误商品晋级 | 配件、身份冲突或错误型号进入正式推荐的候选数 | 0 |
| 可验证商品事实证据一致率 | 证据对象、候选引用、规范化值、单位/币种、有效时间及原始 JSON path/value 均与独立 Gold 一致的事实项 / 全部可验证事实项 | 100% |
| 无依据事实 | 无有效证据却被发布的价格、库存、市场、商户、型号或成色事实数 | 0 |
| Discovery 错误晋级 | 开放品类身份不足却以正式推荐输出的 trial 数 | 0 |
| 必需披露召回率 | 与唯一 Gold 披露一对一匹配的已发布披露 / Gold 必需披露，每项最多计一次 | 100% |
| 必需回答召回率 | 实际回答的 required answer slot / Gold required answer slot | ≥95% |
| 错误披露 | 不适用于当前事实却被发布的 disclosure 数 | 0 |

未知库存或允许条件下的未知成色可以进入结果，但必须按规则披露；不能把“不确定”统一计为资格失败。

在冻结 manifest 时，39 个 task 中至少 18 个必须标记为 `fixture_has_eligible_offer=true`，且 Gold 要求系统完成推荐或比较；每个相关 family 至少包含一个正向 task。只有“有合格报价任务正确产出率”达到门槛且推荐候选分母大于 0，目标简历才能回填“推荐候选准入精确率”，防止通过全部拒答或全部输出无匹配刷出零违规。

规范化事实项以发布的 Claim 为基础，按 `(offerRef, predicate, normalizedValue, unitOrCurrency, evidenceScope)` 去重计数。“证据一致”只表示回复事实与当前候选、本次运行证据及外部报价服务原始字段一致，不推导商家数据在现实世界中绝对真实。每个正向 trial 至少预登记 2 项 required verifiable fact；至少 54 个正向 trial，因此冻结分母 `N_fact` 不得低于 108。运行后必须报告实际 `N_fact`；分母为 0 或低于预登记门槛时只能记为 N/A，禁止回填简历。117 个 trial 内所有 Turn 的终态 AssistantMessage，以及其中全部用户可见模型生成字段，都必须进行全量事实标注，覆盖 summary、next move label 和其他非 Claim 文本；发现未形成 Claim 的商品事实时，该事实也进入分母，并作为无依据事实计数。若未来运行时能确定性禁止所有非 Claim 字段承载商品事实，可用对应校验器替代人工标注，但必须先通过 mutation 负控。

### 4.5 独立 Gold 与评分器负控

商品资格、硬性条件和 Claim–Evidence 等关键安全指标不能直接再次调用生产判定器完成自评分。Evaluator 使用人工标注的 listing/outcome/原始 JSON path 作为独立 Gold，并至少加入以下 mutation/negative-control 测试：

- 把配件或错误型号强制放入正式推荐；
- 删除必需价格或来源证据；
- 把序数绑定到错误 `offerRef`；
- 漏掉 required answer slot；
- 把有合格候选的任务改为 `NO_MATCH`；
- 注入重复或超预算的 Provider 调用。

所有负控必须被评分器稳定判失败，才能开始正式运行。

### 4.6 延迟与成本

在同一环境分别报告：

- 真实模型 + Replay 环境下单 Turn 和完整 trial 的 p50/p95 延迟，明确标注为 `Gold Replay latency`；
- 每 trial 模型输入/输出 tokens；
- 依据真实模型 usage 计算的实际模型成本；
- Replay 报价 Provider 的逻辑调用次数；只有存在固定价目表时才报告“估算 Provider 成本”；
- 正常、研究、协议修复和降级路径分组结果。

延迟从服务端接收 Turn 到 AssistantMessage 进入终态计算，不包含人工复核时间。Replay 延迟和估算 Provider 成本不能冒充真实 BuyWhere 的网络延迟或实际费用。独立 Live smoke 需要单列样本数、真实 Provider 延迟、错误和费用；没有同条件基线或预算门槛前，这些指标只进入评测报告，不进入简历正文。

### 4.7 面向 Agent 岗的消融指标

绝对任务指标证明系统能否完成任务；若简历要使用“降低”“提升”等效果表达，还必须建立同条件消融基线。基线只存在于评测 Harness，不作为生产运行开关，也不能绕过正式系统的安全边界执行真实副作用。

| 设计主张 | 当前方案 | 评测基线 | 主要指标 | 质量护栏 |
| --- | --- | --- | --- | --- |
| 结构化上下文 | 当前消息 + Goal/Dialogue/WorkingSet 有界投影 | 同一任务回灌截至当前 Turn 的完整 Conversation transcript | 模型实际 input tokens 的 p50/p95 与每 task 总量，按 `(baseline-current)/baseline` 计算降幅 | 端到端成功、状态和指代指标不得出现超过预登记容差的下降 |
| 候选与证据复用 | 证据覆盖充分的 follow-up 保持零报价调用 | 评测适配器在每个可回答 follow-up 强制重新执行同一冻结报价检索 | BuyWhere 物理调用、每 task 外调次数及调用降幅 | 候选、答案和事实指标至少与当前方案等价 |
| Policy-Enforced Host | Schema、source grounding、Intent Compiler、Policy 与 Claim 校验 | 仅执行 JSON Schema 校验的非落盘影子判定器 | 30 项对抗提案的危险接受数和拦截率变化 | 基线不得调用真实 Provider、不得写入正式 Conversation 状态 |

两组方案必须使用相同的 task/trial、模型 ID、参数、Prompt、Replay Fixture、运行窗口与评分器，每个 task 保持相同重复次数和随机化规则。模型 usage 缺失的 trial 不得用 JSON 字符数估算替代正式 Token 指标；系统性模型供应商故障按预登记有效性规则处理。报告同时给出基线与当前方案的绝对分子、分母和差值，不只给百分比。

## 五、Runtime 故障注入

### 5.1 规模

覆盖八类故障组，每组运行 10 次，共 80 个 fault trial：

1. Provider 请求已被独立 stub 接收、响应返回前进程退出；
2. Provider 返回后、成功结果持久化前进程退出；
3. Provider 结果与 step ledger 已持久化后、Turn 最终提交前退出；
4. lease 过期并由新 attempt 接管，旧 attempt 分别尝试完成 step 与最终提交；
5. final transaction：5 次后置校验或数据库异常，5 次数据库 commit 成功但 Worker 丢失确认；
6. 重复 accept、retry 与幂等键，按预登记 fault point 分配 10 次；
7. supersede、revision conflict 与并发 Worker，按 4/3/3 次分配；
8. outbox 发布：3 次持续失败至 dead letter，3 次失败后成功，4 次 sink 成功后、`published_at` 写入前退出。

使用隔离 PostgreSQL 数据库和独立进程的可计数 Provider stub；调用日志持久化到独立存储，并通过 barrier/ack 精确控制请求已接收、响应已发送、Worker 已收到和 step ledger 已提交，不能依赖 sleep 猜测崩溃窗口。每个 trial 重置数据，并记录调用发生、返回、落库和提交时间点。

每次注入后必须重启 Worker 并运行到 task 预期终态或明确的不可恢复终态，再进行判分；不能以“一直没有提交”冒充恢复正确。

在运行前生成包含 80 行的参数化 fault manifest，每行记录：

```text
fault_id
fault_group
crashpoint_or_barrier
precondition
logical_turn_id
attempt_sequence
invalid_actor_id
invalid_actor_commit_attempted
invalid_actor_commit_succeeded
expected_recovery_action
expected_terminal_state
eligible_metrics
repeat_index
scheduling_seed
```

“已持久化步骤复用”只统计同一逻辑 Turn 的 lease-recovery attempt；`retryTurn` 创建新 Turn，不计入该指标。Provider 正常 retry、新 research wave 和进程崩溃造成的同一 step key 重复物理调用必须分开记录。

### 5.2 指标

| 指标 | 公式 | 建议门槛 |
| --- | --- | ---: |
| 故障恢复一致性率 | 达到预登记终态且状态、正式回复、事件记录及全部适用副作用检查均通过的 fault trial / 80 | 80/80 |
| 过期或冲突 attempt 误提交 | 成功提交状态的 stale/expired trial / 第 4 组 10 次 + 第 7 组 supersede/revision conflict 7 次 | 0/17 |
| 并发重复 claim | 第 7 组并发 Worker 用例中同一 fence 被多个 Worker 成功 claim 的 trial / 3 | 0/3 |
| 状态重复提交 | 一个逻辑 Turn 产生多个正式 revision 的 trial / manifest 预登记 `duplicate_state_commit` eligible trial | 0/N_state；N_state 在运行前冻结 |
| 回复重复提交 | 一个逻辑 Turn 产生多个正式 AssistantMessage 的 trial / manifest 预登记 `duplicate_reply_commit` eligible trial | 0/N_reply；N_reply 在运行前冻结 |
| 已持久化成功步骤重复执行 | 第 3 组中已存在成功 step ledger 仍再次执行工具的 trial / 10 | 0/10 |
| 事务残留 | 失败事务留下部分 Goal、WorkingSet、Message 或 outbox 的 trial / 第 5 组的事务失败 trial | 0/5 |
| Provider 重复调用 | `Σ max(actual_calls_per_step - 1, 0)`，并报告发生重复的 trial/适用 fault trial | 按八组分别报告，不设合并门槛 |
| outbox 终态正确率 | 达到成功或预期 dead letter 状态的 outbox trial / outbox trial | 100% |

“Provider 返回后、落库前退出”可能重复调用外部 Provider，这是系统已知边界。outbox sink 成功但确认写入前退出也可能导致外部重复投递，属于 at-least-once 边界。两者必须单列，不能通过状态原子性推导 Provider 或外部 sink exactly-once。

每个 fault point 只进入 manifest 预登记的适用分母：期望不提交的用例不进入重复提交率，期望 dead letter、最终 published 或成功 commit 的用例分别统计。过期/冲突指标只计算 `invalid_actor_commit_attempted=true` 的 17 个用例，并直接判断 `invalid_actor_commit_succeeded`；3 个纯并发 claim 用例单列重复 claim 指标。

## 六、人工复核

- `independent_listing_gold`、期望候选资格、结果层级和原始 JSON path/value 由两名审核者独立标注，分歧由第三人裁决，并记录 label schema 与版本；
- 全部失败 trial 必须复核；
- 在查看结果前登记随机种子和抽样算法，从成功样本中抽取 `ceil(success_trials × 20%)`；
- 涉及自然语言披露、比较解释和未知事实表达的样本至少双人复核；
- 分歧由第三人裁决并记录最终标签；
- reviewer 不得看到当前简历目标数字，避免目标泄漏影响判分。

人工复核只判断 Gold 规则无法稳定自动判定的内容，不覆盖确定性数据库和调用计数。全部 117 个 trial 中每个 Turn 的终态 AssistantMessage及其用户可见模型输出都必须完成事实标注；其他凡影响 trial 通过与否的人类语义标签，也必须覆盖所有 eligible trial。20% 成功抽查只用于审计完全自动判分的样本，不能替未审核 trial 填人工标签。若人工发现评分器系统性错误，应修复评分器并重算全部 117 trial，不能逐条手工改写确定性得分。最终任务结果以完成所需人工复核和分歧裁决后的标签为准。

## 七、简历主张映射

| 目标版 bullet | 回填指标 | 必须达到的证据层级 |
| --- | --- | --- |
| 多轮需求与稳定指代 | 多轮约束状态准确率、候选指代准确率 | 真实模型 117 trial + 人工标注 |
| 规划校验与工具执行 | 必需操作执行覆盖率、协议对抗场景安全处置率 | 真实模型 Gold + 30 项脚本对抗集 |
| 候选准入与事实校验 | 推荐候选准入精确率、可验证商品事实证据一致率；正向产出和 `N_fact` 门禁为前置条件 | 真实模型 Gold + 独立 listing Gold + Claim–Evidence 检查 |
| 持久执行与故障恢复 | 故障恢复一致性率；已持久化成功步骤重复执行只作为诊断明细 | 80 个 fault trial |
| 多轮任务与稳定评测 | 端到端任务成功率、三次稳定通过率 | 完整 Gold 报告 |

## 八、实现顺序与验收产物

1. 建立产品 invariant/capability → family → task 覆盖矩阵；
2. 把现有 `gold-evaluator` 从 conversation/turn 聚合升级为 task/trial schema，删除旧 100 conversation、50 个三轮会话和预计算布尔字段门槛；
3. 建立版本化 Provider replay fixture、独立 listing Gold 和 39 个 sealed task；
4. 实现逐 Turn 环境动作、Provider 分类型预算、operation predicate、Goal comparator、referent、answer slot、outcome 和 Claim–Evidence 评分；
5. 为 evaluator 增加 mutation/negative-control 测试，并实现 30 项脚本对抗协议集；
6. 同步更新 acceptance CLI、evaluator tests、required family registry 和阶段验收文档；
7. 固定 `model id + 参数 + prompt/build hash + 运行窗口`，运行 117 个真实模型 trial，完成全部最终消息事实标注和所需人工复核并生成失败报告；
8. 实现 80 行 fault manifest、独立可计数 Provider stub 和八类故障注入；
9. 输出机器可读 JSON、Markdown 汇总、原始轨迹、版本清单和复现命令；
10. 只有审核通过的指标才能回填 `resume-interec-agent-target.md`。

每个简历数字必须能定位到：定义、分子、分母、模型/代码/数据版本、运行时间、判分方式、失败样本和复现入口。

## 九、实现与验收状态（2026-08-28）

本节记录工程实现进度，不改变前文正式口径，也不把开发集或在线冒烟结果换算成简历指标。

### 9.1 已实现

- Gold 预登记蓝图：以资深跨市场购物推荐产品负责人视角冻结 13 类各 3 项的 39-task 业务覆盖，严格区分作者蓝图与独立 sealed Gold；校验每类数量、同类变化轴、产品能力/不变量、正负样本、关键切片和最低事实分母，并用语义哈希锁检测静默漂移。
- 新任务评测器：严格解析 manifest、task 和 trial artifact，按 3-run task 统计端到端成功、稳定性、约束状态、候选指代、必需操作、必需回答、正向产出、候选准入和事实—证据一致性；拒绝混合版本、缺失/重复 trial、未标注用户可见事实和自报成功字段。
- 冻结回放端口：Product Search 与 FX 必须精确匹配 query、market、limit 和调用预算；未登记调用、超预算、请求漂移及 fixture Schema 漂移均失败关闭。
- 漂移门禁：比较同模型、参数、Prompt、Evaluator、Fixture 下的指标分母、绝对回退、family 稳定性和安全违规；版本或数据不兼容时标记为不可比较，而不是误报回归。
- 协议对抗集：六类各 5 项，共 30 项，覆盖阶段外工具、重复提交、越界消息 ordinal、无原文 Goal、连续无工具回复和无效 Claim 引用。
- Runtime 故障评测：可生成八组各 10 行的开发 fault manifest；严格接收 `ISOLATED_POSTGRES_PROCESS` 观察文件，统计恢复一致性、过期 attempt 提交、并发重复 claim、状态/回复重复提交、成功步骤重复执行、事务残留、outbox 交付和 Provider 重复调用。评分器拒绝用内存模拟冒充正式观察。
- 在线服务漂移：对 DeepSeek 与 BuyWhere 分别记录脱敏契约指纹、模型身份、精确探针回复、结果非空、延迟和错误；支持当前样本与已保存基线比较，不持久化 Key 或商品正文。
- PostgreSQL 集成入口：`npm run test:integration` 会加载 `.env` 并强制执行数据库用例，不再默认跳过后返回成功。

主要命令：

```text
npm run acceptance:evaluation:plan
npm run acceptance:tasks
npm run acceptance:drift
npm run acceptance:protocol
npm run acceptance:fault:manifest
npm run acceptance:fault
npm run acceptance:live:drift
npm run test:integration
npm run acceptance
```

### 9.2 本轮证据

- Gold 作者蓝图：39 个 task、13 类各 3 项通过校验；32 个正向任务，最低计划事实分母 201，另含 3 个无合格报价、3 个 Discovery、2 个部分成功和 1 个全 Provider 不可用任务。该结果只证明业务覆盖与组卷约束完整，不是 sealed Gold 成绩。
- 开发任务夹具：2 task × 3 run，共 6/6 通过；仅证明评分链路和 mutation 负控有效，不属于 39 task 正式 Gold。
- 协议对抗：30/30 进入预登记的受控降级，未发布越权回复；该结果来自 Faux 模型驱动的真实协议代码路径。
- 自动化回归（2026-08-29）：单元测试 32 个文件、202 项通过，23 项按配置跳过；PostgreSQL/API 集成 23/23 通过；类型检查和全工作区构建通过。
- 在线依赖：第一次漂移运行中 BuyWhere 2 次网络失败，而 DeepSeek 2/2 成功；随后原有探针恢复，后续基线与当前各 2 次均通过，4/4 样本的 BuyWhere 与 DeepSeek 契约指纹一致。结论为“恢复后未检测到契约漂移”，同时保留首次瞬时网络故障，不能写成持续可用性 100%。
- 真实两轮手机会话：API、PostgreSQL、DeepSeek、BuyWhere 和证据持久化链路均完成；第二轮收窄市场后仍保留 `iPhone 16 Pro 256GB` 目标，Turn 均为 `COMPLETED/RECOMMENDATION`。该结果是在线端到端 smoke，不替代 Gold 人审。

脱敏运行报告保存在被 Git 忽略的 `.artifacts/evaluation/` 与 `.artifacts/live/`，便于本机复核，但不能作为独立审核者控制的封存证据。

### 9.3 尚未完成且禁止提前回填

- 39 项业务蓝图已经冻结，但具体话术、Replay 报价与独立 Gold 尚未由独立审核者组卷密封，117 个真实模型 trial 也尚未运行；作者蓝图不得更名为 sealed Gold，因此不得回填端到端成功率、三次稳定率等正式简历数字。
- 80 行 fault manifest 和评分器已经落地，但尚未由隔离 PostgreSQL、独立 Worker 进程及 barrier/ack runner 生成 80 条正式观察；现有 23 项集成测试只能证明关键仓储边界，不得表述为“故障恢复 80/80”。
- Listing Gold、Source Fact Gold 和终态文本的独立全量标注尚未完成，因此开发夹具中的推荐精确率和事实一致率不得进入简历正文。
