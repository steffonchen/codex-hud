# Phase 10 验收矩阵

**PHASE 10 STATUS: PARTIAL**

日期：2026-09-13。环境为 macOS arm64、Node v23.11.0、Codex CLI 0.154.0、当前 Desktop rollout writer 0.153.4、HUD 0.1.0。使用当前任务的明确环境线程 ID，不读取其他任务正文、不创建模型请求、不修改真实 rollout。

Implemented 表示代码存在；Automated/Replay 表示自动化或夹具证据；Real Runtime 单独记录实际来源。下表 PASS 只限于有本轮真实证据的范围。合成协议的通过不作为真实 App Server 通过。

## 能力矩阵

| 能力 | Implemented | Automated | Replay | Real Runtime | Status | 证据与限制 |
| --- | --- | --- | --- | --- | --- | --- |
| Model | 是 | 通过 | 通过 | 当前任务 Rollout | PASS | 实际模型字段与 HUD 渲染；App Server 通道未验证 |
| Reasoning | 是 | 通过 | 通过 | 当前任务 Rollout | PASS | 实际 effort 字段；不推断未上报的内部推理 |
| Context | 是 | 通过 | 通过 | 当前任务 Rollout | PASS | 最近快照/窗口估算；并非服务端精确占用 |
| Token | 是 | 通过 | 通过 | 逐分钟与原始 offset 对照 | PASS | 子集与总量不变量；真实双来源 parity 未验证 |
| Cache | 是 | 通过 | 通过 | 实测缓存输入字段 | PASS | cached input 不重复加到 input |
| Quota | 是 | 通过 | 通过 | 窗口为空 | ENVIRONMENT LIMITED | empty/unavailable 正常显示；真实百分比及重置未验证 |
| Cost | 是 | 通过 | 通过 | 正确返回 unavailable | PARTIAL | 真实缓存写入计费映射不明；无真实金额对照；标准 API 等价估算不是账单 |
| Tools | 是 | 通过 | 通过 | 实际工具调用及完成 | PASS | 当前日志可见的外层调用与完成时间；未伪造内层开始/关联 |
| Activity | 是 | 通过 | 通过 | 当前任务活动 | PASS | 运行中/完成记录实际进入状态和渲染 |
| Agents | 是 | 通过 | 通过 | 明确父边的子代理 | PASS | 本轮只读审计代理的发现与完成；真实失败/取消未触发 |
| MCP | 是 | 通过 | 通过 | 配置可读，无运行调用 | PARTIAL | 配置不等于连接；本轮连接和调用生命周期未观测 |
| Skills | 是 | 通过 | 通过 | 目录与当前任务清单 | PARTIAL | 已发现/可用可验证；逐技能 loaded/active 未观测 |
| Plan | 是 | 通过 | 通过 | 无 execution 清单 | NOT VERIFIED | 当前任务不产生适配器可确认的实际清单；未把实施文档充作 execution plan |
| Session | 是 | 通过 | 通过 | 明确身份、稳定读取及重启 | PASS | A→B→A 和迟到事件的运行行为由夹具验证；未切换真实 Codex 任务 |
| App Server | 是 | 受限项外通过 | 通过 | 进程核验 EPERM / socket 缺失 | ENVIRONMENT LIMITED | 未建立真实握手或实时附着 |
| Runtime Authority | 是 | 受限项外通过 | 通过 | 安全选择 Rollout 回退 | ENVIRONMENT LIMITED | shared/managed/owned 的真实选择链尚未完整验证 |
| Reconnect | 是 | 通过 | 通过 | 未发生真实已连接 runtime 断线 | ENVIRONMENT LIMITED | 静默超时、历史恢复、重试上限、清理失败均为合成证据 |
| Rollout fallback | 是 | 通过 | 通过 | 自然 EMFILE 下持续更新 | PASS | 增量读取、稳定零新增字节、资源释放；真实双源交接仍受限 |
| Diagnostics | 是 | 通过 | 通过 | doctor/debug 与错误环境 | PASS | 版本、来源、受限原因、空数据与脱敏输出均实际检查 |
| Performance | 是 | 通过 | 一万请求基准通过 | 30 分钟持续采样 | PASS | 只限本机当前会话规模；不是所有硬件/协议的延迟承诺 |

## 自动化与回放

本轮新增 55 项测试，位于 `tests/Phase10Reliability.test.ts`、`tests/Phase10Recovery.test.ts`、`tests/Phase10Pipeline.test.ts`。覆盖：

- 坏信封、空值、未知类型、缺失身份、非有限时间、非法序号，以及一万条同序号身份的缓存边界。
- 五千轮及无时间戳身份淘汰；旧 start 不复活活动；跨轮次镜像继续完成 Token 交接。
- 相同 Token 的窗口 A→B→A、重复累计快照、缓存/推理子集和费用不重复。
- 账户 pending 时断线、旧历史迟到失败、静默连接有界探测、正常 idle 不重连、健康检查期间 stop。
- 清理失败后阻止替代连接、显式重试清理、失败停机后直接重启保持订阅。
- 三十轮 A→B→A→断线→停止；二十轮同一 Provider start/stop；三十轮 Runtime 重启及 SIGINT/SIGTERM。
- 退休代理的新旧轮次隔离；两万条无效 UTF-8；子线程警告不能掩盖后续错误。
- 截断空文件中间态、追加错误 session_meta、单事件归约异常、EMFILE 和诊断消费者故障。
- 30/40/50/60/80/100/120/140/160 列、连续 resize、Unicode/ANSI、模块失败恢复、输出超时和迟到错误。

`tests/fixtures/reliability/handoff.json` 是有出处说明的合成交接序列。既有 basic conversation、tool success/failure、nested agent、MCP、skills、plan、Token/cache/quota/compaction 样本继续复用，索引见 [回放说明](../tests/fixtures/reliability/README.md)。

### 完整命令结果

| 验证 | 结果 |
| --- | --- |
| `npm test -- --reporter=dot` | 78 文件，1099 项；74 文件/1081 项通过，4 文件/18 项因 Unix socket `listen EPERM` 失败 |
| 可执行范围回归 | 排除上述四文件：74 文件、1058 项全部通过 |
| `npm run typecheck` | 通过，0 类型错误 |
| src + tests 严格 TypeScript 检查 | 通过 |
| `npm run build` | 通过，dist 与源码对应 |
| 一万请求基准 | 通过，计数与边界断言成立 |

受阻文件为 `RuntimeDiscovery.test.ts`、`ExternalAttach.test.ts`、`ManagedDaemon.test.ts`、`ExternalProcessSafety.test.ts`。完整运行仍执行了这些文件中不依赖 socket 的 23 项通过测试，不能把排除文件后的 1058 项叫作完整回归。

请求扩大沙箱权限运行完整回归时，自动审批服务返回 HTTP 404，提示所选审批模型不可用，请求被拒绝。没有绕过拒绝，也没有将基线已有的 EPERM 失败改成 skip 或删除断言。零失败的完整回归验收尚未满足。

## 真实 A–L 实验

| 实验 | 本轮实际执行 | 判定 |
| --- | --- | --- |
| A 启动/发现/附着/渲染 | 现有 Codex 任务，明确环境线程与 Rollout 关联，HUD 完整渲染至内存终端 | PARTIAL：共享 runtime 附着受限 |
| B 普通对话 | 读取当前任务自然产生的真实模型、Token、Context、Activity；没有专门发送 hello | 已验证这些观测字段；独立 hello 回合 NOT VERIFIED |
| C command | 本轮实际命令在工具日志中产生完成记录，检查工具数量/状态/时长字段 | PASS（可观测范围） |
| D 文件操作 | 本轮真实日志中统计到 22 条 FileChange；文件操作与工具完成记录进入既有映射 | PASS（已有 FileChange 映射范围）；没有推断内层独立开始时间 |
| E Agent | 本轮实际只读审计子代理；父边、独立状态、完成事件 | PASS（成功路径）；真实 failure/cancel NOT VERIFIED |
| F Plan | 当前会话没有可确认的 execution 清单 | NOT VERIFIED |
| G MCP/Skill | 真实配置与技能目录可读；未产生运行生命周期样本 | PARTIAL |
| H Runtime restart | 没有重启外部 Codex/daemon；实际附着本身受限 | ENVIRONMENT LIMITED；回放恢复已验证 |
| I HUD restart | 新 Provider 重读同一真实会话；稳定 offset 下账本一致 | PASS（Rollout） |
| J Session A→B→A | 完整自动化与夹具验证；未改变真实 Codex 当前任务 | NOT VERIFIED（真实切换） |
| K SIGINT | 合成信号、真实本地夹具进程与所有权测试；未向外部 Codex 发信号 | PARTIAL：物理终端 Ctrl+C / 外部 socket 场景受限 |
| L 30min+ | 两轮各 30 分钟，最终轮对应最终构建；每分钟安全采样 | 详见性能报告；未连续运行一小时 |

真实采样脚本 `scripts/phase10-soak.mjs` 只读取当前任务来源，使用真实 Provider、Store、Runtime、Renderer 和 TerminalController。终端字节流写入内存计数器，因而不能把结果称为物理终端视觉验收。资源报告仅针对 HUD 观察进程；进程扫描受限时不能据此认证外部 Codex 自身没有泄漏。

最终轮完整持续 1800078.05 ms，31 次身份、Token 不变量与原始累计分项对照全部通过，无解析、归约、渲染错误或清理失败，停止后活动资源和输出监听器为空。最终 dist JavaScript 指纹与该轮一致。全部归档见 [证据索引](evidence/phase10/README.md)，包括 [测试结果](evidence/phase10/verification.json)、[真实事件形态](evidence/phase10/real-event-shapes.json) 和 [配置完整性](evidence/phase10/configuration-integrity.json)。事件形态统计是一个实际采样窗口内的记录数量，不等同于近期工具列表长度或独立请求数量。

## 尚未解除的生产限制

1. **完整 socket 回归和真实 App Server 附着/重启/双源交接。** 属于沙箱与审批服务限制；代码及合成恢复已实现。生产部署若使用共享 runtime，仍需在允许本机 socket 和进程核验的终端补验。
2. **非空 Quota、实际 Cost 对照、MCP 连接/调用、Skill 活动状态、当前版本 execution Plan。** 适配器已有实现或如实降级，但本轮真实来源没有这些证据。相应模块可能为空、隐藏或 unavailable，不能承诺未经观测的 live 行为。
3. **物理 TTY、真实用户切换任务和连续一小时以上。** 已有宽度/resize/信号自动化，以及两轮独立 30 分钟 Rollout 观测；不足以代替上述真实场景。需要补验，不能宣称整条实时 App Server 链已无条件达到生产 PASS。

`PHASE 10 STATUS: PARTIAL`。本阶段完成后停止，不进入 Phase 11。
