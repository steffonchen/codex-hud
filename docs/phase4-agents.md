# Phase 4：Agents / Subagents / Agent Tree 验收报告

记录日期：2026-09-12。schema 依据见 [Discovery](phase4-agent-discovery.md)，真实样本索引见 [fixtures](../tests/fixtures/agents/README.md)。

## 1. Phase 4 完成情况

**状态：PARTIAL。** 已实现可靠的 Agent 数据链路、树、独立 Context/Token/Activity、布局、能力检测和诊断；420 项测试、类型检查、构建以及真实单代理、并行、嵌套、HUD 重启和终端验收均通过。保留的验收缺口是：没有观察到真实 Agent 级 failed 事件，不能声称已验证它的 raw → Parser → HUD 全链路。

| 验收项 | 结果 |
| --- | --- |
| schema、真实 spawn、child lifecycle、直接父子关系 | PASS |
| AgentState / Tracker / Tree、按线程 Context / Token / Activity | PASS |
| Agents 模块、树、运行/等待/完成、窄宽/短高、纯文本状态 | PASS |
| failed 显示 | 归一化 Tracker / Renderer 测试 PASS；真实 Agent failed 来源未观察到 |
| single / parallel / nested | PASS；嵌套为真实三层 |
| session switch | PASS；文件链路测试及两份真实来源受控 A→B→A 切换 |
| HUD restart / SIGINT / EMFILE | PASS |
| watcher / timer / 重复事件 | 集成测试 PASS；真实进程退出与监听归零 PASS |
| 脱敏、测试、类型检查、构建、文档 | PASS |

没有进入 Phase 5；没有新增依赖、修改配置 schema、自动启用用户模块或执行 Git 写操作。

## 2. Codex CLI version

实际命令返回 `codex-cli 0.154.0`，binary 为 `/opt/homebrew/bin/codex`。验证平台为 macOS，Node.js `v23.11.0`。CLI feature 快照显示 `multi_agent=true`、`multi_agent_v2=false`，它只描述当前 CLI 配置。

## 3. Rollout version

本次读取的 Desktop rollout 的 `cli_version` 为 `0.153.4`，任务子线程记录 `multi_agent_version="v2"`。未观察到独立的 rollout schema 版本号；没有用安装的 CLI 版本替代实际写入版本，也没有把 Desktop v2 与 CLI flag 混为一谈。

## 4. Agent schema

自身线程 ID 为 `session_meta.payload.id`，直接父 ID 为顶层或 `source.subagent.thread_spawn.parent_thread_id`，根会话归属为 `session_id`。任务名称优先取已脱敏 `agent_path` 的末段，再取昵称/角色；路径只用于显示。

Discovery 排除内部 `guardian_review`，保留真实任务子线程；根选择继续使用“当前目录最近主会话，其次最近主会话”。目录与时间只用于选择主会话，不用于构造 Agent 父子关系。

## 5. Agent event schema

新增 `src/core/AgentEvents.ts` 和 `src/providers/codex/AgentEventParser.ts`。Renderer 只消费归一化状态：

| 归一化事件 | 来源与含义 |
| --- | --- |
| `agent-discovered` | session metadata；只保留实际线程身份、父关系及安全名称 |
| `agent-status` | 所属线程的 task_started / task_complete / turn_aborted，或父线程 wait 的开始/返回 |
| `agent-call` | `namespace="collaboration"` 的 spawn / wait；保存父线程 ID、call_id、操作，不制造 child ID |

实际完成事件是 `task_complete`。中断原因只有确认的 `interrupted` 映射 cancelled。工具失败不会自动映射成代理失败；`CollabAgentToolCall.status=completed` 也不会被当作接收者完成。

## 6. Parent-child correlation

**STRONG**：依据 child metadata 的明确父线程 ID 建边；根 ID 来自实际主文件。并行顺序和日志交错不参与关联。父字段冲突不建立猜测关系，缺父保留 orphan，环保持可见且不会形成循环对象。

当前 spawn 返回只有任务路径，因此逐调用 `spawn call_id → child UUID` 不可用；树的直接父边仍可独立确认。没有 timestamp/latest-spawn/path heuristic，也没有 inferred 父边。

## 7. AgentState

新增 `src/core/AgentState.ts`。状态包含真实 id、parentId、名称/路径/角色、模型/推理强度、turnId、状态/时间，以及已有 TokenUsage、ContextUsage、ActivityState 和有限错误摘要。

状态集合为 `starting | running | waiting | completed | failed | cancelled | unknown`。`starting` 保留旧接口兼容，`failed` 支持归一化输入和展示；当前 raw Parser 不凭猜测产生这两个状态。

`HudState.agentSummary` 提供 rootId、计数、capability、tree、orphans、issues 和更新时间。`count` / `activeCount` 包括根代理，`activeSubagentCount` 单独统计子代理。旧 `HudState.agents?: AgentNode[]` 保留，由可靠树投影，演示及原有调用方继续可用。

## 8. AgentTracker

新增 `src/core/AgentTracker.ts`，由主 `HudStateReducer` 持有，处理同 ID 去重、乱序、轮次切换、终态稳定、文件恢复及有界历史。

- 同轮 complete 先于 start 到达时可以补开始时间，但终态不回退到 running。
- 新 turn 可以重新运行；旧轮 wait 的迟到结果不能重新开启已经结束的新轮。每线程保留最多 64 个退休 turn ID。
- 总节点默认 256，近期结束节点默认 20；为了连接活动后代而保留的祖先仍受总上限约束。构造参数支持调整 Tracker 上限，不读取或假定 Codex 的 max threads。
- 失联线程标记 unknown，清除无法确认的活动、Context 和 Token，并进入有界历史；文件重现时回放恢复。
- 退休身份窗口为默认 1024 项，关系问题最多 50 项；超限、字段冲突和未采集数据都有诊断。

## 9. AgentTree 与读取链路

`src/core/AgentTree.ts` 使用 ID 索引和迭代环检测，返回 `{ tree, orphans, issues }`；提供非递归 flatten 和旧接口投影。构建关系不会对每个节点重新扫描全体节点。

```text
CodexDiscoveryProvider：主会话与明确属于它的子 rollout
                  ↓
现有根 RolloutReader + 集中 RolloutAgentProvider
                  ↓
每线程 RolloutEventParser：Session / Agent / Tool 归一化
                  ↓
根 AgentTracker ← 子线程 HudStateReducer(false)
                  ↓        TokenTracker / ToolTracker / ActivityTracker
              HudState
                  ↓
StateStore → RenderScheduler → HudRenderer → TerminalController
```

`RolloutAgentProvider` 仅保存 reader、parser、reducer 和游标，不创建 watcher 或 timer。最多同时保存 255 个子 reader；读取候选窗口为 4096 个文件，窗口外仍已跟踪的流会继续处理。退休文件 mtime 独立记录，静态历史不会因 Tracker 身份窗口淘汰而重复全量回放。Discovery metadata 缓存最多 4096 项。

根文件切换/重放时重置整组代理；子文件截断、替换或重现仅重置对应线程。达到 reader 上限也会继续处理已有流的完成，释放名额后读取新线程。实际出错保持诊断，不返回虚假成功。

## 10. Renderer、Setup 与 Doctor

现有 `agents` 注册点委托新增 `src/renderer/modules/AgentModule.ts`。LayoutEngine 传递终端宽高与剩余行预算，隐藏优先级仍为 80。没有解析 JSONL 的 Renderer 私有状态。

| 条件 | 展示行为 |
| --- | --- |
| 宽屏、空间充足 | 树、状态、上下文、耗时和活动摘要 |
| 中等密度 | 上下文与活动合并；遵循整个 HUD 的行预算 |
| 窄屏 / 极短高度 | 精简树或数量/活动/失败摘要，必要时按模块优先级隐藏 |
| 高度 ≥12 / 8–11 / 5–7 | 最大展开 4 / 2 / 1 层，根计作一层；更深处显示省略提示 |
| 高度 <5、可用行 <3 或宽度 <24 | 摘要模式 |

活动及失败分支优先，通常展示最近 5 个完成/取消节点；连接树所需的祖先可以额外保留。隐藏节点仍反映在统计或省略提示中。全部活动节点是否展开受实际终端行数限制，不承诺短终端能展开全部节点。

符号 `● ○ ✓ ✗ ⊘ ?` 在 `NO_COLOR` 下保留含义；名称用短 ID 后缀消歧，未知 Context 显示 `—`。耗时复用既有每秒重绘时钟，不写 Store、不读文件。根 idle 时只要还有活动子代理，`hide_when_idle` 就不会隐藏 HUD。

用户通过 `codex-hud setup` 选择“子代理”。CLI 明确启用 multi_agent 时，即使尚无历史事件也允许选择；未检测到、CLI 已关闭和来源不可读分别解释，不把未观察到当成 unsupported。未勾选 agents 时继续采集关联状态，但不显示模块。已有用户配置保持原样。

doctor 显示 CLI feature 来源、事件检测、活动/完成/失败计数和关联强度；debug 增加代理发现、读取、能力及脱敏树。单次 debug 的 watcher 状态不代表另一个持续运行的 HUD。

## 11. Context / Token association

每个线程拥有自己的既有 `HudStateReducer(false)`，因此 TokenTracker 继续使用累计快照覆盖语义。Agent 的累计 Token、最近上下文、模型与推理强度来自本线程，不混入根或兄弟线程。

Context 继续使用 `last_token_usage.total_tokens / model_context_window`，压缩清除旧估算，无可靠数值时显示 `—`。实际 explorer/tester 累计 Token 分别为 1,077,643 / 681,570；single 的累计 Token 为 44,128，最近用量 22,218，窗口 258,400。根不对这些数值求和。

## 12. Activity association

子线程普通事件交给自己的 ToolTracker 和 ActivityTracker，归一化 Agent 事件交给根 AgentTracker。即使不同线程使用相同 call_id 或 turn_id，活动仍隔离。

HUD 展示安全活动标签，例如读取文件或执行工具，不展示完整任务 prompt、命令脚本或工具输出。沿用 Phase 3 的来源限制：当前 Desktop 未提供内层命令独立 start 及可靠外层父调用关联，运行中可能显示外层“工具调用”，具体 read/search/shell 结果在完成记录到达后显示。

## 13. EMFILE fallback

沿用最多一个根 rollout 目录原生 watcher、一个根 Reader 的 3000 毫秒补查 timer，以及一个 Provider 的 3000 毫秒 rediscovery timer。子代理只在同一串行刷新中读取新增字节。Runtime 的渲染时钟仍是既有时钟，不按代理增设。

真实原生监听发生异步 EMFILE 后，activeWatchers 为 0、mode 为 polling，子线程仍持续更新。debug/doctor 保留原因；补查可用时不占用 HUD 提示区域。同步和异步 EMFILE 均有集成测试。当前执行环境的原生通知成功送达仍未验证。

## 14. Runtime test

真实实验使用本次 Desktop 任务和真实子代理。HUD 在 PTY 中运行构建后的 `createProgram().parseAsync(["start"])`，只通过临时配置启用 Agents、Tools、Current Activity 等模块；Provider、Runtime、Renderer 和 TerminalController 均为实际实现。

| 场景 | 证据与结果 |
| --- | --- |
| 单代理 | `single_probe` 实际读取 package.json 并返回项目名称；spawn/start/read/completion/父收到结果均有原始行证据 |
| 并行逆序完成 | pipeline_scout `00:06:16.521→00:13:35.201`，ui_capability_scout `00:06:30.284→00:12:07.737`（UTC）；B 先完成，身份/Token 不串线 |
| 实时并行 | 后续 slow/fast 实验在 PID 67562 中有 6 份快照同时显示两者 running，随后各自完成 |
| 嵌套 | nested_probe/leaf_probe 构成真实三层；叶子直接父 ID 正确，各自有 Token 与生命周期 |
| 工具失败 | slow 内部无害命令真实退出码 7；工具 failed，代理 completed，没有混淆 |
| 最终构建快照 | 9 节点，strong / nested / context / token 能力均确认，解析诊断为空 |
| NO_COLOR 与尺寸 | 最终 debug 验证 120×24、80×16、50×10、24×6、10×4，均不越界、无 ANSI；最短终端可按优先级隐藏 Agents |

第一轮定时 PTY 没有完整捕捉所有并行过程，因此不以它证明完整并行。补做的状态触发实验用于运行中重启；逆序完成证据来自前述最初两名探索代理，两者没有混为同一实验。

## 15. Session switch

自动测试验证旧主会话切换后旧代理清除。最终构建另外读取两份真实来源，受控选择 A→B→A：

| 来源 | 主线程 ID | 树节点数 | 结果 |
| --- | --- | --- | --- |
| A | `01a092ed-87ba-7752-baaa-8a946263d93e` | 9 | strong，无诊断 |
| B | `01a09291-bae7-7370-aed2-27ee84aaf892` | 7 | strong，完全不含 A 的节点 |
| 返回 A | 同 A | 9 | 恢复相同身份集合，无 B 节点 |

切换仅控制 Provider 的来源选择，读取未经修改的真实文件；没有修改真实日志或数据库。这证明文件状态隔离，不冒充新 CLI 正常退出/启动后的自动跟随闭环。该 Phase 2 遗留验收仍见 [原报告](phase2-live-runtime.md)。

## 16. Restart

真实 PID 67320 捕获 slow 从 completed 进入新 turn 的 running；持续运行约 3 秒后 SIGINT，退出码 0。随后新 Node 进程 PID 67562 首轮回放恢复仍在运行的 slow，继续观察到它完成，树没有归零。

两进程分别记录 29 / 33 份 Provider 快照、输出 5,216 / 8,880 字节；开始/结束由实际状态触发，不以固定等待时间假装实验成功。重放、子文件恢复和无新增字节重复读取另有集成测试。

## 17. SIGINT 与资源释放

五次真实 PTY HUD 进程均退出码 0，光标与备用屏恢复标记齐全。最后一次使用最终源码构建：PID 78926，运行 15.08 秒，120×24→80×16→50×10→120×24，输出 2,995 字节，无整屏清空序列。

最后一次记录 10 份快照：根首次读 4,393,313 字节，之后只有一次新增 20,787 字节，其余为 0；停止后 watcher 为 inactive、activeWatchers 为 0。多代理验收中的几个边界修复由最终回归测试覆盖，最终构建另外完成此轮 PTY 检查，没有把旧构建误称为最终构建。

集成测试连续两轮 start/SIGINT/stop 验证 watcher、timer 和 signal listener 归零；原有 Runtime/StateStore 测试继续覆盖取消订阅、迟到回调和重启。真实进程均已结束，无遗留 HUD。

## 18. Security / sanitization

- 复用 `Redaction.ts` 的凭据过滤与摘要截断，覆盖 authorization、bearer、token、api_key、apikey、password、passwd、secret、cookie、credential、private_key、access_token、refresh_token 等形式。
- Parser 不把 Agent prompt/message/原始工具输入输出保存进 AgentState。展示名称、路径末段和 Activity 摘要；错误不输出堆栈。
- debug 使用 Agent 字段白名单重新建立树，再统一脱敏；额外字段、原始命令和 prompt 不会透传。
- 9 个 fixture 共 239 条记录，均有原始文件/行号索引。字段经过筛选，正文替换，线程身份及任务路径对应一致；保留字符串/数组返回容器与 wait 的 JSON 结构。轮次与调用 ID 是关联标识，未将它们误称为凭据。
- 坏行、路径不可读和 schema 异常只报告固定说明、错误码及定位，不把原始 JSON 错误中的正文打印到终端。

源码测试验证凭据遮蔽、未知字段白名单、控制字符和纯文本布局。样本模式扫描未发现用户目录、邮箱、URL、常见凭据或未替换正文；这不是对任意自由文本都无敏感信息的普遍保证。

## 19. Tests count 与修改范围

| 检查 | 结果 |
| --- | --- |
| Phase 3 基线 | 28 文件 / 309 passed |
| AgentEventParser 与 Discovery/归一化 | 33 项新增 |
| AgentTracker | 22 项新增 |
| AgentTree | 12 项新增 |
| AgentRendering、能力与脱敏 | 24 项新增 |
| AgentLive 文件/Runtime 链路 | 20 项新增 |
| 合计 | 新增 111 项；33 文件 / **420 passed** |
| `npm run typecheck` | PASS |
| 源码 + 测试 TypeScript 检查 | PASS，98 个文件；临时扩展 include/rootDir，未修改项目 tsconfig |
| `npm run build` | PASS |
| 构建入口 debug / doctor / PTY | PASS；EMFILE 与缺失 quota 如实报告 |

50 / 100 子代理测试均只创建一个 watcher 和两个既有 Provider/Reader timer；停止后为 0。1,045 个静态结束子线程第二次读取仅保留 20 个流且 bytesRead 全为 0。另覆盖上限释放、新代理接入、旧 turn 迟到 wait、父字段冲突、环、orphan、缺失/重现、半行、截断和线程工具 ID 碰撞。这些检查证明有界性，不是长期内存或吞吐量基准。

主要新增路径：

- `src/core/AgentEvents.ts`、`AgentState.ts`、`AgentTracker.ts`、`AgentTree.ts`。
- `src/providers/codex/AgentMetadata.ts`、`AgentEventParser.ts`、`RolloutAgentProvider.ts`。
- `src/renderer/modules/AgentModule.ts`。
- `tests/AgentTracker.test.ts`、`AgentTree.test.ts`、`AgentRendering.test.ts`、`providers/AgentEventParser.test.ts`、`runtime/AgentLive.test.ts`、辅助 `tests/agents.ts` 和 9 个真实 fixture。

既有接口修改集中于 HudState/HudEvent/Reducer、Codex Discovery/Session/Parser、Agents/Layout/Renderer、Runtime、CapabilityDetector、CLI Diagnostics。旧 ToolLive 测试装载 fixture 时同步调整显式 thread_id，使其与临时线程身份一致。README 和两份 Phase 4 文档更新，`dist/` 已重建。package/lock、tsconfig、配置实现、演示数据和 Phase 2/3 文档保持原样；当前目录没有 Git 仓库，以开始前 SHA256 基线核对变更。

## 20. Known limitations

| 项目 | 分类与影响 |
| --- | --- |
| Agent 级 failed | unknown / not observed；不能宣称真实失败全链路已验收 |
| spawn call 到 child UUID | 当前返回 unavailable；不影响 metadata 的强父子树 |
| CLI 配置与 Desktop 配置 | 不同来源，不能相互推断 |
| 原生文件通知送达 | 当前环境未验证；真实 polling 已通过 |
| 其他 rollout 写入版本、stdout 完整性 | 未验证；未知字段不猜测 |
| 历史和读取安全窗口 | 超限会提示未采集；不承诺无限历史及窗口外任意乱序恢复 |
| 主会话选择 | 当前目录/最近修改策略，不识别用户聚焦窗口或存活进程 |
| Phase 3 内层工具 start | 沿用现有限制，详见该阶段记录 |
| Phase 2 新 CLI 多轮退出/重启、非空额度 | 原有遗留，本阶段未宣称解决 |

## 21. 未完成项目与下一步

Phase 4 的剩余验收是取得真实 Agent 级失败事件，确认其 schema，再增加对应 fixture 和完整链路测试；在此之前总体保持 PARTIAL，已有可靠的 Agent Tree 可以使用。未通过工具失败、虚构事件或篡改真实日志制造 Agent failed。

建议下一步先补齐这一验收缺口，再由用户决定是否进入 Phase 5。MCP、Skills、Plan、Cost、Cache 和 App Server 均未扩展。

本地验收日志位于 `/var/folders/77/qmfl9p5n6318ls5mz55x8qhc0000gn/T/codex-hud-phase4-_nzaom66`，包含安全快照、PTY 输出、会话切换结果及基线；临时目录可能被系统清理，主要结果已记录在本文。
