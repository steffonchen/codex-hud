# Phase 6：Plan / Execution Progress 实现与验收

日期：2026-09-12。阶段状态：**PARTIAL**。本地实现、相关测试和构建完成；当前 CLI 的完整 Plan Mode 真实交互仍待单独确认。Phase 5 的既有限制不作为本阶段阻塞项，也没有开展 Phase 7。

## 来源与范围

- 当前 CLI：`0.154.0`；常见 Desktop rollout metadata：`0.153.4`。
- 真实执行清单证据：历史 rollout metadata writer `0.146.1/0.147.0/0.149.1`，本阶段 fixture 和原文件验收采用 `0.149.1`。
- 当前版本本地 schema 确认执行清单通知、提案文本 delta、Plan ThreadItem；这是协议适配依据，不是实时订阅证明。
- 当前版本样本未观测完整 Plan Mode、批准、拒绝、取消或失败来源。没有从 Activity、Tool、Agent、Goal 或自然语言推导 Plan。

结构、逐行出处和持久化调查见 [Plan Discovery](phase6-plan-discovery.md)。脱敏规则及每份真实 fixture 的行号见 [fixture 说明](../tests/fixtures/plan/README.md) 与 [provenance.json](../tests/fixtures/plan/provenance.json)。缺少真实来源的 delta/cancelled/agent-plan 没有伪造 JSONL。

## 数据链路

```text
既有根 RolloutReader / 集中子线程 Reader
                    ↓
RolloutEventParser → PlanEventParser
                    ↓
        成功回执确认 / 事件归一化
                    ↓
各线程 HudStateReducer → PlanTracker
                    ↓
HudState.planSummary → StateStore
                    ↓
PlanModule / 明确关联的 Agent Plan / CLI 诊断
```

新增文件：

- `src/core/PlanState.ts`、`PlanEvents.ts`、`PlanTracker.ts`。
- `src/providers/codex/PlanEventParser.ts`、`PlanDiscovery.ts`。
- `src/renderer/modules/PlanModule.ts`；旧 `Plan.ts` 保留导出入口。
- 六个 Plan 测试文件、测试辅助文件和 `tests/fixtures/plan/`。

接入点限定为既有 Reducer、HudState、AgentTracker、Rollout Parser/Provider、CapabilityDetector、LayoutEngine、AgentModule 及 CLI。没有新建正式 App Server 或数据库 Provider，没有新增 Plan watcher/timer，没有改变既有模块优先级。

## 状态与事件

`PlanSummary` 分别保存 `execution`、`proposal`、`mode`、capability、最近事件及诊断。

执行清单包含确定性的 `planId`、线程/轮次、来源、步骤、六种步骤状态计数、当前步骤位置、完成数、总数、百分比、解释及来源顺序。Plan ID 由线程 SHA-256 摘要生成，步骤 ID 使用 Plan ID 与位置；同一线程后续完整快照修订原清单，不随机创建新身份。没有来源步骤 ID 时，位置身份不能追踪插入或重排后的业务同一性。

步骤状态为 `pending/in_progress/completed/failed/cancelled/unknown`；实际 rollout 适配仅接受已核验的前三种。百分比为 `completedCount / totalCount × 100`，空数组为 idle，不显示 NaN，不把进行中的步骤计为完成。多个进行中步骤保持原位置并诊断，不改写来源。

归一化事件为 `plan-updated`、`plan-mode`、`plan-proposed`、`plan-delta`、`plan-status`、`plan-cleared`。显式生命周期可以表示 approved/executing/completed/failed/cancelled，但没有为缺乏证据的 raw approval/failure/cancel 事件设计虚假映射。全部步骤完成可以确认执行计划完成；提案 item 完成、模式退出及 task_complete 均不能代替它。

rollout 的 `update_plan` 需要同线程 `call_id` 的成功返回 `Plan updated`。参数失败或未知返回保留上次清单并诊断；已确认的参数失败替换通用工具成功分类，重复回执即使使用更晚时间戳也不会显示成功。更新顺序使用原始调用行号，回执只负责确认，因此乱序返回不会回退较新的清单。

每次清单更新采用完整数组替换语义，包括删除旧步骤；不按未经确认的 patch 语义补回缺失项。模式、提案、执行清单分别维护来源顺序屏障，事件去重与重放保持幂等。当前 Provider 只使用 rollout 顺序；未来若合并多个实时来源，需要先定义共同顺序，不能直接比较各连接的序号。

## PlanDelta 与安全边界

`parseNotification()` 根据当前 CLI 导出的 schema，纯适配：

- `turn/plan/updated`：完整执行步骤，`inProgress` 归一化为 `in_progress`。
- `item/plan/delta`：按 thread/turn/item 关联的提案文本片段，不是步骤 patch。
- `item/started`、`item/completed` 的 `type="plan"`：提案生命周期，最终 text 权威覆盖拼接结果。

`PlanTracker.applyDelta()` 增量拼接有界私有文本；相同文本的不同片段仍分别接收，重复事件不再次追加，完成后的迟到片段不能重开同一提案。流正文可能把凭据分成多个片段，因此生成中只暴露字符计数和状态。最终文本先用现有 sanitizer 脱敏，再进入快照；最终正文与累计片段可以不同。

步骤标题、解释、事件诊断与显示出口复用 `Redaction`，移除终端控制字符并隐藏凭据。debug 使用字段白名单，任意 raw payload、prompt、参数、工具输出不进入计划诊断。普通 HUD 从不输出完整提案正文。

边界：最多 256 步、单个原始标题 4096 字符、显示标题 240 字符、提案正文最多 65,536 个 UTF-16 代码单元、最近 20 条事件、20 条 Tracker 诊断、256 个去重身份、128 个待确认调用、256 个提前返回或已结算调用身份。超过边界可见诊断，不静默伪装完整数据；这些窗口不保证无限久远的重新投递身份去重。时间字段只保存有限非负值。

## 展示与 CLI

Plan 模块默认启用，priority 继续为 65。已有显式 `display.enabled` 不变；setup 根据可靠数据或已观测的 collaboration mode 字段允许选择，用户主动勾选后才加入旧配置。

| 可用宽度 / 高度 | 显示 |
| --- | --- |
| 140、80 列且行数充足 | 清单进度与步骤状态 |
| 50 列 | 进度与六种状态的非零计数 |
| 30 列 | `P 1/4`，保留失败/取消/未知符号 |
| 7–9 行 | 当前步骤周边窗口及省略数量 |
| 5–6 行 | 摘要与当前步骤 |
| 少于 5 行 | 摘要 |

以上使用模块收到的可用高度；LayoutEngine 仍按现有全局宽高预算和优先级分配空间，空间不足可隐藏整个模块。Renderer 只访问归一化状态和可见步骤，不回放事件或读取文件。提案只显示“生成中／待确认”，不展示执行百分比。

根计划独立显示。只有 `isSubagent && plan.threadId === agent.id` 才复制到 AgentState；文件失联清除旧子计划。紧凑代理行把简短计划进度放在活动文本之前，长 MCP 活动不会挤掉进度或失败符号。Agent 失败不会改变 Plan 终态。

doctor 区分 `available/unsupported/not-observed/disabled/unavailable/partial`。模块开关与来源能力分开报告，App Server 实时订阅明确为 unsupported。默认 debug stderr 只输出计划能力、来源、模式、状态和计数；`--verbose` 才展开脱敏步骤、事件及已完成提案正文。stdout 的 HUD 仍可显示步骤。

## 验证结果

```text
测试文件：48 passed
测试用例：713 passed（基线 550，新增 163）
npm run typecheck：PASS
额外 src + tests 严格类型检查：PASS
npm run build：PASS
```

新增测试分布：Tracker 32、Delta 18、Parser 41、Renderer/Agent 36、Discovery/CLI/配置/隐私 22、文件/Runtime 集成 14。

覆盖完整快照、真实回执失败、重复/乱序、线程隔离、重放、模式独立、提案权威文本、跨片段凭据、宽高矩阵、短标题与状态、已有配置保留、Agent ID 关联、半行、截断/替换、文件消失恢复、compaction、A→B→A、重启、SIGINT、同步/异步 EMFILE 及有界资源。注入通知、显式生命周期、compaction 顺序及 Agent+Plan 组合测试是协议/归一化契约测试，不能称为真实 Codex 样本。

两名 `gpt-6-astra / medium` 子代理做只读独立核验。确认的重复失败回执时间戳问题及 80 列长活动裁掉子计划问题已修复，并加入回归断言。

交付核对：7 份 fixture 按 provenance 对照原文件，时间、事件类型、步骤字段/状态及回执逐行一致；3 份协议摘录与本次 CLI 导出一致。基线 395 个文件，完成后 440 个；没有删除文件，新增/修改限定为本阶段源码、测试、文档及对应 dist 构建产物。文本均为 UTF-8 无 BOM；`~/.codex/config.toml` 和 `~/.codex-hud/config.toml` 的 SHA-256 与实施前一致。项目没有 Git 元数据，没有执行 Git 写操作。

## IMPLEMENTED 与 RUNTIME VERIFIED

| 能力 | IMPLEMENTED | RUNTIME VERIFIED |
| --- | --- | --- |
| 执行清单创建、更新、步骤比例、完成 | YES | YES：未改动的旧版真实 rollout；当前版本待验证 |
| Replay、Provider 重建、A→B→A | YES | YES：两个旧版原始文件；测试另覆盖不同中间进度 |
| Plan Mode 独立状态 | YES | default 有真实记录；active 尚未验证 |
| Plan item 与提案 delta | YES：当前 schema 纯适配 | NO：没有实时 App Server 订阅或真实 delta 样本 |
| 用户批准、Plan failure/cancel | YES：归一化状态和渲染 | NO：raw 来源未观测 |
| Agent + Plan | YES：明确线程关联 | NO：只有独立来源组合测试，没有真实子计划样本 |
| compaction 保留 Plan | YES | NO：组合测试通过，未观测实际 Plan 压缩时间线 |
| 原生文件追加与 HUD 更新 | YES | YES：真实宿主文件/时钟/TTY，输入为历史脱敏 fixture |
| HUD SIGINT、监听及订阅释放 | YES | YES：真实 TTY 进程接收 OS SIGINT，两次恢复原文件及一次追加流程均正常退出 |
| EMFILE | YES | 部分：本机原文件目录实际返回 EMFILE，补查模式恢复及退出已验证；故障下追加链路由集成测试验证 |

构建产物直接读取历史原文件的结果：

| 原文件 A 前缀截止行 | 已完成 / 总数 | 百分比 | 状态 |
| --- | --- | --- | --- |
| 33 | 0/4 | 0% | executing |
| 58 | 1/4 | 25% | executing |
| 102 | 3/4 | 75% | executing |
| 107 | 4/4 | 100% | completed |

四个前缀均在 140/80/50/30 列成功显示对应比例。完整 A、B 原文件均恢复最终 4/4；两者 Plan ID 不同，A→B→A 后状态完全一致。静态文件再次读取新增字节为 0。原文件 B 的两条计划诊断对应真实无效参数及拒绝回执，并未隐藏。

真实 TTY 的追加实验使用 0600 临时文件承载脱敏 fixture，0/4→1/4→4/4，累计解析 2353 字节与输入总字节一致；最多一个原生 watcher，OS SIGINT 后为 0，进程自然退出，临时文件清理完成。它验证真实 HUD 文件链路，不是新增 Codex 模型会话。

本机读取历史原文件目录时，原生监听实际返回 EMFILE；首次把 native 作为前提的验收断言因此未通过，随后明确检查 polling 与可见原因，恢复及 SIGINT 均通过。另一次仅对子进程设置 fd 上限 64 的实验未让 fs.watch 触发预期 EMFILE，属于故障注入前提不成立，未计为成功，相关资源与临时目录已清理。没有修改宿主全局限制。

## 待单独确认的当前版本真实实验

本地实现计划已批准；以下操作会调用模型并新增 Codex 会话日志，按原计划与用户 AGENTS.md 的外部写入约束单独确认。尚未启动模型实验，未修改 `~/.codex/config.toml` 或用户 HUD 配置。

实验模型固定为 `gpt-6-astra`，任务限定在隔离临时目录，添加 `clamp.mjs` 与 `clamp.test.mjs`；不安装依赖，不发布或推送。

第一阶段的任务文本：

> 请通过当前 CLI 实际支持的 Plan Mode，为新增 clamp(value, min, max) 工具函数制定方案。三个参数必须为有限数字，否则抛 TypeError；min 大于 max 时抛 RangeError；其余情况把 value 限制在闭区间内。使用 Node 内置测试覆盖边界值、越界值、非有限输入和反向区间。现在只给出计划，不实施。

观察实际 collaboration mode、提案 item/delta 和持久化内容。用户确认生成的具体方案后，进入 implementation，创建两个文件并运行 `node --test clamp.test.mjs`。只有当前工具自然提供 `update_plan` 才观察其执行清单更新；不启用隐藏 feature、不改配置来凑验收。逐项记录 entered/generated/updated/approved/implementation/completed，未观测项标记 N/A。

创建实验任务文件及早前官方网页访问曾被自动审批拒绝，审批服务调用 `gpt-5.6-luna` 返回 HTTP 404。主任务与子代理采用 `gpt-6-astra`，不能改变独立审批服务。没有换工具绕过该拒绝，待确认实验文件仍未创建。官方网页未成功获取，本阶段结构结论依赖当前 CLI 离线导出和本地真实记录。

## 已知限制与结束范围

当前版本完整 Plan Mode / proposal / approval / execution 的新会话验证尚未完成，因此阶段保持 PARTIAL。执行状态只能来自可确认的历史数据，不承诺当前 CLI 一定持久化同样结构。App Server 连接、数据库 Plan 内容、未观测生命周期与真实子计划仍待来源验证；事件历史已被源端裁剪时，HUD 不能从不存在的历史中恢复计划。

不进入 Phase 7，不调整 Cost、Cache、Quota 或 Pricing。下一步仅是用户确认后的 Phase 6 当前版本真实实验。
