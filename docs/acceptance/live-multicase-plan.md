# 真实模型与 BuyWhere 多用例联调计划

## 调用边界

- 模型：当前配置的 `deepseek/deepseek-v4-flash`。
- 商品检索：当前配置的 BuyWhere，仅允许 US/SG 市场。
- 数据：以下测试文本、模型工具调用和 BuyWhere 检索会写入本地 PostgreSQL 验收 tenant；不发送仓库文件、密钥或历史用户内容。
- 调用上限：初始的 8 个自然语言 Turn / 4 个 BuyWhere 市场请求上限已被用户在第二阶段明确取消；仍只为验收场景调用，不扫描无关队列。
- 停止条件：跨租户可见、无证据事实、错品类/配件晋级、硬约束丢失、集合外引用、Provider 调用超预算或非预期外部目标。

## 用例 A：耳机澄清、研究与零外调追问

1. `想买一款通勤用的降噪耳机`
   - 期望：澄清；零 BuyWhere 调用；Conversation 保持 OPEN。
2. `预算 2500 元，比较美国和新加坡`
   - 期望：延续同一 Conversation；研究 US/SG；只晋级 proof-qualified 耳机本体。
3. `第二个为什么更贵？`
   - 期望：绑定当前 WorkingSet 第二项；零 BuyWhere 调用；事实均有 EvidenceRef。
4. `预算加到 3000，只看新加坡，而且不要第二个`
   - 期望：同轮完整执行预算、市场和排除；已有证据足够时零 BuyWhere 调用。
5. `为什么选它？保修有吗？`
   - 期望：解释有证据取舍；保修未知；零 BuyWhere 调用。

## 用例 B：手机品类 contract 与本地比较

1. `想买 iPhone 16 Pro 256GB 新机，预算 9000 元，比较美国和新加坡`
   - 期望：smartphone contract；研究 US/SG；配件、其他型号、非 NEW 条目 fail closed。
2. `第二个和第一个差在哪？`
   - 期望：引用稳定绑定；零 BuyWhere 调用。
3. `只看美国`
   - 期望：已有 pool 足够时本地 refilter；零 BuyWhere 调用。

## 每轮证据

- API Projection：Turn 终态、Conversation/state revision 一致、AssistantEnvelope、消息账本。
- PostgreSQL：TurnPlan/attempt、tool execution、ResearchWave、Provider artifact、source fact、qualification、ComparisonSet、WorkingSet、claim/evidence chain。
- 浏览器：桌面/移动布局、输入与发送、执行状态、澄清、候选、比较、详情、引用、刷新恢复。
- 偏移审视：pi-agent 是否负责开放语言计划；宿主是否继续拥有事实、证据、引用、Provider policy 与原子提交。
