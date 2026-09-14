# Phase 6：Plan 数据来源调查

调查日期：2026-09-12。本文区分协议声明、真实持久化样本和运行验证，不以工具、活动、代理或 Goal 状态推断 Plan。

## 版本与调查范围

- `codex --version`：`codex-cli 0.154.0`。本次用该 binary 执行 `app-server generate-json-schema --experimental --out <临时目录>`，离线导出成功，没有启动 App Server 或修改用户配置。
- 现有 Desktop rollout 的 metadata 常见 writer 为 `0.153.4`；CLI 文件也有 `0.154.0`。metadata 版本不证明每次续写都来自同一个版本。
- 只读结构扫描 2026/08、2026/09 共 227 个 rollout，采样时约 289 MB、46,182 行。9 月 132 个文件中，90 个标记 `0.153.4`、22 个标记 `0.154.0`。没有把本任务中粘贴的需求、源码或工具输出里的关键词算作 Plan 事件。
- 当前版本样本未观察到 `PlanUpdate`、`PlanDelta`、Plan item 或 `update_plan`。666 条带 collaboration mode 的 turn_context 均为 `default`，未观察到 assistant proposed_plan。此结论仅为 **not observed**，不表示 Codex 不支持。

## 五种不同的概念

| 概念 | 已确认结构与含义 | 证据等级 |
| --- | --- | --- |
| Plan Mode | `collaboration_mode.mode`；当前导出的 `ModeKind` 为 `plan/default`。模式与执行清单独立 | default 有真实 rollout；plan 为当前协议声明，运行待验证 |
| 执行计划通知 | `turn/plan/updated`，参数 `threadId/turnId/plan`，可选 `explanation`；步骤为 `step/status`，状态 `pending/inProgress/completed` | 当前 CLI 离线 schema |
| 提案流式更新 | `item/plan/delta`，参数 `threadId/turnId/itemId/delta`，delta 是字符串 | 当前 CLI 离线 schema；不是步骤 patch |
| 提案 item | App Server `ThreadItem` 的 `PlanThreadItem`，`type="plan"`，字段 `id/text`；完成后的 text 具有权威性 | 当前 CLI 离线 schema；不是带步骤状态的清单 |
| Thread Goal | 独立的目标、预算、累计 token/时间和 `active/paused/blocked/usageLimited/budgetLimited/complete` 状态 | 当前协议和独立数据库 schema；不进入 Plan progress |

当前 `PlanDeltaNotification` 的逐字说明为：`EXPERIMENTAL - proposed plan streaming deltas for plan items. Clients should not assume concatenated deltas match the completed plan item content.` 因此不能把 delta 当成完整计划，也不能把它解释成 `B -> completed`。完成的提案不表示实施完成或用户批准。

当前包内置的 Plan Mode 说明也明确：`update_plan` 是 checklist/progress/TODO 工具，不负责切换 collaboration mode；Plan Mode 中该工具会报错。这是静态说明，不能替代真实交互验收。

## 真实执行清单样本

8 月共 48 次 `update_plan` 调用，记录 writer 为 `0.146.1`（8 次）、`0.147.0`（1 次）、`0.149.1`（39 次）。按 call_id 关联到 47 次成功和 1 次参数解析失败。

```text
response_item / function_call
  name = update_plan
  call_id
  arguments = JSON 字符串 { plan: [{ step, status }], explanation? }
  status = pending | in_progress | completed

response_item / function_call_output
  同一个 call_id
  成功 output = "Plan updated"
```

正证来源：`sessions/2026/08/24/rollout-2026-08-24T18-28-21-01a03350-6564-77e1-bf41-9352dc9813c2.jsonl`，metadata 第 1 行为 `0.149.1`；当前 turn_context 为第 25 行；调用/返回位于 32/33、57/58、101/102、106/107 行。四个步骤依次从一个进行中，更新到一个完成、三个完成，最终全部完成。第 24/112 行是 task_started/task_complete，不能用后者代替清单的完成状态。

反证来源：`sessions/2026/08/26/rollout-2026-08-26T12-12-14-01a03c44-c140-7cc0-8129-260bfa321ece.jsonl:92` 的第四步缺 status，第 93 行明确返回 ``failed to parse function arguments: missing field `status` at line 1 column 228``；当前轮次上下文为第 74 行；第 97/98 行补齐字段后重试成功。**仅观察到调用不能确认 Plan 已更新。**

真实调用每次携带完整步骤数组，没有步骤 ID、Plan ID 或步骤 patch。数组更新采用完整快照语义，不能把缺失的步骤自行补回。HUD 内部身份使用线程与步骤位置确定性生成，不能声称识别了插入、删除、重排后的业务步骤身份。

## 排序、持久化与关联

- rollout 的物理行号是现有 Reader 提供的稳定顺序；初次回放和增量读取使用同一顺序，重新回放时一起重建 Parser/Tracker。不按时间戳猜测重新排序。
- 调用更新需要同线程 call_id 的成功返回确认；没有返回、失败或未知返回时保留上次已确认的执行清单。
- 已确认清单可以从真实旧版 rollout 回放恢复；当前 writer 的持久化方式仍需真实实验。
- 调用本身没有 thread_id/turn_id，归属来自本文件的明确 session_meta.id 及轮次上下文。只有真实线程身份及父子 metadata 才允许关联 Agent；根清单默认作为独立模块。
- compaction 只影响 Context，不自行清空、完成或批准 Plan。

SQLite 调查仅以只读、immutable 方式检查 schema，不读取 prompt/credential：`state_5.sqlite.threads` 没有 Plan 列；`goals_1.sqlite.thread_goals` 保存独立 Goal；`thread_history_1.sqlite.thread_items` 有 `thread_id/turn_id/item_id/item_type/item_json/rollout_ordinal/updated_at_ordinal`。未确认其中是否有 Plan 内容；本阶段不建立数据库 Provider。immutable 模式可能看不到尚未 checkpoint 的 WAL schema。

## 实现与验收边界

现阶段的在线来源复用已有 rollout stream；App Server 的纯协议归一化可依据当前离线 schema 验证，连接与订阅留作 future provider，不新增 watcher。审批、拒绝、取消、失败以及当前版本的完整 Plan Mode 交互仍未取得真实来源，不通过自然语言、模式退出、工具失败或 task_complete 补造生命周期。

真实 fixture 仅摘自上述旧版持久化记录，明确标注版本与出处。没有真实样本的 delta、approval、cancelled、agent-plan 不伪造原始 JSONL；协议及归一化边界单测与运行验收分别报告。

官方网页检索曾被自动审批服务拒绝：审批模型 `gpt-5.6-luna` 的接口返回 HTTP 404。后续离线导出与本地读取未依赖该网页访问，也未修改审批配置。用户指定的工作及核验模型为 `gpt-6-astra`，不代表审批服务的模型已经改变。

当前已通过 713 项测试、类型检查与构建。构建后直接读取未改动的历史原文件，确认 0/4、1/4、3/4、4/4 的前缀回放、完整 Provider 恢复和 A→B→A 隔离。当前 CLI 的 Plan entered/generated/approved/implementation/completed 全流程仍待单独运行许可；不能把历史回放或离线 schema 测试计作这项验收。详细结果见 [Phase 6 实现与验收](phase6-plan.md)。
