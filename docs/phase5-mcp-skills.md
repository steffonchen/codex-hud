# Phase 5：MCP 与 Skills 实现和验收

记录日期：2026-09-12。阶段状态：**PARTIAL**。可可靠读取的数据链路已经实现并验证；服务连接生命周期、完整工具/资源/提示词目录、逐技能执行状态仍缺真实来源。具体 schema 与出处见 [Discovery](phase5-mcp-skills-discovery.md)。

CLI 为 `codex-cli 0.154.0`，实际 Desktop rollout 写入版本为 `0.153.4`；macOS arm64，Node.js v23.11.0。没有将 CLI 版本当作 rollout schema 版本。

## 实施范围

完成 Discovery、独立 State/Tracker、Renderer、Setup、Doctor、Debug 及相关测试、文档。没有安装或启动 MCP、安装技能、修改用户 Codex 配置，也没有实现 Plan、Cost、Cache 或 App Server。MCP/Skills 默认关闭，沿用既有配置 schema 与模块优先级。Phase 4 的 Agent failed 保持 **IMPLEMENTED / RUNTIME VERIFIED: NO**，不阻塞本阶段。

| 能力 | IMPLEMENTED | RUNTIME VERIFIED |
| --- | --- | --- |
| MCP 用户配置发现、禁用状态、稳定身份 | YES | YES，本机 2 项配置，其中 1 项禁用 |
| MCP 调用中观察服务器与工具 | YES | YES，新的 codex_app.read_thread 完成事件；没有冒充完整目录 |
| MCP 工具失败与服务失败隔离 | YES | YES，真实历史 cua_repl.js 失败记录回放 |
| MCP starting/connected/ready/failed 状态分支 | YES，归一化 API、Tracker、Renderer | NO，没有可靠服务生命周期样本 |
| 完整工具目录 | 接受明确归一化目录；没有 raw 来源适配器 | NO，toolDiscovery=false |
| Resources / Prompts | 未建立无来源的状态模型 | N/A，未观察到可靠目录 |
| 系统/用户/项目 Skills 发现、目录替换 | YES | YES，系统/用户/当前任务插件定义；项目目录通过临时目录测试 |
| 当前任务列出的技能可用性、真实版本 | YES | YES，15 项发现、14 项可用，archify 2.16 |
| Skill loaded/active/disabled/failed 状态分支 | YES，状态模型与展示 | NO，没有逐技能执行/禁用事件来源；定义读取错误单独报告 |
| Agent + MCP | YES，明确 Thread ID 关联 | YES，真实子调用、父子 metadata 和日志前缀回放 |
| Agent + Skills / Skill + MCP | 无使用关系来源，不建立推测关联 | N/A |

## 数据链路与兼容

```text
已有根 rollout watcher + 集中子 rollout 读取
  → RolloutEventParser / ToolEventParser / McpEventParser / SkillEventParser
  → 各线程 HudStateReducer → McpTracker / ToolTracker / ActivityTracker
  → 明确 Thread ID 汇总至根 AgentTracker 与 McpTracker

CODEX_HOME/config.toml + 实际技能目录 + 当前任务技能文件引用
  → CapabilityDiscovery / DiscoveryFiles
  → McpTracker.replaceConfiguration / SkillTracker.replaceDirectory

HudState → StateStore → 既有调度器 → LayoutEngine → MCP / Skills / Activity / Agents
```

保留 Phase 1—4 的 `HudState.mcp`、`skills` 数组接口；新状态放入 `mcpSummary`、`skillSummary`。旧 `Mcp.ts`、`Skills.ts` 注册入口继续 re-export 新模块。TokenTracker、Watcher、ToolTracker 和 ActivityTracker 的基本架构没有重写。

`ToolEvent`、`ToolActivity`、`ActivityState` 的可选 MCP metadata 只包含稳定服务/工具 ID 与安全名称。外层 exec 的 call_id 与内层 McpToolCall ID 没有可靠父关系时不合并。Skills 目录事件不增加 session.lastActivityAt，不把发现能力当作执行活动。

## MCP 状态与 Tracker

`McpState.ts` 定义 configured、starting、connected、ready、failed、disabled、unknown。当前配置只能生成 configured 或显式 disabled；调用观察生成 runtimeObserved，保持 unknown 或已有明确状态。命令形式只用于确认 stdio，不保存 command、args、env 或 URL。

服务 ID 对原始名称做确定性 SHA256，工具 ID 对 serverId 与原始工具名生成；先生成身份，再截断或脱敏展示名称。相同服务/工具重复观察不会增加身份，不同服务同名工具仍独立。

`McpToolState` 表示能力条目，Phase 3 的 ToolState 表示一次调用。`discovery=observed-call` 与 `runtime-catalog` 区分证据；`observedToolCount` 不填充完整 `toolCount`，不存在的 count、enabled、available 不补零或 true。只有明确目录能设置 toolDiscovery，目录不要求服务已 ready。

`McpTracker` 分开维护配置、当前线程运行状态与子线程快照。配置 A→B 替换旧配置；运行观察按会话重置，子文件消失、重放或退休时移除该线程汇总。全局配置不会随会话变成上一个会话的运行状态。

服务生命周期时间 `lastUpdatedAt` 与调用时间 `lastObservedAt` 分开；较新的普通调用不会覆盖或阻挡乱序到达的明确状态，跨线程合并同样保留最新明确生命周期。配置先占据汇总名额，避免 128 个运行服务挤掉已配置服务。上限为 128 个服务、1,024 个工具、256 个子线程快照，超限保留诊断；快照与输入均防止外部回写。

## Skills 状态与发现

`SkillState.ts` 和 `SkillTracker.ts` 保存稳定路径身份、名称、必要描述、来源、可选版本及可靠状态。规范路径的 SHA256 用作 identity，符号链接别名去重；同名不同定义仍独立，HUD 用短 ID 消歧。

读取实际存在的 CODEX_HOME/skills、用户 .agents/skills，以及所选会话 cwd 向上的项目 .agents/skills、.codex/skills；遇 Git 边界、用户目录、文件系统根或父级安全上限停止。`.system` 标记为系统来源。插件缓存只读取当前任务能力目录明确引用的定义，缓存磁盘中未列出的插件不当作当前能力。

当前 developer message 中的 `skills_instructions`、`Available skills` 与别名路径表是目录证据。解析器不从用户提及、工具结果或任意正文猜测技能使用。文件可读且被当前目录列出为 available，仅磁盘发现为 unknown；明确引用但缺失为 unavailable，读取/定义解析失败为 failed 并保留诊断。这里的错误描述 HUD 的发现结果，不声称技能执行失败。

版本只读取实际 `metadata.version`，不使用插件 manifest 版本。frontmatter 采用限定标量映射解析，支持本机样本、单/双引号、块描述及简单嵌套映射；复杂 YAML、锚点、标签、流式集合或异常缩进明确报错。未使用字段也校验，不跳过损坏结构而宣称可用。正文不进入解析结果。

Skills 上限 512 项；目录访问上限 256 个，每目录最多 1,024 个条目、技能树深度最多 4，项目父目录最多 32 级。遍历防环，超限说明清单不完整。当前没有 Skill↔Agent、Skill↔MCP 使用证据，也不从内部 Tool failed 推断 Skill failed。

## 刷新、缓存与隐私

复用 Provider 的 3 秒集中重新发现；普通 rollout 通知且任务目录引用不变时返回缓存，IO 为零。Renderer 只消费 State，不访问文件。没有新增服务/技能 watcher 或 timer。

配置读取上限 1 MiB，技能头部上限 64 KiB。缓存键检查规范路径、设备/inode、大小、mtime/ctime，以及解析函数、字节上限和头部模式；读取期间变化会重试。稳定解析错误可以缓存，临时 open/read/close 错误不会永久缓存，EMFILE 解除后重读未修改文件。

缓存只保留解析后的白名单字段。MCP 参数、返回正文、命令、环境值、技能正文、完整提示词和凭据不保存到 HUD。状态、错误、名称继续统一脱敏并移除终端控制字符。debug 的技能路径仅在 verbose 中输出末级目录摘要；诊断不回显 TOML 原文或未知额外字段。

## 展示与 CLI

MCP 与 Skills 的默认开关均为 false，priority 保持 40 / 30。宽屏各展示最多 5 项，中宽最多 2 项，剩余数量明确显示；窄屏使用计数，极窄时为 M:N / S:N，并保留失败标记。配置使用空心符号，已观测工具明确标为“观测”，不暗示 ready。完整工具列表不默认展开。

Current Activity 可显示 `MCP server.tool`。LayoutEngine 在实际可见的活动模块与 Tools 间去掉同一调用，空间变化后重新计算，其他调用仍保留；Agent 活动使用相同 metadata 展示。空间不足时按既有优先级隐藏模块。

setup 可以独立根据 MCP/Skills 静态来源提供选项，即使没有当前 rollout；只写 HUD display config。doctor 分别报告配置、禁用、调用观察、连接状态、工具目录与技能目录/活动，不把 unknown、未配置、未检测和 failed 混为一类。debug 默认仅增加能力摘要，`--verbose` 才输出有界明细；错误仍导致 debug 非零退出。

## 自动验证

| 验证 | 结果 |
| --- | --- |
| npm test | **550 passed，42 个测试文件**；基线 420，新增 130 |
| npm run typecheck | PASS |
| src + tests TypeScript 检查 | PASS；在内存中扩展 include/rootDir，未修改 tsconfig |
| npm run build | PASS；dist 已更新 |

新增测试分布：MCP Discovery 12、MCP Parser 12、MCP Tracker 18、Skills Discovery/目录解析 22、Skill Tracker 11、集中能力发现 17、文件缓存 4、展示/脱敏 20、完整链路 14。覆盖配置/技能替换、删除、修复、临时读取失败、符号链接跨解析器、必要字段与额外损坏字段、跨线程/乱序生命周期、目录保留、数量界限、Session A→B→A、Provider 重启、SIGINT、同步/异步 EMFILE、默认关闭、宽度变化、Current Activity 去重、setup 与 doctor/debug 错误路径。

fixture 来自实际配置、技能 frontmatter、任务目录与 McpToolCall 完成/失败记录的脱敏结构，出处见 `tests/fixtures/mcp/README.md` 与 `tests/fixtures/skills/README.md`。没有伪造 ready-server、failed-server 或 Skill active 原始样本；归一化状态分支通过明确的单元测试输入验证，不能当作 runtime verification。

既有测试调整了 Current Activity 去重后的预期，以及异步发现读取的等待方式。新增集成测试中的 macOS 规范路径差异使用 realpath 比较，doctor 的真实 100 ms watcher 检查使用真实计时；没有通过跳过测试或放宽错误条件隐藏失败。

## 实机验收

| 场景 | 实际结果 |
| --- | --- |
| 默认发现当前根任务 | PASS，选中 `01a0935a-6431-7b12-b5dd-704c48848e53` |
| MCP 配置与调用清单 | PASS，4 个身份：2 配置、2 调用观察；ready=0、server failed=0 |
| Skills | PASS，15 项发现、14 项当前可用、active=0；archify 2.16 |
| 能力重复刷新 | PASS，首轮 16 文件/337,941 字节，下一轮 0 文件/0 字节 |
| Provider 重启 | PASS，新实例恢复相同 MCP/Skills 身份与状态 |
| 新的 MCP 调用 | PASS，根与子代理均只读调用现有 codex_app.read_thread；未启动 MCP |
| 当前活动、Tools 去重 | PASS，真实子日志回放至第 21 行，完成的 MCP 调用只显示一次 |
| Agent + MCP | PASS，真实父子 metadata，回放根/子日志后 correlation=strong，活动位于 phase5_runtime_probe 节点 |
| 工具失败隔离 | PASS，真实历史 cua_repl.js 失败回放；服务与 Agent failedCount 仍为 0 |
| doctor / debug / verbose | PASS，实际本机来源，摘要/清单分离且无完整技能路径 |
| setup 交互 | PASS，真实 TTY 列出可选且未勾选的 MCP/技能；取消后退出 130，Codex/HUD 配置 SHA256 不变。保存路径通过临时配置集成测试 |
| 真实终端 resize | PASS，两轮 140×40 → 80×24 → 50×12 → 10×6 → 140×40 |
| SIGINT 与终端重启 | PASS，两轮退出 0，status=stopped，光标与主屏恢复 |
| EMFILE 增量补查 | PASS，原生 watcher 初始注册 1 个后实际报 EMFILE；3 秒补查接收新 MCP 完成事件，新增读取 80,548 字节，能力 filesRead=0 |
| 停止后的资源 | PASS，activeWatchers=0，SIGINT/SIGTERM listener=0，无 Timeout/FSEventWrap，仅剩 stdout/stderr TTYWrap |

同时选择 Agents、Current Activity、Tools 时，10 列空间会先隐藏 MCP/Skills；仅选择两个能力模块时显示 M:4 / S:15。首次 PTY 验收错误地要求所有模块在极窄屏保留，经检查确认是验收预期错误，按实际优先级分别验证两种配置后通过。

终端和快照验收使用构建后的真实 Provider/Renderer/Runtime，在内存中启用展示模块；没有重写真实 Codex 日志或用户配置。实际会话正在写入，字节数是当次采样记录，不是固定性能指标。

## 修改路径

| 范围 | 主要路径 |
| --- | --- |
| 新状态与 Tracker | src/core/McpState.ts、McpToolState.ts、McpTracker.ts、SkillState.ts、SkillTracker.ts |
| 来源与解析 | src/providers/codex/DiscoveryFiles.ts、CapabilityDiscovery.ts、McpDiscovery.ts、SkillDiscovery.ts、McpEventParser.ts、SkillEventParser.ts |
| 既有链路 | HudState/HudEvent/HudStateReducer、ToolTracker/ActivityTracker、CodexDiscoveryProvider/CodexSessionProvider/RolloutAgentProvider、ToolEventParser/RolloutEventParser |
| 展示与 CLI | McpModule/SkillsModule、AgentModule/CurrentActivity/Tools、LayoutEngine/Formatter/HudModule、CapabilityDetector、Program/Setup/Diagnostics |
| 测试与说明 | tests 中 9 个新测试文件、capabilities.ts、mcp/skills fixtures、README 和两份 Phase 5 文档 |

package.json、lockfile、tsconfig、配置 schema、TokenTracker、RolloutReader 和终端运行架构保持原样。当前目录没有 Git 元数据，以实施前 320 文件 SHA256 基线核对变更；没有执行 commit、push 或创建分支。构建产物随 TypeScript 重新生成。

## 已知限制与停止边界

1. **MCP server failure rendering：IMPLEMENTED；RUNTIME VERIFIED：NO。** 没有取得服务 starting/connected/ready/failed 原始事件；历史工具失败不能代替它。完整 tools/resources/prompts 清单、版本、HTTP 传输语义及跨配置层优先级未确认。
2. **Skill loaded/active 与 Agent↔Skill：RUNTIME VERIFIED：NO / N/A。** 当前目录只能证明列出；读取 SKILL.md 或出现内部工具调用不能证明技能正在执行。复杂 YAML 会明确报告不支持。
3. 内层 MCP 目前主要在完成记录到达时取得可靠 metadata；没有独立开始事件就不提前显示“正在运行 MCP”。新版本字段仍需先调查；当前根第 705 行的未知 item.status 保留警告。
4. 原生 fs.watch 的实际通知送达仍未验证；本机走真实 EMFILE polling。Phase 2 的新 CLI 多轮退出/重启、非空额度窗口等原有遗留不在本次完成范围。
5. 官方检索与临时脚本创建曾被自动审批拒绝：审批模型 gpt-5.6-luna 接口 HTTP 404。临时脚本未创建；本次可行的实机检查通过无文件写入的只读操作完成，没有绕过被拒绝的浏览器操作。

后续应在出现可靠来源时补齐生命周期和技能调用验收。下一阶段等待用户另行指定；本阶段到此停止。
