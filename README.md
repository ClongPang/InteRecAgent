# HeartShop

HeartShop 是从 Globex 项目总览还原出来的跨平台对话式购物 Agent。它的核心不是把用户 query 透传给搜索 API，而是通过主 AgentLoop 统筹、按需 fork 同质子 AgentLoop、调用购物工具、实时推送进度，并把用户偏好沉淀到长期记忆里。

## 已还原内容

- FastAPI 长任务入口：`POST /api/task`
- WebSocket 事件通道：`/ws/{thread_id}`
- `thread_id` 与 `session_dir` 的 ContextVar 贯穿
- AGUI 风格监控事件：`session_created`、`assistant_call`、`tool_start`、`tool_end`、`task_result`、`task_cancelled`、`error`
- Harness Hook Pipeline：`on_session_start` / `pre_think` / `pre_tool_call` / `post_tool_call` / `post_reflect` / `on_session_end`
- 动态工具权限：`PLANNING -> SEARCHING -> COMPARING -> CONCLUDING` 阶段状态机、阶段工具过滤和高风险工具保护
- `app/tools` 下的 9 个购物工具
- bootstrap 版长期记忆、上下文压缩、评测、轨迹记录模块
- 项目架构文档：[docs/architecture.md](docs/architecture.md)

## 架构摘要

项目可以记成：

```text
1 个主 AgentLoop
+ N 个按需 fork 的同质子 AgentLoop
+ 9 个购物工具
+ 5 类基础设施
```

5 类基础设施分别是：向量召回、长期记忆、上下文压缩、AGUI 进度事件、Harness 过程治理与评测训练闭环。

## 环境准备

```bash
uv sync
cp .env.example .env
```

`.env` 只放本地密钥和服务地址，不提交仓库。

导入与编译检查：

```bash
uv run python -m compileall app scripts examples main.py
uv run python -c "from app.agent.tool_registry import FULL_TOOL_SET; print([t.name for t in FULL_TOOL_SET])"
```

## 启动 API

```bash
uv run uvicorn app.api.server:app --reload
```

创建购物任务：

```bash
curl -X POST http://127.0.0.1:8000/api/task \
  -H "Content-Type: application/json" \
  -d '{"query":"我想买一套便宜又抗造的旅行三件套，预算 300 块，最好不要塑料的，喜欢小众一点。","user_id":"demo"}'
```

请求体可选传入 `thread_id`。同一个 `thread_id` 下只保留一个活跃任务，新任务会先取消旧任务并复用同一条 WebSocket 会话标识。

查询任务状态：

```bash
curl http://127.0.0.1:8000/api/task/<thread_id>
```

监听实时事件：

```text
ws://127.0.0.1:8000/ws/<thread_id>
```

连接建立后服务端会先推送 `monitor_event/session_created`。客户端发送任意心跳文本时，服务端返回 `{"type":"pong"}`。

## 当前运行模式

在还没有配置模型、ANN 索引和 OpenSearch 时，服务会运行确定性的 bootstrap AgentLoop。这个模式用于验证工程链路：

```text
HTTP task -> thread context -> assistant_call -> planner event -> optional fork event -> result event
```

配置外部服务后，可以把 `app/agent/main_agent.py` 接到真正的 LangGraph/LangChain Agent；API、工具注册、监控事件、长期记忆和文档结构可以继续复用。

## Harness Hook Pipeline

Harness 把白名单、工具参数校验、返回截断、安全过滤、单步验证、Silent Drift 检测、LoopDetector、Token 预算 hint 和最终输出审核收敛到统一中间件：

```text
on_session_start -> pre_think -> pre_tool_call -> post_tool_call -> post_reflect -> on_session_end
```

Hook 低 `priority` 先执行。普通 Hook 异常只记录日志并跳过，`HookRejectSignal` 用于拒绝当前工具调用。`HarnessToolNode` 可替换 LangGraph 默认 `ToolNode`，在工具执行前后触发 `pre_tool_call` 和 `post_tool_call`。

单步验证包含三类 assertion：Schema 检查工具返回结构，Sequencing 检查工具调用顺序，Semantic 用轻量模型检查高价值工具返回是否和原始需求相关。`post_reflect` 会汇总 assertion 失败并注入纠正消息。Silent Drift 每 3 轮检测一次目标遗忘、探索发散、偏好丢失和成本失控，必要时注入漂移提醒或强制收尾提示。

17-4 章补上的动态工具权限把对话分成四个只进不退的阶段：`PLANNING` 只暴露 `planner`、`chat_fallback`、`category_insight`、`web_search`；`SEARCHING` 暴露检索和 fork；`COMPARING` 暴露比价、运费和精挑；`CONCLUDING` 只暴露 `shopping_summary` 和兜底。`phase_check` 在工具执行前做最后拦截，`phase_transition` 在 Reflect 后推进阶段，`phase_rollback` 允许 COMPARING 连续无进展时回退到 SEARCHING。`tool_risk` 同时标记只读、写入和资源消耗类工具，`dispatch_tool` 会受 fork 深度和并发上限保护。

## 关键环境变量

| 变量 | 作用 |
| --- | --- |
| `DEEPSEEK_API_KEY` | 模型 API key |
| `DEEPSEEK_BASE_URL` | OpenAI 兼容模型端点 |
| `DEEPSEEK_MODEL_MAIN` | 主/子 AgentLoop 模型 |
| `DEEPSEEK_MODEL_JUDGE` | Rubric judge 模型 |
| `TOWER_QUERY_ENDPOINT` | Query embedding tower |
| `TOWER_USER_ENDPOINT` | User embedding tower |
| `ANN_INDEX_PATH` | 本地 FAISS 索引路径 |
| `OPENSEARCH_*` | 品类 RAG 和偏好后端 |
| `LANGFUSE_*` | 可选链路追踪 |

## 项目目录

```text
app/
  agent/          AgentLoop、提示词、模型工厂、dispatch_tool
  api/            FastAPI、WebSocket、monitor、ContextVar
  tools/          Planner、ItemSearch、PriceCompare、ShoppingSummary 等
  recall/         tower client、FAISS ANN、品类知识库
  memory/         本地偏好 Store 与 prompt 注入
  compress/       cache breakpoint 与上下文压缩
  eval/           rubric 评分与轨迹记录
  harness/        Hook Pipeline、默认 Hook 和 HarnessToolNode 支撑
  observability/  Langfuse 和运行时告警
  prompt/         YAML 提示词
  utils/          路径与 thread scope 工具
```
