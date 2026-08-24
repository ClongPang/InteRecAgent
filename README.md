# InteRecAgent · 跨境选物台

跨平台跨境购物推荐 Agent。从用户的一段自然语言购物需求出发，聚合 BuyWhere 商品数据、统一换算成人民币、跨平台比价与证据化推荐，并把用户引导到商户页完成购买。

## 产品定位与边界

**业务闭环**：描述需求 → 形成任务 → 检索候选 → 人民币比较 → 比较取舍 → 商户跳转。

系统 **提供**：

- 自然语言需求解析（商品查询、预算、市场、排序偏好、仅看有货）
- 多市场（US / SG / VN / TH / MY）BuyWhere 商品检索
- 原币价 + 人民币估算（关联汇率来源与日期）
- 2–4 件结构化比较与证据化推荐
- 匿名开发任务 + 隔离的模拟登录 demo

系统 **不承诺**：支付、下单、代购、物流、关税、最终到手价、配送资格。运费与税费一律提示“以商户结算页确认”。

## 快速启动

前置：Python 3.12+、uv、Node.js LTS、Docker（PostgreSQL 验收需要）。

```bash
make bootstrap     # 安装前后端依赖并准备 .env（可重复执行）
make db-up         # 启动 PostgreSQL（骨架验收需要）
make migrate       # 应用数据库迁移（P2 起）
make backend-dev   # 后端 http://localhost:8000
make frontend-dev  # 前端 http://localhost:5173
```

## 模式切换

| 模式 | 配置 | 说明 |
|---|---|---|
| Fixture（默认） | `INTEREC_DATA_SOURCE=fixture` | 无第三方 Key、无外网即可跑通闭环 |
| Live | `INTEREC_DATA_SOURCE=live` | 真实 BuyWhere / Frankfurter，仅受控开发与冒烟 |

前端数据源由 `VITE_DATA_SOURCE=fixture|api` 切换；fixture 与 api 实现同一个 `MissionApi` 接口，组件不出现供应商分支。

## 测试命令

```bash
make backend-unit        # 领域/契约离线测试
make backend-integration # PostgreSQL 集成测试
make architecture        # 导入依赖方向检查
make agent-test          # Agent 状态图
make api-test            # FastAPI HTTP/SSE
make frontend-check      # 前端 TypeScript 检查与生产构建
make check               # 无 Key CI 等价门禁
make acceptance          # 最终机械验收
```

完整命令见 `make help`。

## 环境变量

见 [.env.example](.env.example)。第三方 Key 只存在于服务端环境；`.env` 不入 Git，`.env.example` 不含真实值。

## 文档

- `spec/spec-architecture-project-skeleton.md` — 骨架执行规格（权威事实源）
- `docs/project-skeleton-execution.md` — 工作包执行台账
- `docs/cross-border-shopping-agent-prd.md` — 产品需求
- `docs/technical-architecture-and-selection.md` — 技术架构与选型
- `docs/agent-architecture-walkthrough.md` — Agent 现行架构走读（入口分流、图、研究环、模型/规则对照）
- `docs/project-directory-design.md` — 目录设计
