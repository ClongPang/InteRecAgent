# InteRecAgent

基于 pi-agent、TypeScript 和 PostgreSQL 的多轮对话式购物推荐 Agent。

LLM 负责理解自然语言、生成有序 `TurnPlan` 和组织回复；确定性 Host 负责购物目标、候选世界、指代绑定、Provider 授权、商品事实、证据、金额、排序与最终原子提交。模型不能绕过 Host 直接修改状态或陈述未经验证的商品事实。

## 当前状态

仓库已经完成从旧 Python 单轮 Research Workflow 到 TypeScript Conversation Runtime 的切换：

- `Conversation` 是长期购物任务，`Turn` 是可租约、重试、取消和审计的持久执行边界。
- Goal、Dialogue、WorkingSet、Candidate Feedback、Provider Artifact、Source Fact、Claim 与 AssistantMessage 均持久化在 PostgreSQL。
- 普通对话、条件修改、市场过滤、偏好重排、比较、解释、拒绝、恢复和 undo 在现有证据充分时保持零 Provider 调用。
- API 使用服务端验证的 Bearer JWT，支持 owner 隔离、PostgreSQL RLS、SSE cursor 恢复和 durable worker。
- 前端直接消费 `ConversationProjection`，展示运行进度、Goal、候选、比较、证据级别和失败重试。
- 已删除旧 Python、Mission/Run/Decision 和旧前端实现；当前只有一条正式执行链。

当前推荐能力采用双通道，而不是为每个品类复制一套 Agent：

| 通道 | 范围 | 保证 |
| --- | --- | --- |
| `VERIFIED` | 当前增强品类：`headphones`、`smartphone` | 执行型号、主商品/配件、成色和品类资格校验，可形成已验证候选 |
| `DISCOVERY` | 其他开放品类 | 可以检索、排序、比较和接收多轮反馈；身份不足时保持 `OFFER_ONLY`，不会冒充已验证 Item |

真实 DeepSeek、BuyWhere、FX 与 PostgreSQL 验收已覆盖耳机、手机和未注册的洗衣机品类；完整结果见[对话式推荐 Agent 调研与演进建议](docs/conversational-recommendation-agent-industry-research.md)。

## 架构

```text
Conversation UI
      │ Bearer JWT / SSE
      ▼
Conversation API ───────────────► PostgreSQL authoritative state
                                         │
                                         ▼
                                durable Turn worker
                                         │ bounded snapshot
                                         ▼
                                  fresh pi-agent
                                         │
             Observe → commit_turn_plan → ordered WorldOps → publish_reply
                                         │
                                         ▼
                  deterministic Goal / WorkingSet / proof / feedback Host
                                         │
                   local candidate reuse ─┴─ governed BuyWhere / FX calls
```

关键边界：

- pi-agent 只负责开放语言理解、计划和回复结构，不拥有商品世界。
- Host 对模型提案执行原文归一化、schema 校验、policy 校验和顺序执行。
- 一轮最多获得一次逻辑研究授权；研究内部可能按检索波次和市场展开为多次物理 Provider 调用。
- WorkingSet 是跨轮可指代的候选总线；拒绝候选不会删除 proof pool。
- 失败、取消、过期或被 supersede 的 attempt draft 不会晋级正式 Conversation revision。
- 所有商品事实必须通过 Claim 引用不可变 EvidenceRef；无证据内容不会进入 AssistantMessage。

详细决策见 [ADR-0004](docs/adr/0004-conversational-turn-runtime.md)、[proof-carrying offers](docs/adr/0003-proof-carrying-offers.md) 和 [`docs/stage-reviews/`](docs/stage-reviews/)。

## 环境要求

- Node.js 22.19+
- npm 11+
- PostgreSQL 16+
- 可选：Docker Compose，用于启动本地 PostgreSQL

## 快速开始

安装依赖并创建本地配置：

```powershell
npm ci
Copy-Item .env.example .env
docker compose up -d postgres
npm run db:migrate
```

至少需要配置：

```text
INTEREC_DATABASE_URL
INTEREC_AUTH_HMAC_SECRET
INTEREC_AUTH_ISSUER
INTEREC_AUTH_AUDIENCE
INTEREC_MODEL_PROVIDER
INTEREC_MODEL_ID
INTEREC_MODEL_API_KEY
INTEREC_PROVIDER_BUYWHERE_API_KEY
```

分别启动 API、worker 和前端：

```powershell
# terminal 1
npm run dev:api

# terminal 2
npm run dev:worker

# terminal 3
npm run dev --workspace frontend
```

默认地址：

- 前端：`http://127.0.0.1:5173`
- API：`http://127.0.0.1:8081`
- Liveness：`http://127.0.0.1:8081/health/live`
- Readiness：`http://127.0.0.1:8081/health/ready`

浏览器需要一个由 `INTEREC_AUTH_HMAC_SECRET` 签名、issuer/audience 匹配且包含 `tenant_id` 与 `sub` 的短期 Bearer JWT。开发时可通过页面输入令牌或设置 `VITE_AUTH_TOKEN`；生产环境应由正式身份服务注入，不能让浏览器自行声明 tenant/owner。

## 配置原则

- `.env` 只用于本地运行，禁止提交；可提交变量模板位于 [`.env.example`](.env.example)。
- 生产 worker 应使用 `INTEREC_WORKER_DATABASE_URL` 指向独立受控数据库角色，通常需要跨 owner claim turn 的权限。
- BuyWhere、模型和 FX 都属于外部运行资源，应配置超时、租户配额、并发限制、熔断和成本监控。
- Langfuse 与 OTLP 指标是可选项；默认不采集 prompt、query、output 或工具参数原文。

完整运维说明见[运行手册](docs/conversation-runtime-operations-runbook.md)和[可观测性配置](ops/observability/README.md)。

## 验证与质量门禁

完整离线门禁会依次检查产品契约、唯一实现、工作流、可观测性、类型、测试和所有 workspace 构建：

```powershell
npm run acceptance
```

当前基线：

- 产品契约：12 项不变量、13 条多轮轨迹、12 个零 Provider turn。
- 离线测试：24 个测试文件、156 项测试通过；2 个 PostgreSQL 文件默认跳过。
- PostgreSQL 集成：2 个测试文件、23 项测试通过。
- 可观测性：24 个指标、11 个 Grafana panel、12 条 Prometheus alert。

PostgreSQL 集成测试必须使用隔离测试数据库：

```powershell
$env:RUN_CONVERSATION_PG_INTEGRATION='1'
$env:INTEREC_DATABASE_URL='postgresql://interec:interec@127.0.0.1:5432/interec_test'
npm run db:migrate
npm run test:integration
```

## 受控真实验收

真实模型和 Provider 验收会产生外部调用与费用，默认不会在 CI 运行，必须显式授权。

只探测依赖：

```powershell
$env:INTEREC_LIVE_PROBE_CONFIRM='authorized-external-probe'
npm run acceptance:live:probe
```

运行限定的多品类用例：

```powershell
$env:INTEREC_LIVE_CASE_CONFIRM='authorized-external-cases'
$env:INTEREC_LIVE_CASE='HEADPHONES' # HEADPHONES | SMARTPHONE | WASHER
$env:INTEREC_LIVE_MAX_TURNS='1'
npm run acceptance:live:cases
```

脚本只输出 conversation/turn ID、能力等级、候选计数和数据库证据计数，不输出密钥或原始 Provider payload。一次真实验收已证明：

- 耳机：4 个 `VERIFIED` 候选，后续过滤、偏好和拒绝均为零 Provider 调用。
- 手机：2 个 `VERIFIED` 候选，输出 `RECOMMENDATION`。
- 洗衣机：1 个 `DISCOVERY / OFFER_ONLY` 候选，后续通用偏好重排为零 Provider 调用。

## 商品事实边界

- 只陈述带 EvidenceRef 的价格、币种、汇率、市场、商户、库存、型号和成色。
- Provider 检索市场不等于配送资格；配送目的地是独立 Goal 字段。
- 不补写缺失的规格、评分、评论、运费、税费、保修和真伪。
- 库存只有 `IN_STOCK / OUT_OF_STOCK / UNKNOWN`，未知不会被描述为有货。
- 人民币金额是带 source fact 与 FX snapshot 的估算，不含税费、运费和支付成本。
- Discovery 中的未知身份不是事实冲突，但也不会提升为 Verified Item。

## 项目结构

```text
packages/domain/      确定性领域模型、Goal、WorkingSet、资格与排序
packages/agent/       pi-agent 上下文、工具协议、proposal schema 与 Host
packages/runtime/     PostgreSQL repository、worker、research/proof、Provider 治理
packages/api/         JWT Conversation API、projection 与 SSE
frontend/             React Conversation 工作台
packages/runtime/conversation-migrations/
                      不可变 PostgreSQL migrations
spec/                 产品、可观测性和验收机器契约
ops/                  Grafana、Prometheus 与运维配置
docs/                 ADR、阶段评审、验收记录和研究文档
scripts/              漂移检查、smoke 与显式授权的 live 工具
```

## 架构与面试说明

面向项目答辩和技术面试的完整架构说明见[项目架构定位与面试说明](docs/project-architecture-interview-guide.md)。该文档覆盖 Worker、pi-agent、Intent Compiler、Host、模型工具暴露、证据链、PostgreSQL 一致性边界及常见追问。

## 下一步资源边界

第一版不需要新增基础设施。进一步提升全品类推荐质量时，优先级是：

1. 统一商品目录以及 GTIN/MPN/品牌型号映射。
2. 商品规格、描述、评论和问答语料。
3. 在现有 PostgreSQL 中增加 `pgvector`，形成词法 + 语义 + 实时 Offer 混合召回。
4. 收集曝光、点击、接受、拒绝和购买反馈，建立离线评测。
5. 有足够真实标签后再训练 Ranker、建立长期画像与线上 A/B 平台。

不要在数据和流量证明必要之前拆分独立向量数据库、推荐模型服务或逐品类 Agent。完整分析见[对话式推荐 Agent：本质问题、业界架构与 InteRecAgent 演进建议](docs/conversational-recommendation-agent-industry-research.md)。
