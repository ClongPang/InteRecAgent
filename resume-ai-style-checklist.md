# 简历“AI 味”判断与改写检查清单

本文用于检查项目简历是否存在明显的生成式表达。判断重点不是猜测文字是否由 AI 生成，而是识别通用套话、术语堆叠、不可验证结论和缺乏领域共识的自造名词。

## 一、常见判断点

### 1. 表达过于通用

去掉项目名后，内容仍可直接套用到大量项目，例如：

- 提升系统效率与用户体验
- 实现智能决策并保障系统稳定性
- 构建高可用、可扩展的技术架构

简历应写清具体对象、设计决策和实现边界，使表述只能对应当前项目。

### 2. 术语堆叠但缺少逻辑关系

连续罗列 LangGraph、Goal State、Grounding、Claim Verification 等名词，却没有说明各自负责什么、为何采用以及如何协作，容易呈现关键词拼接感。

术语应服务于架构说明，至少交代：

- 该概念解决什么问题；
- 它位于哪一层；
- 它与其他模块的职责边界是什么。

### 3. 句式高度模板化

常见模板包括：

- 针对……基于……通过……实现……
- 通过 A、B、C，保障 X、Y、Z
- 负责……实现……提升……

多条经历使用相同节奏、相同动词或工整排比，会显得像批量生成。应优先直接描述设计选择、实现方式和可验证结果。

### 4. 只有职责，没有设计决策

“负责检索、排序和校验”更像岗位说明，不能体现个人判断。有效信息应包括关键取舍，例如：

- 为什么使用固定状态图，而不是 ReAct；
- 为什么不采用多 Agent 协作；
- 哪些环节交给模型，哪些环节必须由确定性代码执行；
- 上游部分失败时如何继续返回可信结果。

### 5. 结论抽象且无法验证

“增强可靠性”“提高推荐质量”“保障可用性”等结论没有说明验证口径。应尽量补充：

- 评测集规模和覆盖场景；
- Precision、Recall、违规率、可追溯率和 P95 延迟；
- 回放测试、变形测试或发布门禁；
- 超时、限流、缺字段和部分市场失败等异常场景。

### 6. 过度拔高普通实现

避免将普通模块包装成超出事实的能力，例如：

- 将接口封装写成“平台化能力”；
- 将固定流程写成“自主智能决策”；
- 使用“业界领先”“显著提升”“全面保障”等无基线结论。

每个结论都应能够对应代码、测试、数据或文档。

### 7. 不符合本人表达习惯

如果一句话无法在面试中自然复述，或不能解释其中每个术语对应的代码实现，就不适合直接写入简历。可以用以下问题自检：

1. 这句话是否只能描述我的项目？
2. 每个名词能否对应到具体模块、代码或指标？
3. 我能否解释为什么采用这个方案，而不是其他方案？
4. 面试官追问数据来源时，我能否提供评测集和计算口径？

## 二、伪术语与自造复合名词

AI 容易把多个真实概念拼成一个“像术语的短语”。其中每个词可能都存在，但组合后的名称没有稳定定义，也不属于行业公认的架构分类。

风险示例：

- 以 Goal 为权威状态的单域 Agent
- 证据驱动的决策智能体架构
- 目标感知型动态编排引擎
- 认知闭环式推荐框架

### 判断方法

- 能否在官方文档、经典论文或主流框架中找到相对稳定的定义；
- 不同从业者看到该名称后，是否会产生接近的理解；
- 能否对应已有分类，如 Task-oriented Dialogue、Dialogue State Tracking、StateGraph、ReAct 或 Grounding；
- 如果只是项目代码中的抽象，应明确写成 `ShoppingGoal`、`ShoppingMission` 等项目名称，不要包装成行业架构名称；
- 去掉英文大写以及“式、型、驱动、感知、闭环”等修饰后，如果概念立即失去明确含义，大概率属于包装性表达。

## 三、本项目术语审计

| 表述 | 判断 | 使用建议 |
|---|---|---|
| Task-oriented Dialogue | 有领域共识 | 可用于说明任务型对话场景 |
| Dialogue State Tracking | 有领域共识 | 仅在确实描述多轮状态跟踪时使用 |
| LangGraph StateGraph | 框架官方概念 | 可用于说明共享状态、节点和条件边编排 |
| Grounding | 有领域共识 | 应说明依据是商品、汇率或其他外部证据 |
| Claim Verification | NLP 事实核查术语 | 中文简历优先写“生成内容与证据一致性校验” |
| Goal State | 任务型对话中的已有概念 | 应说明它表示用户目标和约束，而非完整系统状态 |
| 有状态 Agent | 通用描述 | 可以使用，但不应包装成特定架构流派 |
| 单域 Agent | 可以理解但无统一定义 | 优先改为“面向跨境购物领域的 Agent” |
| 单 Agent 工作流 | workflow 与 agent 的边界有歧义 | 优先描述“任务型对话 Agent + StateGraph 编排” |
| 以 Goal 为权威状态 | 项目设计概括 | 不应作为行业术语；应分别说明 `ShoppingMission` 与 `ShoppingGoal` 的职责 |

## 四、改写原则

1. **先写设计选择，再写技术名词。** 不为出现关键词而堆叠框架名称。
2. **使用公认概念，项目概念保留代码名。** 行业术语与内部抽象不能混为一谈。
3. **写清职责边界。** 明确模型、确定性代码、数据源和持久化层分别负责什么。
4. **用机制替代形容词。** 用版本控制、超时重试、部分失败降级、事件审计等事实替代“稳定可靠”。
5. **用指标替代效果套话。** 指标必须有样本、计算方式和可复现的评测入口。
6. **一条 bullet 只承担一个主结论。** 总览写架构与关键取舍，后续条目分别展开状态管理、可靠性和评测。

## 五、提交简历前的快速检查

- [ ] 删除项目名后，这句话是否仍像通用模板？
- [ ] 是否存在三个以上连续出现但没有关系说明的术语？
- [ ] 是否反复使用“针对、基于、通过、实现、保障”等模板动词？
- [ ] 是否出现无法在权威资料中找到定义的复合名词？
- [ ] 是否把项目内部类名包装成行业架构名称？
- [ ] 每项成果是否能对应代码、测试、日志或评测数据？
- [ ] 所有量化指标是否有明确样本和口径？
- [ ] 是否写清关键方案的取舍，而不只是罗列职责？
- [ ] 是否能够用日常专业表达在面试中复述每句话？

## 六、参考资料

- [LinkedIn：Telltale signs of AI resumes](https://www.linkedin.com/news/story/telltale-signs-of-ai-resumes-7094380/)
- [Augsburg University：Can Recruiters Tell If You’ve Used AI To Write Your Resume?](https://careers.augsburg.edu/resources/can-recruiters-tell-if-youve-used-ai-to-write-your-resume/)
- [UniSQ：Ethical AI for Career Development](https://www.unisq.edu.au/-/media/unisq/current-students/career-ready-graduations/unisq-ethical-ai-for-career-development.ashx)
- [LangGraph Graph API](https://docs.langchain.com/oss/python/langgraph/graph-api)
- [Anthropic：Building Effective AI Agents](https://www.anthropic.com/engineering/building-effective-agents)
- [ACL：A Systematic Survey of Claim Verification](https://aclanthology.org/2025.findings-emnlp.1170/)
