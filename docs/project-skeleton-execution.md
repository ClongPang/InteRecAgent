# InteRecAgent 项目骨架执行台账

依据 [规格 §7.2](spec-architecture-project-skeleton.md)（同目录上级）维护。每个工作包只有一个状态（pending / in_progress / passed / blocked），同时最多一个 `in_progress`。`passed` 必须附直接证据。发现规格缺陷时先标记 `blocked`、修订规格记录版本，再恢复执行。

台账规则：

- 时间使用 UTC ISO 8601。
- `Commands` 记录实际执行命令，不记录计划命令。
- `Evidence` 链接 JUnit、coverage、Playwright 报告、迁移输出或可复现 API fixture。
- 用户未授权提交时，`Change/commit` 写工作树路径和 diff 摘要，不擅自提交。

## 执行台账

| Work package | State | Started at | Finished at | Change/commit | Commands | Evidence | Notes |
|---|---|---|---|---|---|---|---|
| P0-W01 | passed | 2026-08-16T13:11:00Z | 2026-08-16T13:12:00Z | 工作树无改动（仅检查） | `git status -sb` `git diff --check` `pytest -q` `npm run build` | 29 tests pass；`npm run build` 成功；diff clean | 会话开始 gitStatus 快照过时，实为已提交；无资产丢失 |
| P0-W02 | passed | 2026-08-16T13:13:00Z | 2026-08-16T13:40:00Z | 工作树：README/.gitignore/.env.example/pyproject.toml/Makefile/compose.yaml/docs ledger | `make bootstrap` ×2 `make baseline` | bootstrap 可重复执行；baseline PASS | 修正 game-recommendation 遗留；新增后续依赖组 |
| P1-W01 | passed | 2026-08-16T13:41:00Z | 2026-08-16T14:05:00Z | 工作树：domain/policies/、application/{dto,ports,services,errors}、tests/test_architecture.py、tests/test_mission_service.py、scripts/check_architecture.py | `make backend-unit backend-contract architecture` | 59+11+29 tests pass；architecture script OK | 领域迁入 policies/；打破 domain→adapters 依赖（Protocol） |
| P1-W02 | passed | 2026-08-16T14:06:00Z | 2026-08-16T15:00:00Z | 工作树：infrastructure/{product_sources,fx_sources,retry}.py、application/services/search_service.py、tests 异步化 | `make backend-unit backend-contract architecture`；ruff | 74+17+35 tests pass；ruff clean | 移除 adapters/service.py；tenacity 重试（401 不重试/429 遵守 Retry-After/5xx 受限重试）；新增超时/429/部分市场失败/无价格用例 |
| P1-W03 | passed | 2026-08-16T15:01:00Z | 2026-08-16T15:20:00Z | 工作树：bootstrap/{settings,container}.py、cli.py 改用 container、tests/test_container.py、ARC-006 测试 | `make backend-unit backend-contract architecture`；CLI fixture/live 验证 | 87 tests pass；fixture CLI 无 Key 可跑；live 缺 Key 报错不泄漏 | Settings 为唯一 env 读取点；Fixture/Live 切换仅在 container |
| P2-W01 | passed | 2026-08-16T15:21:00Z | 2026-08-16T15:50:00Z | 工作树：orm.py/database.py、alembic.ini、migrations/{env,script.mako,versions/0001}、tests/test_migrations.py、Makefile | `make migrate-test backend-integration` | migrate-test PASS；integration 3 tests pass | Docker Desktop 启动 + postgres:16；迁移 autogenerate 并与 metadata 无漂移 |
| P2-W02 | passed | 2026-08-16T15:51:00Z | 2026-08-16T16:15:00Z | 工作树：repositories.py、unit_of_work.py、tests/test_repositories.py、DTO id 默认 | `make backend-integration`；ruff | 8 integration tests pass（迁移+仓储事务）；ruff clean | 事件/版本原子性、版本冲突、回滚不留半条记录、sequence 单调递增；asyncio_mode=auto |
| P3-W01 | passed | 2026-08-16T16:16:00Z | 2026-08-16T16:45:00Z | 工作树：agent/{state,graph,runner,nodes/*}、runtime/in_process_dispatcher.py、UnitOfWork Port 扩仓储 | `make agent-test`（结构） | 2 结构测试 pass | 13 节点齐全；Agent 不 import Infrastructure（uow_factory 注入） |
| P3-W02 | passed | 2026-08-16T16:46:00Z | 2026-08-16T17:30:00Z | 工作树：node 逻辑、MissionCommandService 改 uow_factory、tests/test_agent_graph.py | `make agent-test`（integration） | 7 行为测试 + 1 全链路 pass；全量 121 tests；ruff clean | 正常/追问/无结果/FX 失败/部分市场失败/superseded；修正预算剥离正则 |
| P3-W03 | passed | 2026-08-16T17:31:00Z | 2026-08-16T18:00:00Z | 工作树：llm/unconfigured.py、图接 model_backend 缝、tests/test_model_backend.py | `make agent-test` | agent-test 14 pass；全量 128 tests；ruff clean | 无 LLM Key 完整图走确定性 fallback；结构化 schema 拒非法输入 |
| P4-W01 | passed | 2026-08-16T18:01:00Z | 2026-08-16T18:40:00Z | 工作树：api/{app,middleware,errors,dependencies,schemas,routes/health,missions}、backend/main.py、container 会话工厂 | `make api-test` | api-test 部分通过 | 统一错误契约 + trace_id + 健康检查 + 版本前缀 |
| P4-W02 | passed | 2026-08-16T18:41:00Z | 2026-08-16T19:10:00Z | 工作树：mission_service 扩展（constraints/undo/comparison/查询）、tests/test_api.py | `make api-test` | 10+ API command tests pass | 2–4 比较边界、分页、版本冲突 409、undo、跨 owner 404 |
| P4-W03 | passed | 2026-08-16T19:11:00Z | 2026-08-16T19:50:00Z | 工作树：SSE 路由、后台 dispatcher 生命周期、tests/test_sse.py、tests/test_dispatcher.py | `make api-test` | api-test 13 pass；全量 155；ruff clean | 优雅关闭 drain/interrupted、SSE 递增序号（真实 uvicorn 验证）；trace 中间件改纯 ASGI |
| P5-W01 | in_progress | 2026-08-16T19:51:00Z | | | | | 冻结 ViewModel + MissionApi 双实现 |
| P3-W01 | pending | | | | | | Agent 状态与节点契约 |
| P3-W02 | pending | | | | | | 确定性基础路径 13 节点 |
| P3-W03 | pending | | | | | | LLM 接缝（UnconfiguredModelBackend） |
| P4-W01 | pending | | | | | | API Shell + 健康检查 |
| P4-W02 | pending | | | | | | Mission Commands |
| P4-W03 | pending | | | | | | SSE Events + RunDispatcher 生命周期 |
| P5-W01 | pending | | | | | | 冻结 ViewModel + MissionApi 双实现 |
| P5-W02 | pending | | | | | | 拆分 App.tsx 模块化迁移 |
| P5-W03 | pending | | | | | | 接入任务 API |
| P6-W01 | pending | | | | | | 后端自动化测试与覆盖率 |
| P6-W02 | pending | | | | | | 前端自动化测试 |
| P6-W03 | pending | | | | | | CI 基线 |
| P7-W01 | pending | | | | | | 机械验收 |
| P7-W02 | pending | | | | | | 文档收敛 |

## 验收门禁进度

| 阶段 | 门禁命令 | 结果 |
|---|---|---|
| P0 | `make baseline` | 待执行 |
| P1 | `make backend-unit backend-contract architecture` | 待执行 |
| P2 | `make migrate-test backend-integration` | 待执行 |
| P3 | `make agent-test` | 待执行 |
| P4 | `make api-test contract-drift` | 待执行 |
| P5 | `make frontend-check` | 待执行 |
| P6 | `make check e2e` | 待执行 |
| P7 | `make acceptance` | 待执行 |
