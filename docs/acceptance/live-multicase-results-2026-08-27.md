# 真实模型与 BuyWhere 多用例联调阶段结果（2026-08-27）

## 第四阶段更新：余额恢复后的真实 A/B 轨迹与根因修复

- 余额恢复后继续使用 `deepseek/deepseek-v4-flash`，BuyWhere 仍只访问 US/SG；所有自然语言 Turn、模型计划、Provider permit、artifact、qualification、claim/evidence 和最终回复均写入本地 PostgreSQL 验收租户。
- 耳机验收使用 `live-acceptance-v8/browser-acceptance`，Conversation `1f1b7b93-0e19-4f48-ba44-ad7ba0113bc9`。A1–A4 连续完成“澄清 → US/SG 研究 → 第二项/第一项证据比较 → 预算 3000 + 仅 SG + 排除原第二项”，仅 A2 产生 2 次 BuyWhere market permit；A3/A4 为零外调。A5 首次因两套确定性 disclosure 渲染不一致降级，修复后同会话重试成功，明确输出“保修信息：暂无可验证证据”。
- 手机验收使用 `live-acceptance-v10/browser-acceptance`，Conversation `b6719779-5536-4b88-915f-c08783c4e84c`。Host 将模型遗漏的容量补全为 `IPHONE 16 PRO 256GB + NEW`，B1 使用 4 次 BuyWhere market permit（两个 query wave × US/SG），但真实数据没有同时证明型号、256GB、全新和对应价格的可比条目，因此安全返回 `NO_MATCH`。qualification 为：3 条 `CONDITION_MISMATCH`、4 条 `OVER_BUDGET`、3 条 `PRODUCT_IDENTITY_CONFLICT`、2 条 `PRODUCT_IDENTITY_UNRESOLVED`；没有手机壳、128GB、Pro Max、翻新或 condition unknown 条目晋级。
- 因 B1 的严格结果为空，原计划中的 B2“比较第一/第二项”在现实数据上不存在合法 referent。系统不再降级或伪造候选，而是返回明确指代澄清；B3“只看美国”仅做本地 Goal/WorkingSet 投影，零 BuyWhere。

### 本阶段修复的架构根因

1. Goal provenance 从“只校验消息 ordinal”升级为“校验当前用户原文支持”：预算数字、币种、市场、型号和 condition 不能由模型编造；“元”确定性归一为 CNY，未明确新旧时 condition 归一为 `ANY`。
2. 手机产品身份加入容量维度；`iPhone 16 Pro 256GB` 不再退化为 `IPHONE 16 PRO`。手机壳/保护套优先识别为 `ACCESSORY`，明确 `NEW` 时 condition unknown fail closed。
3. Host 会用 catalog contract 从原文补全模型遗漏的精确型号，并删除已经编码进型号的冗余 `storage_capacity` constraint，避免 unsupported hard constraint 把全部结果错误降级为证据不足。
4. 首次 Goal 已具备 category、budget、market 时，Host 会移除非阻塞的多余澄清并补全 research；Goal 仅缩小预算/市场且现有 proof pool 足够时，Host 会剔除模型误加的 research，保证零 Provider 路径。
5. display rank 在 Turn 观察快照上稳定绑定；“不要第二个”只允许拒绝原第二项，模型额外生成的拒绝操作会被 Host 丢弃。空 WorkingSet 上的第一/第二项比较改为明确澄清，不再通用降级。
6. `RANKING_REASON` 现在是带 source-fact/evidence chain 的正式 claim；`WARRANTY_UNKNOWN` 和价格边界由 Host 自动披露。TRANSITION 继续只接受 Host-owned code，模型不能写入因果或价格事实。
7. Goal 变更后 WorkingSet 由 Host 确定性重投影；referent 澄清在新的 Goal 指令到来时自动清除；已拒绝 offer 会进入后续研究的排除集合。

### 最终门禁与运行状态

- `npm run acceptance`：product / architecture / workflow / observability / typecheck / unit / build 全部通过；19 files passed、137 tests passed，2 个显式 integration 文件在普通套件中按设计跳过。
- `RUN_CONVERSATION_PG_INTEGRATION=1 npm run test:integration`：2 files、23 tests 全部通过。
- API `/health/live=ok`、`/health/ready=ready`；frontend `http://127.0.0.1:5173/` 返回 200；worker 已使用本阶段最终代码重启。

## 第三阶段更新：对话语义、报价归一化与重启复验

- 澄清问题不再允许模型提交自由 wording。pi-agent 只提交一个稳定的语义 `slotId`，确定性 Host 负责生成单槽问题并持久化，避免一问多槽和模型措辞漂移。
- WorkingSet 继续以 `offerRef` 为可指代对象，但 proof kernel 升级为 `proof-carrying-v2`：同一商品身份、同一检索市场、同一规范化商家域名只晋级一个代表报价，按“市场证据、库存证据、同层价格、观察时间、稳定 ID”的顺序确定代表项。
- 真实历史数据重放覆盖 56 条跨轮 listing 观察。原来重复出现的 Harvey Norman Bose QuietComfort 419/449 SGD 报价现只保留 419 SGD；全部结果最终收敛为 7 个不同 merchant-product 报价，外部调用为 0。
- 排名依据进入 CandidateProjection、当前轮 research receipt 和前端候选卡。页面明确披露“市场证据 → 库存证据 → 同层价格”，并说明它不是产品质量、口碑或综合体验排名。
- Host 会剔除模型自由文本中的“最佳、首选、最值得、best value”等无证据排序断言，协议校验层也会拒绝漏网断言。
- 全量验收通过：19 个测试文件、124 个测试；显式开启 PostgreSQL/API 门禁后，2 个集成文件、23 个测试通过；所有 workspace 和前端生产构建通过。
- API、worker、frontend 已用最新代码重启。`/health/live` 为 `ok`、`/health/ready` 为 `ready`、前端返回 200。
- 浏览器新建 `live-acceptance-v3/browser-acceptance` Conversation `8a104756-ab60-4416-87cc-2881691da9c4`，首页创建、Turn 入队、worker 接管、SSE 进度和回复发布均成功，未复现 `NOT_FOUND`。
- 该新 Turn 的真实 DeepSeek 调用仍返回 `402 Insufficient Balance`；完整 provider 诊断已持久化到 `turn_attempts.draft_json.fallbackReasonCode`。因此当前只能发布安全降级回复，不能伪造对话式推荐成功。

## 第二阶段更新：不限调用后的真实多轮与架构修复

> 本节是当前结论；下方“调用范围与硬上限”保留第一阶段历史，不再代表当前授权。

- 第二阶段验收 tenant/owner：`live-acceptance-v2/browser-acceptance`。
- 主要耳机 Conversation：`cff45275-9bb3-439d-8e13-79a7ce7e7977`，当前 `revision=13`，13 个 Turn 全部进入持久终态。
- 该 Conversation 共执行 8 次 BuyWhere 市场请求（US 4、SG 4），全部成功；落库 8 个 artifact，累计 56 条 listing 观测；FX 8 次成功。
- 首轮 `想买一款通勤用的降噪耳机` 已真实证明：pi-agent 写入 canonical `headphones`、`noise_cancelling=true` 硬约束和通勤偏好，只追问缺口，BuyWhere 为 0。
- 第二轮 `预算 2500 元，比较美国和新加坡` 已真实证明 Goal/市场原子提交、US/SG 约束检索和 NO_MATCH 披露；检索词从泛化 `headphones` 修为 `headphones active noise cancelling` 后，真实返回集中到 ANC 商品。
- 修复后的真实捕获数据离线重判：14 条去重 listing 中 8 条可比较，US/SG 均有候选；外部调用为 0。浏览器已实际展示 8 张候选卡并保持稳定指代顺序。

### 第二阶段暴露并修复的架构根因

1. `addressedOpIds` 原由模型手抄，已执行的 research 会因漏抄被误判未处理。现在由 Host 从有效 TurnPlan 派生，模型只提交叙事提案。
2. 硬约束原只做后置过滤。CategoryContract 现在同时定义 proof signals 与 query terms，Goal 约束确定性编译进每个 Provider query。
3. 模型可自由发明 category ID。Goal 边界现在通过版本化 catalog contract 规范化；未知类别 fail closed，数据库只保存 canonical ID。
4. 模型遗漏研究操作时，Goal 虽已具备类别、预算和市场却没有候选。ConversationPolicy 现在会把首次 research-ready 且 WorkingSet 为空的计划补全为可审计的 `host-required-research`。
5. 自由文本中的事实化 TRANSITION 会毁掉已完成研究。Host 现在删除未验证事实化过渡语、自动附加必需披露，并从 WorkingSet 确定 NO_MATCH；外部事实仍只能通过 Claim 发布。
6. Amazon 父类目 `Headphones, Earbuds & Accessories` 会把主商品误判为配件。身份解析改为标题主商品信号优先、标题配件关系优先于父类目；类别级目标不再要求数字型号，且不再把多模型候选错误压成单一 comparison key。
7. 空 WorkingSet 曾被当作充分覆盖；现在缺失或空池为 `INSUFFICIENT_COVERAGE`，Goal 绑定版本不一致为 `STALE`。
8. 刷新原因原为任意字符串、Host 却要求精确常量。pi-agent tool schema 现使用受控 research reason enum，Host 成为唯一 Provider 授权权威。
9. 降级 Assistant 被过滤但其 User 消息仍污染 recent context。现在只投影最后一组成功的 User→Assistant 邻接对，失败轨迹仅留在审计历史。
10. SourceFact 刷新曾报 immutable evidence 时间不一致。根因是 Node 对 PostgreSQL `Date` 先 `String()` 导致毫秒丢失；现在统一直接 `toISOString()`，带毫秒的完整 PostgreSQL proof-chain 集成测试通过。
11. 模型无工具输出过去只记录 `PI_AGENT_INCOMPLETE`。现在 attempt 会持久化 stopReason、Provider error 和受限内容诊断，并允许同一 fresh pi-agent 会话做一次协议修复推理。

### 当前外部阻塞

`deepseek/deepseek-v4-flash` 当前真实入口已返回 `402 Insufficient Balance`。余额耗尽后的 Turn 没有模型工具调用，因此无法继续证明“第二个为什么更贵”、约束修改、保修未知以及 smartphone 三轮轨迹。项目只配置了这一组模型凭据；没有在未获授权的其他模型上偷换验收。BuyWhere 本身仍正常，已执行请求均成功。

### 当前回归证据

- 全量质量门：product / architecture / workflow / observability / typecheck / unit / build 全部通过。
- 单元：19 files、122 tests passed；另 2 个 integration 文件在普通 `npm test` 中按设计跳过。
- 显式 PostgreSQL/API 集成：2 files、23 tests passed。
- 带毫秒 SourceFact 的 Research→Claim→原子发布集成：passed。
- worker 已用最新代码重启；API、frontend、worker 当前均在运行。

## 调用范围与硬上限

- 模型：`deepseek/deepseek-v4-flash`。
- BuyWhere：仅 US/SG。
- 已执行自然语言 Turn：5 / 8。
- 已执行 BuyWhere 市场请求：4 / 4，已达到授权上限；之后 worker 已停止，防止误触发额外检索。
- 验收 tenant/owner：`live-acceptance/browser-acceptance`。
- Conversation：`7adcf56d-6dc4-44a6-a93b-20178c8db5ca`。

## 浏览器证据

- Codex 内置 Browser 已连接并实际操作 `http://127.0.0.1:5173/`。
- 首次点击“开始对话”复现 `HTTP_404`；根因是 `frontend/.env` 仍配置旧前缀 `/api/v1`，新客户端又追加 `/api/conversations`。
- 清除旧前缀并换发短期本地验收 JWT 后，Conversation 创建、Turn 入队、SSE 进度和刷新恢复均通过。
- 390×844 移动视口下，消息、Goal 条件、输入框、快捷建议和候选区可访问。
- 刷新后 Conversation `revision=5`、消息、预算和 US/SG 市场恢复。
- 修复了披露码和 `assistant.message.committed` 直接暴露内部英文枚举的问题。

## 真实 Turn 账本

| # | Turn ID | 输入 | 结果 | BuyWhere |
|---|---|---|---|---:|
| 1 | `9ec51f76-5dba-4603-bf4f-04da7d3a44cd` | 想买一款通勤用的降噪耳机 | Goal target 成功提交，回复因工具协议不完整降级 | 0 |
| 2 | `68201200-fed8-4e89-9f63-e6e4f00e421b` | 预算 2500 元，比较美国和新加坡 | `commit_turn_plan` 参数校验失败，安全降级 | 0 |
| 3 | `2a8d87d9-bb89-4d3b-89fd-bd55467ff86c` | 同上（修复后重跑） | 预算和市场原子提交；回复因 factual TRANSITION 被拒而降级 | 0 |
| 4 | `e7404ac8-279e-47e1-9d6c-7af32ec43f78` | 同上（恢复状态修复前重跑） | 通用 `turn_rephrase` 污染后续计划，错误重复澄清 | 0 |
| 5 | `0c703eff-b395-4830-b7d6-f015a53c9141` | 同上（恢复状态修复后重跑） | pi-agent 完整提交 target/budget/markets/research；真实研究完成，回复 `NO_MATCH` | 4 |

Turn 5 的 4 次 BuyWhere 请求全部 `SUCCEEDED`：

- wave 1：SG 8 条、US 8 条；
- wave 2：SG 8 条、US 8 条；
- FX：SGD→CNY、USD→CNY 均成功；
- 落库：4 个 provider artifacts、31 个 source listings；
- 旧身份规则：10 条 `PRODUCT_IDENTITY_CONFLICT`，21 条 `PRODUCT_IDENTITY_UNRESOLVED`，0 个候选晋级。

## 联调发现与修复

1. **旧 API 前缀导致首页无反应**：`frontend/.env` 与 `.env.example` 改为同源代理根路径。
2. **pi-agent 澄清协议不明确**：系统提示明确 `REQUEST_CLARIFICATION`、Goal/World 操作字段边界和无 claim 时的中性过渡规则。
3. **降级原因不可诊断**：`fallbackReasonCode` 现写入 Turn attempt `draft_json`，工具校验错误保留限长详情。
4. **通用降级污染业务对话**：`turn_rephrase` 不再投影成商品缺口；新 Turn 自动清除该恢复标记；相邻上下文排除降级模板回复。
5. **类别级推荐永远无法晋级**：身份解析器现在允许“类别匹配＋主商品＋标题提供稳定型号”的 listing 解析为 `RESOLVED`，具体型号请求仍严格匹配，配件/错品类继续 fail closed。
6. **UI 暴露内部枚举**：补齐 provider/FX/库存/成色/未验证结果披露文案与回复发布事件文案。
7. **hard constraint 未进入 proof kernel**：CategoryContract 新增属性证明规则；耳机 `noise_cancelling=true` 必须由 ANC/降噪信号证明，`open-back` 明确冲突，缺证据保持 `INSUFFICIENT_EVIDENCE`；pi-agent 协议要求显式需求写入 Goal constraint、软使用场景写入 preference。

## 真实捕获数据的零外调重判

使用修复后的身份解析器，对上述 31 条真实 BuyWhere listing 和已落库 FX 快照做只读重判：

- 外部调用：0；
- 可比较 qualification：3；
- comparison ranked offers：1；
- 第一名：`Beyerdynamic DT 990 PRO X Open-Back Headphones`，SG，约 CNY 1546.02；
- 仍 fail closed：10 条身份冲突、16 条身份不足、2 条超预算。

该结果证明类别级 identity 修复能从真实捕获数据产生候选，但它不是新的线上 Turn，不能替代浏览器端重新研究验收。此外，原 Turn 的持久 Goal 没有保存“通勤/降噪”，所以重判仍按旧 Goal 产生 open-back 候选；新 proof kernel 会在 Goal 含 `noise_cancelling=true` 时拒绝该候选，但 pi-agent 是否在真实模型下稳定写入该 constraint 仍需新 Conversation 验证。

## 回归结果

- unit：16 files / 108 tests passed；
- PostgreSQL/API integration：2 files / 23 tests passed；
- build：domain/agent/runtime/api/frontend passed；
- architecture/product/workflow checks passed；
- Browser：404 修复、真实 Turn/SSE、移动布局、刷新恢复、披露文案通过。

## 尚未证明

- 修复后从全新 Conversation 完成“澄清 → 研究 → 候选 → 指代比较 → 约束修改 → 解释/未知保修”的完整耳机轨迹；
- smartphone contract 的真实 iPhone US/SG 用例；
- 浏览器候选卡、对比、详情、focus、引用链；
- “通勤/降噪”等类别属性在真实模型下从 pi-agent Goal 操作进入已实现的 proof-kernel 属性证明规则；
- 修复后首波有足够 coverage 时，BuyWhere 是否只调用 US/SG 各一次。

这些项目不能在当前授权内继续：BuyWhere 4 次上限已经耗尽，剩余 3 个模型 Turn 也不足以重跑两条完整轨迹。
