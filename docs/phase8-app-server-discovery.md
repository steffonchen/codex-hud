# Phase 8：App Server 来源调查

调查日期：2026-09-13。本文区分当前安装版本的协议、实际进程观察与 HUD 运行验证。

## 当前环境与命令

- `codex --version`：`codex-cli 0.154.0`。
- `codex app-server --help` 确认支持默认 `stdio://`、`--stdio`、Unix socket、WebSocket 与 `off`。
- `codex app-server proxy --help` 确认可通过 stdio 代理连接既有本地 control socket，支持 `--sock`。
- `codex app-server daemon version` 返回 control socket 不存在；不能将独立启动的进程当作当前 Desktop 线程的执行进程。
- 当前 binary 已重新执行 `generate-json-schema --experimental --out <临时目录>` 与 `generate-ts --experimental --out <临时目录>`。没有修改用户配置。
- 现有 Rollout writer 为 0.153.4，与 CLI 版本分别记录；本轮没有启动新的模型轮次。

使用的导出命令为 `codex app-server generate-json-schema --experimental --out <临时目录>` 和 `codex app-server generate-ts --experimental --out <临时目录>`。`--listen` 的当前帮助列出 `stdio://`、`unix://`、`unix://PATH`、`ws://IP:PORT`、`off`。实现仅采用经本机帮助确认的 `codex app-server --stdio`；已有共享 socket 时采用 `codex app-server proxy --sock <既有 socket>`。没有创建或管理常驻 daemon。

## 连接与历史契约

通信为按行 JSON-RPC，wire 不要求 `jsonrpc` 字段。每连接先 `initialize`，再发送 `initialized`；响应按 ID 匹配，不能依赖顺序。初始化响应没有独立协议版本字段，因此诊断显示 `detected`，并另外标明采用当前 v2 schema。

`thread/read` 不订阅实时事件。当前协议没有专用 `thread/subscribe`；`thread/resume` 对运行中的线程重新加入，对未运行线程则可能从磁盘恢复。HUD 不用恢复历史线程来冒充被动订阅，也不通过配置覆盖改变线程。共享进程的可观察线程与独立 stdio 进程必须分别报告。

`thread/read` 的 `includeTurns` 对分页线程已不推荐。`thread/turns/list` 默认降序、summary，完整恢复需显式请求 full；`thread/items/list` 默认升序，可按 turnId 筛选，依赖后端分页支持。游标不透明，反向页可能再次包含边界项。历史读取只用于 bootstrap、线程切换和重连补偿。

Thread 的 `id` 对应当前 HUD 的 session.id；协议 `sessionId` 是整棵会话树共享身份，不能代替线程 ID。父关系只接受 parentThreadId 或明确的子代理来源；forkedFromId、路径、名称与时间不用于建父边。

Thread.model / reasoningEffort 是当前配置或最近持久化配置，协议明确说明它们不是逐轮执行遥测。因此仅用于模型展示，不用于给历史请求定价。`thread/status/changed` 的 `notLoaded` 撤销该线程的实时权威；`activeFlags` 可报告等待审批/用户输入，`idle` 不作为代理任务完成证据。此通知没有 turnId，须在历史与实时事件合并后关联已确认的当前轮次。

## 用量与计划

`ThreadTokenUsageUpdatedNotification` 的必需字段为 threadId、turnId、tokenUsage。tokenUsage 必需 total、last；modelContextWindow 可缺失或 null。两份 breakdown 包含 inputTokens、cachedInputTokens、outputTokens、reasoningOutputTokens、totalTokens；cacheWriteInputTokens 可省略，JSON schema 默认值为 0。来源层还需验证非负安全整数。

`TurnPlanUpdatedNotification` 必需 threadId、turnId、plan；explanation 可缺失或 null。步骤是 `{step,status}`，status 为 pending、inProgress、completed，没有步骤 ID、callId 或更新序号。它不能与仅包含 id/text 的 plan item 混淆。

Thread/Turn 历史对象不包含 Token 快照或执行清单通知。历史中的 plan item 是提案文本，不能补造执行步骤。Rollout 保留持久化用量与执行清单职责，费用继续由既有 CostCalculator 估算。

## 工具、代理、压缩与额度

item/started 提供 startedAtMs，item/completed 提供 completedAtMs，均为 Unix 毫秒；Thread/Turn 的 createdAt、startedAt、completedAt 为 Unix 秒。通知 completed 不表示工具成功，需检查 commandExecution、fileChange、mcpToolCall、dynamicToolCall、collabAgentToolCall 的各自状态。

collabAgentToolCall 的 senderThreadId、receiverThreadIds 是明确身份；仅 spawnAgent 的接收者可证明新建子关系。其他操作的接收者不能当作子代理。agentsStates 没有子线程 turnId，不得复制父轮次 ID。subAgentActivity 的 agentThreadId 是目标线程，item.id 是条目身份。

contextCompaction 只有条目身份，不携带压缩后的占用量；仅归一化压缩边界，等待实际用量。account/rateLimits/updated 是稀疏更新，需要在来源层按窗口与 credits 字段合并；空账户元数据不清除已确认值，spendControlReached 的显式 null 保留为不可用。多个额度桶且通知缺少明确 limitId 时报告身份不确定，不猜桶。Quota 仍复用现有解析器和 Tracker。

## 去重与来源约束

实施前，HudEvent 没有统一来源信封，Token 账本身份与 ordinal 带有 Rollout 假设；Plan 虽区分来源序号，却共享最终执行状态。Phase 8 增加来源元数据和独立去重层，保留原始来源序号，在过滤后才分配 Reducer 序号。不能将两个来源的本地序号直接比较，也不能给迟到历史赋新的到达序号来绕过屏障。

跨源工具可按明确 thread/turn/item/生命周期关联。Token 没有共享 requestId，Plan 通知没有 rollout callId；内容相等只证明快照相等，不能证明是同一次请求。来源层必须明确历史边界、交接与能力，不在业务 Tracker 中猜来源。

## 运行证据与限制

当前确认命令、协议导出与默认共享 control socket 不存在。未取得真实 App Server 通知进入 HUD 的证据，不能标记 RUNTIME VERIFIED。

只读握手探测脚本最初创建被自动审批服务拒绝；后续创建成功。它只计划发送 initialize、initialized、loaded/list，以及当前线程的 read / turns/list，不启动模型。沙箱内实际启动 `codex app-server --stdio` 后，进程在 initialize 完成前退出：exit=1，安全分类为 filesystem-permission / database，握手、线程读取和历史页均未完成。没有保存或输出 stderr 原文。

对同一握手命令申请沙箱外运行再次被自动审批拒绝，命令没有执行。最后，准备 doctor/debug/start 白名单降级验证脚本也被拒绝；已核对脚本没有创建，相关产品运行验证未执行。两次拒绝均为审批服务经 AnyRouter 调用 gpt-5.6-luna 时返回 HTTP 404，提示所选模型不受支持。未用其他工具、路径或间接启动绕过拒绝。

已获批的最多两轮短模型实验实际使用 **0 轮**。连接、通知、真实双来源一致性、真实 App Server 重连和终端验收均为 ENVIRONMENT LIMITED；Plan、Agent、MCP 自然通知为 NOT OBSERVED。自动化测试与历史 Rollout 的既有证据分别记录，不能替代本轮真实验证。

仓库保存六份原样 JSON Schema 及 SHA-256。19 份合成通知/响应/历史页已针对本机同次导出的 TypeScript 定义运行严格类型检查，结果 PASS；malformed 反例不参与符合性检查。这不是完整 JSON Schema validator，也不是运行捕获。样本说明见 [协议样本](../tests/fixtures/app-server/README.md)。

官方依据：[Codex App Server](https://learn.chatgpt.com/docs/app-server)。实际字段以本机 0.154.0 新导出的 schema 为准。
