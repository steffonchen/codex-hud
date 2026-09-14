# Phase 3 工具事件样本

这些样本来自本机现有 Codex Desktop 主会话，写入版本为 `0.153.4`。本机 PATH 中的 CLI 版本另为 `0.154.0`。没有为取得样本启动新 Codex 会话。

保留实际事件类型、字段位置、值类型、状态、退出码、时间和耗时；ID 一致匿名化。命令、参数、路径、查询、脚本、文件正文、差异和输出内容均被替换或删除。示例中的 `npm test`、`package.json` 等是安全替代内容，不代表原会话确实执行了这些具体命令。样本不是可执行脚本。

来源索引（行号从 1 开始）：

- A：`rollout-2026-09-12T06-23-39-01a09291-bae7-7370-aed2-27ee84aaf892.jsonl`，13、15～19 行。
- B：`rollout-2026-09-11T18-04-38-01a08fed-25fb-7483-a596-2bbc3b0d00b9.jsonl`，79、160、163、167、169、170、208 行。
- C：`rollout-2026-09-11T12-30-25-01a08ebb-27fa-7561-94db-090f63d3d722.jsonl`，166、169、176、178 行。
- D：`rollout-2026-09-11T22-09-28-01a090cd-4ca2-72c3-98a3-34cb82fd88c1.jsonl`，43 行。

| 文件 | 结构与来源 |
| --- | --- |
| `tool-start.jsonl` | A:13，外层 `custom_tool_call`，name 为 exec。调用记录的 `status=completed` 不代表执行完成。 |
| `tool-complete.jsonl` | A:13、17、19，外层调用与输出，以及独立 `CommandExecution` 完成记录。 |
| `tool-failed.jsonl` | A:15，`status=failed`、`exit_code=128`、真实耗时。 |
| `tool-multiple.jsonl` | A:13、15～19，一个 exec 包含四个独立命令完成记录。 |
| `tool-partial.jsonl` | A:17 脱敏行的前半段，没有末尾换行，仅用于半行与坏 JSON 测试。 |
| `tool-unknown.jsonl` | B:160、163，带 namespace 的普通 function call，作为尚未专门适配的外部工具处理。 |
| `tool-external-failed.jsonl` | B:167、169、170，结构化外部工具失败与同 call_id 输出，验证失败不会被外层返回覆盖。 |
| `tool-yielded.jsonl` | C:166、169、176、178，exec 让出 cell 与 wait 续跑；保留真实头部格式，cell ID 匿名化。 |
| `tool-read-search.jsonl` | A:17、B:79，`parsed_cmd.read/search/list_files` 的字段形状。 |
| `tool-edit.jsonl` | B:208，`FileChange.changes` 中的 add/update；未保存文件正文或差异。 |
| `tool-turn-aborted.jsonl` | D:43，`turn_aborted`、`reason=interrupted`；它不是工具级 cancelled 的证据。 |

观察到的 CommandExecution/FileChange 都是 `item_completed`，没有内层开始事件，也没有指向外层 exec 的 call_id。测试不补造这些关联。ToolTracker 的 pending、cancelled、缺字段、乱序、重复、容量限制与异常输入测试是在已知结构或归一化事件上构造的边界测试，不作为额外真实 schema 证据。
