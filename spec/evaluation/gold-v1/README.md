# Gold v1 独立组卷交接

本目录中的 `authoring-blueprint.json` 是业务预登记蓝图，不是 sealed Gold，也不能产生简历指标。它冻结 39 个任务的业务风险、能力覆盖、变化轴、正负样本结构和最低事实分母；具体商品、报价、用户原话、`offerRef`、Listing Gold 与 Source Fact Gold 必须由独立审核方在实现和 Prompt 冻结后另行生成。

## 已完成的业务决策

- 13 个 family 各 3 个 task，共 39 个；同一 family 的任意两个 task 至少改变两个变化轴。
- 32 个任务要求合格输出，其中 30 个完整推荐、2 个部分市场成功；另含 3 个无合格报价、3 个 Discovery 和 1 个全 Provider 不可用任务。
- 每个正向 task 至少登记 2 项可验证事实，三次运行的最低计划事实分母为 201。
- 未知事实、部分失败、打断接管、持久恢复、能力分级、目标纠正、撤销与零报价 follow-up 均有独立切片。
- 架构不变量不塞进自然语言任务冒充验证：原子发布、过期 attempt 和单实现分别交给 PostgreSQL/故障、协议对抗和架构门禁。

`gold-authoring-v1.0.1` 修正了 v1.0.0 将未配置适配器的电脑配件误标为 VERIFIED 的问题；对应任务改用已支持品类的替代型号，旧语义哈希作废并保留修订原因。

`gold-authoring-v1.0.2` 根据真实模型预检修正了“开放品类必须先补交付地”的错误前提，改为产品政策真正会阻断研究的目标品类缺失；这是测试设计修正，不是为提高模型得分而放宽通过条件。

`gold-authoring-v1.0.3` 根据冻结报价预检修正了固定“第三项”等不可满足引用：相关任务改用至少两个候选可验证的第一/第二项，或要求候选不足时显式说明。通过条件的能力与风险覆盖不变，避免用题面缺陷误判系统。

`gold-authoring-v1.0.4` 完成逐题冻结来源可满足性审计：需要稳定序数、焦点、连续拒绝或重启后比较的任务，改用实际能形成两个合格候选的跨市场样本；复合任务明确“先绑定并拒绝、再过滤”的操作顺序。该修订收紧了题面与冻结数据的一致性，没有把失败实现改写成通过条件。

`gold-authoring-v1.0.5` 根据 39 项真实运行的冻结报价逐项复核，修正了会把保留市场一并拒绝、预算必然导致空集、以及在首次检索前引用未来序数的不可满足题面；同时把“检索后拒绝并偏好”拆成独立后续轮次。系统真实缺陷（开放目标擅猜、Discovery 越级和重复身份约束）仍由实现修复，未通过改题或放宽评分规避。

`gold-authoring-v1.0.6` 修正 `clarify_resume-01` 的结果层级矛盾：原话只确定“降噪耳机”品类，却要求严格身份准入后的正式推荐；第二轮现明确具体型号，同时保留“先澄清、同会话续研”的核心风险。模型协议失败时丢失部分 Goal、复合后续无法恢复，以及型号容量被重复建成硬约束等问题均由 Host/证据实现修复，不计作题面调整。

`gold-authoring-v1.0.7` 移除 `capability_tiering-03` 对不可见淘汰项的序数指代：首轮无合格候选时，低价配件不会进入用户可见 working set，用户不能合理地说“最便宜那条”。追问改为可从覆盖/淘汰原因回答的“配件类结果”，身份隔离风险与 NO_MATCH 要求不变。开放品类首轮被误标 Recommendation 则由 Host 强制 Discovery 分级修复。

内部资格话术另移除了 `capability_tiering-01` 的“全新”硬条件：冻结来源不提供可证明的商品成色，保留该条件会把“受支持品类可正式推荐”错测成来源字段缺失。正式独立 Gold 仍须按其冻结 Listing 决定是否能加入成色条件。

## 独立审核方组卷流程

1. 先冻结代码提交、Prompt/Skill、模型 ID 与参数、Evaluator、数据库 migration、Replay schema 和运行窗口。
2. 执行 `npm run acceptance:gold:blueprint`，确认语义哈希与 `authoring-blueprint.lock.json` 一致；任何蓝图变更必须提升版本并重新评审，不能静默改锁。
3. 由 fixture custodian 为每个 task 选择具体目标、市场数据和干扰项。不得复制开发集、产品 contract 示例、线上 smoke 会话或作者已看过的报价。
4. 由 task writer 根据每轮 `intent` 撰写自然话术；保持业务语义，但避免照抄仓库现有 trajectory。环境动作由 Harness 注入，不能伪装成普通用户文本。
5. 两名 reviewer 分别从原始冻结 JSON 标注 Listing Gold、Source Fact Gold、资格、结果层级、失败原因和原始 path/value；不得调用生产 qualifier 作为答案。
6. 分歧由第三人裁决。reviewer 不看简历目标阈值，作者不看 sealed task、具体 fixture 或 Gold 标签。
7. 生成正式 `interec-eval-manifest-v1`，用现有 SEALED 校验器检查 39 task、117 trial、3/family、正向数和事实分母，再一次性运行全部 trial。
8. 全量标注每个终态回复的用户可见事实；保留全部失败、预登记成功抽样、分歧记录、原始轨迹和版本清单。

## 业务判定准则

- “正式推荐”要求目标身份、品类能力、硬条件和必需商业事实均通过独立 Gold；低价不构成放宽理由。
- 软偏好只能影响排序，除非用户明确把它提升为硬条件；市场范围、预算上限和目标身份默认按硬约束处理。
- Provider 不可用、超时和无结果是三种不同结论；只有成功检索且独立 Gold 确认无合格报价时才允许 `NO_MATCH`。
- 缺失库存、保修、税费、运费、真伪或履约信息必须保持未知，不能用品牌常识、商家惯例或模型推测补齐。
- 序数、焦点和比较对象绑定到变更前的当前 working set；解析不唯一时应澄清，禁止回退到第一名。
- 当前证据足以回答比较、解释、拒绝、重排、过滤或撤销时，报价 Provider 预算为零；扩大未覆盖市场、改变目标或显式刷新才允许研究。
- 开放品类可返回 Discovery，但不得使用“最值得买”“确认可买”等正式推荐措辞；转为 Recommendation 需要该品类的确定性准入适配器。

## 封存包最低内容

```text
blueprint semantic hash
implementation / prompt / model / evaluator / fixture versions
39-task manifest + 117 planned trial IDs
frozen provider and FX fixtures
independent Listing Gold + Source Fact Gold
reviewer identities, blind statement, disagreements and adjudication
raw model/tool/state traces + final-text fact annotations
machine-readable report + failure inventory + reproduction command
```

蓝图通过只说明“正式评测设计已具备可交接性”。只有独立组卷、密封、运行和复核完成后，正式指标才有资格回填简历。
