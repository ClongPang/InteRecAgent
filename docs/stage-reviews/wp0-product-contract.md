# WP0 阶段审视：产品契约与架构边界

## 完成证据

- 多方审批方案：`docs/pi-agent-conversational-agent-refactor-plan.md`
- 架构决策：`docs/adr/0004-conversational-turn-runtime.md`
- 机器可验证产品契约：`spec/conversational-agent-product-contract.json`
- 校验器：`scripts/check_product_contract.mjs`

## 定位审视

本阶段没有把目标缩成聊天样式或单轮推荐。契约明确：

- Conversation/Mission 是长期购物任务；
- pi-agent 是每个自然语言话轮的计划与工具编排核心；
- Turn 终结不等于 Conversation 终结；
- 用户可澄清、指代、比较、排除、表达态度、修改条件、纠错和撤销；
- 搜索不是默认路径；
- 事实和推荐仍受确定性证据内核约束；
- 不兼容、不双写、不保留旧引擎。

## Bad-case 审视

十三条轨迹不是十三个生产特判。它们被抽象为共同机制：

- ordered TurnPlan 解决复合话轮；
- WorkingSet binder 解决指代；
- GoalOperations/revision 解决纠错与撤销；
- RouteGuard 解决无必要检索；
- attempt-scoped draft + atomic publish 解决打断与失败污染；
- ClaimVerifier 解决未知和无证据事实。

因此本阶段没有为单个句式、型号或 Provider 返回堆叠分支。

## 阶段裁决

WP0 可进入测试。只有 `npm run product:check` 通过且后续实现持续满足该契约，才能进入 WP1；当前单轮 V2 仍是 rejected baseline，不得被描述为完成态。
