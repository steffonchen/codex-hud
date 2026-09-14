# Phase 10 验收证据

日期：2026-09-13。只归档本次验证所需的白名单指标、脱敏诊断、测试日志和哈希；不包含真实 rollout 正文、用户配置内容、完整环境变量或凭据。

| 文件 | 用途与边界 |
| --- | --- |
| [verification.json](verification.json) | 完整与可执行范围回归、18 项受阻明细、类型检查、构建、脚本语法和审批限制 |
| [full-regression.log](full-regression.log) | 完整 1099 项执行记录；18 项 socket EPERM 保持失败，不改成 skip |
| [available-regression.log](available-regression.log) | 排除四个受阻文件后的 1058 项通过记录，不代表完整回归 |
| [typecheck.log](typecheck.log) / [build.log](build.log) | 必需命令的成功输出 |
| [benchmark.json](benchmark.json) | 一万请求合成回放与本地 Node 协议夹具；不是实际 Codex App Server |
| [real-soak.json](real-soak.json) | 最终构建完整 30 分钟真实 Rollout 观测，含全部 31 个样本与停止后的资源 |
| [real-soak-pre-final-summary.json](real-soak-pre-final-summary.json) | 较早构建的独立 30 分钟摘要；不能替代最终轮，也不构成连续一小时 |
| [real-smoke.json](real-smoke.json) | 真实 Provider 重启一致性、九宽度和业务能力快照 |
| [real-event-shapes.json](real-event-shapes.json) | 真实日志形态数量；不保存工具参数或正文，不等同于独立请求计数 |
| [doctor.log](doctor.log) | 实际版本、来源、EPERM/EMFILE、空数据与配置、渲染检查 |
| [debug-summary.json](debug-summary.json) | 实际 debug 的内部诊断白名单；不导出完整业务状态 |
| [configuration-integrity.json](configuration-integrity.json) | 两份用户配置执行前后 SHA-256 及 package-lock 未变化 |
| [static-audit.json](static-audit.json) | 额外未使用项与不可达代码审计；新增问题 0，保留 3 处已核对基线的既有未使用项 |
| [quality-checks.json](quality-checks.json) | UTF-8、文档引用、构建与证据一致性、范围检查 |
| [changes.json](changes.json) | 与执行前 596 文件基线比较的逐文件变更；dist 单列，保留已有系统元数据 |

最终构建 SHA-256 为 `40646bf8c5ba034050a3a881921b2b565a6204d7d47e8e4ce3570a6bd278858f`。算法按 dist 中 `.js` 相对路径排序，依次读取路径 UTF-8 字节与文件字节；source map 不进入指纹。

日志中的 `<PROJECT>` 和 `<TEST_TMP>` 仅替换绝对目录；doctor 原本已使用 `<CODEX_HOME>`。第一轮摘要、debug 摘要及测试汇总保留原始文件哈希作为对应依据。原始执行日志和基线保存在本机 `/private/tmp/codex-hud-phase10-hmg7k5zd`，临时目录并非永久归档。

`rawUnknown` 表示无专用映射的合法原始行；`processed` 是成功归约次数，不是请求数。真实观测使用内存终端，外部 Runtime 进程核验受限，不能将无 socket/子进程资源或回退重试计数解释为已完成真实 App Server 断线恢复。
