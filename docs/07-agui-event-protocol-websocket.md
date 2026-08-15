# 07 AGUI事件协议与WebSocket实时推送

来源：https://alidocs.dingtalk.com/i/nodes/GZLxjv9VGqgwQMXxt6BgQD5986EDybno

作者：会敲代码的泡

创建时间：06-15 15:07

## AI 概览

Agent 长任务需通过 HTTP 启动后立即返回 thread_id，并借助 WebSocket 持续推送执行事件流，以实现用户可感知的实时反馈。核心在于利用 thread_id 串联前后端上下文，通过标准化事件协议（如 tool_start、task_result 等）提升调试与体验能力。

## 本章课程目标

- 理解为什么 Agent 长任务必须用 stream + WebSocket，不能用普通 HTTP 同步等待。
- 掌握 AGUI 事件协议的核心事件类型：session_created / tool_start / assistant_call / task_result / error。
- 看清 thread_id 在前端连接、后台任务表、会话目录、检查点四处串联的设计。

学习建议：本章是工程层“用户体验”维度的关键能力。如果你只关心模型怎么跑、不关心前端怎么显示，可以先跳。但如果你做过 Agent 项目并被“用户以为系统挂了”困扰过，本章会直接解决你的痛点。

## 1、本章导读

### 1.1 一个真实的体验问题

用户对 Globex 说：“帮我跨平台搜旅行收纳袋。”

主 AgentLoop 内部要做的事：

```text
Think → Act(planner) → Observe
Think → Act(parallel_dispatch_tool[4 个平台]) → Observe（这一步十几秒）
Think → Act(price_compare) → Observe
Think → Act(item_picker) → Observe
Think → Reflect → 输出最终回答
```

整个过程可能跑 15-20 秒。

如果用普通 HTTP 同步等待，前端在这 15-20 秒里什么反馈都没有。用户会以为系统挂了，或者重复点击发送按钮。

### 1.2 解法：把执行过程拆成事件流

让 Agent 在执行的每一步都向前端推送一个事件：

```text
0s   session_created    → 前端显示"会话创建"
1s   tool_start: planner → 前端显示"正在拆解需求..."
2s   tool_start: parallel_dispatch_tool → 前端显示"正在跨 4 平台并行检索..."
14s  tool_start: price_compare → 前端显示"正在比价..."
15s  tool_start: item_picker → 前端显示"正在精挑..."
17s  task_result        → 前端显示最终商品清单
```

用户不再“傻等”，而是看到 Agent 一步步在干什么。

## 2、为什么不能用普通 HTTP

### 2.1 同步 HTTP 的局限

```text
客户端 ─── POST /api/task ───→ 服务端
                              （服务端跑 15-20 秒）
客户端 ←─── 返回最终结果 ─────── 服务端
```

问题：

| 维度 | 同步 HTTP |
| --- | --- |
| 反馈延迟 | 等任务完全结束才有反馈 |
| 进度可见 | 完全不可见 |
| 取消能力 | 无（只能等超时） |
| 调试能力 | 出错时不知道卡在哪一步 |

### 2.2 解法：异步任务 + WebSocket 推送

```text
客户端 ─── POST /api/task ───→ 服务端
客户端 ←─── 立即返回 thread_id ── 服务端

客户端 ─── WS /ws/{thread_id} ─→ 服务端（建立长连接）
                              （服务端后台跑任务）
服务端 ─── tool_start 事件 ───→ 客户端
服务端 ─── tool_start 事件 ───→ 客户端
服务端 ─── task_result 事件 ──→ 客户端
```

HTTP 只负责“启动任务，立即返回 thread_id”。WebSocket 长连接负责持续推送过程事件。

## 3、AGUI 核心事件类型

### 3.1 七个标准事件

| 事件名 | 触发时机 | data 字段示例 |
| --- | --- | --- |
| `session_created` | 后台任务创建成功 | `{"thread_id": "xxx", "session_dir": "..."}` |
| `assistant_call` | 主 AgentLoop 进入 Think 阶段 | `{"step": "thinking", "preview": "..."}` |
| `tool_start` | 工具开始执行 | `{"tool_name": "item_search", "args": {...}}` |
| `tool_end` | 工具返回结果 | `{"tool_name": "item_search", "duration_ms": 1200}` |
| `task_result` | 任务完成 | `{"final_answer": "..."}` |
| `task_cancelled` | 任务被用户取消 | `{}` |
| `error` | 执行异常 | `{"error_type": "...", "message": "..."}` |

### 3.2 统一的消息结构

所有事件都包装成统一的 JSON 格式：

```json
{
  "type": "monitor_event",
  "event": "tool_start",
  "message": "正在调用 item_search 工具",
  "data": {
    "tool_name": "item_search",
    "args": {"query": "旅行收纳袋"}
  },
  "timestamp": "2026-06-09T14:23:45.123Z"
}
```

前端只需要根据 event 字段做不同展示，data 携带具体业务数据。

## 4、thread_id：贯穿全链路的钥匙

### 4.1 thread_id 串起了五件事

| 用在哪里 | 作用 |
| --- | --- |
| WebSocket 连接 | 找到当前页面的长连接 |
| `active_tasks` 表 | 找到当前会话的后台任务 |
| `session_dir` | 隔离本次任务的工作目录 |
| AgentLoop checkpoint | 区分同一会话的执行上下文 |
| 用户偏好 Store 写入 | 标记这条偏好来自哪次会话 |

如果 thread_id 处理不好，会出现“串台”：A 用户的进度推给了 B 用户，或者 A 的子 Agent 写到了 B 的会话目录里。

### 4.2 完整链路

```text
前端发起任务（带 thread_id）
  → 后端 /api/task 接到，登记 active_tasks[thread_id] = Task
  → 后端 asyncio.create_task 启动后台协程
  → 协程内 set_thread_context(thread_id)（写入 ContextVar）
  → AgentLoop 执行，每一步通过 monitor.report() 上报
  → monitor 读取当前 ContextVar 里的 thread_id
  → 通过 ConnectionManager 找到对应 WebSocket
  → 推送事件给前端
```

ContextVar 让深层工具不需要层层传 thread_id，全程透明。

## 5、API 层设计

### 5.1 启动任务接口

```python
@app.post("/api/task")
async def run_task(request: TaskRequest):
    """启动一次 AgentLoop 后台任务，立即返回不等结果。"""
    thread_id = request.thread_id or str(uuid.uuid4())

    # 同 thread_id 只保留一个活跃任务，新任务先取消旧任务
    old_task = active_tasks.get(thread_id)
    if old_task and not old_task.done():
        old_task.cancel()

    # 关键：create_task 把长任务放后台，HTTP 不等待
    task = asyncio.create_task(run_agent(request.query, thread_id))
    active_tasks[thread_id] = task

    return {"status": "started", "thread_id": thread_id}
```

注意：返回的不是任务结果，而是 thread_id。前端拿到 thread_id 后，立即建立 WebSocket 连接订阅事件。

### 5.2 WebSocket 接口

```python
@app.websocket("/ws/{thread_id}")
async def websocket_endpoint(websocket: WebSocket, thread_id: str):
    """建立长连接，接收 monitor 推送的事件。"""
    await manager.connect(websocket, thread_id)
    try:
        while True:
            # 接收前端心跳（防止连接超时）
            data = await websocket.receive_text()
            await websocket.send_json({"type": "pong"})
    except WebSocketDisconnect:
        manager.disconnect(websocket, thread_id)
```

### 5.3 取消接口

```python
@app.post("/api/task/{thread_id}/cancel")
async def cancel_task(thread_id: str):
    """用户主动取消任务。"""
    task = active_tasks.get(thread_id)
    if not task or task.done():
        raise HTTPException(404, "任务不存在或已结束")

    task.cancel()
    # AgentLoop 内部捕获 CancelledError 后会发 task_cancelled 事件
    return {"status": "cancelled", "thread_id": thread_id}
```

## 6、ConnectionManager：thread_id → WebSocket 的路由

### 6.1 核心数据结构

```python
class ConnectionManager:
    """管理 thread_id 到 WebSocket 的映射。"""

    def __init__(self):
        self.active_connections: dict[str, WebSocket] = {}
        self.loop: asyncio.AbstractEventLoop | None = None

    async def connect(self, websocket: WebSocket, thread_id: str):
        await websocket.accept()
        self.active_connections[thread_id] = websocket

    def disconnect(self, websocket: WebSocket, thread_id: str):
        # 重要：只删除当前对象，不能按 thread_id 盲删
        # 否则重连时会误删新连接
        if self.active_connections.get(thread_id) is websocket:
            del self.active_connections[thread_id]

    async def send_to_thread(self, payload: dict, thread_id: str):
        ws = self.active_connections.get(thread_id)
        if ws:
            await ws.send_json(payload)
```

### 6.2 重连场景的注意点

用户刷新页面会建立新 WebSocket，旧连接稍后才触发断开。如果断开时按 thread_id 盲删，会把刚建好的新连接误删。所以 `disconnect` 必须判断 `is websocket`，只有当前登记的就是要断开的对象时才删。

## 7、monitor：从工具内部上报事件

### 7.1 monitor 的接口

```python
class Monitor:
    """统一封装事件上报。"""

    def __init__(self, manager: ConnectionManager):
        self.manager = manager

    async def report_tool_start(self, tool_name: str, args: dict):
        thread_id = get_thread_context()  # 从 ContextVar 读
        await self._emit("tool_start", f"正在调用 {tool_name}", {
            "tool_name": tool_name, "args": args,
        }, thread_id)

    async def report_task_result(self, result: str):
        thread_id = get_thread_context()
        await self._emit("task_result", "任务完成", {
            "final_answer": result,
        }, thread_id)

    async def _emit(self, event: str, message: str, data: dict, thread_id: str):
        payload = {
            "type": "monitor_event",
            "event": event,
            "message": message,
            "data": data,
            "timestamp": datetime.now().isoformat(),
        }
        await self.manager.send_to_thread(payload, thread_id)
```

### 7.2 工具内部怎么用

工具实现里只需要调一行：

```python
@tool
async def item_search(query: str) -> str:
    """搜索商品。"""
    await monitor.report_tool_start("item_search", {"query": query})
    result = await actual_search(query)
    await monitor.report_tool_end("item_search", duration_ms=1200)
    return result
```

工具不需要知道 thread_id 是什么、WebSocket 在哪、事件怎么序列化，这些全部由 `monitor` 和 `ContextVar` 透明处理。

## 8、前端怎么消费事件

```javascript
const ws = new WebSocket(`ws://localhost:8000/ws/${threadId}`);

ws.onmessage = (event) => {
  const msg = JSON.parse(event.data);
  if (msg.type !== "monitor_event") return;

  switch (msg.event) {
    case "session_created":
      showStatus("会话已创建");
      break;
    case "tool_start":
      showStatus(`正在调用 ${msg.data.tool_name}`);
      break;
    case "task_result":
      renderFinalAnswer(msg.data.final_answer);
      break;
    case "error":
      showError(msg.data.message);
      break;
  }
};
```

前端只关心事件类型和 data，不关心后端怎么生成的。

## 本章小结

到这里，你应该理解 Globex AGUI 事件协议的设计：

1. Agent 长任务不能用同步 HTTP，必须 HTTP 启动 + WebSocket 推送过程事件。
2. AGUI 标准事件有七种：session_created / assistant_call / tool_start / tool_end / task_result / task_cancelled / error。
3. thread_id 是贯穿全链路的钥匙：前端连接、后台任务、会话目录、checkpoint、Store 写入都靠它串起来。
4. ConnectionManager 负责 thread_id → WebSocket 的路由，重连时要判断对象身份避免误删。
5. monitor 透过 ContextVar 自动拿到当前 thread_id，工具内部上报事件不需要传参。

下一章「[Rubric 评测与 Agentic RL 训练闭环](08 Rubric评测与Agentic-RL训练闭环.md)」会讲整套评测训练数据飞轮：从 Rubric 自动评分到 SFT 冷启动再到 Agentic RL 天花板。
