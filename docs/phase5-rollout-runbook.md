# 单实现发布健康检查手册

本手册适用于已经全量发布的显式 V2 决策图。系统不再保留旧执行图、流量分桶或运行时回切开关；历史事件只作为不可变审计记录，不构成可执行路径。

## 1. 发布前检查

```powershell
.venv\Scripts\python.exe -m alembic upgrade head
.venv\Scripts\python.exe -m ruff check backend tests scripts
.venv\Scripts\python.exe -m mypy backend
.venv\Scripts\python.exe -m pytest -m "not live" --cov=backend --cov-fail-under=75
Set-Location frontend
npm run build
```

线上品类仍由发布契约限制：

```text
INTEREC_V2_ENABLED_ITEM_TYPES=["smartphone","headphones"]
```

`run.release_observed` 记录 `execution_path=explicit_v2`、`release_state=full`、状态、端到端延迟、资格结果、coverage、ClaimLedger 校验和 canonical candidate IDs。失败运行会阻断健康判定；`superseded`、`cancelled`、`interrupted` 仅保留为生命周期历史。

## 2. 生成健康报告

健康门槛按有效样本数判断，不要求覆盖固定自然日。日历跨度只用于诊断。

```powershell
.venv\Scripts\python.exe -m scripts.audit_rollout `
  --lookback-days 30 `
  --minimum-samples 300 `
  --minimum-latency-samples 30 `
  --max-p95-run-latency-ms 60000
```

只有当前 qualification profile、当前 enabled item types、`explicit_v2/full` 的可评估运行计入报告。旧路径、旧配置与旧策略样本会被明确计入排除数量，不参与比较。

报告在以下情况阻断：样本或品类缺失、运行失败、eligible@3 低于 0.8、研究循环越过预算或异常终止、非 ELIGIBLE 候选进入排序、AnswerPlan obligation 非法、Renderer 扩张 ClaimLedger、答案未验证、内部 source ID 泄露、排序解释与资格证据不一致、发布候选数与 canonical set 不一致，或 P95 端到端延迟超过绝对预算。

人工审核文件示例：

```json
{
  "approved": true,
  "reviewer": "reviewer-name",
  "reviewed_at": "2026-08-30T12:00:00+08:00",
  "notes": "Reviewed the current full-release evidence window."
}
```

```powershell
.venv\Scripts\python.exe -m scripts.audit_rollout `
  --minimum-samples 300 `
  --minimum-latency-samples 30 `
  --max-p95-run-latency-ms 60000 `
  --manual-audit-signoff .artifacts/phase5-signoff.json `
  --require-healthy
```

签核时间必须不早于本次有效窗口中的最新运行。

## 3. 故障处置

- 不允许通过环境变量切回旧执行图；旧实现已删除。
- 应通过标准部署系统回滚到最近一个通过验收、仍采用显式 V2 单路径的版本。
- 单品类故障可暂时从 `INTEREC_V2_ENABLED_ITEM_TYPES` 移除对应品类；该操作只缩小已批准集合。
- 空的硬约束结果必须如实返回，不能用 UNKNOWN 或不合格商品补足页面。
- qualification、ClaimVerifier、Goal version 与 CategoryContract 不得作为止血手段绕过。

## 4. 语义分类器

结构化语义分类器仍是独立的 shadow 能力，不是第二条推荐执行路径。使用 `scripts.audit_semantic_shadow` 审计 proposal、evidence span 与人工裁决；只有独立评审变更才能令其参与资格判断，环境变量不能直接晋级。
