# 16-5 工具熔断与请求排队优先级

来源：https://alidocs.dingtalk.com/i/nodes/PwkYGxZV3ZOp3jngU97ROvRQWAgozOKL

作者：会敲代码的泡

创建时间：07-04 22:51

## AI 概览

本章围绕 Agent 服务稳定性展开，核心是两条防线：

- 外部依赖不稳定时，用工具熔断避免单个工具拖垮主循环。
- 请求流量超过处理能力时，用排队优先级和动态调度保护系统吞吐。

课程还把熔断、排队、Token 预算、LoopDetector、幂等性和多实例部署串起来，形成一套面向生产环境的稳定性设计。

本章课程目标：

- 掌握工具熔断的三态模型：Closed、Open、HalfOpen。
- 理解 Agent 场景下，工具熔断后主 loop 应该如何降级而不是崩溃。
- 理解请求排队优先级设计：按对话轮数分流、按用户等级排序、高峰期动态压缩大请求。
- 掌握三层幂等设计：活跃任务检测、Checkpoint 防重跑、重复提交检测。
- 看清工具熔断、LoopDetector、Token 预算、请求排队分别守护系统稳定性的不同维度。

学习建议：本章解决两类“Agent 被拖垮”的问题：外部工具不可用，以及请求量超过处理能力。两者结合后，系统不会因为某个依赖挂掉或流量突增而整体不可用。

对应代码分支：`16-5-circuit-breaker-queue`

---

## 1、工具熔断：保护 Agent 不被外部依赖拖垮

### 1.1 问题：一个工具挂了，整个 Agent 跟着挂

Globex 依赖多个外部服务，例如亚马逊 API、Shopee API、速卖通 API、eBay API、Reranker 服务、三塔 Embedding 服务。只要其中一个服务长时间超时，主 AgentLoop 就可能被拖慢。

典型故障链路：

```text
亚马逊 API 超时
  -> dispatch_tool fork 多路执行，其中亚马逊分支一直等待
  -> 主 loop 等待 dispatch_tool 返回，直到超时
  -> 用户长时间无结果
  -> 并发连接池被慢请求占满
  -> 其他平台的正常请求也被排队
  -> 系统出现雪崩风险
```

工具熔断的作用是：当某个工具持续失败时，系统短时间内停止向它发请求，并把“工具暂时不可用”作为可处理的 Observation 返回给主 loop。主 loop 可以继续使用其他平台的结果完成任务。

### 1.2 三态模型

```text
Closed --失败率超过阈值--> Open --等待恢复窗口--> HalfOpen
  ^                                             |
  |                                             |
  +------------- 探测请求成功 ------------------+

HalfOpen 探测失败 -> 回到 Open
```

| 状态 | 行为 |
| --- | --- |
| Closed | 正常放行请求，同时统计滑动窗口失败率 |
| Open | 拒绝请求，直接返回工具不可用 |
| HalfOpen | 放行少量探测请求；成功则恢复 Closed，失败则回到 Open |

### 1.3 完整实现要点

核心文件：`app/resilience/circuit_breaker.py`

实现需要包含：

- `State` 枚举：`closed`、`open`、`half_open`。
- `CircuitBreaker` 类：保存工具名、失败率阈值、滑动窗口大小、恢复等待时间。
- 滑动窗口：用 `deque[bool]` 记录最近一段时间的成功/失败结果。
- 并发保护：用 `asyncio.Lock` 保护状态切换。
- `call()` 包装真实工具调用，并在调用前判断当前状态。
- `CircuitOpenError`：当熔断器处于 Open 且尚未到试探时间时抛出。

实现骨架：

```python
class State(Enum):
    CLOSED = "closed"
    OPEN = "open"
    HALF_OPEN = "half_open"


class CircuitOpenError(Exception):
    pass


class CircuitBreaker:
    def __init__(
        self,
        tool_name: str,
        failure_threshold: float = 0.30,
        window_size: int = 100,
        recovery_timeout: float = 300.0,
    ):
        self.tool_name = tool_name
        self.failure_threshold = failure_threshold
        self.window_size = window_size
        self.recovery_timeout = recovery_timeout
        self._state = State.CLOSED
        self._results: deque[bool] = deque(maxlen=window_size)
        self._open_since = 0.0
        self._lock = asyncio.Lock()

    @property
    def state(self) -> State:
        return self._state
```

### 1.4 每个工具一个熔断器

核心文件：`app/resilience/breakers.py`

每个外部依赖需要独立配置熔断器。例如商品搜索可以按平台拆开，Reranker 和 Embedding 服务也分别维护熔断状态。

```python
TOOL_BREAKERS = {
    "item_search_amazon": CircuitBreaker("item_search_amazon", recovery_timeout=300),
    "item_search_shopee": CircuitBreaker("item_search_shopee", recovery_timeout=180),
    "item_search_aliexpress": CircuitBreaker("item_search_aliexpress", recovery_timeout=300),
    "item_search_ebay": CircuitBreaker("item_search_ebay", recovery_timeout=300),
    "reranker": CircuitBreaker("reranker", failure_threshold=0.20, recovery_timeout=120),
    "tower_encode": CircuitBreaker("tower_encode", failure_threshold=0.20, recovery_timeout=120),
}


def get_breaker(tool_name: str) -> CircuitBreaker | None:
    return TOOL_BREAKERS.get(tool_name)
```

### 1.5 熔断后 Agent 的行为

熔断器不应该让 Agent 直接崩溃。更稳妥的方式是让工具返回一个结构化的特殊结果：

- `candidates=[]`
- `total_recall=0`
- `error_message="工具已熔断"`

主 loop 在 Think 阶段看到这个 Observation 后，可以自然降级：

```text
已知某个平台的 ItemSearch 处于熔断状态。
已有其他平台的搜索结果。
下一步：先使用可用平台结果继续比价，不等待熔断平台恢复。
```

---

## 2、请求排队优先级

### 2.1 问题：大请求把小请求堵住

Globex 同时会收到两类请求：

- 正常请求：3 到 8 轮对话，通常 5 到 10 秒可完成。
- 大请求：30 轮以上对话，可能需要 60 秒以上。

如果所有请求共用一个 Worker 池，大请求会长期占用 Worker，导致后面的短请求无谓等待。

### 2.2 双队列 + 优先级设计

```text
请求入口 -> 分类器 -> 正常队列（轮数 < 30） -> Worker Pool A
                  -> 大请求队列（轮数 >= 30） -> Worker Pool B
```

设计要点：

- 先按对话轮数把请求分到正常队列或大请求队列。
- 队列内部按优先级排序，用户等级越高越靠前。
- 正常请求和大请求分配不同 Worker 池，避免互相阻塞。

### 2.3 实现

核心文件：`app/resilience/request_queue.py`

核心结构：

```python
@dataclass(order=True)
class PrioritizedRequest:
    """按优先级排序的请求。priority 越小越优先。"""
    priority: int
    timestamp: float = field(compare=False)
    thread_id: str = field(compare=False)
    query: str = field(compare=False)
    user_id: str | None = field(compare=False, default=None)


class PriorityRequestQueue:
    """双队列 + 优先级调度。"""

    def __init__(self, normal_workers: int = 8, heavy_workers: int = 4):
        self._normal_queue: list[PrioritizedRequest] = []
        self._heavy_queue: list[PrioritizedRequest] = []
        self._normal_sem = asyncio.Semaphore(normal_workers)
        self._heavy_sem = asyncio.Semaphore(heavy_workers)

    def classify(self, dialog_turns: int) -> str:
        return "heavy" if dialog_turns >= 30 else "normal"
```

用户等级可以映射为队列优先级：

```python
USER_PRIORITY = {
    "premium": 1,
    "standard": 5,
    "free": 10,
}
```

### 2.4 高峰期动态调整

当正常队列出现明显积压时，可以临时压缩大请求 Worker，把吞吐让给短请求。

```python
async def dynamic_rebalance(self):
    """高峰期：压缩大请求 Worker，优先保正常请求。"""
    normal_pending = len(self._normal_queue)
    if normal_pending > 20:
        self._heavy_sem = asyncio.Semaphore(2)
    elif normal_pending < 5:
        self._heavy_sem = asyncio.Semaphore(4)
```

### 2.5 用户等待反馈

请求入队后，前端不应停留在空白状态。后端可以立即通过 WebSocket 推送排队状态：

```python
await monitor._emit("queue_status", "已收到请求，当前排队中...", {
    "position": queue_position,
    "estimated_wait_seconds": queue_position * avg_process_time,
})
```

这样用户能看到当前排队位置和预计等待时间。

---

## 3、幂等性设计

### 3.1 问题：用户重复提交

用户等待过程中可能刷新页面，前端会再次发送 `POST /agent/run` 或类似请求。同一条 query 可能被启动两次，导致重复工具调用、重复扣预算、重复写结果。

### 3.2 三层幂等保护

第一层：活跃任务检测。

```python
active_tasks: dict[str, asyncio.Task] = {}


@app.post("/api/task")
async def create_task(req: TaskRequest):
    thread_id = req.thread_id or uuid.uuid4().hex

    existing = active_tasks.get(thread_id)
    if existing and not existing.done():
        return {"status": "already_running", "thread_id": thread_id}

    task = asyncio.create_task(_runner(req, thread_id))
    active_tasks[thread_id] = task
    return {"status": "started", "thread_id": thread_id}
```

第二层：Checkpoint 防重跑。

- 如果任务已经执行到某一步，重启后从 Checkpoint 恢复。
- 不重复执行已经完成的工具调用。
- 对长任务尤其重要，因为用户刷新、服务重启、WebSocket 重连都可能发生。

第三层：请求指纹去重。

```python
_recent_requests: dict[str, float] = {}
DEDUP_WINDOW = 5.0


def is_duplicate(user_id: str | None, query: str) -> bool:
    fp = hashlib.md5(f"{user_id}:{query}".encode()).hexdigest()
    now = time.time()

    expired = [k for k, t in _recent_requests.items() if now - t > DEDUP_WINDOW]
    for key in expired:
        del _recent_requests[key]

    if fp in _recent_requests:
        return True

    _recent_requests[fp] = now
    return False
```

三层保护覆盖不同情况：

| 层级 | 解决的问题 |
| --- | --- |
| `active_tasks` | 同一个 `thread_id` 的任务正在运行 |
| Checkpoint | 任务中断后避免重复执行已完成步骤 |
| 请求指纹 | 短时间内同一用户重复提交相同 query |

---

## 4、三个稳定性维度的关系

### 4.1 一张图看清守护边界

请求排队、Token 预算、LoopDetector、工具熔断各自解决不同维度的问题：

```text
请求排队
  守容量：不要让 Worker 被打满

Token 预算
  守成本：不要让单次请求无限消耗 token

LoopDetector
  守行为：不要让 Agent 自己在循环里打转

工具熔断
  守外部依赖：不要让坏工具拖垮整个系统
```

### 4.2 四者的协同场景

当亚马逊 API 连续超时，同时涌入大量请求：

1. 工具熔断让亚马逊 ItemSearch 进入 Open 状态，Agent 自动跳过亚马逊。
2. 跳过一个平台后，Agent 只查可用平台，Token 消耗随之降低。
3. 请求排队把涌入流量按优先级排队，避免 Worker 被打满。
4. LoopDetector 监控 Agent 是否因为缺少一个平台数据而反复重试，并在必要时注入收敛提示。

四层机制共同工作，系统在外部服务异常和流量突增时仍然可用。

---

## 5、熔断状态的持久化与多实例共享

### 5.1 单实例问题

单实例部署时，熔断状态保存在内存里即可。但多实例部署时会出现状态不一致：

```text
实例 A 检测到亚马逊 API 挂了并进入本地熔断
实例 B 不知道这个状态，继续向亚马逊发请求
结果：实例 B 仍然被慢依赖拖住
```

### 5.2 Redis 共享状态

多实例场景下，熔断状态需要写入 Redis：

```python
async def _save_state_to_redis(self):
    key = f"breaker:{self.tool_name}"
    await redis.set(key, json.dumps({
        "state": self._state.value,
        "open_since": self._open_since,
        "failure_count": self._results.count(False),
        "total_count": len(self._results),
    }), ex=600)


async def _load_state_from_redis(self):
    key = f"breaker:{self.tool_name}"
    data = await redis.get(key)
    if data:
        info = json.loads(data)
        self._state = State(info["state"])
        self._open_since = info["open_since"]
```

建议策略：

- 状态变更时同步写 Redis。
- 请求前读取 Redis 状态。
- 本地做 5 秒左右缓存，避免每次工具调用都打 Redis。
- Redis key 设置过期时间，防止陈旧状态长期保留。

---

## 6、监控与告警

### 6.1 熔断事件推送

熔断状态变化时需要同时做两件事：

- 写入链路追踪或观测系统，便于事后分析。
- 当状态进入 Open 时发送告警，提醒外部依赖可能正在故障。

示例字段：

```python
await monitor._emit("circuit_breaker_state_changed", {
    "tool": self.tool_name,
    "from": old_state.value,
    "to": new_state.value,
})
```

进入 Open 状态时可推送告警：

```python
await send_alert(
    f"[熔断] 工具 {self.tool_name} 已熔断，"
    f"失败率 {self._failure_rate():.0%}，"
    f"预计 {self.recovery_timeout}s 后试探恢复"
)
```

### 6.2 看板指标

| 指标 | 含义 | 告警阈值 |
| --- | --- | --- |
| 各工具当前状态 | Closed / Open / HalfOpen | 任何工具 Open |
| 各工具失败率 | 滑动窗口内失败比例 | 大于 20% |
| 熔断触发次数/小时 | 每小时进入 Open 的次数 | 大于 5 |
| 恢复成功率 | HalfOpen 到 Closed 的比例 | 小于 50% |
| 正常队列排队数 | 当前等待处理的正常请求 | 大于 20 |
| 大请求队列排队数 | 当前等待处理的大请求 | 大于 10 |

---

## 7、和其它章节的关系

| 章节 | 本章和它的关系 |
| --- | --- |
| 第 14 章 LoopDetector | LoopDetector 守 Agent 行为，工具熔断守外部依赖 |
| 第 15 章 FastAPI | `active_tasks` 幂等检测位于 FastAPI 入口层 |
| 16-3 LangFuse | 熔断事件打标，排队延迟记录 |
| 16-4 Token 预算 | 工具熔断后 token 消耗降低，和预算机制形成正向配合 |
| 16-6 K8s | 多实例部署时熔断状态需要 Redis 共享 |

---

## 本章小结

到这里，Globex 有了完整的外部依赖保护和流量调度机制：

1. 工具熔断三态模型：Closed -> Open -> HalfOpen，滑动窗口失败率超过阈值后触发，等待恢复窗口后试探恢复。
2. 熔断后 Agent 行为：工具返回特殊结果而不是抛出未处理异常，主 loop 在 Think 阶段自然降级。
3. 双队列 + 优先级：按对话轮数分流，同队列按用户等级排序，高峰期压缩大请求 Worker。
4. 三层幂等：`active_tasks` 检测、Checkpoint 防重跑、请求指纹去重。
5. 多实例共享：熔断状态写入 Redis，让所有实例同步感知。
6. 四维稳定性：排队守容量，Token 预算守成本，LoopDetector 守行为，工具熔断守依赖。

下一章是“安全护栏与 K8s 生产化”，主题包括 Prompt Injection 防御、K8s 滚动更新、长任务处理和灰度发布。
