# Phase 9：来源权威矩阵

更新日期：2026-09-13。运行时权威决定连接哪个 server；线程权威决定观察哪个 conversation；事件来源权威仍由 Phase 8 的 SourceAuthorityPolicy / SourceDeduplicator 处理，三者不能相互替代。

## 运行时选择

外部候选必须同时通过 socket 类型、owner、权限、进程 executable/命令行/出生信息、端点归属、可靠版本、协议握手、CODEX_HOME 和当前线程归属核验。只有 PID、文件存在或历史 `thread/read` 成功均不足以附着。

| 场景 | 决策 | AuthorityReason |
| --- | --- | --- |
| 不知道当前实时线程 | 保留明确标注的 Rollout 历史，不建立实时连接 | `thread-authority-unknown` |
| 合格共享候选承载明确线程 | 复用初始化后的连接；不另起 standalone | `existing-compatible-runtime` |
| 合格候选同时经当前 home 的官方 daemon 查询确认 | 按策略参与排序，不凌驾于身份与线程核验 | `managed-daemon-active` |
| 多个合格候选同级且无法消歧 | 回退，不按 PID、时间或列表顺序挑选 | `ambiguous-runtime` |
| 发现完整、无外部候选且配置允许 spawn | 尝试一个 HUD 自有 stdio server；只提供其实际可得历史/实时能力 | `standalone-owned-by-hud` 或失败后回退 |
| 外部候选存在，但 owner、版本、协议或线程归属未确认 | 回退；不把核验失败当作另起 server 的理由 | `fallback-rollout` |
| 外部附着关闭 | 只可使用允许的 HUD 自有 server 或 Rollout | `external-attach-disabled` 或 `standalone-owned-by-hud` |
| 进程表不可读、发现超限/不完整、权限不足 | 保留错误并回退，不自动 spawn | `fallback-rollout` |

通过证据门槛后，排序依次考虑：线程已加载、`prefer_shared`、`prefer_managed`、健康状态和协议兼容程度。同级候选即使 ID 不同也返回 ambiguous。版本不同本身不构成不兼容；必要方法实际可用时可为 `compatible-with-fallback`。

默认策略：`prefer_managed=true`、`prefer_shared=true`、`allow_spawn=true`、`allow_external_attach=true`、`auto_reconnect=true`、`auto_start_managed=false`。managed 的启动只在显式开启配置、明确线程、发现完整且没有运行候选、当前官方命令支持时尝试一次；HUD 不执行 bootstrap、daemon stop/restart 或 remote-control 配置。

## 数据来源

Managed 与 standalone 使用同一 App Server Source 和业务 trackers。区别在于该 server 是否真正承载目标线程，而非为不同进程类型预设不同数据值。表中 App Server 能力均为已实现的协议路径，真实运行仍为 NOT OBSERVED；Rollout 的实际观察见 [运行时来源对照](phase9-runtime-parity.md)。

| Data | Managed App Server | Standalone App Server | Rollout | Authority |
| --- | --- | --- | --- | --- |
| Model / Reasoning | 线程/轮次 metadata | 线程/轮次 metadata | `turn_context` | 归一化后按线程与事件来源选择 |
| Context / Token | 实时 token notification；历史 NOT EXPOSED | 仅本实例承载线程的实时通知；历史 NOT EXPOSED | 累计和最近 token 快照 | 同一 TokenUsageTracker；历史缺口保留 Rollout，镜像快照不累加 |
| Cache / Cost | 已确认请求的用量派生 | 同左 | 已确认请求账本 | 同一用量账本；费用始终为标准 API 等价估算 |
| Plan | `turn/plan/updated`；提案独立保存 | 同左；仅已订阅线程 | 成功确认的清单调用/结果 | 同一 PlanTracker；没有共享修订号时保留已确认来源 |
| Tool | turn/items 历史与实时 item | 同左 | 调用及执行结果 | 同一 ToolTracker；history/live/rollout 重叠去重 |
| Activity | thread/turn/item 生命周期 | 同左；只针对已承载线程 | 明确生命周期事件 | 同一 ActivityTracker，不按无事件时长判故障 |
| Agent | 明确的子线程与父线程 metadata | 同左；可读历史不等于 live | 明确父线程关系与子 Rollout | 同一 AgentTracker；不按时间或目录猜关系 |
| Quota | 结构化 read 的兼容单桶视图及通知 | 同左，取决于认证和方法能力 | 实际 rate limit 字段 | 同一 QuotaTracker；空值不补零，不合并未知多桶 |
| Account | `account/read(refreshToken=false)` | 同左 | 不推断账户身份 | 只保留 authenticated，不保存 email/token |
| Approval | 服务端审批/输入请求与 resolved 通知 | 同左 | 不据工具状态推断审批决定 | 仅记录已观察计数，不自动 approve/reject 或回复错误 |

## 线程与所有权边界

`CODEX_THREAD_ID` 只在环境 home 与发现 home 一致、且与可选的 `CODEX_SESSION_ID` 不冲突时作为实时选择；显式 provider thread ID 可覆盖环境。当前 Rollout 必须匹配该身份；不匹配时不回放另一线程。没有明确实时 ID 时，旧的 cwd/recent 规则仅提供历史快照，`activeThreadId` 保持空。

外部选择还要求 `thread/loaded/list` 与 `thread/read` 确认同一目标；仅存储在磁盘上的历史线程不能成为外部 authority。对已加载且 active/idle 的线程才调用 `thread/resume` rejoin，再补 history；不调用 `thread/start`、不覆盖线程配置。协议没有 observer-only resume，loaded 查询与 resume 之间存在非原子的卸载竞态，不能保证零副作用订阅。

外部 server 始终为 `external`；官方 proxy 是 HUD 自有 child。stop、SIGINT、SIGTERM 和异常退出只清理自有 child，candidate PID 只用于核验，绝不用于 terminate。即使显式配置允许官方 daemon start，持久 daemon 也不纳入 HUD 子进程清理。

## 能力与健康

`loadedThreads`、`threadRead`、`turnsList`、`itemsList`、`unsubscribe`、`accountRead`、`rateLimits` 分别记录 supported / unsupported / unknown。分页方法不支持时尝试 `thread/read(includeTurns=true)`；不能用整体 compatible 掩盖单项缺失。

外部连接要求实际 `server/diagnostics({})` 返回的 PID 与已核验进程一致；不支持该诊断方法的旧 server 当前拒绝外部附着。初始化 `userAgent` 不作为版本契约；owned server 没有可靠版本响应时显示 unknown，不把 PATH CLI 的版本冒充 server 版本。

健康由连接、协议及线程状态决定。闲置线程十秒没有事件不构成 unhealthy；不创建自定义 heartbeat。每个连接保留最后事件时间、事件数、线程 attachment、重连次数及失败原因，作为来源 metadata 投影到既有 HudState。
