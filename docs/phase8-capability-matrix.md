# Phase 8：来源能力矩阵

日期：2026-09-13。协议依据为本机 Codex CLI 0.154.0 导出，Rollout writer 为 0.153.4。下表描述已接入的数据契约，不把 schema、fixture 或单元测试当作真实通知证据。

`IMPLEMENTED` 表示实现已接入既有业务链路；`PROTOCOL TEST ONLY` 表示仅有协议与自动化验证；`HISTORICAL SOURCE ONLY` 表示依赖持久化来源。当前 App Server 的所有真实通知验证均为 `NOT OBSERVED / ENVIRONMENT LIMITED`。Phase 2～7 的既有运行结论见各阶段报告，本表不重新授予运行通过状态。

| 数据 | Rollout / 既有来源 | App Server 已接入能力 | App 历史能否恢复 | 限制 |
| --- | --- | --- | --- | --- |
| Session | YES：session_meta、task_started/complete | YES：Thread.id、turn/started/completed | YES：read、turns/list | sessionId 是会话树身份；不能取代 Thread.id |
| Model / Reasoning | YES：turn_context | PARTIAL：Thread.model / reasoningEffort | 当前或最近配置 | 不是逐轮遥测，不据此给历史请求定价 |
| Token | YES：token_count total/last | YES：thread/tokenUsage/updated | NO | 历史缺口由 Rollout 补偿；不从 Thread/Turn 合成用量 |
| Cache | YES：显式缓存读取/写入字段 | YES：cachedInputTokens、cacheWriteInputTokens | NO | 省略 cacheWrite 的协议默认值为 0；显式 null 无效；计费语义仍需确认 |
| Context | YES/PARTIAL：最近快照与窗口 | YES/PARTIAL：last.totalTokens / modelContextWindow、压缩边界 | 仅压缩条目 | 窗口可能为空；压缩条目没有压缩后实际用量 |
| Tool | YES：明确调用与结果 | YES：commandExecution、fileChange、dynamicToolCall、mcpToolCall、collabAgentToolCall | YES：turns/list full，必要时 items/list | 完成通知不等于成功；读取 status、exitCode、isError 等 |
| Activity | YES：既有工具和轮次事件 | YES：归一化工具开始/结束与轮次事件 | PARTIAL | 历史条目可能没有实时开始时间，不生成虚假耗时 |
| Agent | YES/PARTIAL：明确父边与独立子日志 | PARTIAL：parentThreadId、明确 spawn 接收者、子线程自身事件 | PARTIAL | 无父边的 subAgentActivity 不建关系；父 agentsStates 不推进子轮次 |
| Plan 执行清单 | YES：成功确认的 update_plan | YES：turn/plan/updated | NO | 没有 callId/修订号；同轮跨源不任意覆盖已确认清单 |
| Plan 提案 | HISTORICAL SOURCE ONLY / 既有结构化适配 | YES：plan item、item/plan/delta | YES：完成条目正文 | 提案与执行清单分开；跨断线不拼接无法确认的片段 |
| Plan Mode | YES：turn_context 明确模式 | 未接入模式推断 | NO | 不从文字或提案反推模式 |
| MCP | YES/PARTIAL：配置与明确调用 | PARTIAL：mcpToolCall 服务/工具身份、结果 | YES：调用条目 | 不等于完整工具目录或服务连接状态 |
| Skills | YES/PARTIAL：配置、磁盘、当前任务清单 | 未增加 App 来源 | NO | 保留 Phase 5 来源；不推断 loaded/active |
| Quota | PARTIAL：结构化 rate limits | PARTIAL：account/rateLimits/updated | NO | 账户可能不提供窗口；稀疏字段合并；多桶缺 ID 时拒绝猜测 |
| Cost | derived：既有 CostCalculator | derived：同一请求账本与计算器 | 依赖可确认的持久化用量 | 始终 estimated；不是实际订阅账单；未知模型/价格不补零 |
| Git | 无真实来源，既有演示接口 | 未增加 | NO | 不属于 Phase 8 范围 |

## 连接能力与实际可用性

| 项目 | 实现 | 当前运行证据 |
| --- | --- | --- |
| 官方 stdio transport、请求 ID、错误解析 | IMPLEMENTED | 本机帮助/导出已检查；握手前数据库权限失败 |
| 既有共享 socket 的 stdio proxy | IMPLEMENTED | 帮助确认支持；默认 socket 不存在，NOT OBSERVED |
| History bootstrap 与分页补读 | IMPLEMENTED | PROTOCOL TEST ONLY |
| 当前线程及明确子线程过滤 | IMPLEMENTED | PROTOCOL TEST ONLY |
| Live 通知与有界缓冲 | IMPLEMENTED | PROTOCOL TEST ONLY |
| 重连、历史边界、重叠去重 | IMPLEMENTED | PROTOCOL TEST ONLY |
| 根/子线程 notLoaded 后的来源交接 | IMPLEMENTED | PROTOCOL TEST ONLY |
| Rollout fallback 与禁用 App 配置 | IMPLEMENTED | 自动化完整 Provider 链路通过；本轮真实产品验证受审批阻塞 |
| Doctor / Debug 来源检查及脱敏 | IMPLEMENTED | 自动化通过；本轮真实命令验证未执行 |

`SourceCapabilities` 中的布尔值表示来源适配器支持该协议能力，不表示当前连接、当前线程或账户正在提供数据。`SourceStatus.available/live/history` 和实际 HudState 分别报告连接、实时和已取得数据；`tokenSource` 另行报告 Token 的实际权威来源，不能用 active source 代替各模块来源。

独立 stdio 实例可读取持久化线程，但不能假装订阅另一个 CLI/Desktop 实例。只有当前 App Server 已承载的线程才自动 rejoin。无明确当前身份时，不选择任意 loaded 线程，不发 thread/start 或 turn/start。

依据与限制：[Discovery](phase8-app-server-discovery.md)、[来源一致性](phase8-source-parity.md)、[阶段验收](phase8-app-server.md)。
