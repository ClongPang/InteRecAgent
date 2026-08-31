# 历史检索覆盖读取能力实施与验收

本报告属于内部开发证据，`eligibleForResumeMetrics=false`，不能直接作为简历指标。

## 结论

缺失的历史检索覆盖读取能力已实现。用户追问“某市场没有结果是否代表当地无售”时，Agent 可规划 `INSPECT_RESEARCH_COVERAGE`，话轮执行器读取最近一次已提交、已发布且所属 Turn 已完成的检索轮次记录（内部实体 `ResearchWave`）。该路径不重新调用 Provider，也不把检索失败解释为市场不存在。

## 否定式设计审批

以下方案已否决：

- 将历史覆盖摘要长期塞入提示词：可能陈旧，且缺少本轮可审计回执。
- 复用 `INSPECT_WORKING_SET`：候选事实与检索执行状态不是同一领域对象。
- 让模型直接查数据库：越过话轮执行器的权限、租户隔离和发布边界。
- 生成 `RESEARCH_STATUS` 商品 Claim：`ResearchWave` 是检索执行元数据，不应伪装成 Provider 原始商品字段，否则会污染来源追踪链路。

最终采用只读检索状态操作、结构化回执和话轮执行器强制披露。覆盖结论不进入商品 GroundedClaimSet。

## 实现边界

- 领域与协议新增 `INSPECT_RESEARCH_COVERAGE`，路由保持 `talk`。
- PostgreSQL 查询只选择最新已发布候选批次对应 attempt 的最终 `ResearchWave`，并要求历史 Turn 为 `COMPLETED`。
- 查询事务设置 tenant/owner RLS 上下文，同时显式校验 conversation 归属。
- 历史记录不存在时发布 `RESEARCH_COVERAGE_UNKNOWN`。
- 存在失败市场时发布带市场集合的 `RESEARCH_COVERAGE_INCOMPLETE:*`；确定性渲染明确说明“覆盖不完整不代表当地没有销售”。
- 只读覆盖 Turn 的过渡语由话轮执行器固定为“核对前提”，不再表达“已更新状态”。
- 内部资格评分器按 Turn 检查专用操作、禁止重新研究，并检查本轮覆盖披露，避免首轮 disclosure 掩盖末轮缺失。

## 验收结果

- 相关单元/协议测试：82/82 通过。
- 全量测试：233 通过，23 个需特定环境的测试跳过。
- PostgreSQL 集成测试：23/23 通过，覆盖最新已晋升波次读取与跨 owner 隔离。
- 完整项目门禁：产品契约、架构、工作流、可观测性、类型检查、测试和构建全部通过。
- 离线评测门禁：39 个预登记评测设计任务、82 个用户 Turn、30/30 协议负向用例及故障清单均通过；开发评测各项指标无回退。
- 最终 DeepSeek 重复运行 3 次：末轮 3/3 选择专用操作，3/3 零 Provider，3/3 无末轮 fallback，3/3 发布 SG 覆盖不完整且不代表无售。
- 整体 trial 业务通过 3/3、严格协议通过 2/3；未严格通过的一次发生在首轮推荐的既有 `researched-attribute` 恢复，末轮新能力仍干净通过，因此未进行无关 badcase 缝补。

## 工件

- `.artifacts/evaluation/development-evaluation-search-coverage-built-3run.json`
- `.artifacts/evaluation/development-evaluation-search-coverage-built-3run-score.json`

## 指标回归判断

预登记评测设计（内部版本标识仍沿用 `gold-authoring-*`）的语义哈希保持 `sha256:a4bc8ac0a4c98d6e12800afd46328e303d81461058942b680b8de9b08d2aaeca`；单实现架构检查、既有产品契约、全量回归及离线任务评测均通过。当前只可得出“开发集指标未回退”，不能据此宣称不存在数据漂移、模型漂移或架构漂移。内部资格评分报告也不是正式独立评测报告，结论仅限本次开发与内部资格边界。
