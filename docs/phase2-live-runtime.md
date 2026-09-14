# Phase 2.6 实时运行与验收记录

记录日期：2026-09-11。实时 HUD 实现、本地集成测试与真实 PTY 检查已完成；真实 Codex CLI 的多轮对话、退出和重启闭环受执行沙箱与审批服务故障限制，尚不能宣告 Phase 2 完整验收。

## 实现

`HudRuntime` 管理启动、运行、恢复、停止和重启。数据沿现有链路进入 StateStore，订阅只使调度器失效；Renderer 和模块仍然只消费归一化状态。

```text
Discovery → RolloutReader → Parser → Reducer → StateStore
                                                  │
                                                  ▼
                                           RenderScheduler
                                                  │
                                                  ▼
                                             HudRenderer
                                                  │
                                                  ▼
                                         TerminalController
```

- Provider 首次回放已有文件，再监听追加；建立监听后补读一次，覆盖回放与监听之间的追加。文件事件不重复 Discovery，每 3 秒独立发现新会话，覆盖跨日期目录。读取串行，通知合并。
- 新 Session、文件替换、截断或消失时重建会话状态；累计 Token 使用最新快照，Context 使用最近用量除以窗口。缺少有效窗口时隐藏 Context。
- Discovery/Reader 故障保留可见诊断并重试；坏行跳过，半行等待补齐。旧文件的监听诊断不会带入新会话。
- StateStore 提供独立订阅快照、取消订阅、重入顺序及同步/异步回调异常隔离。异常只保留计数和最近消息，避免无界积累；Provider 输出脱敏诊断。
- RenderScheduler 合并状态变化，按 `refresh_ms` 限流；慢输出时只保留待更新状态，不并发绘制。显式 flush 用于首帧与 resize，stop 等待在途输出。
- TerminalController 集中处理 ANSI，使用备用屏幕和行差异更新；相同内容不写 stdout，常规刷新不清整屏。resize 重建当前可见行，输出失败或关闭均能结束等待。
- 会话时长每秒更新一次，不触发文件读取。没有可靠的 idle 判据时继续显示，保留原有明确 `activity.status=idle` 的隐藏规则。
- SIGINT/SIGTERM 幂等清理；释放期间保留信号处理，关闭 watcher、停止调度器和时钟、取消订阅、恢复光标及主屏。进程 exit 提供同步恢复，旧启动流程不能进入新生命周期。
- `start` 与已有配置的默认入口使用真实来源；首次无参数入口的 setup 保留。`start` 没有配置时使用内存默认值，不写配置、不占用 stdin。非 TTY 输出一次纯文本快照后退出。
- `doctor` 增加 TTY、stdout 和 Renderer 检查；`debug` 增加终端、渲染间隔、启用/可见模块，明确显示为单次快照，不声称正在查询另一个常驻 HUD。

## 文件清单

新增源码：

- `src/runtime/HudRuntime.ts`
- `src/runtime/RenderScheduler.ts`
- `src/runtime/SignalHandler.ts`
- `src/terminal/TerminalController.ts`

修改源码：

- `src/cli/Program.ts`、`RunHud.ts`：真实启动入口及非 TTY 行为。
- `src/cli/Output.ts`、`Diagnostics.ts`：输出关闭处理、运行诊断及清理错误脱敏。
- `src/core/StateStore.ts`：订阅隔离、重入顺序和错误记录。
- `src/providers/codex/CodexSessionProvider.ts`：持续发现、增量监听、恢复及停止发布门控。
- `src/renderer/modules/Context.ts`：窗口与用量同时有效才显示。

新增测试及辅助文件：

- `tests/StateStore.test.ts`
- `tests/providers/CodexLive.test.ts`
- `tests/runtime/HudRuntime.test.ts`
- `tests/runtime/LiveRollout.test.ts`
- `tests/runtime/RenderScheduler.test.ts`
- `tests/runtime/fixtures.ts`
- `tests/terminal/TerminalController.test.ts`

更新 `tests/CLI.test.ts`、`tests/ModuleRegistry.test.ts`、`tests/Redaction.test.ts`，以及 README、前期 rollout 记录和本文。构建产物位于 `dist/`。依赖、配置 schema、setup 推荐规则和 Git 状态未改动；当前目录本身没有 Git 仓库。

## 自动验证

| 检查 | 结果 |
| --- | --- |
| 原始基线 | 17 个文件、176 项测试通过 |
| 新增覆盖 | 46 项；包含现有测试文件增加的用例 |
| 最终测试 | 23 个文件、222 项通过 |
| `npm run typecheck` | 通过 |
| 源码和测试 TypeScript 检查 | 通过，76 个文件；临时检查将 rootDir 扩展到项目根目录，不改项目 tsconfig |
| `npm run build` | 通过 |
| 已构建 `start --help` | 中文帮助正确 |
| 已构建 `doctor` | 真实来源、终端与 Renderer 检查正常；额度及尚不存在的用户配置如实报告 |

完整文件链路测试由真实临时 JSONL、Discovery、Reader、Parser、Reducer、Store、Scheduler 和 Renderer 组成，终端与时钟可控。累计量 `10000 → 15000 → 18000` 最终是 `18000`，Context 分别为 `10% → 15% → 18%`；会话切换 `100000 → 2000` 不累加。另覆盖半行、坏行、截断、消失、跨日期新会话、停止后的迟到回调、慢发现、慢输出、订阅异常与重复信号。这些合成输入仅用于软件测试，不冒充真实 Codex 对话。

## 真实运行观察

- 环境：macOS、Node.js `v23.11.0`，安装的 Codex CLI 为 `0.154.0`。本次成功读取的现有会话写入版本为 `0.153.4`。
- 使用临时 HUD 配置启用 Model、Reasoning、Context、Session、Token 和两个额度模块；用户的 `~/.codex-hud/config.toml` 不存在，本次未创建它。临时入口仅注入该配置路径，调用构建后的同一个 `createProgram().parseAsync()` 和 `start` 命令。
- HUD 在真实 PTY 中长期运行，先显示等待，再回放实际会话。已有真实会话显示 `gpt-6-astra / high`；同一会话的 HUD 从约 `2.8M` 累计 Token、`69%` Context 更新到 `3.6M`、`71%`。最终快照为累计 `3,557,064`、Context `184,018 / 258,400 = 71.2144%`。
- 实际 Token 明细包含输入、输出、推理输出、缓存输入和总计；最终快照分别为 `3,493,672`、`63,392`、`29,994`、`3,054,700`、`3,557,064`。会话创建时间、轮数和最近活动来自 rollout，经过时长持续变化。
- 当前实际 `rate_limits` 没有可显示窗口，额度模块隐藏。没有声称完成非空额度的验证。
- 本次执行环境中原生 `fs.watch` 返回 `EMFILE`，HUD 显示原因并使用已有的默认 3 秒增量补查，真实更新验证覆盖的是这条补查路径。成功监听分支由可控事件测试覆盖，原生监听成功仍待执行环境允许时确认。
- 在没有当前目录会话的临时工作目录，回退选择会在多个最近写入的真实主会话之间切换。这验证了持续重新发现，也说明使用时应让 HUD 和 Codex 位于同一工作目录；此观察不能替代目标 CLI 的退出重启测试。

独立 PTY 检查使用真实会话数据和配置，验证了 `140×20`、`120×15`、`80×10`、`60×8`、`50×5`、`40×4`，以及连续 `140 → 100 → 80 → 60 → 120` 列 resize。所有写入均在可见宽高内，没有 `NaN`、`undefined` 或整屏清空序列。该次检查 stdout 共写入 4,884 字节；Ctrl+C 退出码为 0，光标、主屏恢复，stdin 的 ICANON/ECHO/ISIG 标志保持不变。

## 11 步验收与阻塞

| 步骤 | 当前证据 |
| --- | --- |
| ① `codex-hud start` | 构建入口、临时配置入口和真实 PTY 均通过 |
| ② 启动真实 Codex CLI | 已尝试，启动被本地数据库只读限制阻止 |
| ③ 发第一条消息 | 未完成目标 CLI 对话 |
| ④ Token 变化 | 已有真实会话与文件集成测试通过；目标 CLI 待验收 |
| ⑤ Context 百分比变化 | 已有真实会话与文件集成测试通过；目标 CLI 待验收 |
| ⑥ 再发消息 | 未完成目标 CLI 对话 |
| ⑦ 数字继续变化 | 已有真实会话与文件集成测试通过；目标 CLI 待验收 |
| ⑧ Codex 正常退出 | 目标 CLI 尚未成功进入可用会话，不能算完成 |
| ⑨ HUD 不崩溃 | 实际 CLI 启动失败时 HUD 持续运行；停止写入及消失测试通过，正常 CLI 退出场景待验收 |
| ⑩ 再启动 Codex | 待恢复审批服务后继续验收 |
| ⑪ 自动跟随新 Session | 实际多主会话重新选择和文件集成测试通过；目标 CLI 重启闭环待验收 |

真实 CLI 使用 `--sandbox read-only`，在临时工作目录发起只回复固定文本的验收请求。初始 PTY 的 `TERM=dumb` 已通过为该测试进程设置 `TERM=xterm-256color` 解决。后续确切错误为 `state_5.sqlite: attempt to write a readonly database`：当前执行沙箱不允许 Codex 写入自己的运行目录。

针对该启动操作的沙箱外执行申请被自动审批拒绝。审批服务调用 `gpt-5.6-luna`，上游表示不支持该模型并返回 HTTP 404；这不是 HUD 的执行失败。官方文档访问也被同一审批故障拒绝，CLI 参数依据本机 `--help` 核实。本次没有修改审批设置、Codex 数据库或认证文件，也没有用其他途径绕过拒绝。

## 已知限制与后续验收

- Discovery 沿用当前目录优先、最近修改主会话的策略，并排除子代理；不会识别用户正在聚焦的终端，也不能仅凭残留 rollout 判断进程是否退出。保留最后数据继续跟随是当前策略。
- Context 是最近一条用量快照的估算，显示为整数百分比；小幅用量变化不一定跨过显示取整边界。压缩可能使占用下降。
- 非空额度窗口格式仍缺少实际样本，保持可见诊断并隐藏模块。本阶段没有扩展 Tools、Agents、MCP、App Server 或 Codex TUI 集成。
- 当前机器未注册全局 `codex-hud` 命令。项目内可执行 `npm run dev -- start`，或构建后执行 `node dist/cli/index.js start`。

恢复审批服务后，在相同工作目录的两个终端启动 HUD 和 Codex，完成至少两轮真实对话，记录 Session ID、五类 Token、Context、CLI 退出后 HUD 存活，以及新 CLI Session 自动接续。达到这 11 步后才将 Phase 2 标为完成；本次未进入后续 Phase。
