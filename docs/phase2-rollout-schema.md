# Phase 2.1～2.5 实现与验证记录

记录日期：2026-09-11。本文记录 Phase 2.1～2.5 的真实数据快照及 Provider 增量读取基线；Phase 2.6 的持续 HUD、`start`、会话跟随和终端验收见 [实时运行记录](phase2-live-runtime.md)。

## 实际环境与取样

- `codex --version`：`codex-cli 0.154.0`。
- `which codex`：`/opt/homebrew/bin/codex`。
- `codex --help`：正常返回，包含 `exec`、`resume`、`app-server`、`migrate-rollouts` 等命令。
- Codex home 下存在 `sessions/YYYY/MM/DD/rollout-…jsonl`。读取只涉及 rollout，不读取认证文件或 Codex 账户配置。
- 当前项目主会话由 Codex Desktop 0.153.4 写入；另一个 CLI 主会话由 0.154.0 写入。因此 binary 版本与 rollout 写入版本分别记录。
- 原始 JSON 仅在 Discovery / Reader / Parser 层处理；Renderer 和 Module 不读取文件。

## 已核实的 schema 与映射

| 实际字段 | 内部用途 | 约束 |
| --- | --- | --- |
| `session_meta.payload.id` | `session.id` | 使用自身 ID |
| `session_meta.payload.session_id` | 不作为自身身份依据 | 子代理可能使用父会话 ID |
| `parent_thread_id`、`source.subagent` | Discovery 排除子代理 | 最新修改的文件可能是子代理 |
| `session_meta.payload.timestamp` | `session.startedAt` | ISO 时间转毫秒；缺少时使用合法事件时间 |
| `session_meta.payload.cli_version` | `codexVersion` | 与 PATH CLI 版本分开 |
| `session_meta.payload.context_window` | 不作为容量 | 实际是带 `window_id` 的对象 |
| `turn_context.payload.model`、`effort` | `model`、`reasoningEffort` | 不依赖嵌套历史别名 |
| `task_started.turn_id` | 去重后的 `session.turnCount` | 没有可靠 ID 时保持未知 |
| `task_started.started_at` | 活动时间 | Unix 秒转毫秒 |
| `task_started.model_context_window` | 窗口容量 | 必须为正整数 |
| 顶层 `timestamp` | `session.lastActivityAt` | 取合法事件时间的最大值，不从时间变化推算轮数 |
| `event_msg / token_count` 的 `info` | Token 快照 | 可为 `null` |
| `info.total_token_usage` | 独立 `tokenUsage` | 最新累计快照覆盖，不求和 |
| `info.last_token_usage.total_tokens` | `context.usedTokens` | 最近快照，包含压缩后的估算 |
| `info.model_context_window` | `context.contextWindow` | 非法值诊断，缺失时不计算百分比 |
| 顶层 `compacted` | 清除旧 Context 占用 | 等待后续快照，累计 Token 保留 |
| `token_count.rate_limits.primary / secondary` | 可用额度判断 | 当前实际样本均为空 |

Token 快照中的 `input_tokens`、`cached_input_tokens`、`output_tokens`、`reasoning_output_tokens`、`total_tokens` 映射为 camelCase 内部字段。实际还存在 `cache_write_input_tokens`，本阶段不接入独立 Cache 明细。

Context 公式为最近快照总量除以窗口容量，剩余量为 `max(window - used, 0)`。实测压缩前 `last.total_tokens=191970`，压缩后变为 `18994`，两次累计均为 `6475285`。累计量除以窗口不能表示当前上下文。这里呈现的是最近记录的估算，尚未与官方 TUI 百分比逐点对照。

Session duration 表示创建时间至采样时间的经过时长。`task_started` 的 ID 去重计数不从 Token 事件次数推断；重复累计快照仅更新最新记录。

## 额度边界

最初 6 个文件的 91 条 Token 记录以及随后额外 50 个文件的 540 条记录，都只有空 `primary` / `secondary`。后一次采样覆盖 2025-10-21～2026-09-11，每文件仅读取头 32 KiB、尾 192 KiB；不能将采样结论外推到未读部分。

实际外层还包含 `limit_id`、`limit_name`、`credits`、`individual_limit`、`spend_control_reached`、`plan_type`、`rate_limit_reached_type`。这些字段没有用于推测额度窗口。

`RateLimitParser` 已处理缺失、空窗口及非法类型。遇到未知非空窗口会给出带行号的提示并隐藏额度模块；目前没有实现非空窗口的比例、周期及 reset 映射。后续需要真实非空样本才能加入对应解析与测试。

## 实现范围与文件清单

新增源码：

- `src/providers/codex/CodexDiscoveryProvider.ts`
- `src/providers/codex/RolloutReader.ts`
- `src/providers/codex/RolloutEventParser.ts`
- `src/providers/codex/RateLimitParser.ts`
- `src/providers/codex/CodexSessionProvider.ts`
- `src/providers/codex/Diagnostics.ts`
- `src/providers/codex/index.ts`
- `src/core/HudEvent.ts`
- `src/core/HudStateReducer.ts`
- `src/core/Redaction.ts`
- `src/cli/Diagnostics.ts`

修改源码：

- `src/core/HudState.ts`：新增独立累计 Token 和最近活动时间，保留 Phase 1 API。
- `src/core/StateStore.ts`：完整替换 / 重置，避免会话切换残留旧字段。
- `src/renderer/modules/TokenDetails.ts`：优先使用独立累计快照。
- `src/renderer/modules/Context.ts`：完整密度显示剩余容量。
- `src/renderer/modules/Session.ts`：展示最近活动时间。
- `src/capabilities/CapabilityDetector.ts`：真实来源能力分支，不依赖 App Server 探测。
- `src/cli/Program.ts`、`Setup.ts`、`RunHud.ts`、`index.ts`：真实单次 debug / doctor / setup 来源、演示入口说明与错误输出脱敏。
- `src/config/Config.ts`：TOML 语法错误仅保留行列定位，不输出配置原文。

新增 `tests/providers/` 下的 Discovery、Reader、Watcher、Parser、Provider、RateLimit 和 Rendering 测试，`tests/Redaction.test.ts` 与 `tests/fixtures/codex/`。更新 `tests/CLI.test.ts`、`tests/Capabilities.test.ts`、`tests/fixtures.ts`，保留原有 TokenTracker 与配置行为回归。文档更新为本文件、fixture 说明及根 README；构建产物生成于 `dist/`。

未接入 Agents、Tools、当前活动、Plan、Git、MCP、Skills、Cost、独立 Cache 数据、App Server 连接或 Codex TUI 注入。没有修改真实用户配置、安装依赖或执行 Git 写操作。

## Reader 与错误行为

- 首次按 64 KiB 分块回放到采样时的文件长度，后续从字节 offset 继续。
- 半行和多字节 UTF-8 等待完整换行后解析；单行默认上限 8 MiB，超限或非法 UTF-8 保留可定位诊断。
- 路径切换、inode 替换、文件缩短会重置；等长修改检查时间戳，另以末尾 64 字节辅助发现同 inode 重写。Reader 面向追加式日志，不做全文件原地编辑的一致性校验。
- `watch()` 监听父目录以覆盖替换，默认 3 秒增量补查；事件合并、错误诊断和停止释放资源已覆盖测试。没有高频全量读取。
- Reader 坏行及 Parser 诊断跨增量读取保留，到会话切换或重放时重建；只保存前 50 条详细定位，并按错误 / 提示分别汇总余数。
- Debug 只选择当前阶段的内部字段，并对 stdout、stderr、参数错误和顶层异常脱敏。原始消息和认证文件不进入诊断。doctor 缺失项不会中止后续检查。

## 验证结果

- 每个实施步骤均运行 `npm run typecheck` 和 `npm test`。
- 最终测试：176 项；源码及测试代码的 TypeScript 检查通过，`npm run build` 通过。
- 已构建入口的 `debug --width 140 --height 30` 和 `doctor` 对本机真实 rollout 运行成功：显示 `gpt-6-astra / high`、当前 Context、累计 Token、创建时间、最近活动及轮数；解析诊断为空。
- 本机同一 Provider 连续读取：初次读取 4,165,047 字节；第二次仅新增 5,902 字节、4 行，累计量由 9,418,245 更新为 9,576,431；第三次新增字节与行数均为 0，累计量保持 9,576,431。
- 额度外层字段被检测到，但窗口为空，doctor 报告该项缺失，HUD 隐藏额度。
- 沙箱内原生 `fs.watch` 返回 `EMFILE`，实际低频增量补查通过；成功监听分支由可控事件测试覆盖。沙箱外原生监听验证被自动审批服务拒绝，原因是审批服务的模型接口返回 HTTP 404，尚未完成该环境下的原生监听成功验证。
- `start`、实时 HUD、真实新会话切换及其 Ctrl+C 端到端验收留待 Phase 2.6；本阶段会话切换和资源清理由临时文件与回归测试验证。

Phase 2.6 已连接 Provider 的监听生命周期与 HUD 重绘，保持 `refresh_ms` 仅控制渲染；最新检查结果及受阻的真实 CLI 验收见实时运行记录。
