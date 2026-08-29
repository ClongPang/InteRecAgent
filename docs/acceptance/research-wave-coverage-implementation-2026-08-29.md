# ResearchWave 历史覆盖能力实施与验收

本报告属于内部开发证据，`eligibleForResumeMetrics=false`，不能直接作为简历指标。

## 结论

缺失的历史 ResearchWave 覆盖读取能力已实现。用户追问“某市场没有结果是否代表当地无售”时，Agent 可规划 `INSPECT_RESEARCH_COVERAGE`，Host 读取最近一次已提交、已晋升且所属 Turn 已完成的 ResearchWave。该路径不重新调用 Provider，也不把检索失败解释为市场不存在。

## 否定式设计审批

以下方案已否决：

- 将历史覆盖摘要长期塞入提示词：可能陈旧，且缺少本轮可审计回执。
- 复用 `INSPECT_WORKING_SET`：候选事实与检索执行状态不是同一领域对象。
- 让模型直接查数据库：越过 Host 的权限、租户隔离和发布边界。
- 生成 `RESEARCH_STATUS` 商品 Claim：ResearchWave 是执行元数据，不应伪装成 provider artifact 事实，否则会污染证明链。

最终采用只读世界操作、结构化回执和 Host 强制披露。覆盖结论不进入商品 ClaimLedger。

## 实现边界

- 领域与协议新增 `INSPECT_RESEARCH_COVERAGE`，路由保持 `talk`。
- PostgreSQL 查询只选择最新 promoted comparison attempt 的最终 ResearchWave，并要求历史 Turn 为 `COMPLETED`。
- 查询事务设置 tenant/owner RLS 上下文，同时显式校验 conversation 归属。
- 历史记录不存在时发布 `RESEARCH_COVERAGE_UNKNOWN`。
- 存在失败市场时发布带市场集合的 `RESEARCH_COVERAGE_INCOMPLETE:*`；确定性渲染明确说明“覆盖不完整不代表当地没有销售”。
- 只读覆盖 Turn 的过渡语由 Host 固定为“核对前提”，不再表达“已更新状态”。
- 内部资格评分器按 Turn 检查专用操作、禁止重新研究，并检查本轮覆盖披露，避免首轮 disclosure 掩盖末轮缺失。

## 验收结果

- 相关单元/协议测试：82/82 通过。
- 全量测试：233 通过，23 个需特定环境的测试跳过。
- PostgreSQL 集成测试：23/23 通过，覆盖最新已晋升波次读取与跨 owner 隔离。
- 完整项目门禁：产品契约、架构、工作流、可观测性、类型检查、测试和构建全部通过。
- 离线评测门禁：39 个 Gold 蓝图任务、82 个用户 Turn、30/30 协议对抗用例及故障清单均通过；开发评测各项指标无回归。
- 最终 DeepSeek 重复运行 3 次：末轮 3/3 选择专用操作，3/3 零 Provider，3/3 无末轮 fallback，3/3 发布 SG 覆盖不完整且不代表无售。
- 整体 trial 业务通过 3/3、严格协议通过 2/3；未严格通过的一次发生在首轮推荐的既有 `researched-attribute` 恢复，末轮新能力仍干净通过，因此未进行无关 badcase 缝补。

## 工件

- `.artifacts/evaluation/internal-qualification-research-coverage-built-3run.json`
- `.artifacts/evaluation/internal-qualification-research-coverage-built-3run-score.json`

## 漂移判断

Gold 蓝图语义哈希保持 `sha256:a4bc8ac0a4c98d6e12800afd46328e303d81461058942b680b8de9b08d2aaeca`；单实现架构检查、既有产品契约、全量回归及离线任务评测均通过。当前未发现功能或架构漂移。资格评分报告不是 `interec-eval-report-v1`，因此不能伪装成正式 sealed drift report；结论仅限本次开发与内部资格边界。
