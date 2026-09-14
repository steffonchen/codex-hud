# Codex rollout 测试样本

这些 fixture 提取自 2026-09-11 本机实际 rollout 结构，不包含消息、工具输出、用户指令、认证资料或原始工作目录。会话、轮次、窗口 ID 与路径已替换；未使用的原始字段省略。

- `rollout-session.jsonl`：`session_meta`、`task_started`、`turn_context` 的实际字段位置，写入版本 0.153.4。
- `rollout-token-count.jsonl`：实际压缩前后的数值。累计总量均为 6,475,285；最近总量从 191,970 变为 18,994。后者是 Codex 提供的压缩后估算，input/output 都为 0，不能用两者求和覆盖 total。中间 `compacted` 只保留事件标记与匿名窗口字段。
- `rollout-rate-limit.jsonl`：实际 `info=null` 与 `primary=null / secondary=null`。没有为非空窗口编造 fixture。
- `rollout-partial.jsonl`：从实际事件前缀截出的半行；增量测试去掉文件末尾换行，再分次追加其余 JSON 和换行。

测试中额外构造的无效数值、损坏行、重复快照和未知额度对象用于错误路径验证，不作为新的协议格式证据。
