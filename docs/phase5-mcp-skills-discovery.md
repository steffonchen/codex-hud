# Phase 5：MCP 与 Skills 来源调查

记录日期：2026-09-12。本文记录已经读取的真实来源；实现与验收结果见 [Phase 5 报告](phase5-mcp-skills.md)。

## 环境与取样

| 项目 | 已确认事实 |
| --- | --- |
| CLI | `codex-cli 0.154.0` |
| rollout 写入版本 | 本项目当天取样的 21 份文件均为 `session_meta.payload.cli_version = "0.153.4"` |
| 平台 | macOS / arm64；Node.js `v23.11.0` |
| 配置来源 | `CODEX_HOME/config.toml`，本机为 `~/.codex/config.toml` |
| 运行来源 | 已有 Desktop rollout；没有启动 MCP 或新的 Codex/App Server |
| 版本边界 | 安装的 CLI 版本不代表 Desktop 写入版本；未观察到独立 rollout schema 版本 |

取样约 22.5 MB，覆盖本项目三个根任务及相关子任务。当前根文件为 `rollout-2026-09-12T10-02-49-01a0935a-6431-7b12-b5dd-704c48848e53.jsonl`。没有读取认证文件或扫描全部历史会话。

## MCP 配置与运行证据

本机用户配置第 80 行声明 `[mcp_servers.node_repl]`，含 `command`、`args` 和 `startup_timeout_sec`；第 85 行包含环境变量映射，内容不进入状态、fixture 或诊断。第 102 行声明 `[mcp_servers.computer-use]`，第 106 行明确 `enabled = false`。缺少 enabled 不推断 connected、ready 或当前可调用。

已确认的结构化工具结果：

```text
type: event_msg
payload.type: item_completed
payload.thread_id: string
payload.turn_id: string
payload.started_at_ms / completed_at_ms: number
payload.item.type: McpToolCall
payload.item.id: string
payload.item.server: string
payload.item.tool: string
payload.item.status: completed
payload.item.result.isError: false
payload.item.duration: { secs: number, nanos: number }
```

出处为 `rollout-2026-09-12T06-23-39-01a09291-bae7-7370-aed2-27ee84aaf892.jsonl:773` 与 `rollout-2026-09-12T08-03-55-01a092ed-87ba-7752-baaa-8a946263d93e.jsonl:861`。两条均明确标识 `codex_app.open_in_codex`。item ID 与外层 exec 的 call_id 不一致，不能补造二者的父调用关系。

该证据可确认一次调用的服务器、工具和线程。它不能证明服务当前 ready，也不能作为完整工具目录或工具总数。已观察工具数量与完整目录数量必须分开。工具失败不等于服务器连接失败。

真实失败样本来自 `sessions/2026/09/11/rollout-2026-09-11T18-04-38-01a08fed-25fb-7483-a596-2bbc3b0d00b9.jsonl:169`：`server=cua_repl`、`tool=js`、`status=failed`、`result.isError=true`。第 167 / 170 行为相关 function_call / function_call_output。这是工具调用失败，没有服务连接失败的证据。按原始记录回放，工具 failed、MCP server failedCount=0、Agent failedCount=0。

本次新增只读调用也取得了真实证据：

| 来源 | 明确字段 |
| --- | --- |
| 当前根 rollout 第 755、787 行 | `server=codex_app`、`tool=read_thread`、`status=completed`、`result.isError=false`，thread_id 为当前根 ID |
| `rollout-2026-09-12T10-57-39-01a0938c-970d-76d1-87d6-ea156c6a940f.jsonl:1` | `agent_path=/root/phase5_runtime_probe`，子 ID 为 `01a0938c-970d-76d1-87d6-ea156c6a940f`，父 ID 为当前根 ID |
| 同一子 rollout 第 17 行 | `McpToolCall`，`codex_app.read_thread` 完成，isError=false，thread_id 与子 ID 一致 |

子调用 started_at_ms=1789181875712、completed_at_ms=1789181875743。按原始日志回放至第 21 行后，Current Activity 显示 MCP 完成结果；使用实际父子 metadata 汇总后，活动位于 `phase5_runtime_probe` 节点，相关服务仍为 unknown。没有用时间推断父子关系。

尚未观察到服务器 starting/connected/ready/failed 生命周期、完整 tools/resources/prompts 清单。Resources 与 Prompts 记录为 **not observed / unavailable**，不生成虚构状态或计数。MCP 与 Agent 只沿明确线程身份关联。

## Skills 来源

本机目录调查得到 16 份定义：用户 `.agents/skills` 中 2 份，Codex `.system` 中 6 份，插件缓存中 8 份。本项目及向上至 Workspace 的 `.agents/skills`、`.codex/skills` 均不存在。

当前根 rollout 第 3 行的 developer message 中，`### Available skills` 明确列出 14 项，并由 `### Skill roots` 提供 r0—r4 的路径映射。它是当前任务的能力目录，不是技能已加载或正在执行的证据。磁盘上存在但目录没有列出的 `review-agent` 和缓存中的 `browser` 不能据此宣称当前可用。

已观察 frontmatter 的必要字段为 `name`、`description`。用户 archify 定义的第 6 行含 `metadata.version: "2.16"`；插件版本不能代替技能版本。`allow_implicit_invocation: false` 只是调用策略，不能当作 disabled。

当前第 7 行 `world_state.payload.state.host_skills` 含 `body` 与 `includeInstructions`；`skills` 和 `orchestrator_skills` 只有整体开关，未提供逐技能 loaded/active 状态。未发现可靠 Skill→Agent 或 Skill→MCP 使用关系。

最终 HUD 采样发现 15 项：系统/用户目录与当前任务引用的插件定义合并后，14 项 advertised 且可读，另有 `review-agent` 仅在磁盘发现。缓存中的 browser 没有被当前目录引用，运行发现器不全量扫描插件缓存，因此 HUD 数量与人工调查的 16 份磁盘文件不同。activeCount=0；archify 版本为 2.16。

实现使用限定的 frontmatter 标量映射解析器，覆盖实际样本的 name、description、metadata.version、引号及块描述。未使用字段也经过结构校验；复杂 YAML、重复字段、异常缩进或不支持的标量会给出定义解析诊断。它不是通用 YAML 解析器，不把解析器不支持的定义标成可用。

## 缓存与隐私边界

插件缓存有 MCP 声明，但其中 tools 可表示审批配置，enabled_tools 可表示过滤规则，不能冒充发现目录。用户配置、缓存与 Desktop 的合并优先级尚未确认。`~/.codex/cache/codex_apps_tools/` 的取样文件为 schema_version 2、tools 空数组，修改时间为 2026-04-22，不能证明当前能力。

缓存仅作调查证据。本阶段运行采集优先读取真实任务目录及配置，不全量轮询插件缓存。所有输入先按字段白名单收缩，再脱敏；命令、环境值、参数、完整提示词、返回正文、认证信息均不进入 HUD。

最终采样中 MCP 共 4 个身份：node_repl 为 configured，computer-use 为 disabled，codex_app 与 cua_repl 为调用中观察到的 unknown。已配置数量 2 包含禁用项；观测到的服务数量 2 不表示连接仍然存活。完整 toolDiscovery、serverStatus、resourceDiscovery、promptDiscovery 均为 false。

首轮能力发现读取 16 个文件、337,941 字节；紧接着再次发现 filesRead=0、bytesRead=0。统计中的 stats=26 是文件检查次数，directories=11 是打开的技能目录数，不是全部系统调用计数。现有 3 秒集中刷新继续检查元数据；普通 rollout 通知且目录引用不变时，能力发现不进行 IO。

## 限制

官方页面检索受执行环境 DNS 与自动审批服务故障限制；浏览器审批返回 404，原因是审批模型不受支持。临时实机脚本文件的创建也被自动审批拒绝，文件未创建；后续采用无文件写入的只读快照和内存中的 PTY 检查完成可行验收。以上事实来自本机配置、rollout 和定义文件，不冒充官方稳定接口。

当前根 rollout 第 705 行存在未识别的 item.status，解析器保留 `unknown-tool-field` 警告，没有补造成功状态。未确认项目 MCP 配置与用户/插件配置的覆盖规则，因此当前 MCP 配置发现只读取实际 CODEX_HOME/config.toml。本机未获得 HTTP 传输的可靠样本，transport 只标注已确认的 stdio。

Agent failed 继续保留：**implemented / runtime verification pending**。不会为获得样本修改 Codex 行为或伪造服务、技能、代理失败。
