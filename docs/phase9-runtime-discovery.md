# Phase 9：运行时发现

调查日期：2026-09-13。本文区分命令与协议证据、实际运行观察和软件测试；实现完成后的验收结果另见阶段报告。

## 已确认的环境

- 已完整阅读 README 和 Phase 2～8 的全部阶段文档；仓库没有独立 Phase 1 文档，基础架构由 README 记录。
- 当前 `codex --version` 返回 `codex-cli 0.154.0`。当前根 rollout 的 `session_meta.cli_version` 为 `0.153.4`，不能用 CLI 版本替代 server 或 rollout 版本。
- `CODEX_HOME` 未设置。当前 CLI 的 `daemon version` 实际尝试连接 `~/.codex/app-server-control/app-server-control.sock`，确认了本轮使用的默认 home；这不是根据路径存在推断服务有效。
- `CODEX_THREAD_ID` 与 `CODEX_SESSION_ID` 相等，且与当前项目根 rollout 首行的自身 ID 一致。未读取 prompt、认证文件、SQLite 或 WAL。
- 当前目录没有 Git 元数据；实施前记录了 551 个项目文件的 SHA-256，以及 Codex/HUD 配置哈希，供修改范围核对。

## 命令表面

以下均由本机 `--help` 确认，未执行管理命令：

| 入口 | 本机结果 |
| --- | --- |
| `codex app-server` | `--stdio`；`--listen` 支持 stdio、Unix socket、WebSocket、off |
| `codex app-server daemon` | bootstrap、start、restart、stop、version、enable/disable-remote-control |
| `daemon status` | 未在本版本命令表中提供，不调用猜测命令 |
| `daemon version` | 只读查询 CLI/server 版本；本次返回 socket 不存在 |
| `codex app-server proxy --sock PATH` | 通过 stdio 连接既有 control socket；proxy 是 app-server 的直接子命令 |
| `daemon bootstrap` | 安装持久化管理；不属于 HUD 的默认发现流程 |

本轮只读进程表检查发现两个 Desktop 启动的 `codex app-server` 进程，同属当前用户；其中一个明确使用 `--listen stdio://`。限定这些 PID 的 Unix/TCP 监听检查未发现可附着的具名监听端点。Codex home 顶层未发现 app-server/daemon 状态目录、PID 文件或 socket；默认 control socket 返回 ENOENT。结果为“检测到外部 runtime，尚无可验证的 attach 端点”，不能称作 healthy/compatible。进程表首次读取受沙箱限制；获准只读检查后取得结果。

## 协议依据与安全边界

官方正文已实际获取：[Codex App Server](https://learn.chatgpt.com/docs/app-server)。本轮已重新导出本机 0.154.0 的完整 TypeScript 协议类型，并定点核对 initialize、diagnostics、线程分页、resume、account 与额度字段。

- stdio 使用逐行 JSON-RPC；Unix socket 使用 HTTP Upgrade 后的 WebSocket，不能直接向 socket 写 JSONL。共享 socket 优先复用官方 `proxy`。
- 每个连接只发送一次 `initialize`，成功后发送 `initialized`。当前 InitializeResponse 包含 `userAgent`、`codexHome`、`platformFamily`、`platformOs`，没有独立协议版本号。
- `thread/read` 不订阅；`thread/loaded/list` 提供当前实例已加载线程。`thread/resume` 对运行中线程 rejoin，对未运行线程可能从磁盘恢复；HUD 不为历史线程主动恢复执行环境，不覆盖线程配置。
- `thread/turns/list` 与 `thread/items/list` 是实验性分页能力；后端可能不支持。必须依据实际响应选择补读方式，不能仅凭 CLI 版本宣称兼容。
- `thread/unsubscribe` 移除当前连接的订阅；最后订阅离开后的卸载由 server 自己管理。HUD 不发送归档、删除、打断或审批决定。
- Phase 9 已移除 Phase 8 对服务端 request 统一回复 -32601 的行为；审批/用户输入请求仅观察计数，不自动批准、拒绝或回复错误。
- thread/turn 历史不暴露 Token 快照与执行清单通知；保留 Rollout 历史补偿与既有 TokenUsageTracker、PlanTracker、ToolTracker 等，不另建业务状态。

## 实施约束

发现、探测、authority 和连接管理位于 provider 层；只在启动、断线、重连及显式诊断时进行有界异步发现，render 不触发 IO。PID、命令行、文件类型、owner、权限、endpoint 和协议共同形成证据；不可读取命令行时保持 unknown。多个同等候选无法消歧则回退，不按 PID/时间随机选取。

外部 server 的 ownership 与 HUD 创建的 proxy 子进程必须分开：可以关闭自有 proxy，绝不能向外部 PID 发信号。连接、请求、历史均有限期；重连指数退避并有次数/时间边界。切换 runtime 保持来源 generation 的单调性及历史去重边界。

managed 默认 discover only，不启动 daemon。运行配置明确允许时才可使用经本机 help 确认的启动入口；bootstrap、remote-control 和用户配置写入不在自动流程中。未知/拒绝 attach、权限不足、陈旧端点及线程归属不明均保留诊断并回退 Rollout。

## 已实现的发现与连接

实现位于 `src/providers/codex/runtime/`。进程检查使用异步 `ps`/`lsof`，固定 `LC_ALL=C`；不可读或格式未知时返回 error。只识别真正的 app-server 子命令，不把 `codex exec app-server` 的输入文字当作服务。发现结果缓存 30 秒，同步到来的请求共用一次扫描。

文件扫描只检查 home 顶层和已发现的 app-server/daemon 状态目录，限制 512 个顶层条目、每个状态目录 64 个条目、16 个 socket 和 32 个候选。PID 文件使用 O_NOFOLLOW 和有界读取，仅作为旁证；不解析 daemon 内部 JSON、SQLite 或 WAL。发现不完整或超过预算返回 error，禁止据此自动 spawn。

外部连接前重新核验进程出生信息、executable 和端点归属；随后复查 socket 的 owner、权限、inode/ctime。进程 binary 版本只在文件时间早于进程出生且查询前后身份稳定时采用。managed 标签还要求 socket 属于当前 home 的已发现官方控制目录，并且该 home 的 `daemon version` 成功；同名目录不够。

Probe 执行 initialize → initialized、`server/diagnostics({})` PID 核验、home 比对、loaded/list 和明确线程 read。外部 server 缺少 diagnostics 或可靠版本时拒绝附着。初始化 userAgent 不推导版本；owned server 版本保持 unknown，直至有可靠证据。协议版本差异按实际方法能力判断，不简单按版本号拒绝。

连接默认限期 3 秒，普通请求 8 秒，probe 单请求 5 秒、整体 15 秒，history 30 秒。发现有 15 秒扫描预算，连接层最多等待 20 秒；候选探测轮也有预算与单候选期限。自有 child 的 stop 最多等待 3.5 秒，manager 清理最多等待 4 秒；pending request/write 和 timer 一并清除。默认连续失败达到 8 次即停止自动重试，退避由 1 秒增加到最多 30 秒。

AppServerSource 保留 Phase 8 history/live 缓冲和去重流程。切换线程及重连按 generation/selection 隔离旧响应；旧 open、disconnect、失败清理和迟到 resume 不能覆盖新选择。根线程关闭保持 lost，子线程关闭不会使根线程失效。更多选择规则见 [权威矩阵](phase9-authority-matrix.md)。

## 当前证据等级

Discovery 的早期外部进程实际观察已完成；最新代码在当前沙箱中的进程扫描返回 error，未取得完整实机发现成功证据。真实共享握手、外部附着、daemon 重启、live 通知和双来源 parity 尚未验证。真实 daemon 启停与最小模型实验在本地实现和测试完成后另行确认；fixture、mock 或 schema 不能计为 RUNTIME VERIFIED。

已用构建后的真实 Provider 完成当前根 Rollout 的只读恢复，以及 doctor/debug/非 TTY start 检查；策略明确关闭 runtime 启动与外部附着。两次独立进程读取期间日志继续增长，Token 的实际增量按不同快照记录，详见 [运行时来源对照](phase9-runtime-parity.md)。没有输出 prompt、凭据或完整 JSON-RPC payload。

最终完整本地回归需要临时 Unix socket，被自动审批服务的 HTTP 404／不支持审批模型故障拒绝，命令没有执行；最新沙箱内 1003 项测试、类型检查和构建通过。环境故障不能转换为测试通过或真实 runtime 通过。
