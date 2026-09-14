# Phase 4：真实 Agent Schema Discovery

记录日期：2026-09-12。本文依据本机真实 rollout、实际多代理实验和只读状态库检查；实现及验收见 [Phase 4 报告](phase4-agents.md)，脱敏样本的来源文件和原始行号见 [fixture 说明](../tests/fixtures/agents/README.md)。

## 环境与来源

| 项目 | 实际结果 |
| --- | --- |
| 平台 / Node.js | macOS / `v23.11.0` |
| CLI binary | `/opt/homebrew/bin/codex` |
| `codex --version` | `codex-cli 0.154.0` |
| 本次 rollout 写入版本 | `session_meta.payload.cli_version = "0.153.4"`，由 Codex Desktop 写入 |
| 子代理版本字段 | `multi_agent_version = "v2"`；这不是整个 rollout 的 schema 版本号 |
| CLI feature 快照 | `multi_agent stable true`；`multi_agent_v2 stable false` |
| 主要事实来源 | `~/.codex/sessions/**/rollout-*.jsonl` |
| 辅助检查 | `~/.codex/session_index.jsonl`、`~/.codex/state_5.sqlite` |

CLI 的 feature 配置与 Desktop 实际使用的 v2 不能等同。运行时缓存本次启动的 CLI feature 查询；查询失败或标志缺失时为 `null`，不推断为不支持。历史 Agent 事件与当前 CLI 关闭配置可以同时存在。没有将 CLI 的最大线程数、默认子模型或默认推理强度写死；未获得可靠配置来源的值保持未确认，实际模型和强度取各线程的 `turn_context`。

`session_index.jsonl` 观察到 `id`、`thread_name`、`updated_at`，未提供直接父关系。SQLite 使用 `mode=ro&immutable=1` 检查结构与计数：`thread_spawn_edges(parent_thread_id, child_thread_id, status)` 存在，检查时 72 条边全部为 `open`。已完成线程的边也为 `open`，因此不能据此判断代理仍在运行；HUD 本阶段不依赖数据库读取生命周期。

未进行 `codex exec --json` stdout 与 rollout 的对照实验，因此不宣称复现了 stdout 缺失 spawn 的公开问题。当前实现以已观察到的 rollout 为准，stdout 完整性仍未确认。

## 已观察到的事件

表中“必需”表示本实现可靠处理该行为所需的字段，不声明未来 Codex 版本的协议要求。

| 事件 | 字段与例值 | 含义及出现时机 | 本实现的必需条件 |
| --- | --- | --- | --- |
| `session_meta` | `id`、`session_id`、`parent_thread_id` | 文件所属线程、根会话归属、直接父线程；通常为文件首行 | 自身 `id`；建立父边还需明确的父 ID |
| 子线程 metadata | `source.subagent.thread_spawn.parent_thread_id`、`depth`、`agent_path`、`agent_nickname`、可空 `agent_role` | 子线程创建时的来源信息；顶层也可出现路径和昵称 | 父 ID 与顶层字段不得冲突；路径仅用于命名 |
| 子线程 metadata | `thread_source: "subagent"`、`multi_agent_version: "v2"` | 区分任务子代理及来源版本 | 明确的任务子代理来源 |
| `response_item / function_call` | `namespace: "collaboration"`、`name: "spawn_agent"`、`call_id`、JSON 字符串 `arguments` | 父线程提出 spawn；参数有 `task_name`、模型/强度和任务正文 | namespace、name、call_id；不保存任务正文 |
| `function_call_output` | 相同 `call_id`；字符串 `{"task_name":"/root/single_probe"}` | spawn 返回任务路径；本次没有返回 child UUID | 只确认调用返回，不能用路径补造子身份 |
| `event_msg / task_started` | `turn_id`、`started_at`、`model_context_window` | 对应文件中的新轮次开始 | 文件线程身份；轮次 ID 用于隔离 |
| `turn_context` | `turn_id`、`model`、`effort` | 当前线程模型配置 | 复用既有模型归一化 |
| `function_call` | `namespace: "collaboration"`、`name: "wait_agent"`、`call_id`、`arguments.timeout_ms` | 当前父线程进入等待 | 本线程 call_id 关联 |
| `function_call_output` | 等待调用的 call_id；JSON 字符串含 `message`、`timed_out` | 等待结束或超时；父线程恢复处理 | 不能据此将任何 child 标为 completed |
| `event_msg / item_completed` | `item.type: "CollabAgentToolCall"`、`tool: "wait"`、`sender_thread_id`、`receiver_thread_ids`、`receiver_agents`、`agents_states` | 本次只观察到 wait 的结构化完成记录；接收者数组和状态映射为空 | 不从空接收者或工具 status 推断 child 状态 |
| `event_msg / task_complete` | `turn_id`、`started_at`、`completed_at`、`duration_ms` | 本文件线程轮次正常结束；实际拼写是 `task_complete` | 线程归属及轮次关联 |
| `event_msg / turn_aborted` | `turn_id`、`reason: "interrupted"` | 历史样本中的明确中断 | `interrupted` 映射 cancelled，未确认原因保留 unknown |
| `response_item / agent_message` | `author`、`recipient`、`content` | 子代理结果送达父代理；author/recipient 为任务路径 | 仅作为发现证据，正文和路径都不用于建父边 |
| 工具调用、返回及 `CommandExecution` | call_id / item.id、status、exit_code、parsed_cmd | 子线程自身工具活动 | 复用 Phase 3 Parser、ToolTracker 与 ActivityTracker |
| `event_msg / token_count` | `info.total_token_usage`、`last_token_usage`、`model_context_window` | 子线程自身 Token 与上下文快照 | 复用 Phase 2 TokenTracker，不求所有代理之和 |

工具返回同时存在字符串和 `[{"type":"input_text","text":"…"}]` 容器。脱敏 fixture 保留这一区别，替换其中正文；wait 返回保留 JSON 对象的字段结构。

## 关系强度与根身份

确认的父子关系为 **STRONG**：child 的 `session_meta.id` 对应自身线程，`parent_thread_id` 对应直接父线程。顶层父字段与 `source.subagent.thread_spawn.parent_thread_id` 同时存在时必须一致。根身份来自所选主 rollout 的 metadata，没有硬编码 `id === "main"`。

```text
主 rollout 的 session_meta.id
                │
                └── child.parent_thread_id
                        │
                        └── grandchild.parent_thread_id
```

`session_id` 仅用于筛选属于同一根会话的记录。它不能代替直接父 ID：中间父文件缺失时保留 orphan，并在 debug 中报告。`agent_path` 用于展示名称，`depth` 用于核对观察结果；二者不参与父边推断。

spawn 的 `call_id` 能关联父线程的调用与返回，但当前返回没有 child UUID，故 **spawn 调用 → 具体 child ID 的逐调用关联不可用**。这不影响依靠子线程 metadata 确认父子树，也不应制造 `spawnId`。两个无关工具使用同名 `spawn_agent` 时，缺少 `collaboration` namespace 不会触发 Agent 事件。

`guardian_review` 属于内部审批来源，观察到 `source.subagent.other`，不会作为用户任务子代理进入树。父字段冲突、缺失父节点或关系环会进入可见诊断，不按时间戳、最近 spawn 或路径相似度修复关系。

## 一次真实单代理生命周期

实际任务为读取 `package.json` 并返回项目名称，结果为“项目名称：codex-hud”。以下时间均为 UTC，原始行号指未脱敏文件。

- 父 session / thread：`01a092ed-87ba-7752-baaa-8a946263d93e`。
- 父 turn：`01a092f9-8d57-7d43-b260-442437b80ed0`。
- 父文件：`rollout-2026-09-12T08-03-55-01a092ed-87ba-7752-baaa-8a946263d93e.jsonl`。
- 子 thread：`01a092fa-6e96-7822-8114-1349bb2a3c87`，未观察到额外独立的 Agent ID。
- 子 turn：`01a092fa-6ec2-7e73-8c32-9c60caabb7e6`。
- 子文件：`rollout-2026-09-12T08-18-00-01a092fa-6e96-7822-8114-1349bb2a3c87.jsonl`。

| 时刻 | 文件位置 | 观察 |
| --- | --- | --- |
| `00:18:00.973` | 父第 197 行 | `spawn_agent`；call_id 为 `call_aedVo3aVWz0T78w2ZqGkAkU4` |
| `00:18:01.037` | 子第 1、2 行 | metadata 确认直接父 ID；`task_started` |
| `00:18:01.064` | 父第 200 行 | 同 call_id 返回 `/root/single_probe`；不含 child UUID |
| `00:18:05.911` | 子第 11 行 | 外层 exec 工具调用 |
| `00:18:05.983` | 子第 13 行 | `CommandExecution`，`parsed_cmd.type=read`，退出码 0 |
| `00:18:09.989` | 子第 19 行 | 累计 Token 44,128，最近 Token 22,218，窗口 258,400 |
| `00:18:09.995` | 子第 20 行 | `task_complete` |
| `00:18:26.403` | 父第 204 行 | 父调用 `wait_agent`，call_id 为 `call_juj4kLLaEu1MyHc8BsZD5hHt` |
| `00:18:26.521` | 父第 210 行 | 收到 author 为 `/root/single_probe`、recipient 为 `/root` 的结果消息 |

此处子线程在父开始等待前已经完成，说明不能用“父等待返回时刻”代替 child 的真实结束时刻。

## 并行、嵌套与失败证据

两个真实探索任务按 A 开始、B 开始、B 结束、A 结束的顺序运行：

| 代理 | task_started | task_complete | 累计 Token |
| --- | --- | --- | --- |
| `pipeline_scout`（fixture `explorer`） | `00:06:16.521` | `00:13:35.201` | 1,077,643 |
| `ui_capability_scout`（fixture `tester`） | `00:06:30.284` | `00:12:07.737` | 681,570 |

同一父线程下的独立文件、明确 ID 和各自 Token 快照构成“不串线”的证据。完整文件链路测试还故意复用跨线程的 call_id / turn_id，确认工具结果仍隔离；这些复用 ID 属于边界测试，不冒充额外的真实执行。

真实嵌套为根任务 → `nested_probe` → `leaf_probe`。中间层开始/完成为 `00:44:47.318` / `00:45:43.761`，叶子开始/完成为 `00:45:04.282` / `00:45:36.584`。叶子的直接父 ID 是中间层线程，`session_id` 仍是根线程，因此三层关系已确认。

`runtime_slow` 内部执行无害的退出码 7 命令，真实工具结果为 failed，但代理最后正常 `task_complete`。本阶段不能将它标为 Agent failed。扫描 72 个真实任务子 rollout，观察到 `task_started` 95 条、`task_complete` 88 条、`turn_aborted` 6 条，未观察到 Agent 级 `error` / `task_failed` / `agent_failed`。不同事件数量不是完整任务成败统计，历史记录可能跨轮次或不完整。

## 已确认与未确认边界

| 能力 | 证据等级 | 处理 |
| --- | --- | --- |
| 根、直接父子关系、真实三层树 | confirmed | 使用明确 metadata ID |
| 当前轮次 running / completed | confirmed | 使用所属线程的 task 生命周期 |
| 父线程 waiting | confirmed | 使用 collaboration wait 的 call_id 开始/返回 |
| interrupted → cancelled | confirmed（历史样本） | 保留明确中断含义 |
| 按线程关联 Token / Context / Activity | confirmed | 子线程独立 Reducer，复用现有 Tracker |
| 工具退出码 7 | confirmed | 仅标记工具失败 |
| Agent 级 failed 原始事件 | unknown / not observed | 没有建立猜测的 raw 映射；归一化模型和 Renderer 已支持 |
| spawn call_id 到具体 child UUID | unavailable（当前已观察的返回） | 不制造关联 |
| CLI 与 Desktop 配置一致性 | unknown | 分别报告 |
| `close_agent`、`send_input` 等其他接口生命周期 | 未在本阶段证据中确认 | 不凭名称添加 raw schema |
| stdout Agent 信息完整性、其他 rollout 写入版本 | unknown | 不宣称已覆盖 |
| 时间、路径、最新 spawn 的父边推断 | 未使用 | 没有 inferred 父边 |

后续只有取得新的真实事件证据，才扩展相应 Parser 和 fixture。本阶段不接入 App Server，不进入 Phase 5。
