# Phase 10 回放索引

`handoff.json` 是手工构造的确定性交接序列：Rollout 基线、App 镜像、实时新增、重复通知、Rollout 提前尾部、断线释放、旧序号迟到。它通过真实 SourceDeduplicator、Reducer 和费用逻辑，不代表真实 App Server 证据。

| 场景 | 既有样本与执行测试 |
| --- | --- |
| 会话、模型、普通活动 | `../codex/rollout-session.jsonl`；CodexSessionProvider、LiveRollout |
| 工具开始、成功、失败、终止、文件操作 | `../codex/tools/`；ToolEventParser、ToolTracker、ToolLive |
| Agent、nested agent、失败、取消、重启 | `../agents/`；AgentEventParser、AgentTracker、AgentLive |
| MCP 配置、调用成功/失败 | `../mcp/`；McpTracker、McpEventParser、CapabilityLive |
| Skills 目录与运行目录 | `../skills/`；SkillTracker、SkillDiscovery |
| Plan 创建、更新、完成、拒绝、delta | `../plan/`；PlanTracker、PlanDelta、PlanLive |
| Token、Cache、Quota、压缩 | `../usage/`、`../codex/rollout-token-count.jsonl`、`../codex/rollout-rate-limit.jsonl`；UsageParsing、UsageLive |
| Runtime 生命周期与通知 | `../app-server/lifecycle.json`、`notifications.json`；RuntimeFallback、AppServerReconnect |
| 本地协议进程与所有权 | `../app-server/protocol-child.mjs`、`../runtime-process.mjs`；AppServerProtocol、RuntimeOwnership |
| 断线、重启、晚到、乱序、会话切换、资源循环 | `handoff.json` 和 Phase10 三份测试中的可控动态夹具 |

历史真实样本的版本和匿名化说明保留在各自 README/provenance 中。组合匿名父子 ID、合成异常或替身进程后，证据类别仍是 Replay/Automated，不能升级为 Real Runtime。
