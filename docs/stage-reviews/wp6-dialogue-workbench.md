# WP6 阶段审视：对话式推荐工作台

## 完成范围

- 删除旧 `frontend/src/v2/client.ts`，不保留 `/v2`、Run/Decision 或浏览器自报 tenant/owner 的兼容路径。
- 新客户端直接使用 `POST /api/conversations`、durable Turn、ConversationProjection、取消/重试和带 Bearer 鉴权的 SSE fetch stream。
- 页面围绕一个长期 Conversation 组织：对话线程、目标条件、执行进度、WorkingSet、候选聚焦、二至四项比较、候选详情、引用定位、澄清 next move、失败重试和刷新恢复。
- Projection 增加 owner-scoped `latestTurn`，使终态失败在刷新后仍可见且可重试；未建立第二套浏览器状态真相。
- 桌面双栏、移动端单栏、键盘发送、可见焦点、aria live、dialog label 和按钮语义已进入实现。

## pi-agent 定位复核

本阶段没有把产品退化成“推荐 API 加聊天壳”。自然语言消息仍进入同一个 durable Turn，由 worker 从 PostgreSQL bounded snapshot 创建 fresh pi-agent，执行 `commit_turn_plan → ordered host operations → publish_reply`。UI 只提交用户消息和确定性快捷操作，不在浏览器推理购物目标、伪造事实或替代 Agent 规划。

候选卡点击后的自然语言会携带明确的候选引用，消除“这个”在并发状态中的歧义；引用仍由宿主绑定到当前 WorkingSet，找不到时 fail closed，不默认回退第一名。

## 漂移检查

- 无旧 `/v2` endpoint、`VITE_V2_*` 或 `x-tenant-id/x-actor-id`。
- 无旧 Run/Decision 页面模型和 NOT_FOUND 自动重建补丁。
- 无前端自造报价、排名、证据或已验证状态。
- Conversation、Turn、WorkingSet 和 AssistantEnvelope 仍是唯一正式契约。

## 验证

- 全 workspace build：通过。
- 单元测试：14 files / 185 tests 通过。
- PostgreSQL/API integration：2 files / 22 tests 通过。
- 产品、架构与工作流静态门禁：通过。

WP6 已达到进入 WP7 的条件。下一阶段必须用正式 API、worker、数据库和新前端启动全栈，完成桌面/移动端浏览器验收；不得为了演示恢复 rejected 单轮服务。
