# Phase 8 协议样本

`schema/` 是本机 Codex CLI 0.154.0 的 `codex app-server generate-json-schema --experimental --out …` 原样导出子集。`provenance.json` 保留各文件 SHA-256，协议没有协商版本字段；这里的 v2 是导出目录版本。

`notifications.json` 是依据这些定义制作的合成样本，覆盖 Token、结构化 Plan、shell、MCP、明确父子身份和额度。标识符、路径与正文都使用测试值，不包含用户会话或认证数据。它们用于协议测试，不能作为真实运行验证证据。

`lifecycle.json` 根据同次导出的 InitializeResponse、ThreadStartResponse、ThreadReadResponse、ThreadResumeResponse、TurnStartResponse、ThreadStartedNotification、TurnStartedNotification、TurnCompletedNotification、ErrorNotification 与 TurnsPage 制作；包含握手响应、线程创建/读取/恢复响应、轮次开始/结束、错误和断线前后历史页。`malformed` 明确为反例，用于验证拒绝路径，不宣称符合 schema。单元测试不发送真实 thread/start 或 turn/start。

`protocol-child.mjs` 是测试 JSON-RPC framing、乱序响应、错误与进程清理的合成子进程，并非 Codex App Server。SIGINT/SIGTERM 测试通过现有 Runtime 信号处理器关闭此 Node 子进程；不能替代真实 Codex 连接验证。真实实验结果单独记录于 `docs/phase8-app-server.md`。
