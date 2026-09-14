# Plan 样本出处

这些 JSONL 来自真实 Codex rollout 的字段白名单摘录，记录 writer 为 **0.149.1**，不是当前 0.154.0 的运行证据。源文件和逐条原始行号见 `provenance.json`。

- `plan-created` 包含 metadata、当前轮次上下文及首次成功更新。
- `plan-updated`、`plan-progress`、`plan-completed` 是后续成功快照，需接在相同线程的 metadata 后回放。
- `plan-turn-completed` 只有真实轮次完成事件，用于确认其不会自行完成 Plan。
- `multiple-updates` 是同一清单的完整演进，不把无 Plan ID 的多次更新称作多个独立计划。
- `plan-update-rejected` 保留第四步缺 status、真实参数解析失败以及修正后成功的记录。

线程/轮次/调用 ID 经过一致替换，路径替换为 `/fixture/plan-project`，模型替换为 `fixture-model`，标题替换为“检查结构、实现工具函数、补充边界测试、验证结果”，explanation 也替换为安全文字。步骤数量、顺序、状态、缺失字段、成功/失败结果及时间来自原始记录；替换标题不表示实际执行过这些示例任务。未知字段、完整 prompt、命令和用户数据不进入 fixture。

`schema/` 来自本次 `codex-cli 0.154.0` 的离线 `app-server generate-json-schema --experimental` 导出。其中 PlanThreadItem 单独摘自 ServerNotification 的同名变体。它们证明协议字段；基于它们构造的通知单测不是运行采样。

没有取得当前版本的真实 PlanDelta、取消、批准或 Agent+Plan 样本，因此不创建虚构的对应 JSONL。归一化生命周期、schema 通知和异常输入仅用于软件边界测试，不能作为 runtime verification。
