# 报价线索重构阶段 4：单一实现切流与全量质量审批

日期：2026-09-01  
目标合同：`quote-leads-sg-v1`  
审批结论：`APPROVED`

## 本阶段结论

活动业务已经从双实现状态切换为唯一的“新加坡已知型号报价线索”实现。新会话固定创建 `quote-leads-sg-v1` 合同；API 只接受自然语言 `MESSAGE`；唯一 worker 只执行报价计划、BuyWhere 报价查询、证据持久化和宿主渲染。旧推荐、跨市场、配送目的地、通用商品搜索及自动搜索兜底不再具有活动源码、包导出、命令入口或编译产物。

历史数据库结构和历史会话记录没有被伪装成新合同，也没有被破坏性迁移。它们只保留为审计兼容数据：旧会话读取时返回明确的 `LEGACY_CONVERSATION_RETIRED`，worker claim SQL 按新合同过滤，因此旧会话不可继续执行或写入。这个边界避免了长期双业务实现，也避免把历史数据静默重解释为报价会话。

默认 `npm run acceptance` 现在是完整的报价专属门禁：合同与漂移、文档、lint、维护性、类型、全部单元测试、覆盖率、真实 PostgreSQL 集成、浏览器 E2E、清洁生产构建和构建产物架构复核。根构建会先校验目标并清理 5 个明确的 `dist` 目录，再从当前源码重建，防止已删除模块以旧 JavaScript 继续残留。

## 三轮审批复核

### 第一轮：运行时可达性与单一业务实现

通过。活动源码共 58 个生产文件；唯一业务 worker 只引用报价 Agent、报价数据服务和报价 repository turn session。领域包只导出当前根入口，API 输入 schema 不再接受旧结构化购物动作，前端只呈现已知型号、原币报价、可选 CNY 估算和商家页确认入口。架构门禁同时扫描活动源码中的推荐、多市场、配送目的地、通用搜索和旧客户端标记，并验证退役实现文件不存在。

清洁构建后再次扫描每个 package 的 `dist`：每个 JavaScript、声明文件及 source map 都必须能映射到一个当前源码文件。该检查证明“源码已删但旧编译文件仍可被加载”的风险已经消除。

### 第二轮：历史数据兼容、租约与失败边界

通过。PostgreSQL 生命周期测试证明：新建会话只能使用报价合同；owner 隔离、幂等请求、消息批处理、supersession、fence token 和失败终态保持有效。专门的历史行测试证明旧合同会话可被识别但不可 claim、不可作为报价会话继续写入。

供应商调用控制器测试覆盖有效 fence、过期 fence、cluster bulkhead、tenant 并发、分钟配额、日配额、单 turn 重试预算、circuit-open，以及 permit 成功、失败、重复释放和事务回滚。FX 客户端覆盖 idempotent reuse、并发等待、fence 拒绝、成功落库、落库失败、准入失败和非 Error 异常；失败不会伪造汇率或删除原币报价。

### 第三轮：事实安全、质量阈值与维护性

通过。模型必须调用唯一的 `commit_quote_plan`；一次结构化 policy 拒绝只开放一次修复窗口；模型自由回答、执行异常或取消都会走宿主确定性降级，不会发布模型生成的价格、商家、URL、库存或配送事实。上下文投影只包含经验证的公开报价摘要，具有消息、历史、线索数和 token 上限。

覆盖率补测发现并修复了一个真实金额边界缺陷：`decimal.js` 将正零视为 positive，旧判断会接受 0 元报价。实现已改为显式拒绝 `amount <= 0` 或 `rate <= 0`，并加入非法小数、非有限值、货币对不匹配、零值和负值回归测试。

维护性门禁验证 14 个报价专属职责模块的依赖方向和行数预算。覆盖率没有降级阈值，也没有排除报价领域、Agent、Provider、持久化或 API 业务代码。V8 采集仅排除可观测性生命周期模块和可执行启动入口；被排除的遥测生命周期测试仍由默认 `test:unit` 执行并通过。

## 可复现门禁结果

- `npm run quote:contract:check`：通过；18 invariants、10 trajectories、8 个零 Provider turns、14 个 Provider turns。
- `npm run quote:drift:check`：通过；phase 4、目标 `quote-leads-sg-v1`。
- `npm run docs:check`：通过；活动文档及本地链接有效。
- `npm run lint`：通过。
- `npm run architecture:maintainability:check`：通过；14 个报价专属职责模块。
- `npm run typecheck`：通过。
- `npm run test:unit`：通过；17 files、115 tests，包含遥测生命周期测试。
- `npm run test:coverage`：通过；20 files、120 tests，包含真实 PostgreSQL 用例。Statements 67.35%、Branches 57.40%、Functions 75.51%、Lines 71.85%。
- `npm run test:integration`：通过；4 files、9 tests。
- `npm run test:e2e`：通过；Chromium 1/1，覆盖精确型号报价到零 Provider 比较流程。
- `npm run build`：通过；5 个生成目录先清理后全 workspace 重建。
- `npm run architecture:active:check`：通过；58 个生产文件、一个报价 worker、退役路径及陈旧构建产物不存在。
- `npm run acceptance`：通过；上述默认门禁按顺序全部执行成功。

## 未冒充为本阶段已完成的事项

- 本阶段没有把一次真实目录结果外推为 BuyWhere 的稳定覆盖率、实时库存、最终价格或商家可购买性保证。
- 本阶段的 Provider 语义有契约测试和脱敏真实 replay，但最终真实 BuyWhere 多型号、多状态验收属于阶段 5。
- 历史数据库表和迁移仍为审计与兼容而存在；它们不是第二套活动业务实现，也不会被 worker 执行。
