# Phase 10 性能与长期运行

环境：macOS arm64、Node v23.11.0、Codex CLI 0.154.0、Desktop writer 0.153.4。下述时间来自本机观测，不作为跨设备的性能承诺。基准和真实运行分开记录。

## 可复现命令

```bash
npm run build
npm run benchmark:phase10 -- 10000
npm run soak:phase10 -- 30 /tmp/codex-hud-real-soak.json
```

基准使用临时目录、真实 Node stdio 夹具子进程、合成 rollout 和现有整条处理链。退出清理仅针对夹具及临时目录。soak 读取当前真实任务，不启动独立 Codex/daemon、不发送模型请求、不改用户配置。

## 计时定义

| 字段 | 测量边界 |
| --- | --- |
| startup | 诊断实例创建至首次取得可用来源 |
| discovery | Provider 调用 Discovery 的耗时；可包含文件发现与只读 CLI 探测 |
| attach | 本轮 Source select/start/初次同步完成；缺少可用 App 时不填数字 |
| firstEvent | 实例创建至第一次采用事件，可能来自历史 |
| firstRender | 实例创建至第一次渲染完成，包含“等待会话”首帧，不等于首个业务数据帧 |
| eventToReducer | 验证、排序、来源去重的本地处理时间，不是 Codex 产生事件至屏幕的端到端延迟 |
| reducer | 单次归约时间，包含 Tracker 调用 |
| reducerToRender | 最近一次成功归约至随后一帧完成，包含状态发布、调度和输出；合并更新只计最新边界 |
| render | Runtime 当前一帧的构造、布局和输出；压力回放为 Store 快照加纯渲染 |
| reconnect | 重试开始至连接/同步成功，不含退避等待；另记录完整断线恢复 wall time |
| shutdown | Provider 和 Runtime 分别记录清理耗时；不能将两个样本相加当总耗时 |

每阶段仅保留 count、total、last、max；mean 从 total/count 得出，不保存每事件计时数组。没有观测到的 attach/reconnect 不填零来冒充成功。

## 一万请求合成基准

命令：`node --expose-gc scripts/phase10-benchmark.mjs 10000`。原始数字见 [benchmark.json](evidence/phase10/benchmark.json)。

| 项目 | 测量结果 |
| --- | ---: |
| 初始 Runtime 启动 wall time | 45.64 ms |
| Discovery 均值 / 最大 | 0.85 / 1.36 ms |
| 合成协议 attach | 30.55 ms |
| 首事件 / 首帧（可为等待帧） | 12.79 / 9.46 ms |
| 合成完整重连 wall time | 38.93 ms |
| 重连连接与同步阶段 | 27.11 ms |
| Runtime shutdown | 2.35 ms |
| 静态 rollout 第二次读取新增字节 | 0 |
| 压力回放总耗时 | 503.58 ms |
| 解析时间合计 | 83.32 ms |
| Store 状态构造与写入合计 | 15.43 ms |
| Source 验证/排序/去重均值 / 最大 | 0.00379 / 1.21 ms |
| Reducer 均值 / 最大 | 0.00112 / 1.74 ms |
| 压力渲染均值 / 最大 | 0.203 / 1.535 ms |
| 压力回放观察进程 CPU 时间 | 821.80 ms |
| 真实夹具进程创建 / 停止后 pending 请求 | 2 / 全部 0 |

压力输入为 40002 条原始日志，归一化产生 60003 次事件分发；每个 Token 快照刻意重复一次，每 100 请求渲染一次。最终请求数 10000、轮数 10000、累计 Token 1100000。Tracker 把重复内容判为无更新，Source 的 received/processed 不等于请求数，也不能据此把 Token 再相加。

### 历史与堆内存

| 请求数 | 主动 GC 后 heapUsed |
| ---: | ---: |
| 1000 | 9.25 MiB |
| 2000 | 9.53 MiB |
| 4000 | 9.64 MiB |
| 6000 | 9.59 MiB |
| 8000 | 9.66 MiB |
| 10000 | 9.61 MiB |

最后一次采样后约 9.58 MiB；RSS 约 121.6 MiB。请求账本最多 512 条、轮次身份 2048、去重身份 2048，Token 待交接队列为 0。该合成输入在窗口填满后堆占用趋于稳定。RSS 受 V8/分配器保留空间影响；它不等于仍可达的业务对象大小。

主动 GC 只用于基准的可比性，不是生产逻辑，也不是为修复泄漏而定期强制 GC。CPU 时间包含运行时/GC 线程，可能高于 wall time；不包含外部 Codex 的 CPU。

## 真实来源持续运行

两轮独立的 30 分钟观测均已完成，合计观测约一小时，但不是连续一小时。第一轮为较早构建，北京时间 18:19:02–18:49:02，仅作补充证据；最终结论采用第二轮。原始记录见 [最终轮采样](evidence/phase10/real-soak.json) 与 [第一轮摘要](evidence/phase10/real-soak-pre-final-summary.json)。

最终轮时间为 **2026-09-13 18:51:47–19:21:47（Asia/Shanghai）**，实际持续 **1800078.05 ms**，共 31 次采样。观测进程成功退出，`completedRequestedDuration=true`，没有 failure、cleanupFailure 或 invariant violation。观测构建与最终 dist 的 JavaScript 指纹一致：

```text
40646bf8c5ba034050a3a881921b2b565a6204d7d47e8e4ce3570a6bd278858f
```

| 最终轮指标 | 观测结果 |
| --- | ---: |
| 主会话身份 / Token 不变量 / 原始累计分项对照 | 各 31/31 通过 |
| 归一化 processed：首样本 → 末样本 | 1784 → 1934，观测期间增加 150 |
| 原始行计数：首样本 → 末样本 | 1554 → 1689 |
| 根请求账本：首样本 → 末样本 | 73 → 86 |
| 累计渲染次数（含收尾帧） | 2676 |
| 原始无效行 / Reducer 错误 / Renderer 错误 | 0 / 0 / 0 |
| heapUsed：首样本 / 末样本 | 15.73 / 13.46 MiB |
| heapUsed：采样最小 / 最大 | 13.46 / 30.35 MiB |
| 停止并主动 GC 后 heapUsed | 11.67 MiB |
| RSS 采样峰值 | 127.94 MiB |
| 观察进程 CPU 时间 / 单核平均占用 | 21.81 s / 1.21% |
| startup / 首事件 / 首帧 | 199.48 / 43.02 / 3.34 ms |
| Discovery 均值 / 最大 | 67.66 / 206.67 ms |
| Source 验证、排序、去重均值 / 最大 | 0.00528 / 0.216 ms |
| Reducer 均值 / 最大 | 0.00580 / 0.289 ms |
| 最近归约至渲染完成均值 / 最大 | 13.42 / 142.66 ms，49 个合并样本 |
| render 均值 / 最大 | 2.44 / 12.92 ms |
| Runtime shutdown | 0.44 ms |

首样本包含启动时的历史回放，不能将 1934 次 processed 全部算作 30 分钟内的新事件。`rawUnknown=807` 是没有专用 HUD 映射的合法原始行，不属于无效事件。首帧可为等待数据帧，所以可以早于首次可用来源和首事件。

采样期间请求账本峰值 86、去重身份峰值 670、根轮次身份 1，均低于边界；6 个代理状态包含 5 个子代理。`stateSubscribers` 恒为 1，App 事件/状态/诊断订阅各 1；Provider timer、Rollout poll timer 各 1，重试 timer 峰值 1。由于 EMFILE，实际 active watcher 始终为 0；最多一个 watcher 的正常监听路径由自动化验证。

观测进程的 Node 活动 `Timeout` 峰值为 5，包含 Runtime、Provider 和采样脚本自身的时钟；没有观测到活动 socket 或子进程资源。停止后 `resourcesAfterStop={}`、输出监听器 `[]`，诊断中的订阅、timer、watcher、client、pending request/write 均为 0。保留的 5 个 Agent reader 是有界游标对象，不持有长期打开的文件描述符。

中间采样未主动 GC，首末观测采用同一状态链。结合合成压力和反复启动/停止测试，本轮没有发现持续线性增长；这不等于无限时长无泄漏的保证。

真实环境遇到 `fs.watch EMFILE`，使用原有每 3 秒 stat/offset 增量轮询。Runtime 进程核验返回 EPERM，共享 socket 未发现，因此真实观测使用 Rollout。连接重试计数代表失败尝试，不代表已经验证了一次 App Server 断线后恢复。

采样每分钟记录：源年龄、归一化事件/原始行计数、Reducer/渲染计时、heap/RSS、观察进程 CPU、历史大小、watcher/timer/listener/pending/client 数量、终端输出次数。原始事件正文不写入报告。独立读取已消费 offset 前最多 1 MiB 的尾部，对照最后一个完整 token_count 的累计分项；不会比较尚未被 Provider 消费的追加字节。

HUD 重启快照实验确认同一线程、同一 offset 时 usage 完全一致。真实数据九宽度渲染均无越界、无 ANSI 残留；这是布局输出验证，不是物理终端视觉或 Ctrl+C 验证。

最终轮 31 次主动 refresh 中有 30 次新增读取为 0 字节，持续更新也可能已由集中轮询提前消费。另一次快照实验期间恰有 1869 字节自然追加，`unchangedSnapshot=null`，因此不把那次实验写成静态文件零读取。静态输入的独立零读取断言由合成基准验证。

## 轮询、I/O 与恢复成本

- `refresh_ms=150` 控制脏状态渲染节流；没有 150 ms 的进程、socket 或全文件扫描。
- Runtime Discovery 缓存默认 30 秒，并合并进行中的扫描；显式重新连接可强制重新发现，以免复用失效 authority。
- Provider 自身每 3 秒重新发现可能的新会话；CLI 版本读取也属于该低频阶段，未声称它只执行一次。
- Rollout 读取保留 offset，只读追加内容；文件真实截断、替换、读取失败后的恢复才允许重放。
- 子线程集中读取，不为每个 Agent 分配 watcher/timer。
- 正常闲置最多在 60 秒无事件/检查后发起一个有界协议健康请求。默认失败退避最多 8 次，不持续无限 spawn。

本阶段没有进行以性能为由的架构改写。现有 Renderer/Store 的快照复制在本机规模下没有显示出需要额外优化的证据。

## 结论边界

自动化循环与合成压力证明已覆盖路径中的资源释放和集合边界；30 分钟真实观测补充 Rollout 运行证据。它们不能数学证明所有输入、无限运行时长、外部 Codex 自身或所有真实 App Server 协议故障均无泄漏。

既有增量 reader 只做有限尾部检查：若外部程序原地改写很早的历史内容，同时保留文件身份、长度相关条件和末尾校验片段，可能无法检测。Codex 的追加日志正常契约不要求每次全文件校验；本阶段没有引入昂贵的全文件散列轮询。
