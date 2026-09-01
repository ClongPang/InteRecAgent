# 报价线索重构阶段 3：Agent、API 与 UI 审批

日期：2026-09-01  
目标合同：`quote-leads-sg-v1`  
审批结论：`APPROVED`

## 本阶段交付

- 报价专属对话状态与 operations：建立准确型号、请求/确认型号、首次查询、明确刷新、比较、聚焦、排除、恢复和状态解释；稳定指代使用 `quoteLeadRef`，不依赖进程内存。
- 受审计划：模型只能提交 `commit_quote_plan`；宿主执行确定性 policy review，最多接受两次 proposal、每轮最多一个 Provider operation，且不允许模型生成报价事实或最终回复。
- 调用权限：型号不确定、配件/服务请求和普通追问均为零 Provider；首次已确认型号查询调用一次，只有用户明确要求刷新时才允许再次调用。刷新产生新 observation，同一“商家页 + 成色”线索的会话排除继续生效。
- 宿主回复渲染：只读取已验证的公开 QuoteLeadSet 和 operation receipt；分别表达正常报价、正常空结果、全部拒绝和 Provider 退化，不把任何一种状态改写成市场缺货或全局结论。
- 安全公共投影：用户结构只包含型号、原币价格、可选带时间的 CNY 估算、成色、商家域名、记录数、观测时间和 HTTPS 商家页入口；不投影原始 Provider record、availability、配送或库存字段。
- 原子发布：报价证据先作为 fenced `DRAFT` 写入；只有已批准 plan、匹配的公开投影和合法 assistant publication 才能在同一事务中发布 QuoteState、conversation revision、assistant message、event 和 `PUBLISHED` QuoteLeadSet。非法公共字段导致完整回滚。
- API 与 UI：新会话显式使用 `quote-leads-sg-v1`；报价会话只接受自然语言 `MESSAGE`；页面固定为新加坡已知型号报价线索流程，以原币为主、CNY 为辅，并提供“打开商家页确认”链接及 affiliate disclosure。

## 三轮审批复核

### 第一轮：语义隔离与模型权限

通过。报价 Agent 的 prompt 明确固定 SG、无配送目的地、无推荐、无模糊纠错和无搜索 fallback。模型只提出 operation；型号来源绑定当前消息，领域 policy 校验准确型号、确认状态、operation 顺序、用户明确刷新和调用预算。宿主回复渲染从验证后状态生成，因此模型不能发明价格、商家、URL、库存、配送或排名。

### 第二轮：多轮行为与 Provider 调用

通过。单元测试覆盖精确型号的一次查询、比较/聚焦的零调用、不确定型号确认的零调用、正常空与 degraded 分流，以及“排除后明确刷新”仅一次调用且稳定线索仍被排除。普通比较只陈述原币价格、可选 FX、成色、商家域名、记录条数与时间，并明确它不是商品优劣排序。

### 第三轮：证据发布与用户界面

通过。PostgreSQL 集成测试证明发布后重启可恢复同一 QuoteLeadSet 和稳定指代；迟到或携带非法公共字段的 publication 不会产生 revision、assistant message 或 `PUBLISHED` artifact。浏览器验收证明两种原币与可选 CNY 快照正常显示，比较以自然语言消息提交并复用已有观测，商家页链接使用 `target=_blank` 和 `rel="sponsored noopener noreferrer"`，页面不存在配送、库存或“全网最低”表达。

## 可维护性复核

通过。计划审查、上下文投影、状态执行、宿主回复渲染、Provider 数据编排、repository turn session 和 PostgreSQL 原子 commit 分属独立模块。`QuoteConversationTurnExecutor` 已降至 276 行；回复渲染器为 172 行。自动门禁约束 11 个 façade 和 24 个职责模块，防止后续把事实渲染重新塞回状态执行器。

## 可复现门禁结果

- `npm run quote:contract:check`：通过；18 invariants、10 trajectories、8 个零 Provider turns、14 个 Provider turns。
- `npm run quote:drift:check`：通过；phase 3、目标 `quote-leads-sg-v1`。
- `npm run docs:check`：通过；5 个活动文档、4 个退役名称，链接有效。
- `npm run lint`：通过。
- `npm run architecture:maintainability:check`：通过；11 façades、24 responsibility modules。
- `npm run typecheck`：通过。
- `npm run test:unit`：通过；51 files、373 tests。
- `npm run test:integration`：通过；4 files、32 tests；包含完整报价纵向切片、重启恢复、原子发布和非法投影回滚。
- `npm run test:e2e`：通过；Chromium 1/1。
- `npm run build`：通过；所有 workspace 与前端生产构建成功。

## 未在本阶段冒充完成的事项

- Worker 仍保留旧 contract 分支，旧业务文件也仍存在；删除旧活动路径和切换为单一业务实现属于阶段 4。
- 本阶段的模型集成测试使用受控模型桩证明协议和执行边界；真实 BuyWhere 多用例与最终全链路审计属于阶段 5。
- 实时价格、商家可购买性和目录覆盖会变化；本阶段只保证证据、状态和表达边界，不外推为实时市场保证。
