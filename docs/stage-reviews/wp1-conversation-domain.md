# WP1 阶段审视：Conversation 领域与状态内核

## 完成范围

- `ShoppingGoal` 由有序 `GoalOperation` 唯一修改，目标纠正是替换，不是追加冲突状态；
- `GoalRevision` 保存精确 parent，undo 返回实际父版本，不靠逆运算猜测；
- `TurnPlan` 使用单一有序 `ops`，限制操作预算、重复 ID、重复 research 和 undo 冲突；
- `WorkingSet` 是候选引用世界，包含 pool、display、mentioned、comparison、rejected 和 focus；
- referent binder 对 rank、focus、comparison、offer ref 和开放文本返回 `RESOLVED / AMBIGUOUS / NOT_FOUND`，禁止默认回退到 rank 1；
- `DialogueState` 通过确定性 operation 更新，并与 WorkingSet 的 focus/comparison 同步；
- `ConversationPolicy` 根据计划、投影后的 Goal 和结构化 research need 决定 route 与 Provider 调用预算；
- `ClaimVerifier` 校验 claim/offer/WorkingSet 绑定、拒绝状态、source fact、artifact path、provider schema、policy、FX snapshot 和 attempt evidence allowlist；
- `AssistantEnvelope` 将短连接语与 verified claim blocks 分离，并要求所有已执行 operation 被覆盖。

## 测试证据

- `npm run product:check`：12 条不变量、13 条多轮轨迹、12 个零 Provider 话轮通过；
- `npm run typecheck`：domain/runtime/api 严格类型检查通过；
- `npm run test:unit`：10 个文件、165 项测试全部通过；
- 性质覆盖：set-like Goal operation 幂等、操作顺序、精确 undo、拒绝集合单调性、视图操作不破坏 pool、hydrated WorkingSet 不变量、集合外引用和 attempt 外证据拒绝。

## 定位与偏移审视

本阶段实现的是对话式推荐 Agent 的确定性世界模型，不是聊天 UI，也不是把旧单轮 research workflow 包一层消息气泡：

- pi-agent 后续负责把开放语言编译为 TurnPlan、选择被宿主授权的工具并组织 AssistantEnvelope；
- 宿主领域内核拥有 Goal/WorkingSet/事实/引用/Provider policy 的最终裁决权；
- 普通对话、指代、过滤、重排和已有证据解释默认是零 Provider 路径；
- 澄清和无匹配是话轮 outcome，不会关闭 Conversation；
- 当前 V2 单轮实现仍是 rejected baseline，没有因此获得继续保留的资格。

## Bad-case 审视

没有增加“开始比较”、某个中文句式或某个型号的生产特判。原首页 `NOT_FOUND` 的本质被拆为三个可复用约束：

1. 引用必须在当前 WorkingSet 中确定绑定，失败显式变成 ambiguous/not-found；
2. 比较集合必须始终为空或保持 2–4 项，拒绝候选不能留下半比较状态或继续成为 focus；
3. Agent 输出的商品事实必须来自已绑定 offer 的 verified claim，不能由连接语或默认候选补全。

阶段审视中发现并修正了“拒绝比较项后残留单元素比较集”和“被拒绝项仍可聚焦”两个领域不变量问题；修复落在统一 reducer/validator，不是页面事件补丁。

## 阶段裁决

WP1 达到进入 WP2 的条件。WP2 必须把这些纯领域不变量放进全新 Conversation repository 的原子提交边界；在 attempt draft、lease/fence、revision 和 final commit 完成前，不得把内存态或旧 repository 描述为 durable conversation state。
