# Phase 7：Usage Economics 来源调查

初始调查记录：2026-09-12；本轮定点复核：2026-09-13。本文区分实际 rollout、当前 binary 的静态协议、既有定价记录与软件测试。前期记录没有全部重新执行，本轮独立取得的证据和访问失败在下文单独说明。

## 环境与既有能力

CLI 为 `0.154.0`；本项目 Desktop rollout metadata writer 为 `0.153.4`。另检查了 22 份 writer `0.154.0` 的文件；metadata 不保证后续所有续写来自同一版本。未观察到独立 rollout schema 版本。

已亲读 README 与 Phase 2—6 全部文档，并检查 Core、Parser、Reducer、Provider、Renderer、Setup、Doctor、Debug 和对应测试。旧 `TokenTracker` 只覆盖累计快照；最近请求仅用于 Context，完整分项在 Reducer 中丢失。Cache 只读取旧 Context 字段；Cost 无真实计算链。`RateLimitParser` 对所有非空窗口报未支持。现有集中 Reader、线程独立 Reducer、LayoutEngine、优先级及配置入口可以继续使用，不需要新 watcher。

## 实际取样

以下为开发初期留下的取样记录，覆盖数量未在本轮重跑核实，不能与后面的定点样本累加，也不作为本轮严格读取上限的证明：

- 首批 8 份本项目 Desktop 文件，约 14.8 MB、222 条 token_count，所有 info 均为对象；52 次累计总量重复，观察到压缩和 2 条分项全零的估算快照。
- 22 份 CLI 0.154.0 文件，约 31.8 MB、726 条 token_count；703 条 info 对象、23 条 info=null；341 次累计总量重复，2 次 compacted，2 条估算快照。
- 补查最近文件序列 31—129，共 99 文件、约 148.8 MB、2759 条 token_count；每文件上限 8 MiB，总量约 140 MiB，上限截断了 3 个文件。该批与前批有重叠，不合并为独立样本总数。
- 补查 18 份近期文件的 452 条完整用量：330 次新累计快照的六字段差值均等于 last，106 次完整累计快照相同；4 条 last 的 input+output 不等于 total，均为全零分项估算。未观察到 cached+cacheWrite 大于 input 或 reasoning 大于 output。
- 所检查的窗口、credits、plan_type、reached/spend 字段均为空；没有非空 quota、缺失 rate_limits 的实际记录、同线程模型切换、selected_token_count、独立 recompute_token_usage 事件或累计量下降的样本。未观察到不代表不支持；未读区域不在结论范围内。

本轮输出只包含白名单数值、结构和版本；没有打印 prompt、代码、凭据或完整原始日志。新增 fixture 保留原时间和数值，替换线程、父线程、额度 ID 与工作目录，真实行号留作可复核依据。

### 本轮定点复核与可复核样本

仅从两份已定位、metadata.cwd 匹配项目、writer 为 0.153.4 的原文件提取，详见 [样本说明](../tests/fixtures/usage/README.md) 和 [行号及数值记录](../tests/fixtures/usage/provenance.json)。

| 匿名来源 | 提取读取边界 | 保留的 Token 事件 | 核实结果 |
| --- | --- | --- | --- |
| main-sequence | 前 111 行，2,566,922 字节 | 12 条，从首请求起连续保留 | 11 个独立请求；最后两条 total/last 重复；累计 660,916，最近 97,627；包含正数 cache_write |
| child-sequence | 前 24 行，182,597 字节 | 5 条 | 前三条 info=null，后两条是相同首请求；total=last=22,801，cache_write=0；两处明确 parent_thread_id 一致 |

两份样本不声明属于同一真实父子树。窗口、credits、plan_type 和触限字段在上述范围内均为空。同线程模型切换未观测到；当前 fixture 的对应案例明确使用合成契约，不能标为实机来源。

最终构建另外回放了这两份完整原文件：主线程 414 行、3,982,213 字节，恢复 29 次请求；子线程 162 行、1,442,087 字节，恢复 12 次请求。重复刷新读取 0 字节，受控 A→B→A 和新 Provider 回放的四类状态相等。子线程单独作为来源时，未读取父文件会保留 agent-correlation 提示。当前任务自然增量、真实 PTY 与 EMFILE 的证据见 [验收报告](phase7-usage-economics.md)。

## token_count schema

事件：顶层 `type=event_msg`，`payload.type=token_count`。下表路径均从 payload 开始。“稳定”只表示本次对象样本中的存在情况，不声明未来协议稳定性。

| 路径 | 类型 | 本次存在情况 | 当前版本实测 | HUD 用途与边界 |
| --- | --- | --- | --- | --- |
| info | object/null | 每条存在，CLI 样本有23条null | 是 | null不产生新用量；不能变成零 |
| info.total_token_usage | object | 每个非空info存在 | 是 | 累计快照覆盖，绝不求和 |
| info.last_token_usage | object | 每个非空info存在 | 是 | 最近请求或压缩估算，不直接等同新增请求 |
| 两种 usage.input_tokens | 非负整数 | 完整对象均存在 | 是 | 输入总量 |
| 两种 usage.cached_input_tokens | 非负整数 | 完整对象均存在 | 是 | 输入子集，不另加到total |
| 两种 usage.cache_write_input_tokens | 非负整数 | 完整对象均存在 | 是 | 保留实测原值；计费映射未确认，不能自行增加费用 |
| 两种 usage.output_tokens | 非负整数 | 完整对象均存在 | 是 | 输出总量 |
| 两种 usage.reasoning_output_tokens | 非负整数 | 完整对象均存在 | 是 | 输出分项，不重复相加或收费 |
| 两种 usage.total_tokens | 非负整数 | 完整对象均存在 | 是 | 优先采用源端总量 |
| info.model_context_window | 正整数 | 每个非空info存在 | 是 | Context分母，与累计Token无关 |
| rate_limits | object | 本次所有token_count存在 | 是 | 独立额度快照；不能由Token估算 |
| token_count内 thread_id/agent_id/request_id/response_id | 未出现 | 无 | 否 | 不生成虚构请求身份；线程来自所属文件metadata |

典型连续记录（保留实际数值，身份已省略）：

| 次序 | total input/cache/write/output/reasoning/total | last input/cache/write/output/reasoning/total |
| --- | --- | --- |
| 1 | 22066 / 0 / 22063 / 425 / 0 / 22491 | 同左 |
| 2 | 54078 / 22063 / 32009 / 1298 / 516 / 55376 | 32012 / 22063 / 9946 / 873 / 516 / 32885 |
| 3 | 95329 / 54072 / 41248 / 1885 / 664 / 97214 | 41251 / 32009 / 9239 / 587 / 148 / 41838 |

重复完整快照是实际行为，不能按事件条数计算请求。只有新累计快照与 last 的差值一致，或首次 total=last 时，才将 last 确认为账本增量；身份明确的归一化请求另有独立入口。无法确认的断档保持 partial，不能用差值伪造未见的模型请求。来源物理行序用于乱序保护，数值下降仍可作为较新的权威快照接受。

## Compaction 与身份

真实 `compacted` 后观察到：累计 total 仍为 6,409,528，last 的 input/cache/write/output/reasoning 全为0，total=18,448；随后再次发送相同估算。CLI文件另见 total=10,758及18,553的估算。它们仅用于Context，标记 estimated，不进入 Cache 命中率或费用累计。

`compacted.payload.latest_token_usage_record` 实际包含 `thread_id/turn_id/session_id/root_turn_id/response_id/usage/turn_token_usage/thread_token_usage`。这是压缩携带的历史记录，不是额外完成一次请求，不能重复入账。本阶段不新增对该嵌套记录的用量累计。

token_count 没有逐请求ID。文件所属线程由 `session_meta.payload.id` 确认，子代理由明确 parent_thread_id 确认；模型取同文件先前 turn_context.model。没有明确线程或模型时保持未知。取样 turn_context 没有 service_tier/fast_mode，不能据此推断真实服务档位。

未观察到总量下降及 rollback 用量重算；静态 binary 有 `TokenUsageInfo::new_or_append`、`SessionState::record_token_usage` 等符号，反汇编不足以证明每个字段行为。因此不假定累计量单调，归一化回退/重算用测试验证，并与实机证据分开。

## Quota schema 与协议证据

| 实际路径 | 实际类型 | 存在情况 | 可用范围 |
| --- | --- | --- | --- |
| rate_limits.limit_id | string | 所查对象均存在 | 保留经过白名单筛选的来源标签 |
| rate_limits.limit_name | null | 均存在 | 没有名称值，不补造 |
| rate_limits.primary / secondary | null | 均存在 | 空窗口，不是0%或100%可用 |
| rate_limits.credits / individual_limit | null | 均存在 | 未观察到非空结构 |
| rate_limits.spend_control_reached | null | 均存在 | 未知，不推断恢复 |
| rate_limits.plan_type / rate_limit_reached_type | null | 均存在 | 未知，不推断套餐/触限 |

0.154.0 当前安装 binary 的原始 Serde 字段表明确包含 `used_percent/window_minutes/resets_at`（RateLimitWindow）与 `has_credits/unlimited/balance`（CreditsSnapshot）。这是原始字段名的静态证据，不是把 App Server camelCase 任意转写。

本次离线 `codex app-server generate-ts --experimental` 再次确认当前 v2 `RateLimitWindow` 的 `usedPercent:number`、`windowDurationMins:number|null`、`resetsAt:number|null`；`CreditsSnapshot.balance:string|null`，两个标志为 boolean。balance不能照建议接口强转number。`spendControlReached` 注释明确 null 表示不可用，不表示恢复。

**证据限制：** raw非空窗口的实际值、类型、重置时间单位及稀疏合并行为仍未实测。归一化窗口与当前协议适配须独立测试；未知raw结构继续诊断，不能把协议测试记为实机验证。primary/secondary不能直接写死为5h/weekly，显示名称必须检查真实windowDurationMins。额度按全局范围展示，随所选日志恢复快照；没有可靠账号身份时不跨会话复用旧额度。

## Pricing 与费用契约

既有价格记录引用以下官方来源。本轮对模型、pricing、prompt-caching 和 reasoning 页面的直接读取均因 DNS 解析失败，未取得正文；随后只读浏览器访问被自动审批拒绝，原因是审批服务调用所选模型失败、返回 HTTP 404，并非官方页面返回 404。因此以下登记值保留原有来源版本，不能标为本轮官方核验通过：

- [API pricing](https://developers.openai.com/api/docs/pricing)
- [GPT-6 Astra](https://developers.openai.com/api/docs/models/gpt-6-astra)
- [GPT-5.6 Sol](https://developers.openai.com/api/docs/models/gpt-5.6-sol)
- [Prompt caching](https://developers.openai.com/api/docs/guides/prompt-caching)
- [Reasoning](https://developers.openai.com/api/docs/guides/reasoning)
- [Token counting](https://developers.openai.com/api/docs/guides/token-counting)

仓库既有 `sourceVersion=2026-09-12` 的 Standard 美元/百万 Token 登记值（本轮未改价）：

| 模型 | 普通输入 | 缓存读取 | 缓存写入 | 输出 |
| --- | --- | --- | --- | --- |
| gpt-6-astra | 10 | 1 | 12.5 | 50 |
| gpt-5.6-sol | 4 | 0.4 | 5 | 20 |

已有登记条目把两模型单次 input 严格超过 272K 时的整请求输入及缓存费率乘 2、输出乘 1.5；阈值判断使用单次 input，不使用会话累计量或扣除缓存后的数值。测试验证登记规则的计算与边界，本轮没有取得官方正文来重新确认阈值、费率或适用模型，也没有补造历史生效日期。

实现采用明确的互斥输入分类契约：`ordinary=input-cached-cacheWrite`，各类乘对应价格，再加 output 费用；只有归一化输入明确确认这一契约时，才计算正数缓存写入。缓存写入不是额外附加 Token，reasoning 不重复计费。手动测试价格用于独立核验数学结果，不作为官方定价证据。

**rollout cache_write_input_tokens → API cache_write_tokens 的赋值链尚未取得。** 对需要该映射的真实用量，费用保持 unavailable 并说明原因；归一化入口只有显式声明已经确认的输入分类契约，才允许计算缓存写入。价格已知与用量计费契约已知是两个条件，不能混为一谈。

所有 token×price 都是 estimated Standard API-equivalent cost，不是服务器actual cost，更不是Codex订阅账单。未知模型、缺失必要字段、无法确认的分类和不完整账本均不补零；完整会话估算不以可计算的小计冒充。

## 环境限制与后续验证

前期文档记录过官方页面读取成功，但本轮无法独立复核；本轮官方页面直接访问 DNS 失败，浏览器访问被自动审批拒绝（审批服务模型接口返回 404）。没有绕过拒绝，也未修改 Codex 配置。Pricing 验收为 **SOURCE DEPENDENT / ENVIRONMENT LIMITED**：存在 registry 条目只代表可按登记规则计算，不能证明已重新核实价格。非空 Quota 的实机验证仍为 **PARTIAL**。

最终验收分别记录 IMPLEMENTED、RUNTIME VERIFIED 和 UNVERIFIED / NOT OBSERVED。历史原文件、脱敏 fixture、合成边界、当前任务自然新增用量及真实 PTY 观察分别标注；未启动 Phase 6 clamp，也未额外发模型请求或人为耗尽额度。
