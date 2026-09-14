# Phase 10 完成报告

## 1. 状态

**PHASE 10 STATUS: PARTIAL**

Phase 10 的本地加固、自动化、基准、真实来源观测和文档已完成。最终构建经过完整 30 分钟真实 Rollout 观测，31 次身份与 Token 一致性检查全部通过，停止后活动资源归零。完整回归仍有 18 项因沙箱禁止 Unix socket 监听而失败，真实 App Server 附着与断线恢复也缺少可用环境，因此不能给整条真实实时链路标记无条件 PASS。

| 证据等级 | 本轮结果 |
| --- | --- |
| IMPLEMENTED | 内部诊断、来源健康、事件校验、恢复、隔离、资源边界、错误边界与测量脚本已实现 |
| AUTOMATED VERIFIED | 完整运行中 1081 项通过；剔除受阻文件的独立运行 1058 项通过；类型检查、构建通过 |
| REPLAY VERIFIED | 重复/迟到/乱序、会话切换、重连、重启、计量、业务夹具和一万请求压力验证通过 |
| REAL RUNTIME VERIFIED | 当前真实 Codex 的 Rollout 分支、主/子线程状态、HUD 重启、九宽度渲染和最终构建 30 分钟观测 |
| ENVIRONMENT LIMITED | 本机 socket 回归、进程身份核验、真实 App Server 附着/重启/交接，以及缺少实际样本的部分模块 |
| NOT APPLICABLE | 本阶段不执行服务安装、发布、外部 Runtime 终止或 V2 功能开发 |

## 2. 环境

| 项目 | 实际值 |
| --- | --- |
| 日期 / 时区 | 2026-09-13 / Asia/Shanghai |
| 项目 | `/Users/bindo2/Workspace/DevelopProject/Demo/codex-hud` |
| HUD | 0.1.0 |
| Codex CLI | 0.154.0 |
| 当前 Desktop rollout writer | 0.153.4 |
| Node / npm | v23.11.0 / 10.9.2 |
| OS / 架构 | macOS（darwin）/ arm64 |
| 真实来源 | 当前任务明确线程 ID 对应的 Rollout |
| 实际 authority | fallback-rollout；进程核验 EPERM，共享 socket absent |
| 终端验证 | 内存终端、纯文本与布局检查；本轮未执行物理 TTY 操作 |

本机 `codex app-server --help` 已实际检查，没有启动 daemon 或独立 Codex。官方网页正文的联网复核受 DNS 限制；已登记的 pricing 不意味着本轮重新核验了线上价格。

## 3. 变更

保持既有 Runtime → Source → Event → Reducer → Trackers → HudState → Renderer 架构，没有增加 HUD 大模块或依赖。主要修复包括：

- 旧轮次、旧历史失败和旧连接异步结果不能覆盖当前会话；文件截断至空后的延迟新身份仍能重新发现。
- 跨来源旧 Token 镜像可以完成交接，相同 Token 的上下文窗口 A→B→A 不重复计费。
- 清理失败保留资源引用并阻止新连接替代；失败停止后重启继续保有事件订阅。
- 通知队列、身份缓存和解析诊断有界，单条事件或模块异常不会抹掉其他正常状态。
- Renderer 后续更新或 resize 可恢复；输出超时取消实际 Writable，迟到失败不会变成无人处理的 error。

设计、边界与错误处理细节见 [生产加固说明](phase10-production-hardening.md)。

## 4. 可观测性

新增独立 `HudDiagnostics`，不把内部计数塞入普通 HudState。记录 runtime、source、session、events、render、recovery、performance、memory；告警按 code 聚合，最多 20 项。

来源支持 healthy、starting、connecting、stale、reconnecting、fallback、disconnected、failed、unknown。默认 60 秒无事件标记不新鲜；stale 与连接失败分开。doctor/debug 显示版本、来源、authority、ownership、事件年龄、恢复、资源和计时，错误有可定位的脱敏原因。

`processed` 是成功归约次数，包含 Tracker 判定无变化的调用；不是独立请求数。`rawUnknown` 包含合法但没有专用 HUD 映射的原始行，不能把它当成解析失败。停止后反复读取诊断不会增加恢复计数。

## 5. 可靠性

入口验证空值、未知事件、来源、身份、时间与顺序；Parser、Reducer、发布微任务及 Renderer 的异常分别报告。晚到的旧线程/轮次不会抢占当前活动、Token、模型或计划。退休 Agent 只有明确的新轮次才可恢复。

累计 Token 快照不相加；cached input 属于 input，reasoning output 属于 output。请求账本只累计已确认请求或增量。Quota 与费用独立，Cost 始终是估算；真实缓存写入计费契约不明时保持 unavailable。

最终真实观测 31 次分别核对主会话身份、Token 子集/总量，以及已消费 offset 前最后完整 token_count 的累计分项，全部一致。一万请求合成输入刻意重复 Token 快照，最终仍准确计为 10000 请求、10000 轮、1100000 Token。

## 6. 恢复

复用既有有界指数退避，默认基础 1 秒、上限 30 秒、连续失败最多 8 次。既有低频刷新触发一次有界只读健康检查，正常 idle 不重连；generation/selection 变化使旧请求结果失效。

自动化覆盖静默连接、账户请求期间断线、历史迟到失败、清理失败重试，以及 30 轮 A→B→A→断线→Source 重启。另有 20 轮同一 Provider start/stop 和 30 轮 Runtime 信号清理。真实新 Provider 重读同一线程时，稳定 offset 下 usage 一致。

真实观测中的 7 次重连计数是初次连接失败后的重试，没有成功连接后的真实断线，不能作为 App Server 恢复成功的证据。

## 7. 资源安全

| 资源 | 边界或最终观测 |
| --- | --- |
| 请求账本 / 根轮次身份 / Source 去重身份 | 512 / 2048 / 2048 |
| 活动工具 / 近期工具 / Agent 总数 | 64 / 20 / 256 |
| StateStore 待通知 / 单轮重入通知 | 64 / 256，超限可诊断 |
| 根 watcher | 最多 1；实际 EMFILE 后使用集中增量轮询 |
| 最终真实运行资源 | 订阅数量稳定；timer 有界；无实际 socket 或子进程连接 |
| 最终 stop | 活动资源 `{}`，输出监听器 `[]`，订阅/timer/watcher/client/pending 全部为 0 |

更完整的集合边界见 [资源表](phase10-production-hardening.md#资源边界)。有界窗口之外又缺少时间或顺序依据的旧身份会被保守拒绝并提示，不能承诺无限久远事件仍可精确去重。

保留的 5 个 Agent reader 是游标/状态对象，不持有长期文件描述符。外部 PID 仅用于核验；仅 HUD 创建的传输子进程可以由 HUD 停止。真实外部 socket 所有权测试仍受沙箱限制，不能把合成信号测试升级为完整真实进程验收。

## 8. 性能

| 场景 | 结果 |
| --- | --- |
| 一万请求合成回放 | 503.58 ms；GC 后堆内存约 9.6 MiB，窗口填满后趋稳 |
| 合成协议启动 / 完整重连 / 清理 | 45.64 / 38.93 / 2.35 ms |
| 最终真实观测 | 1800078.05 ms，31 样本，2676 次累计渲染 |
| 真实 heapUsed 最小 / 最大 / stop 后 GC | 13.46 / 30.35 / 11.67 MiB |
| 真实 RSS 采样峰值 / 平均 CPU | 127.94 MiB / 单核约 1.21% |
| 真实 render 均值 / 最大 | 2.44 / 12.92 ms |
| 真实最近归约至渲染均值 / 最大 | 13.42 / 142.66 ms，49 个合并样本 |

Renderer 不扫描进程、socket 或日志。150 ms 配置仅控制渲染节流；来源使用已有低频发现、增量读取和统一子线程读取。性能定义、采样、I/O 和限制见 [性能报告](phase10-performance.md)，这些数字不构成跨设备延迟承诺。

## 9. 验收矩阵

完整 20 项能力和 A–L 实验见 [验收矩阵](phase10-acceptance.md)。用户要求的五项判断如下：

| 判断 | 自动化 / 回放 | 真实链路结论 |
| --- | --- | --- |
| 长时间稳定 | 一万请求压力与错误恢复通过 | 最终构建 30 分钟 Rollout 分支通过；未连续一小时 |
| 断线恢复 | 重连、退避、历史同步、清理失败通过 | App Server 真实断线 ENVIRONMENT LIMITED |
| 状态不串 | A→B→A、迟到/旧事件、Agent 隔离通过 | 真实根/子线程身份稳定；真实用户切换 NOT VERIFIED |
| 资源不泄漏 | 多轮启动/停止/重连、缓存上限通过 | 30 分钟未见持续增长，stop 活动资源归零；仅限 HUD 观察进程 |
| 不重复计量 | 重复快照、跨源镜像、费用与缓存不变量通过 | 31 次真实累计分项对照一致；真实双源交接仍受限 |

## 10. 测试

| 命令 / 范围 | 结果 |
| --- | --- |
| `npm test -- --reporter=dot` | 78 文件、1099 项；74 文件/1081 项通过，4 文件/18 项失败 |
| 排除四个受阻文件的回归 | 74 文件、1058 项全部通过 |
| Phase 10 新增 | 3 个测试文件、55 项测试；历史业务与 Runtime 测试继续执行 |
| `npm run typecheck` | 通过，0 类型错误 |
| src + tests 严格 TypeScript 检查 | 通过 |
| `npm run build` | 通过；最终 JavaScript 与真实观测构建一致 |
| 两个测量脚本 `node --check` | 通过 |

18 个失败全部发生于 Unix socket `listen EPERM`，涉及 `RuntimeDiscovery.test.ts`、`ExternalAttach.test.ts`、`ManagedDaemon.test.ts`、`ExternalProcessSafety.test.ts`；初始基线同样有这 18 个环境失败。四文件另有 23 项在完整运行中通过，所以不能将 1058 项结果称为完整回归。

完整命令确实执行且返回失败；没有删除测试、改成 skip 或吞掉错误。扩大权限重跑被自动审批服务 HTTP 404 拒绝，原因是所配置审批模型 `gpt-5.6-luna` 不受上游支持。详细用例及日志见 [verification.json](evidence/phase10/verification.json)。

额外启用未使用项和不可达代码检查后，发现 3 处基线已有未使用项：`RolloutReader` 导入、`event(method)` 参数及 `TokenUsage` 类型导入；相关声明/方法与原始版本一致，本阶段新增诊断为 0。按修改范围要求保留这些既有项，证据见 [静态审计](evidence/phase10/static-audit.json)。新增代码未发现 TODO/FIXME、临时绕过或调试 console.log；文本编码、文档引用和最终构建一致性纳入 [质量检查](evidence/phase10/quality-checks.json)。

## 11. 真实 Runtime 验证

本轮实际走通的分支为：

```text
当前真实 Codex 写入 Rollout
  → RuntimeDiscovery / Authority 识别受限并选择 fallback-rollout
  → RolloutSource / Event normalization / SourceDeduplicator
  → HudStateReducer / Trackers
  → HudState / StateStore
  → HudRuntime / HudRenderer / LayoutEngine / TerminalController
  → 内存终端输出
```

最终轮为北京时间 **18:51:47–19:21:47**，无中断、无不变量违例、无解析/归约/渲染错误或清理失败。较早构建另有一次 30 分钟，两轮不能合并宣称连续一小时。

真实样本包含模型 gpt-6-astra、reasoning high、Context/Token/Cache、工具完成与时长、根和 5 个子代理。日志形态统计观察到 CommandExecution 105 条、FileChange 22 条、外层工具调用 82 条/返回 81 条；这些数量不等同于请求计数。Plan 更新为 0，MCP 运行服务为 0，技能发现 15/可用 14/活动未观测，Quota 窗口为空，Cost 为 unavailable。

真实 HUD 重启在同线程、同 offset 下账本一致。30/40/50/60/80/100/120/140/160 列均无布局越界、ANSI 残留或渲染问题。实际文件监听失败为 EMFILE，集中 3 秒增量轮询仍持续更新。没有为了测试重启外部 Codex 或制造实际模型请求。

## 12. 环境与证据限制

1. **完整 socket 回归、真实 App Server 附着/重启/双来源交接。** 沙箱禁止本机监听与进程身份核验，共享 socket 未发现，提权又被审批服务模型配置错误拒绝，属于环境限制。相关实现和合成测试已完成，但不能据此认证实际 shared/managed/owned Runtime 的全部运行行为。部署依赖 App Server 时必须在合适环境补验，当前可用分支为 Rollout 回退。
2. **非空 Quota、真实金额对照、MCP 连接/调用、Skill 活动和当前版本 execution Plan。** 本轮来源没有相应运行样本；代码适配与回放存在，但真实有效性未完全确认，部分属于环境数据缺失，部分明确为 NOT VERIFIED。生产表现可能为空、隐藏或 unavailable，不能保证未观测的 live 字段；Cost 不应被当成账单。
3. **物理 TTY、真实用户 A→B→A、连续一小时以上和外部 Codex 资源趋势。** 本轮只做内存终端、真实 HUD 重读及两轮独立 30 分钟观测，没有为验收操作外部 Runtime 或用户任务。对应控制逻辑有自动化证据，但实际交互与更长时间窗口尚未覆盖；这些是验收范围限制，不能将 HUD 自身的资源结果推广到外部 Codex。

## 13. 安全

未修改用户配置，未读取 Codex SQLite/WAL，未自动启动/停止真实 daemon，未安装服务或更改 launchctl，未向外部 Codex 发送终止信号。未执行 commit、push、创建分支或 PR。

新增诊断采用固定字段与脱敏，短线程 ID，有限告警；归档不包含日志正文、工具参数/输出、完整环境变量、配置内容或凭据。实际错误保持可见，来源不可用或费用契约不确定时不填虚假成功值。

## 14. 配置完整性

两份配置的执行前后 SHA-256 完全一致：

| 文件 | 前后相同的 SHA-256 |
| --- | --- |
| `~/.codex/config.toml` | `67262bf4557d91b2fe27c92bc146d34e1cb8808921a0483957d82686ae465de1` |
| `~/.codex-hud/config.toml` | `be903bf9937bda8529c4802f9887ae025bd6b3461f4e199f3191a0a699bd93c3` |

项目配置格式与默认行为兼容，没有新增必填设置；`package-lock.json` 未变化，未新增依赖。核验时间与结果见 [配置证据](evidence/phase10/configuration-integrity.json)。

## 15. 涉及文件

| 范围 | 文件 |
| --- | --- |
| 新增诊断 / 校验 | [HudDiagnostics.ts](../src/core/HudDiagnostics.ts)、[EventValidation.ts](../src/core/source/EventValidation.ts) |
| 状态与事件 | `src/core/{HudStateReducer,AgentTracker,StateStore}.ts`、`src/core/source/{DataSource,SourceDeduplicator}.ts` |
| 来源与增量读取 | `src/providers/codex/{CodexSessionProvider,RolloutAgentProvider,RolloutReader,RolloutSource,RolloutEventParser}.ts` |
| 连接与所有权 | `src/providers/codex/app-server/{AppServerProtocol,AppServerSource}.ts`、`src/providers/codex/runtime/RuntimeConnectionManager.ts` |
| 运行 / 渲染 / CLI | `src/runtime/HudRuntime.ts`、`src/renderer/HudRenderer.ts`、`src/cli/{Output,Program,Diagnostics,RunHud}.ts` |
| 新增测试 | [Phase10Reliability.test.ts](../tests/Phase10Reliability.test.ts)、[Phase10Recovery.test.ts](../tests/Phase10Recovery.test.ts)、[Phase10Pipeline.test.ts](../tests/Phase10Pipeline.test.ts) |
| 回放索引 / 夹具 | `tests/fixtures/reliability/{README.md,handoff.json}` |
| 可重复测量 | [phase10-benchmark.mjs](../scripts/phase10-benchmark.mjs)、[phase10-soak.mjs](../scripts/phase10-soak.mjs)、`package.json` scripts |
| 文档 / 证据 | `README.md`、四份 `docs/phase10-*.md`、`docs/evidence/phase10/` |
| 构建产物 | dist：52 个已有文件更新，6 个文件新增 |

19 个既有源文件修改，2 个源文件新增。项目没有 Git 仓库，使用执行前 596 文件 SHA-256 基线比较；没有删除基线文件。既有 `.DS_Store` 早于本次任务，不纳入项目变更，也未清理。逐文件前后哈希及新增文件见 [变更清单](evidence/phase10/changes.json)。

## 16. 证据

[证据索引](evidence/phase10/README.md) 包含完整测试失败日志、可执行回归、构建/类型输出、一万请求基准、真实 31 样本、doctor/debug 摘要、配置完整性及最终质量检查。最终构建指纹为：

```text
40646bf8c5ba034050a3a881921b2b565a6204d7d47e8e4ce3570a6bd278858f
```

原始本地工作日志与基线位于 `/private/tmp/codex-hud-phase10-hmg7k5zd`。项目内归档保留长期复核所需的安全内容，不依赖临时目录永久存在。

## 17. 最终判断

在已覆盖场景中，真实 Rollout 分支持续运行、计量与会话身份一致，异常可诊断，停止后活动资源释放；断线、重启和切换的状态恢复已由自动化与回放验证。尚不能证明真实 App Server 全链路、所有外部进程交互或无限时长均无问题。

PARTIAL 的三个原因是：完整 socket/真实 App Server 验收受环境限制；部分真实业务字段缺少运行样本；物理终端、真实切换及更长连续运行未覆盖。它们的代码状态和生产影响已分别列于第 12 节。

## 18. Future / V2

本轮没有新增 V2 需求，也没有实现 Web、远程面板或其他扩展。后续如继续工作，应先补齐本报告已列明的验收缺口；本阶段到此停止，不进入 Phase 11。

**PHASE 10 STATUS: PARTIAL**
