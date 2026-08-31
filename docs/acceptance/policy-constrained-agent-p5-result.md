# P5 验收：真实依赖、浏览器闭环与最终切换

- 日期：2026-08-31
- 阶段：`P5_LIVE_ACCEPTANCE_AND_CUTOVER`
- 结论：通过

## 浏览器闭环

在 `http://127.0.0.1:5173` 的真实页面完成：

1. 页面自动使用开发身份连接，显示“已连接”，不要求用户填写身份令牌。
2. 输入“想买头戴式耳机，预算 3000 元以内”。
3. 系统展示结构化购买市场澄清：美国、新加坡、两边都比较、暂时跳过，并说明市场是检索/交易上下文而非商品偏好。
4. 点击“两边都比较”后，市场持久化为 `SG / US`，澄清状态清除并自动继续搜索。
5. 页面发布证据安全的搜索结果、强制披露和 4 个可比较候选。
6. 耳机放大器、CD 播放器、分线器、耳塞和骨传导开放耳结果均未进入最终 WorkingSet。

浏览器验收中还发现并修复了前端契约漂移：后端字段为 `groundedClaims`，前端仍读取旧名 `claimLedger`，导致 CLAIM 块显示为空段落。字段对齐后，价格、商家、市场、成色、排序依据和候选证据入口均正常渲染。

## 真实模型与 Buywhere

- 实时会话：`319774c6-0575-4695-8760-9cf349e7c95a`。
- Buywhere 返回 US/SG 原始 artifacts；SG 部分结果只有宽泛 `electronics` 分类。
- `deepseek-v4-flash` 批量输出 ESCI 语义信号，模型 ID、置信度和证据写入 `offer_qualifications.relevance_json`。
- Fosi K7 耳机放大器：`IRRELEVANT / INELIGIBLE / esci-admission-v2`。
- 正常耳机：`EXACT / MAIN_RECOMMENDATION`；可进入 WorkingSet 的结果仍需继续通过市场、价格、预算和身份校验。
- 后续浏览器会话命中受有效期管理的本地候选缓存，页面明确披露缓存复用；缓存中的原始 provider evidence 仍重新经过 ESCI v2 裁决。

## 运行与配置修复

- 修正前端启动脚本：`VITE_API_BASE_URL` 设为空，使用 Vite `/api` 代理，避免客户端重复拼接 `/api/v1/api/...` 和跨域失败。
- 重新生成有效的 12 小时本地开发 JWT；页面不再展示令牌输入。
- Worker 重启后加载 ESCI v2 和批量语义分类器。
- 浏览器控制插件存在旧缓存版本引用；补齐其精确运行文件后恢复同一标签页控制。该操作不修改项目业务代码。

## 最终回归

- `npm run acceptance`：通过。
- 产品契约：12 invariants、13 multi-turn trajectories、12 zero-provider turns。
- 澄清目标：P0→P3，7 invariants。
- 策略约束路线：P0→P5，13 invariants。
- P2：23 个 ESCI 用例，5 个品类。
- Vitest：43 files passed、2 skipped；292 tests passed、26 skipped。
- 全部 domain / agent / runtime / api / frontend 构建成功。
- `npm run test:integration`：2 files、26 tests 全部通过。

## 最终目标漂移审计

| 审计项 | 结论 |
| --- | --- |
| 是否仍按 P0→P5 固定顺序推进 | 是 |
| 是否削弱 pi-agent 为规则 planner | 否；pi-agent 仍生成自然语言业务计划 |
| 策略是否静默增删语义操作 | 否；只审批、返回有界修复或执行确定性准入 |
| 是否增加商品/句式 badcase | 否；采用独立证据门槛、具体目标语义和批量 ESCI 裁决 |
| 模型是否直接控制准入或排序 | 否；模型只提供受校验的语义证据 |
| Provider/模型失败是否归咎用户 | 否；缺失证据 fail closed，并使用系统所有的降级披露 |
| 浏览器身份、澄清、续接、候选和证据渲染是否验收 | 是 |

固定目标已经完整实现、测试并验收，没有遗留阶段工作。
