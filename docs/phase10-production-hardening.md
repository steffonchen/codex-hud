# Phase 10 生产加固

本阶段保持 Phase 1–9 的架构和现有模块，补齐诊断、错误边界、恢复和资源限制。总体验收为 **PARTIAL**；真实 Rollout 链路与受限环境下的证据见 [验收矩阵](phase10-acceptance.md)，性能定义和测量见 [性能报告](phase10-performance.md)。实现不等于真实 Runtime 已验证。

## 架构与数据流

```text
真实 Codex
  → RuntimeDiscovery / RuntimeProbe / RuntimeAuthority
  → AppServerSource 或 RolloutSource
  → Event normalization / SourceDeduplicator
  → HudStateReducer
  → Token / Quota / Tools / Activity / Agents / Plan / MCP / Skills Trackers
  → HudState / StateStore
  → HudRuntime / RenderScheduler
  → HudRenderer / LayoutEngine / TerminalController

各边界的诊断 → HudDiagnosticsTracker → doctor / debug
```

`HudDiagnostics` 与业务 `HudState` 分离，记录 runtime、source、session、events、render、recovery、performance、memory 和有限告警。Renderer 继续只使用状态、终端尺寸、配置和时钟；渲染路径不读取 rollout、不扫描进程/socket、不调用 CLI，也不读取 SQLite/WAL。

## 诊断语义

- `received`：送入统一归一化事件入口的次数，包括无效信封与被路由拒绝的事件。
- `accepted`：Source 实际向后分发的事件数；Token 镜像可以先缓冲，再于回退时分发。
- `processed`：成功完成 Reducer 调用的次数，包含 Tracker 判定无需改变状态的调用。它不是请求数或 Token 数。
- `deduplicated`：Source 确认重复的次数。Tracker 内部语义去重不重复纳入此计数；同内容的新物理行可能到达 Tracker 后才被忽略。
- `outOfOrder`：观察到旧顺序的次数。可以补充历史轮数的迟到开始事件仍可能被采用，因此此项不一定与 accepted 互斥。
- `dropped`：信封、策略、身份、顺序或容量检查导致的舍弃。`invalid`、`unknown` 是其中的原因分类，不能再次加到 dropped 求和。
- `rawReceived/rawInvalid/rawUnknown`：原始解析入口的辅助计数。Rollout 的 rawUnknown 包括没有专用 HUD 映射的合法日志行，不代表协议失效；raw 与归一化事件不是一比一关系。
- `reconnectCount`：连接重试次数；从未连接成功时的重试也会计数，不能据此宣称真实断线恢复成功。

诊断计数跟随 Provider 实例生命周期；业务账本和来源身份随会话切换重置。首次启动/事件/渲染计时从诊断对象创建开始，复用同一实例重启时不伪装成一次全新的首次启动。停止后来源明确为 disconnected；重复读取诊断不会制造恢复或回退次数。

`debug` 只导出固定类别、字段和计时阶段，线程 ID 缩短为八个字符，文本经统一脱敏。未知原始字段、原始消息、工具输入输出和环境变量不进入新增诊断。`doctor` 显示 HUD/CLI/writer 版本、来源、authority/ownership、候选数量、能力和实际观测的区别；来源或 watcher 检查失败后仍继续配置与渲染检查。

Tool/Agent 展示状态没有逐条保留 source 标签；混合来源场景会明确写“归一化历史与实时事件”，不冒充精确的逐工具来源审计。

## 来源健康与恢复

统一健康值为 `healthy / starting / connecting / stale / reconnecting / fallback / disconnected / failed / unknown`。恢复诊断使用 connected、starting、stale、reconnecting、reconnect-failed、fallback、degraded、disconnected。

默认事件年龄阈值为 60 秒。stale 表示近期没有业务事件；正常 idle 不等于失败。Provider 的既有低频检查在必要时执行一次 `thread/read(includeTurns:false)`，5 秒内无有效同线程响应才断开并重试。并发检查共用一个 Promise，不增加常驻 interval；线程/generation 改变后旧结果失效。

复用既有指数退避，默认基础间隔 1 秒、最大 30 秒、最多 8 次失败尝试。成功初始化、历史同步以及账户读取阶段均检查 generation，防止账户读取期间断线后由旧任务重置重试预算。Source 创建失败也有低频有界重试，停止时清除重试与订阅。

旧历史请求失败前再次核对 selection，不能把 A 的 partial 状态写入 B。重连保留已确认历史边界；历史同步期间的实时通知受条数与字节数双限制。

连接清理失败时保留尚未确认退出的对象，停止自动创建替代连接。错误返回调用方；后续显式 stop 可以重试。Provider 若保留 Source 供失败后的重启，也保留相应订阅，避免“连接成功但没有事件消费者”。正常退出会释放这些订阅。

## 事件与状态正确性

事件入口检查空值、类型、来源、身份、有限非负时间及安全整数序号。未知类型计数后舍弃；深层业务字段仍由原 Parser/Tracker 验证。单条归约异常、解析异常、发布微任务异常有独立错误边界，并明确提示状态可能不完整。

主 rollout 的线程必须符合 Discovery 选中的身份。普通追加中的另一份 session_meta 会被拒绝。文件实际截断或替换后允许重新 Discovery 并重放一次；“截断到空文件→稍后写新身份”的中间态保留待确认标记，不因两次读取之间的空窗失去恢复机会。明确指定的实时线程不会擅自切换到新文件身份。

旧轮次不会抢占当前活动、模型、计划或占用状态。已经计量的旧 Token 镜像仍可确认交接队列，使当前轮次的 Rollout 尾部在断线后继续更新。相同 Token 的窗口 `A→B→A` 更新占用容量，不重复记请求或费用。

Token 保持以下不变量：cached input 是 input 的子集；reasoning output 是 output 的子集；累计快照不相加；请求账本采用已确认增量。Quota 不推导美元账单，Cost 始终是标准 API 等价估算。定价或缓存写入契约不明时返回 unavailable，而非错误金额。

Agent 依据明确的线程和父边隔离。完成节点归档后保留有限身份；只有明确的新轮次、有效父关系和非旧时间才可恢复。新轮次不会被旧完成事件覆盖；根 Token 不累加子代理 Token。

## 资源边界

| 资源 | 边界与行为 |
| --- | --- |
| 主会话轮次身份 | 2048；总轮数单独累计 |
| 无时间依据且已淘汰的轮次 | 不重新计数、不切换当前轮次，报告身份窗口限制 |
| Source 去重身份 / 单消息身份 | 默认各 2048；同序号插入前检查容量 |
| 来源线程 | 256；水位按有限来源、线程与事件类型保存 |
| Token 镜像队列 | 每线程每方向默认 2048；超限报告无法安全交接 |
| 请求账本 / 展示请求 | 512 / 20 |
| 活动工具 / 近期工具 / 工具身份 | 64 / 20 / 256 |
| Agent 总数 / 近期完成 / 退休身份 | 256 / 20 / 1024 |
| 每代理旧轮次 | 64 |
| Agent reader / 退休文件游标 | 最多 255 / 4096；不各自创建 watcher 或 timer |
| 计划步骤 / 文本 / 事件 | 256 / 64 KiB / 20 |
| MCP server / tool / thread | 128 / 1024 / 256 |
| Skills | 512 |
| 内部告警 | 按 code 聚合，最多 20 项 |
| 根解析详情 / 子线程详情 | 每个来源最多 50；省略错误独立保留数量和严重级别 |
| 单次 Reader 诊断 | 48 个细节 + 最多 2 个严重级别摘要 |
| StateStore 队列 / 单轮重入通知 | 64 / 256；合并末尾快照，超限有错误计数 |
| App 历史缓冲 | 默认 2048 条 / 2 MiB |
| App 历史 | 分页和 8192 条/16 MiB 等既有边界 |
| 协议请求 / 单消息 / 写缓冲 | 64 / 8 MiB / 1 MiB；默认请求 8 秒超时 |
| 根 watcher | 最多一个；EMFILE 后集中 3 秒增量轮询 |

有界身份窗口无法保证无限久远、没有时间或顺序依据的事件仍可精确去重。超出窗口且无法确认新旧时显式拒绝，不能将猜测当成新轮次。工具、Token 和 Plan 的既有不完整覆盖标记继续保留。

停止后的有界状态、Agent reader 对象可供同实例重启使用；reader 对象不持有跨读取的文件描述符。资源验收关注活动 watcher、timer、监听、pending request、transport 和自有进程是否释放，而非要求所有历史 DTO 在 stop 时变为空。

## 渲染、输出与安全

单模块可用性或 render 失败时保留其他模块，Runtime 显示安全错误提示并允许后续更新或 resize 恢复。成功重绘同时清除旧提示并恢复运行状态。布局保持宽高约束；九种规定宽度和连续 resize 均有测试。

终端写入默认 5 秒超时。超时时取消真实 Writable，避免迟到失败在监听移除后触发未捕获 error；终端输出故障和清理失败仍向调用方报告，不能伪装成运行成功。

外部 runtime PID 仅用于身份核验，永不传给 kill。HUD 只停止自己创建的 stdio/proxy 子进程。本阶段没有修改用户 Codex/HUD 配置，没有安装服务、启停真实 daemon、创建分支、提交、推送或创建 PR，也没有新增依赖或 SQLite/WAL 访问。

## 验证入口

```bash
npm test
npm run typecheck
npm run build
npm run benchmark:phase10 -- 10000
npm run soak:phase10 -- 30 /tmp/codex-hud-real-soak.json
```

两个脚本使用当前 dist，必须先 build。基准明确使用合成日志和本地协议夹具进程；soak 必须取得当前任务的明确线程与真实 rollout 关联，只读观察，关闭自有 Codex spawn 与 daemon 自动启动。它不会制造模型请求、Plan、MCP 或断线来凑验收。
