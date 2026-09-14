# Phase 9：Runtime Authority / Shared App Server / Live Session Control

验收日期：2026-09-13。**阶段状态：PARTIAL**。

本地运行时发现、探测、权威选择、所有权、线程附着、连接生命周期、回退和诊断已实现。最新可执行的软件回归、类型检查和构建通过；真实 Rollout 恢复及只读命令入口通过。真实共享 App Server/daemon 实验未执行，最终完整 socket 回归被自动审批服务故障阻止，因此不能宣称 Phase 9 全部验收成功。

CLI：`0.154.0`。当前根 Rollout writer：`0.153.4`。这两个值均不能替代 App Server 的实际版本。

## 功能与证据等级

| 项目 | IMPLEMENTED | RUNTIME VERIFIED |
| --- | --- | --- |
| Runtime Discovery | 是；有界异步发现、缓存、进程/端点证据 | PARTIAL：早期只读观察到两个 Desktop server；最新代码在沙箱内进程扫描受限，未完成实机成功发现 |
| Runtime Probe | 是；握手、home、PID、方法及明确线程核验 | ENVIRONMENT LIMITED |
| Authority | 是；身份门槛、线程归属、策略排序、同级歧义回退 | ENVIRONMENT LIMITED |
| Ownership / External Attach | 是；external 与自有 proxy/stdio child 分开 | ENVIRONMENT LIMITED；真实 OS 的 Node 替身测试通过，不是 Codex runtime 验收 |
| Managed Daemon | PARTIAL；发现与显式开启配置后的官方 start 路径 | ENVIRONMENT LIMITED；未启动真实 daemon |
| Shared Socket | PARTIAL；经核验的 Unix socket + 官方 proxy；WebSocket 仅发现 | ENVIRONMENT LIMITED；没有取得真实共享端点 |
| Thread Attach | 是；明确 ID、history/rejoin、lost、切换隔离 | ENVIRONMENT LIMITED；没有真实 live attach |
| Reconnect | 是；有界指数退避、重新发现、身份变化与旧响应隔离 | ENVIRONMENT LIMITED；daemon restart 未实测 |
| Fallback / Rollout | 是；继续 Phase 8 同一来源链路 | PASS：真实发现受限时读取当前根 Rollout；真实 App Server 断线交接未实测 |
| Token / Cache / Context | 是；继续 Phase 7 trackers | PASS（Rollout）；App Server live 未观测 |
| Plan | 是；继续 Phase 6 PlanTracker | 当前真实会话仅 mode 已观测，执行清单 NOT OBSERVED；软件回归通过 |
| Tools / Activity | 是；继续 Phase 3 trackers | PASS（Rollout）；App Server live 未观测 |
| Agents | 是；继续 Phase 4 AgentTracker | PASS（Rollout 的 5 个明确子代理及独立 Token/Context）；App Server live 未观测 |
| Quota | 是；结构化 read/通知与 Rollout | PARTIAL：真实窗口为 empty；非空窗口和 live 更新未观测 |
| Account / Approval | 是；只保留认证布尔值；审批只观察 | NOT OBSERVED |
| Doctor / Debug | 是；runtime 白名单摘要与脱敏 | PASS：真实来源的只读命令入口；实际共享连接诊断未实测 |

`IMPLEMENTED` 不等于 `RUNTIME VERIFIED`。协议导出、fixture、mock 和 Node 合成 server 均不会升级为真实 Codex 证据。

## 关键实现

RuntimeDiscoveryProvider → RuntimeProbe → RuntimeAuthorityResolver → RuntimeConnectionManager 接到现有 AppServerSource。外部连接前重新核验 executable、命令行、出生信息、socket owner/权限/身份；握手后核对 server PID、home 与明确线程。external candidate PID 永不传入 kill；HUD 退出只清理自己启动的 proxy 或 stdio child。

未确认的外部进程、不可读进程表、不完整发现、陈旧端点、协议错误或同级歧义均回退。managed 默认只发现；显式 `auto_start_managed=true` 也必须满足官方命令支持、完整发现和明确线程条件。不会执行 bootstrap、Desktop 控制、用户配置写入或隐式模型 turn。

线程 ID 只来自同 home 且一致的环境上下文，或调用方显式选择。没有明确 ID 时，cwd/recent 仅用于 Rollout 历史。history bootstrap、live 缓冲和来源去重继续沿用 Phase 8；旧连接、迟到 resume 与失败清理不能覆盖新线程。未增加第二套 HudState 或业务 tracker，也未修改 SourceDeduplicator。

配置增加 `[runtime]` 六项布尔策略，旧 version=1 文件在内存补默认值；runtime-status 已注册且默认关闭。注册模块由 16 个增至 17 个，推荐的 11 个模块保持不变。账户仅记录 authenticated；审批请求和 resolved 通知只更新有界计数，不回复 approve/reject/-32601。

## 验证结果

| 检查 | 结果与范围 |
| --- | --- |
| Tests | **PARTIAL**：最新沙箱内 71 个文件、1003 项通过，0 失败；最终完整套件未执行 |
| 早期发现/probe/authority 回归 | 74/74 通过；只作为该轮局部证据 |
| 早期 external/managed/thread/config 回归 | 57/57 通过；不替代最终完整套件 |
| External process safety | 合成 Node 外部服务在 stop、SIGINT、SIGTERM、uncaughtException 后仍存活且可重新附着；早期实际 OS 测试通过 |
| Owned process safety | 合成 Node 自有 server 在 SIGINT、SIGTERM、异常退出后被清理；pending write 与 exit-before-close 限期测试通过 |
| Session switch | PASS（软件）：明确线程、跨 home、A→B→C、旧事件/清理隔离；真实 live 切换未实测 |
| HUD restart | PASS（真实 Rollout 的两个独立进程恢复）；共享 runtime 重新附着未实测 |
| SIGINT / SIGTERM | PASS（合成 OS 子进程及既有 HUD 生命周期测试）；不标为真实 Codex daemon 验收 |
| EMFILE | PASS（软件回归）：watcher 失败后增量补查仍更新；未重复人为耗尽本机文件句柄 |
| Typecheck | PASS：`npm run typecheck`，以及包含 src/tests 的严格类型检查 |
| Build | PASS：`npm run build`；dist 已更新 |
| Source parity | ENVIRONMENT LIMITED / NOT OBSERVED；没有真实 App Server 与 Rollout 的成对样本 |

最终沙箱内回归命令：

```sh
npm test -- --reporter=dot --exclude tests/RuntimeDiscovery.test.ts --exclude tests/ExternalAttach.test.ts --exclude tests/ManagedDaemon.test.ts --exclude tests/ExternalProcessSafety.test.ts
```

严格类型检查命令：

```sh
./node_modules/.bin/tsc --noEmit --target ES2022 --module NodeNext --moduleResolution NodeNext --strict --esModuleInterop --skipLibCheck src/**/*.ts tests/**/*.ts
```

完整 `npm test -- --reporter=dot` 需要临时 Unix socket。自动审批服务返回 HTTP 404，原因是上游不支持审批模型 `gpt-5.6-luna`；命令被拒绝，没有启动测试，不能记作通过或测试代码失败。没有改变测试断言、关闭安全检查或绕过该审批。沙箱内已有结果与阻塞项分别保留。

真实 Rollout 只读验收关闭了 spawn、external attach、reconnect 与 managed start。先后正常退出的两个 Node 进程读取相同明确线程；其间源文件从 11,141,856 增至 11,182,769 字节，累计 Token 从 13,764,367 增至 13,856,086，按真实增长记录 DIFFERENT，没有强制快照相等。doctor/debug/非 TTY start 均使用真实 Provider 与内存配置完成，输出只保留有界安全摘要。数值和字段可用性详见 [运行时来源对照](phase9-runtime-parity.md)。

## 已知限制与待确认实验

1. 当前自然环境未暴露可验证的共享 socket；Desktop app-server 的存在不等于允许 external attach。当前仅实现 Unix socket + 官方 proxy，外部 WebSocket 附着未实现。
2. 外部附着要求 server/diagnostics PID 核验和可靠版本证据；缺少该方法的旧 runtime 会保守回退。owned server 无可靠版本响应时显示 unknown。
3. 协议没有 observer-only resume。只对已加载且 active/idle 的明确线程 rejoin，查询与 resume 之间仍存在卸载竞态；不能保证订阅完全无副作用。
4. App Server history 不暴露 Token 快照和执行清单通知；Rollout 历史补偿仍有必要。当前非空 Quota、真实审批及 App Server live Token/Plan/Tool/Agent 都未观测。
5. 完整 socket 回归仍待审批服务恢复。真实 daemon 启停和最多一轮最小模型实验也尚未单独授权；本轮真实模型实验为 0 轮。

后续真实实验的待确认范围如下；这是实验计划，不是已执行记录：

- 先只读重新发现并核对本机 `--version`、相关 `--help` 和 `codex app-server daemon version`。已有 daemon 不纳入启停实验，也不改变 Desktop。
- 若确认当前没有 daemon，单独授权后才执行已由 help 确认的 `codex app-server daemon start`；不使用 bootstrap，不修改 Codex/HUD/Desktop 配置。端点由 discovery 取得并核验，再通过 `codex app-server proxy --sock <已核验端点>` 使用官方协议。
- 建立一个明确的实验线程，最多发起一轮短回复请求，不执行项目写入。观察实际通知，退出并重启 HUD，确认 external daemon 存活和重新附着。
- 仅对这次实验明确创建、且身份未变化的 daemon 执行 `codex app-server daemon stop` / `start`，检查 Rollout fallback、runtime identity 改变与重连；结束时停止实验创建的 daemon。若出现其他使用者、身份变化或权限问题则停止实验并报告。
- 只比较实际暴露且能配对的 Model、Context、Token、Plan、Tool、Activity、Agent、Quota；缺失填 NOT EXPOSED / NOT OBSERVED，差异填 DIFFERENT，不为收集样本额外增加模型 turn。

## 修改范围与保留项

实施前记录 551 个项目文件的 SHA-256。核对结果：没有删除基线文件；Codex 与 HUD 两份用户配置哈希均未变化；变更文本使用 UTF-8 无 BOM。没有读写 SQLite/WAL、修改 Desktop、终止外部 Codex server 或执行 Git 写操作。工作区无 Git 元数据，比较依据为本轮基线。

| 范围 | 涉及路径 |
| --- | --- |
| 运行时实现 | `src/providers/codex/runtime/RuntimeCandidate.ts`、`RuntimePolicy.ts`、`RuntimeDiscoveryProvider.ts`、`RuntimeProbe.ts`、`RuntimeAuthorityResolver.ts`、`RuntimeConnectionManager.ts` |
| Source 与会话 | `src/providers/codex/app-server/AppServerProtocol.ts`、`AppServerSource.ts`、`src/providers/codex/CodexDiscoveryProvider.ts`、`CodexSessionProvider.ts`、`src/core/source/DataSource.ts` |
| 配置及生产入口 | `src/config/Config.ts`、`src/cli/Program.ts`、`RunHud.ts`、`src/runtime/HudRuntime.ts` |
| 能力与诊断 | `src/capabilities/CapabilityDetector.ts`、`src/cli/Diagnostics.ts`、`src/providers/codex/SourceDiagnostics.ts`、`src/renderer/modules/RuntimeStatus.ts`、`ModuleRegistry.ts` |
| 新测试 | `tests/RuntimeDiscovery.test.ts`、`RuntimeProbe.test.ts`、`RuntimeAuthority.test.ts`、`RuntimeOwnership.test.ts`、`RuntimeThreadAttachment.test.ts`、`RuntimeProcessIdentity.test.ts`、`ManagedDaemon.test.ts`、`ExternalAttach.test.ts`、`ExternalProcessSafety.test.ts`、`RuntimeFallback.test.ts`、`RuntimeDiagnostics.test.ts`、`ThreadSelection.test.ts` |
| 测试适配与替身 | `tests/AppServerProtocol.test.ts`、`Capabilities.test.ts`、`Config.test.ts`、`ModuleRegistry.test.ts`、`providers/CodexDiscoveryProvider.test.ts`、`app-server/helpers.ts`、`runtime-authority/helpers.ts`、`fixtures/app-server/protocol-child.mjs`、`fixtures/runtime-process.mjs` |
| 文档与构建产物 | `README.md`、本报告、下列三份 Phase 9 文档，以及对应的 `dist/` 产物 |

配套文档：[运行时发现](phase9-runtime-discovery.md)、[权威矩阵](phase9-authority-matrix.md)、[运行时来源对照](phase9-runtime-parity.md)。Phase 9 到此交付本地实现和可取得的验收证据，未进入 Phase 10。
