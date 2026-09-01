# ADR-0008：小核心、窄入口与按职责拆分的模块架构

状态：Accepted  
日期：2026-09-01

## 背景

报价业务切换后，活动路径已经单一，但代码组织仍保留了迁移期形态：根目录存在不可执行的旧脚本，runtime 根入口导出大量内部实现，PostgreSQL repository、API app 和 React `App` 同时承担多种职责，若干质量脚本通过文件名和宽松行数上限约束架构。这些结构能够运行，却增加了定位、修改和评审成本。

本决策参考两个正在维护的开源实现：

- [nanobot architecture](https://github.com/HKUDS/nanobot/blob/main/docs/architecture.md) 将通道侧 turn 编排与模型/工具 runner 分开，并把 Provider、工具和存储放在明确边缘。
- [nanobot design constraints](https://github.com/HKUDS/nanobot/blob/main/.agent/design.md) 要求核心保持小、动态数据在拥有它的边缘完成解析，并反对无实际收益的抽象层。
- [pi-agent-core](https://github.com/earendil-works/pi/blob/main/packages/agent/README.md) 用 `AgentMessage → transformContext → convertToLlm`、事件流和窄 tool contract 区分应用状态、模型上下文与工具执行。

本项目不会复制参考项目的目录或实现通用 Agent 框架。`pi-agent-core` 已经拥有模型/tool loop，本项目只保留报价意图规划、确定性执行和持久化宿主。

## 决策

### 1. 固定依赖方向

```text
domain <- agent <- runtime <- api
   ^          ^        ^
   └──────────┴────────┘

frontend --HTTP/SSE--> api
```

- `domain` 只包含确定性业务类型、规则和状态转换，不引用 Agent、数据库、HTTP 或 UI。
- `agent` 只依赖 domain 与 pi-agent；模型侧 planner 和宿主侧 executor 分离。
- `runtime` 实现 Provider、数据库、遥测和 worker composition，不把 SDK/raw payload 泄漏进 domain。
- `api` 只依赖 runtime 的公共端口与 composition API，不导入 runtime 内部文件。
- frontend 使用独立 wire contract，并在 HTTP/SSE 边缘校验响应。

### 2. 核心文件按改变原因拆分

- 对话类型、公开投影、状态校验和 referent 解析分开。
- PostgreSQL facade 只组合 conversation commands、turn lifecycle、tool execution 和 query stores。
- Fastify app 只装配错误处理、健康检查、conversation routes 与 event routes。
- React `App` 只组合 controller hook 和展示组件；网络、格式化及浏览器存储各有明确归属。

拆分以“不同原因会改变”为依据，不以固定层数或每个函数一个文件为目标。

### 3. 公共入口显式且最小

workspace 根 `index.ts` 使用有意选择的导出；持久化 helper、SQL row mapper、内部 telemetry helper 和测试构造器不从根入口暴露。composition root 可以直接引用同包内部模块，跨包调用只能使用声明过的公共入口。

### 4. 动态边界只解析一次

BuyWhere payload、数据库 row、JWT、HTTP body 和 SSE frame 均在所属 adapter 解析/校验；内部函数接收窄类型。类型断言不能替代运行时边界检查。

### 5. 架构规则可执行

默认 acceptance 必须验证：workspace 依赖方向、禁止跨包 deep import、根入口无通配导出、composition root 不承载业务规则、退役脚本不再出现、关键职责文件具有紧的行数预算，以及干净构建和公共用户路径全部通过。

## 迁移顺序

1. 删除不可执行的旧脚本与 CI 入口，修复唯一质量工作流。
2. 拆分 domain 对话模型，保持所有公共类型与行为不变。
3. 分离 Agent planner/executor，并缩小 agent 根入口。
4. 将 PostgreSQL repository 拆为薄 facade 与内部 stores，分离 worker runner 和 composition root。
5. 拆分 API routes 与 frontend controller/components。
6. 收紧架构检查，执行全量 acceptance 与报价漂移检查。

每一步都必须保持 `quote-leads-sg-v1`、BuyWhere `find_best_price_v2`、固定 SG、身份准入和“商家页确认”语义不变。

## 后果

收益是每个改动有清晰落点、跨包依赖可追踪、测试可以靠近职责模块，删除模块时不会由宽根导出或陈旧构建继续存活。代价是短期文件数增加，并需要同步更新少量静态门禁；该代价由更小的修改面和可执行边界抵消。
