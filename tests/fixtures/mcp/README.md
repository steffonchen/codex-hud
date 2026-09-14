# MCP 真实结构样本

来源均为本机 Codex Desktop `0.153.4` rollout，配置来自当前 Codex home。调用 ID、线程 ID、轮次 ID 已一致匿名化；命令、参数、环境值、完整提示词和结果正文已删除或替换。保留原事件类型、字段层级、布尔值、状态与时间。

| 样本 | 来源 |
| --- | --- |
| configured-servers.toml | 用户 config.toml 第 80—83 行的 node_repl 配置表 |
| disabled-server.toml | 同文件第 102—106 行的 computer-use；保留明确 enabled=false |
| multiple-servers.toml | 上述两项配置的白名单组合 |
| tool-completed.jsonl | rollout-2026-09-12T08-03-55-01a092ed-87ba-7752-baaa-8a946263d93e.jsonl:861；codex_app.open_in_codex |
| tool-failed.jsonl | rollout-2026-09-11T18-04-38-01a08fed-25fb-7483-a596-2bbc3b0d00b9.jsonl:169；cua_repl.js，status=failed、result.isError=true |

前一文件的第 167、170 行分别是同 ID 的 function_call 与 function_call_output。结构化结果可以确认 MCP 工具失败，不能确认服务器连接失败。

没有取得真实服务器 ready/failed 原始事件，故不创建这些名称的虚构 runtime fixture。相应显示与 Tracker 状态在归一化接口测试中验证。配置变化、同 ID、乱序、跨会话和跨线程重映射是明确的边界测试，不冒充额外真实会话或事件。
