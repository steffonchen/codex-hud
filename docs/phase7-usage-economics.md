# Phase 7：Token / Cache / Quota / Cost 验收

验收日期：2026-09-13，Asia/Shanghai。阶段状态：**PARTIAL**。批准范围内的本地优化、自动化验证和构建已经完成；未观测或受环境限制的实机能力不记为 PASS。

| 项目 | 结果 |
| --- | --- |
| Codex CLI / Node.js | 0.154.0 / v23.11.0 |
| 本轮真实 rollout writer | 0.153.4；不代表所有续写来自相同版本 |
| Tests | **848 passed，55 个文件**，`npm test -- --no-cache` |
| Typecheck | PASS，`npm run typecheck`；额外对 src 与 tests 共 151 个文件检查，0 错误、无输出文件 |
| Build | PASS，`npm run build`；已补齐并刷新 dist 的 JavaScript、声明与 source map |
| Token parser / tracker、Cache、Quota、Cost、PricingProvider | 软件测试 PASS |
| Renderer / Setup / Doctor / Debug | 软件测试 PASS；宽度 140 / 80 / 50 / 30 与短高度均覆盖 |

## 实现与运行证据

| 能力 | IMPLEMENTED | RUNTIME VERIFIED | UNVERIFIED / NOT OBSERVED |
| --- | --- | --- | --- |
| Token | YES | YES：原始历史文件及当前任务自然新增事件 | 当前版本自然 rollback / recompute 未观测到；合成测试覆盖总量回退 |
| Cache | YES | YES：最近请求命中率、完整会话累计、真实连续更新 | 正数 cache_write 的 API 计费归属未确认 |
| Quota | YES | **PARTIAL**：真实空窗口正确保持 empty 并隐藏 | 非空比例、重置、credits、套餐和触限事件 NOT OBSERVED；已有静态字段与契约测试 |
| Cost | YES | **CALCULATED ONLY**：按登记价格计算的 API 等价估算 | 没有 actual billing 来源；当前自然样本包含未确认的缓存写入，费用正确保持不可用 |
| Pricing | YES | **SOURCE DEPENDENT / ENVIRONMENT LIMITED** | 既有登记条目保留，本轮未取得官方网页正文，不能称重新核价通过 |
| Compaction | YES | **HISTORICAL SOURCE ONLY**：既有 0.153.4 压缩样本 | 本轮真实 PTY 未自然触发压缩 |
| Agent usage | YES | **HISTORICAL SOURCE ONLY**：明确身份的子文件可独立回放 | 根/子文件的组合关联由集成测试验证；未将两个独立来源伪称为真实同树实验 |

Session switch：PASS，原始历史文件的受控 A→B→A 与 Runtime 集成测试；不等同用户终端自然切换的实机观察。HUD restart：PASS，新 Provider 恢复历史状态，真实 PTY 进程重新启动后继续显示自然用量。SIGINT：PASS，真实 Ctrl+C 与自动化资源清理验证。EMFILE：PASS，同步/异步故障注入测试，以及本机自然 EMFILE 后的真实增量更新。

## Token、Cache 与账本语义

`total_token_usage` 是权威累计快照，更新时覆盖，不能把各次 total 相加。`last_token_usage` 是最近用量快照；只有首条 total=last，或新累计快照逐字段增量等于 last 时，才确认独立请求。无法确认的缺口保持 partial，不由差值虚构请求。

`cached_input_tokens` 是 input 的子集，reasoning 是 output 的分项，均不额外计入 total。保留 cache_write 原值，但不凭字段名称猜计费分类。input=100,000、cached=90,000、output=1,000、reasoning=700 时，总量为源端的 101,000，缓存命中率为 90%。

压缩后分项为零而 total 大于零时标记 estimated，只用于 Context；最近缓存比例和最近费用不作为实测值展示。累计量未变时保留已确认会话统计；估算期间累计量变化或历史不完整时，会话费用不可用。较新的累计量下降可以被接受，但不当成新的请求费用。

本轮修复了以下会污染状态的路径：

- 短暂缺失累计字段后，保留已确认基线，恢复相同快照不会再次入账。
- 去重历史淘汰后，拒绝无法确认的旧时间或无序号记录，并报告覆盖不完整；有可靠物理序号的累计统计不因展示历史淘汰而清空。
- total 未变而 last 改变时保持 unknown，重复该快照不会重新升为 measured。
- 请求入账被安全边界拒绝后清除旧最近费用，避免上一笔金额与新快照错配。
- 物理序号与无序号的后备请求 ID 分开，混用时不会发生身份碰撞。
- 较早 Token 事件不能套用未来 turn_context 的模型价格；线程切换、重启和 reset 清理独立状态。

Cache 会话命中率只使用确认请求的输入与缓存读取累计值。两个请求 100/80、200/150 得到 230/300≈76.67%，不累加 total 快照。零输入比例为 undefined，显示“—”；缺失或估算来源隐藏最近 Cache。账本最多保留 512 条请求，默认诊断不展开请求历史，verbose 最多 20 条；累计统计独立于保留记录数。

## Quota 与费用边界

Quota 独立维护 primary/secondary、usedPercent、remainingPercent、周期、重置时间、credits 和触限字段。只按周期 300 / 10080 分钟命名 5h / 7d；已知与未知周期混合时两个窗口均保留，其他窗口显示“额度”。used 和 remaining 不互换；null 不变成 0% 或 100% 可用。达到重置时间只提示等待更新，不擅自清零。无法识别的窗口保留 warning，不输出原始未知内容。

额度按 global 范围展示，但它是所选文件记录的快照。没有可靠账号身份时，切换日志会恢复各自额度，不复用另一会话的旧值。`credits.balance` 根据当前静态协议保留 string/null，不强转为金额数值；Token 不能推算订阅额度消耗。

Cost 区分最近请求和完整会话，始终标记 estimated、basis=standard-api-equivalent。按每次请求当时的模型计算，模型变化不重定价历史；任意未定价请求、计费契约缺失、混合币种或不完整历史都会阻止输出完整会话金额，不用可计算的小计冒充总价。真实零费用与不可用分别处理。

已确认的归一化输入分类使用 `ordinary=input-cached-cacheWrite`，分别乘价格再加 output，不额外收费 reasoning。手动测试价格下，输入 100,000、缓存读取 90,000、输出 1,000 的独立结果为 USD 0.073；该测试不依赖官方表。缓存写入缺失或正数写入的语义未确认时保持不可用。

PricingProvider 与 ModelPricingRegistry 沿用现有来源记录、版本及长上下文规则。本轮没有改动 Astra/Sol 的登记费率，没有把网络失败解释为模型或官方页面不存在。具体 URL、登记值与限制见 [Usage Discovery](phase7-usage-discovery.md)。Doctor 的 Pricing available 表示 registry 有条目，不表示联网复核成功。

## 真实文件与终端观察

本轮未额外发起模型请求、耗尽额度、修改用户配置或执行 Phase 6 clamp。历史原文件只读，终端观察使用当前任务自然产生的事件；终端显示仅开启五个用量模块，配置在内存中。

| 实验 | 可核实结果 | 证据范围 |
| --- | --- | --- |
| 新增匿名主样本 | 原文件前 111 行；连续 12 条 Token 事件，确认 11 次请求；末尾重复不增加统计 | 真实脱敏 fixture；最终累计 660,916、最近 97,627 |
| 新增匿名子样本 | 原文件前 24 行；3 条 info=null，2 条重复首请求；只确认 1 次 | 明确 parent_thread_id，累计 22,801、缓存读取 21,761、写入 0 |
| 完整主原文件 | 414 行、3,982,213 字节；29 次请求，coverage=complete | 累计 3,420,433，最近 200,287，命中率约 93.58% |
| 完整子原文件 | 162 行、1,442,087 字节；12 次请求，coverage=complete | 累计 785,983，最近 100,643，命中率约 98.91%；单独选择子文件保留父关联缺失提示 |
| 静态回放、A→B→A | 重复刷新新增读取 0 字节，返回 A 后 Token/Cache/Cost/Quota 状态完全相等 | 受控选择真实原文件，不伪称自然终端切换 |
| 新 Provider 与 Debug | 新 Provider 回放状态相等；Debug 前后 140/80/50/30 列用量显示一致 | 最终 dist + 原始文件 |
| 09:58:40—09:59:40，80×24 PTY | 同一线程请求数 60→61，Token 总量 6,834,429→7,001,328；缓存 91.8%→97.9% | 自然新增事件；60 秒观察到时主动清理，不将其记为 SIGINT |
| 10:00:28—10:00:46，重启 PTY | 请求数 62→63，总量 7,170,364→7,341,206；Ctrl+C 退出码 0 | 光标、主屏恢复，SIGINT 监听释放，watcher=0 |
| 10:01:16—10:02:06，自然 EMFILE | native→polling，reason=EMFILE；请求数 64→65→66，总量 7,512,407→7,686,588→7,861,309 | 34 次快照，其中 28 次读取 0 新字节；一次 watch 调用、最多一个 watcher；两次真实用量增量继续显示，Ctrl+C 正常清理 |

最后一次自然观察的最近输入为 174,393、缓存读取 173,145、输出 328，hitRate≈99.28%，Context window=258,400。额度始终 empty，正数缓存写入映射未确认，费用保持 unavailable；未把长期累计 Token 用作额度百分比或长上下文计价阈值。

同步/异步 EMFILE 的自动化测试使用真实临时文件和 Provider/Runtime，只注入 watcher 失败：不发送变化通知，仍由既有 3 秒补查更新全部四类状态，并核对读取字节。五个用量模块维持既有两个 interval，没有新增专用 watcher 或 timer。SIGINT 后 timer、监听、订阅全部释放；停止后的 StateStore 更新不会产生新帧。

## 配置、诊断与兼容

默认注册表包含 Token Details 和 Cache，Cost 默认关闭，原模块优先级保持不变。已有显式 enabled 不自动补选；来源暂时缺失时，setup 自定义仍保留用户已有的用量选择。能力输出区分“可预选”和“当前有数据”。

Debug 逐层白名单保留 root/agent 用量、cache_write、旧 Context 分项、旧 cost 和新额度字段，不再丢失显示所需数据；额外 raw/prompt/arguments 字段不透传，允许字段中的凭据仍脱敏。Doctor 接入 token-source、cache-source、rate-limit、pricing-source、estimated-cost 五项独立检查，保留覆盖不完整和费用不可用原因。

## 本轮涉及路径

源码修改：

- `src/core/usage/TokenUsageTracker.ts`
- `src/providers/codex/RolloutEventParser.ts`、`RateLimitParser.ts`、`CodexSessionProvider.ts`；新增 `UsageDiagnostics.ts`
- `src/renderer/modules/TokenDetails.ts`、`Quota.ts`
- `src/cli/Diagnostics.ts`、`Setup.ts`、`src/capabilities/CapabilityDetector.ts`

验证与产物：

- 新增 `tests/TokenUsageTracker.test.ts`、`CostCalculator.test.ts`、`QuotaTracker.test.ts`、`UsageRendering.test.ts`、`UsageDiagnostics.test.ts`、`providers/UsageParsing.test.ts`、`runtime/UsageLive.test.ts` 和 `tests/usage.ts`。
- 更新 CLI、Capabilities、Config、ModuleRegistry、LayoutEngine、CodexSessionProvider、RateLimitParser 与 LiveRollout 的旧断言；保留解析错误和安全诊断，未删测试掩盖失败。
- 新增 `tests/fixtures/usage/` 的两个匿名 JSONL、来源记录和说明；压缩复用已有历史 fixture。
- 刷新 `dist/`，补齐原先缺失的用量模块产物；更新 `README.md`、`docs/phase7-usage-discovery.md`，新增本文。

与实施前文件哈希基线对比，没有删除项目文件；修改限定于本阶段源码、测试、文档和构建产物。`~/.codex/config.toml` 与 `~/.codex-hud/config.toml` 的 SHA256 均保持不变，修改文件为 UTF-8 无 BOM。没有 Git 元数据，未执行 commit、push、分支、PR 或其他 Git 写操作。

## 尚未解决的证据限制

- 非空 Quota、真实重置、credits、触限、缺失 rate_limits 的新真实样本、同线程自然模型切换未观测到；对应合成/静态协议测试不能替代实机验证。
- 官方价格与长上下文规则本轮独立复核失败；真实 cache_write 到 API 类别的映射仍未确认，没有 actual cost 或订阅账单来源。
- 当前自然终端观察为短时连续运行，不能代表长期稳定性或超过 272K 输入阈值的实测。压缩只验证既有历史来源与软件边界。
- Phase 6 的 Plan Mode、Approval、Delta 和 Agent+Plan 实机限制维持原记录；本阶段没有运行 clamp 或进入 Phase 8。
