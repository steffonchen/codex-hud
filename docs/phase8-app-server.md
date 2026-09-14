# Phase 8：App Server 实时来源集成

日期：2026-09-13。**Phase 8 status: PARTIAL**。

App Server 来源、协议处理、历史补读、实时归一化、去重、重连和 Rollout 回退已实现，63 个测试文件、936 项测试全部通过。真实 App Server 在握手前受运行时数据库权限限制；沙箱外探测又被自动审批服务拒绝。因此本阶段不把实现和测试通过写成真实连接/通知已验证，也不进入 Phase 9。

## 环境与验证

| 项目 | 结果 |
| --- | --- |
| Codex CLI | 0.154.0；本机命令确认 |
| Rollout writer | 0.153.4；与 CLI 版本分开记录 |
| Tests | PASS：936 tests / 63 files |
| Typecheck | PASS：`npm run typecheck`；src + tests 共 169 个 TypeScript 文件的额外严格检查通过 |
| Build | PASS：`npm run build`，dist 已更新 |
| 当前导出类型与合成样本 | PASS：19 份通知/响应/历史页；六份 JSON Schema 原样保存并带 SHA-256 |
| 用户配置哈希 | UNCHANGED：Codex 与 HUD 两份配置均与实施前相同 |
| 模型实验额度 | 最多两轮短请求已获批；实际使用 0 轮 |

自动化检查覆盖来源切换、bootstrap/live 重叠、旧连接隔离、分页与边界缺失、断线补偿、notLoaded、单独子线程回退、会话切换、停止/重启、错误脱敏和资源上限。SIGINT/SIGTERM 的新增集成测试经现有 Runtime 关闭真实 Node 协议替身子进程；它不是 Codex 运行证据。

## 架构

```text
Rollout JSONL → RolloutSource → 既有 RolloutEventParser ─────┐
                                                         │
Codex App Server → 单一 stdio/proxy connection             │
                 → AppServerEventNormalizer ──────────────┤
                                                         ▼
                         HudEvent + 来源元数据
                                      ↓
                SourceAuthorityPolicy + SourceDeduplicator
                                      ↓
          既有每线程 HudStateReducer / Trackers / CostCalculator
                                      ↓
                HudState → StateStore → 既有 Renderer
```

`HudEvent` 仅增加 source、threadId、turnId、eventId、sourceOrdinal、generation、phase。规范身份由 JSON 数组编码后散列，避免分隔符碰撞；来源内部顺序先校验，过滤后才分配 Reducer ordinal。Token 请求账本使用来源层给出的事件身份，业务计算语义保持不变。

根线程和子线程复用现有 Reducer。只有 App 历史/通知的子线程也可建立独立状态；后续发现其 Rollout 时复用同一 Reducer。没有 AppServerTokenTracker、AppServerPlanTracker、AppServerHudState、第二套 Renderer，也没有每模块/每代理连接。

## 连接与历史生命周期

1. 使用本机帮助确认支持的 `codex app-server --stdio`。既有默认 control socket 存在时，使用官方 `app-server proxy --sock` 连接；不创建 daemon。
2. 单连接发送 initialize，再发送 initialized。响应按数值 ID 匹配，支持乱序返回。协议无独立协商版本字段，诊断显示 `protocol: detected`，schema 另记 v2。
3. 当前线程由原 Discovery 策略选择。Thread.id 映射 session.id；仅跟踪该根线程和明确父边的子线程，不因其他通知切换 HUD。
4. 查询 loaded/list；read 获取线程 metadata。只对当前实例已承载的线程 resume/rejoin，随后读取 turns/list full；summary 条目用 items/list 补全。订阅期间的 live 事件先进入有界缓冲，历史合并完成后再交付。
5. 初次无基线按 asc 读取；已有 Rollout 或实时边界时从 desc 找到已确认轮次，再正序归约。缺失边界保持 partial，不重放不确定旧轮次。缺口按线程保存，直到原边界真正补齐。
6. 连接失败进入 failed/disconnected/reconnecting，按 1 秒起、最高 30 秒退避恢复。保留 Tracker 状态；重连后补历史并去重，旧 generation 的回调无效。
7. notLoaded 撤销该线程的实时权威。沿用 Provider 的 3 秒发现周期检查是否重新承载；仍卸载时不重复读取其历史，重新 loaded 后再 rejoin 和补读。子线程卸载只交接自身来源。
8. stop 幂等，等待正在进行的同步与清理，取消重连 timer、监听及 pending 请求。正常先 SIGTERM，1.5 秒未退出则 SIGKILL；父进程已进入 exit 时同步终止其所拥有的子进程。

thread/read 不订阅；没有专用 thread/subscribe。独立 stdio 进程不能被当作另一个 CLI/Desktop 进程的实时来源。产品不会自动发 thread/start、turn/start，也不会修改 Codex 配置以促成共享连接。

## 数据接入、来源交接与错误处理

Token、Cache、Context、Plan、Tool、Activity、Agent、Quota 均经 HudEvent 进入既有 Trackers。Plan 优先使用 turn/plan/updated；plan item 只代表提案。工具结果读取真实状态与错误字段，不把 item/completed 直接视作成功。代理关系来自明确 parent/spawn 身份，子生命周期只接受其自己的线程事件。

Rollout 持续提供持久化基线和补偿。Token 没有共享 requestId，使用有界快照序列对齐已确认前缀与待采用尾部；内容相等不能单独证明重复请求。权威累计发生下降时，后续相同内容可代表新请求。无法对齐、重放锚点未到达或镜像队列溢出时保留确认值并诊断，不虚构费用。

同轮执行清单没有跨来源修订号，因此保留已确认的清单来源；跨断线 proposal 的不完整片段不拼接，等待完整 completed 正文。Source policy 和具体对照见 [来源一致性](phase8-source-parity.md)。

未知通知和字段可忽略，未知工具状态保持未知；坏 JSON、坏 UTF-8、错误响应、超时、缺失身份和分页循环有明确诊断。HUD 不处理工具执行或审批类 server request，按 JSON-RPC 返回 -32601，不代替用户执行或批准操作。

App 通知仅增量归约并合并 Store 发布，不逐条重读 Rollout、重放全历史或重做 Discovery。没有新增文件 watcher。保留原根目录的最多一个 watcher 与其 EMFILE 增量补查；重连 timer 是整个来源的单一连接调度。

| 边界 | 上限与处理 |
| --- | --- |
| pending 请求 | 64；默认 8 秒超时 |
| JSON 输入行 | 8 MiB；超长行诊断后跳到下一行 |
| JSON 输出与待写缓冲 | 各约 1 MiB；超限拒绝请求 |
| bootstrap live 缓冲 | 2048 个归一化事件 / 2 MiB；溢出断开并安排补读，保持可观察 |
| 历史分页 | 每次最多 100 页；16 MiB 历史内容边界；游标循环报错 |
| 线程 | 最多 256 个明确关联线程 |
| 去重与 Token 镜像 | 默认 2048 项；无法安全交接时保留已确认值并诊断 |

## 配置与诊断

复用既有 `~/.codex-hud/config.toml` 字段，默认值仍为：

```toml
[providers]
prefer_app_server = true
use_rollout_fallback = true
```

prefer_app_server=false 完全不启动 App Server，继续 Rollout。use_rollout_fallback=false 在启用 App 时关闭 Rollout 消费与 watcher；缺失 Token/计划历史时不会制造补偿数据。已有用户文件未写入。

Doctor 显示 available、transport、protocol、connection、history、capabilities 与实际来源。Debug 只输出白名单来源 metadata、8 字符线程摘要、事件种类和计数，不输出 JSON-RPC 原文、prompt、认证或工具完整参数。stderr 仅归类权限/数据库/参数错误，不保存正文。

默认不增加占位的 data-source 模块。发生降级时，Runtime 页脚显示“数据源降级”，窄屏使用 RL / AS / —；即使 hide_when_idle 生效，降级提示仍保持可见。active source 与 tokenSource 分别记录，避免误报 Token 的权威来源。

## 本轮运行验收

| 能力 | IMPLEMENTED | RUNTIME VERIFIED |
| --- | --- | --- |
| App Server / Connection | YES | ENVIRONMENT LIMITED：握手前退出 |
| Protocol | YES | ENVIRONMENT LIMITED；PROTOCOL TEST ONLY |
| History bootstrap | YES | ENVIRONMENT LIMITED；PROTOCOL TEST ONLY |
| Realtime | YES | NOT OBSERVED / ENVIRONMENT LIMITED |
| Token / Cache / Context | YES | App 通知 NOT OBSERVED；既有 Rollout 结论见 Phase 7 |
| Plan | YES | App 通知 NOT OBSERVED；既有历史清单证据不移作本轮实时证据 |
| Tools / Activity | YES | App 通知 NOT OBSERVED |
| Agents | PARTIAL：明确身份及自身轮次 | App 通知 NOT OBSERVED |
| MCP | PARTIAL：明确调用与结果 | App 通知 NOT OBSERVED |
| Quota | PARTIAL：结构化窗口适配 | App 窗口 NOT OBSERVED；不补做 Phase 7 限制实验 |
| Fallback | YES | ENVIRONMENT LIMITED；合成 Provider 完整链路通过 |
| Reconnect | YES | ENVIRONMENT LIMITED；断线补读自动化通过 |
| Source parity | DOCUMENTED | NOT OBSERVED；仅协议/合成数据对照 |
| Doctor / Debug | YES | 自动化 PASS；本轮真实产品验证脚本未执行 |
| Session switch | YES | 自动化 PASS；本轮真实 App 验证受限 |
| HUD restart | YES | 自动化 PASS；本轮真实 App 验证受限 |
| SIGINT / SIGTERM | YES | 自动化 PASS，含真实 Node 替身进程；非真实 Codex 验证 |
| EMFILE | YES：保留既有补查 | 自动化 PASS；本轮未重复真实自然 EMFILE 实验 |

阻塞证据：沙箱内 Codex 进程 exit=1，stderr 安全分类为 filesystem-permission / database；未完成 initialize。沙箱外握手以及后续准备产品降级验证脚本被自动审批拒绝，审批服务通过 AnyRouter 调用 gpt-5.6-luna 返回 HTTP 404“不支持所选模型”。后一个脚本未创建，未通过间接执行绕过。详细记录见 [Discovery](phase8-app-server-discovery.md)。

## 已知限制

- 当前默认共享 socket 不存在；即使独立 stdio 成功启动，也只能补充其他实例的历史，不能凭空获得其实时通知。
- App 历史没有 Token 快照或执行清单；断线期间这些事件的恢复依赖 Rollout。边界不确定或关闭 fallback 时明确保留缺口。
- Thread.model 不是逐请求定价依据，App-only 用量可能缺少可靠模型、价格或完整账本。Cost 仍是估算，Phase 7 的价格/额度运行限制保持原结论。
- 无共享 Plan 修订号、delta 片段身份和 Token requestId；采用保守、有界交接，不以到达时间猜测权威。
- Agent、MCP、Quota 的适配不等于完整能力：无可靠父边不建树，无生命周期证据不宣称服务连接，无非空窗口不显示 0%。
- 真实连接、最小模型通知、双来源 parity 和终端验收尚未完成。需要修复审批模型路由并允许 App Server 访问自身运行时数据库后，继续已获批的有限实验；剩余验证不能用单元测试替代。

## 修改范围

- 新增 `src/core/source/`：公共来源契约、身份、权威与去重。
- 新增 `src/providers/codex/app-server/`、RolloutSource、SourceDiagnostics；接入 CodexSessionProvider 与既有子线程 Provider。
- 既有 HudEvent/HudState/AgentEvents 增加 metadata；Token 账本采用统一 eventId；复用既有 shell 摘要。
- CLI、CapabilityDetector、Usage/Plan 诊断与 Runtime 接入来源状态及统一退出清理。
- 新增八类 Phase 8 测试、共享协议替身与脱敏 fixtures；更新 Plan 旧诊断断言和 Runtime 降级测试。
- README、四份 Phase 8 文档及对应 dist 构建产物。未修改依赖清单、用户配置，未删除文件，未执行 Git/发布操作。

相关资料：[协议调查](phase8-app-server-discovery.md)、[能力矩阵](phase8-capability-matrix.md)、[来源一致性](phase8-source-parity.md)、[样本说明](../tests/fixtures/app-server/README.md)。
