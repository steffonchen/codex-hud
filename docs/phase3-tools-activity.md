# Phase 3：Tools 与 Current Activity

记录日期：2026-09-12。已完成本阶段实现、309 项测试、构建，以及现有真实 Codex 会话的工具与终端验收。Phase 2 遗留的全新 CLI 多轮对话、退出重启闭环和非空额度窗口仍未验收；它们不作为本阶段已经通过的内容。

## 实际环境与 schema

- 平台为 macOS，Node.js `v23.11.0`。
- `codex --version` 返回 `codex-cli 0.154.0`，binary 为 `/opt/homebrew/bin/codex`。
- 本次实际读取的 Desktop 主会话由 `0.153.4` 写入。binary 版本与 rollout 写入版本分别报告。
- 数据来自现有 `sessions` 中的真实 rollout。没有启动新的沙箱外 Codex、读取认证文件或修改真实用户配置。

先检查真实事件，再建立 Parser。已确认的类型和字段如下：

| 真实事件 | 使用的字段 | 归一化方式 |
| --- | --- | --- |
| `response_item / custom_tool_call` | `name=exec`、`call_id`、`input`、`status` | 外层工具调用开始；不解析或执行其中的 JavaScript |
| `response_item / function_call` | `name`、可选 `namespace`、`call_id`、JSON 字符串 `arguments` | 普通工具开始；仅提取已确认的续跑关联字段 |
| `custom_tool_call_output`、`function_call_output` | `call_id`、字符串或 `input_text` 数组形式的 `output` | 按调用 ID 关联返回；不保存完整输出 |
| `event_msg / item_completed`，`item.type=CommandExecution` | `id`、`command` 数组、`parsed_cmd`、`status`、`exit_code`、`duration.secs/nanos` | shell/read/search 结果；非零退出码表示失败 |
| `event_msg / item_completed`，`item.type=FileChange` | `id`、`status`、`changes` | 编辑结果，摘要仅保留文件名及数量 |
| 同类结构中的 `McpToolCall` | `id`、`status` | 只保留普通未知工具结果，不建立 MCP 系统状态 |
| `task_started`、`task_complete`、`turn_aborted` | `turn_id`、时间等已确认字段 | 轮次边界与空闲状态；中断不等于工具已取消 |

`item_completed` 的外层还提供 `started_at_ms`、`completed_at_ms`；命令耗时优先使用实际 `duration`。缺少 ID 时按原始事件行的 SHA256 生成稳定内部 ID，同时保留字段诊断，不使用随机 UUID。

以下边界直接影响 HUD 的含义：

1. 调用记录的 `status=completed` 只说明调用生成完毕，不能当作执行成功；需要等返回或结构化执行结果。
2. 当前样本没有内层命令、编辑的独立开始事件，也没有它们到外层 `exec` 的可靠父调用关联。因此运行中展示“工具调用”，内层具体命令、读取、搜索和编辑在完成事件到达后展示。不能声称已验证每个内层命令的实时开始状态。
3. `Script running with cell ID …` 表示外层执行尚未结束；后续 `wait` 的 `cell_id` 可以关联续跑。只识别工具返回的固定头部，不扫描任意输出寻找成功或失败。
4. 结构化执行结果优先于普通返回。已确认的失败不会被之后的通用“已返回结果”覆盖；外层执行容器也不重复计入近期已完成命令。
5. 没有实际观察到工具级取消事件。Tracker 支持归一化取消状态，但轮次中断后缺少结果的工具归档为 `unknown`，不伪造 `cancelled`。

11 个脱敏 fixture 位于 [工具事件样本](../tests/fixtures/codex/tools/README.md)，覆盖开始、完成、失败、并行结果、半行、未知工具、外部失败、续跑、读写搜索和轮次中断。该说明保留来源与行号。fixture 中的命令和路径是安全替代内容，不冒充对应命令的真实执行证据。

## 状态与数据链路

继续使用现有 `ToolActivity` 名称，扩展字段而不另建重复的 ToolState：

```ts
type ToolStatus =
  | "pending" | "running" | "completed"
  | "failed" | "cancelled" | "unknown";

// 沿用 HudState.tools，保留旧 counts 接口。
tools?: {
  active?: ToolActivity[];
  recent?: ToolActivity[];
  counts?: Record<string, number>;
};
```

每个工具包含稳定 ID、名称、类型、状态，以及可选的开始/结束时间、耗时、输入/输出摘要、错误摘要和轮次 ID。原始参数、脚本、输出和文件差异不会保存到 HudState。

`ActivityState.status` 沿用项目的 `running` 命名，完整取值为 `running | waiting | completed | idle | unknown`。状态还带有标签、描述、时间、当前工具 ID、类型和工具结果状态。失败的活动以 `status=completed`、`toolStatus=failed` 表示执行结束但失败，Renderer 显示“执行失败”。

```text
真实 rollout
    ↓
RolloutReader → RolloutEventParser / ToolEventParser
    ↓
HudEvent：工具、轮次、会话、Token 等归一化事件
    ↓
HudStateReducer → ToolTracker → ActivityTracker
    ↓
HudState → StateStore → RenderScheduler → HudRenderer
    ↓
TerminalController
```

| 组件 | 本阶段实现 |
| --- | --- |
| `ToolEventParser` | 只接受已核实的字段结构，输出开始、更新、完成、失败、未知等工具事件；缺字段保留诊断 |
| `ToolTracker` | 管理生命周期、结果优先级、重复与乱序、exec/wait 关联和资源上限；晚到的 start 不使终态回到 running |
| `ActivityTracker` | 选择一项当前活动，关联轮次边界；当前轮次不会沿用上一轮的完成摘要 |
| `HudStateReducer` | 复用既有入口，接入两个 Tracker；会话、rollout 重放、替换与切换时重置工具和活动 |
| `HudState` | 扩展 `ToolActivity` 与 `ActivityState`，添加 `tools.recent`，保留旧 API |
| `Formatter` | 统一摘要、状态符号、耗时计算、脱敏和列宽截断 |
| `Tools` | 展示活动数量与条目，或近期完成/失败；没有数据时隐藏 |
| `CurrentActivity` | 展示一项最值得关注的活动，完成不伪装成运行，明确 idle 时隐藏 |
| `HudRuntime` | 复用现有一秒重绘时钟和 RenderScheduler；duration 重绘不写 Store、不读 rollout |
| Provider / Reader / CLI | 单 watcher 生命周期、增量补查、可观察的监听状态及 debug/doctor 诊断 |

活动选择顺序为 `running > pending`，同一状态内按 `shell > edit > search > read > 其他`，再按开始时间从新到旧选择，以 ID 保持确定性。没有活动工具时可展示当前轮次的近期结果；明确的轮次完成或中断进入 `idle`。等待期间不推测用户输入或后台进程状态。

资源上限为：活动工具 64 项、近期工具 20 项、每个身份/关联缓存 256 项。超出活动上限时将最旧项归档为未知并报告诊断；有界身份窗口外的旧开始事件也会报告状态未确认。不会无限保留整个会话的工具历史。

## 摘要、隐私与布局

统一扩展现有 `Redaction.ts`，处理 Authorization、Bearer、token、api_key、password、secret、cookie、credential、环境赋值和 camelCase 等凭证形式。重复脱敏保持幂等；摘要最多 240 字符，终端控制字符由既有宽度策略移除。

Shell 摘要仅保留程序名及常见任务名，例如 `npm run build`、`npm test`、`git status`；其他参数概括为 `…`。任意环境值、脚本正文、HTTP 头和 stdout/stderr 不进入 HUD。文件或搜索摘要依赖实际 `parsed_cmd` 元数据，无法可靠识别时保留一般命令摘要。错误通常只保留退出码或结构化失败类别；debug 仍采用脱敏白名单。

Tools 的隐藏优先级为 75，Current Activity 为 82。完整密度最多显示 3 个工具，紧凑密度显示 1 个，极窄布局进一步精简数量或最近结果。全部继续经过 WidthPolicy 和 LayoutEngine，不增加用户布局模式或高频动画。

运行中耗时由 `startedAt + 渲染时刻` 计算，完成后显示固定耗时。只有已有时钟需要重绘时才使 Scheduler 失效，不为每个工具创建 timer，也不每秒更新工具状态。

旧配置继续有效。Tools 保留现有推荐策略，仅在有真实数据时推荐；Current Activity 默认关闭。已选模块不会自动增加。要显示两项，在 `codex-hud setup` 中勾选“工具”和“当前活动”。项目内也可使用 `npm run dev -- setup`。

## Watcher 与 EMFILE

- Discovery 沿用每 3 秒重新发现主会话，不增加 home/session 文件 watcher。
- 每个 Reader 同时最多一个当前 rollout 父目录 watcher；重复 watch 先关闭旧 watcher，切换时先释放再创建。
- 原生监听正常时仍保留既有低频补查；同步或异步 `EMFILE` 后关闭原生句柄，使用默认 3000 毫秒的 `stat + offset + 新增字节` 补查。
- Tool、Activity、Token、Context 和 Session 使用同一增量 stream，没有每工具监听、调度器或轮询。
- `getWatchStatus()` 明确区分 `inactive / native / polling`，提供活动 watcher 数量、fallback 配置和原因。停止后为 `inactive`，活动 watcher 为 0。
- 补查正常时 `watch-unavailable` 不占 HUD 提示区域，原因保留在 Runtime 诊断；真实读取或处理错误继续显示。EMFILE 并未被吞没或伪装成原生成功。

`debug` 输出本进程的单次快照。其 watcher 通常是 `inactive`，不代表另一个 `start` 进程没有监听。它显示工具 active/recent、活动状态和脱敏摘要，但不查询其他 HUD 的内存。

`doctor` 检查 Parser、工具事件和 Activity；没有工具事件只给出提示。监听探测等待 100 毫秒后采样并在 finally 中释放句柄与补查 timer；没有报错也只说明短时检测结果，未证明原生通知已经送达。

真实检查发现 `setImmediate` 后约 0.4 毫秒仍报告 native，但异步 EMFILE 约在 13.9 毫秒到达。已修正这项过早判断，并增加延迟错误与资源释放回归测试。最终 doctor 如实输出“原生文件监听不可用：EMFILE”和“3000 毫秒 stat/offset 补查”。

## 自动验证

| 检查 | 结果 |
| --- | --- |
| 原有基线 | 23 个测试文件、222 项通过 |
| 新增覆盖 | 87 项，包含既有测试文件新增用例 |
| 最终测试 | 28 个文件、309 项全部通过 |
| `npm run typecheck` | 通过 |
| 源码及测试的 TypeScript 检查 | 84 个文件通过，不修改项目 tsconfig |
| `npm run build` | 通过 |
| 构建入口 `debug` | 真实单次快照、工具/活动白名单、来源版本和监听状态正常，解析诊断为空 |
| 构建入口 `doctor` | 工具、活动、Parser、Renderer 检查通过；EMFILE、非 TTY、缺失额度如实报告 |

新增五个测试文件：`ToolTracker.test.ts`、`ActivityTracker.test.ts`、`ToolRendering.test.ts`、`providers/ToolEventParser.test.ts`、`runtime/ToolLive.test.ts`。既有 CLI、能力、setup、模块与脱敏测试同步覆盖 Phase 3 行为。

测试覆盖开始、更新、完成、失败、取消、未知、重复、乱序、等待结果先到、失败结果优先、摘要脱敏和容量边界。取消与异常输入属于归一化边界测试，不是额外的真实 schema 证据。

完整链路测试使用临时 JSONL，经实际 Reader、Parser、Tracker、Store、Scheduler 和 Renderer 验证。另覆盖：

- duration 变化时 Store 内容与通知次数不变，不额外读取文件。
- 同步/异步 EMFILE 后按新增字节更新；降级诊断保留，HUD 正常显示。
- 连续三轮 start/stop；A → B → C → A 切换，最多一个原生 watcher，停止后 timer 为 0。
- 半行补齐、同路径重放、截断/替换和状态重置。
- 100、1000 条事件及对应通知合并后，增量读取与渲染各增加不超过 2 次；近期结果保持 20 项，序列化状态小于 15,000 字符。
- 140、100、80、60、50、40 列下的工具和活动截断、Unicode 列宽及空模块隐藏。

这些资源测试验证有界性和通知合并，不作为吞吐量基准或长期进程内存测量。

## 真实实时与终端验收

通过真实 PTY 运行构建后的 `createProgram().parseAsync(["start"])`，临时配置启用 Model、Reasoning、Context、Tools、Current Activity、Session。临时入口只记录状态和渲染内容；实际 Provider、Runtime、Renderer、TerminalController 与当前真实 rollout 均参与运行，没有模拟执行结果。

| 场景 | 观察结果 |
| --- | --- |
| shell/tool | 执行约 6.5 秒的无害 Node 命令；外层工具调用显示 running，秒数从 0 增长至 8，之后得到 `node …` 完成记录，实际命令耗时约 6404.96 毫秒 |
| read | 单文件读取 `src/renderer/modules/Tools.ts`，归类为 read，并显示已完成摘要 |
| search | 使用 rg 搜索真实源码，归类为 search，HUD 显示 `HudStateReducer.ts` 完成摘要 |
| edit/write | 本次实际更新根 README，经 `FileChange` 进入 edit，HUD 显示该文件已完成 |
| completion | active 清空，近期结果与 Current Activity 转为完成，没有继续显示 running |
| failure | 明确执行无害的 `process.exitCode = 7` 验收命令；实际结果为 failed，错误摘要为“退出码 7”，HUD 显示 `✗ 执行失败 node …` |
| live activity | 新追加的开始和结果记录进入 HUD；运行时长每秒变化。轮询等待会使外层运行显示略晚于实际命令结束 |
| terminal resize | 140×24 → 100×20 → 80×16 → 60×12 → 50×10 → 40×8 → 140×24，全部帧位于对应宽高内 |
| watcher | 异步 EMFILE 后为 polling，原生活动 watcher 为 0，fallback 为 true，间隔 3000 毫秒；期间 shell/search/edit/read/failure 持续更新 |
| SIGINT | 两轮正式验收均退出码 0，恢复光标和主屏，没有遗留 HUD 进程 |
| session switch / watcher lifecycle | 本阶段由完整文件链路测试验证三轮 start/stop 和 A → B → C → A；没有将其冒称为新 CLI 退出重启的真实闭环 |

75.17 秒的 resize 验收记录了 50 份 Provider 快照、107 次终端渲染请求，PTY 实际输出 8,555 字节。首次回放读取 3,352,859 字节，后续六次非零读取共 113,377 字节，offset 连续推进到 3,466,236；没有按补查周期重读整个文件。该次 recent 最大为 20，原生 watcher 最大为 1。

35.20 秒的失败与单文件读取补充验收记录了 51 次渲染请求、4,940 字节终端输出。两轮检查均未发现帧宽高溢出或内容中的非法控制字符；resize 验收的原始 PTY 输出没有整屏清空序列。退出时备用屏和光标恢复标记齐全。

验收日志仅放在本机临时目录：`/private/tmp/codex-hud-phase3-live-pj2d62va` 与 `/private/tmp/codex-hud-phase3-failure-rfuan1kx`。它们不属于项目交付文件，可能随临时目录清理而消失；本文记录主要结果和限制。

## 修改范围

- 新增源码：`src/core/ToolTracker.ts`、`src/core/ActivityTracker.ts`、`src/providers/codex/ToolEventParser.ts`。
- 状态与来源：`HudState.ts`、`HudEvent.ts`、`HudStateReducer.ts`、`Redaction.ts`，Codex Parser/Provider/Reader 及诊断类型。
- 展示与入口：Formatter、HudRenderer、LayoutEngine、HudModule 渲染上下文、Tools、CurrentActivity、HudRuntime、CapabilityDetector、CLI Program/RunHud/Diagnostics。
- 测试与文档：上述五个测试文件、相关既有测试、11 个 fixture 及其说明、根 README 和本文。

依赖、package.json、配置 schema、演示数据、其他模块和此前阶段记录未修改。构建产物更新到 `dist/`。当前目录没有 Git 仓库；以实施前 87 个文件的 SHA256 基线核对范围，没有删除已有文件，没有执行 Git 写操作。

## 已知限制与后续阶段

- 当前真实运行模式为增量 polling。原生监听的成功通知分支有可控测试，但本执行环境的真实原生通知送达仍未验证。
- 内层命令/文件修改缺少独立 start 和可靠父调用关联；外层 wrapper 运行与内层完成分层展示，不能给出并行内层工具的准确实时 active 数量。
- 历史与身份关联有界；窗口之外的过旧乱序事件不能保证完整补关联，会保持未知并报告诊断。
- 尚未确认更多 Codex 写入版本的工具格式；未知字段保留诊断，不据此猜测生命周期。
- Phase 2 的全新 CLI 两轮对话、正常退出和重启跟随闭环，以及非空 quota，继续保留在 [Phase 2 验收记录](phase2-live-runtime.md) 中。
- Discovery 仍按当前目录优先和最近主会话选择，不判断用户聚焦哪个终端，也不根据旧 rollout 推测进程是否存活。

Phase 4 仅建议先检查真实 Agent 事件与父子关联，再单独设计归一化 AgentEvent；本次没有实现 Agents、Agent Tree、MCP、Skills、Plan、Cost、Cache 或 App Server。Phase 3 完成后停止，等待下一阶段。
