# Phase 9：运行时来源对照

调查日期：2026-09-13。`IMPLEMENTED` 表示代码与软件测试覆盖；`RUNTIME VERIFIED` 只用于真实 Codex 进程、协议或原始 Rollout 的运行观察。Node 协议替身、schema 和单元测试均不计为真实 App Server 验收。

## 本轮证据

- 本机 CLI 为 `0.154.0`，当前根 Rollout writer 为 `0.153.4`。
- 实际环境 ID 与所选根 Rollout metadata 一致；选择依据为 `environment`，没有按修改时间推断实时线程。
- 2026-09-13 08:28:49 UTC 使用构建后的真实 Provider 只读回放当前 Rollout，读取 11,141,856 字节。验收策略显式关闭 spawn、external attach、managed start 和 reconnect。
- 当前沙箱中的进程表检查不可用，Runtime Discovery 返回 `error`，保留 Rollout fallback；未把空候选列表宣称为不存在外部进程。外部进程的早期只读观察见 [运行时发现](phase9-runtime-discovery.md)。
- 本轮没有启动真实 Codex server、daemon 或模型 turn，没有真实 App Server 通知样本。因此双来源对照为 **ENVIRONMENT LIMITED / NOT OBSERVED**。

## 字段对照

下列 App Server 列描述已实现的协议路径，不代表本机已观测到对应数据。两个来源没有可比样本时不填 PASS，也不强制一致。

| 数据 | App Server 实现路径 | 当前真实 Rollout | 真实双来源结论 |
| --- | --- | --- | --- |
| Model | `thread/read`、线程/轮次 metadata | `gpt-6-astra`；已观测 | NOT OBSERVED |
| Context | `thread/tokenUsage/updated`；历史不提供快照 | 88,980 / 258,400；约 34.435% | NOT OBSERVED |
| Token | 同一 TokenUsageTracker 处理实时累计/最近快照 | 累计 13,764,367；100 个可确认请求 | NOT OBSERVED |
| Cache | 同一请求账本；cached input 为 input 子集 | 最近命中率约 91.371%；已观测 | NOT OBSERVED |
| Plan | `turn/plan/updated`；提案与执行清单独立 | mode 已观测，当前执行清单未观测 | NOT OBSERVED |
| Tool | 历史 turn/items 与实时 item 生命周期 | 1 个活动工具；20 个近期结果 | NOT OBSERVED |
| Activity | 线程、轮次及工具生命周期 | `running` | NOT OBSERVED |
| Agent | 明确子线程及父线程身份，复用 AgentTracker | 6 个节点含根；5 个子代理均有独立 Token/Context，强关联 | NOT OBSERVED |
| Quota | `account/rateLimits/read` 兼容视图及额度通知 | `empty`，未观测非空窗口 | NOT OBSERVED |
| Cost | 既有标准 API 等价估算，不作为订阅账单 | 真实正数 cache write 的计费语义未确认，费用不可用 | NOT OBSERVED |

这些数值属于采样时刻的既有会话，不是本轮测试的模型用量。HUD 验收没有额外发起模型请求。源文件持续增长时，后续采样允许不同，不能用固定数值断言实时快照相等。

## 重启与命令入口

第一次验收进程正常释放 Provider 并退出后，第二个独立进程于 08:30:05 UTC 再次读取同一明确线程：offset 从 11,141,856 增至 11,182,769；累计 Token 从 13,764,367 增至 13,856,086；可确认请求从 100 增至 101。增加的 91,719 Token 与第二次 Context 快照相符。没有读取/解析错误；模型、6 个 Agent 节点、1 个活动工具、20 个近期工具、未观测执行清单及空额度状态保持一致。这验证了真实 Rollout 的进程重启恢复，不能替代真实共享 server 的重新附着实验。

通过 `createProgram` 调用 doctor、debug（80×24）和非 TTY start，三者均正常完成并清理。注入的是使用上述禁止启动/附着策略的真实 CodexSessionProvider；配置只采用内存默认值，没有写入配置文件。输出保留在 128 KiB 上限的内存 Writable，仅报告字节数和状态，没有输出正文。doctor 完成 Renderer 检查；debug/start 产生非空 HUD，stdout 没有 ANSI。单独用真实 state 验证 140/80/50/30 列分别渲染 19/8/4/4 行。

原始 Rollout 保留一条 `unknown-tool-field` 警告；没有把未知字段丢失伪装成完整解析。当前执行清单与非空额度仍未观测，既有测试或旧阶段样本不升级为本轮真实 PASS。

## 已验证的软件链路

`RuntimeFallback.test.ts` 覆盖 manager → AppServerSource → SourceDeduplicator → 原有 trackers 的完整链路，包括：实时 Token/工具/计划，断线后的 Rollout 补读，history/live 重叠，费用不重复累计，子线程独立用量，以及监听 EMFILE 后继续增量读取。重连复用原有来源 generation 与去重规则；没有新增 RuntimeTokenTracker、RuntimePlanTracker 或第二套 HudState。

`RuntimeThreadAttachment.test.ts`、`ThreadSelection.test.ts` 覆盖明确线程、跨 home 隔离、A→B→C 切换、旧响应隔离，以及关闭通知与未完成 resume 的竞争。这些是软件验证，不是跨真实 daemon 的 live parity。

2026-09-13 最新可执行回归为 71 个文件、1003 项通过；另四个使用临时 Unix socket 的文件未能在最终状态下完整重跑。完整回归被自动审批服务的模型接口 HTTP 404 拒绝，命令没有执行。早先局部通过结果不能替代最终完整套件。

## 未完成的真实对照

真实 managed daemon、external attach、shared socket、live Token/Plan/Tool/Agent/Quota、daemon restart 和双来源 parity 均保留未验证状态。当前协议没有无副作用的 observer-only resume 选项；实现仅对已确认加载且 active/idle 的线程 rejoin，但查询与 resume 之间仍可能发生卸载。真实 daemon 启停与最小模型实验需按已批准计划单独确认。
