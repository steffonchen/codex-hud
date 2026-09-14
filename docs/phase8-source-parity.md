# Phase 8：来源一致性与权威规则

日期：2026-09-13。状态：**DOCUMENTED / PROTOCOL TEST ONLY**。真实同一会话的 App Server 与 Rollout 对照为 **NOT OBSERVED / ENVIRONMENT LIMITED**，没有记录任何真实 MATCH。

## 真实对照的证据边界

本机已有 Rollout，可确认现有来源契约；App Server 在沙箱内因运行时数据库权限失败，initialize 尚未完成。随后沙箱外握手及产品降级验证均遭自动审批服务 HTTP 404 拒绝。实际模型请求为 0 轮，未获取可与 Rollout 配对的真实 App Server 通知。

| 对照项 | Rollout 契约 | App Server 契约 | 本轮真实对照 |
| --- | --- | --- | --- |
| Model | turn_context 的模型/推理参数 | Thread 的当前或最近持久配置 | NOT OBSERVED；含义不同，不能直接证明逐轮相等 |
| Context | last_token_usage.total_tokens / model_context_window | tokenUsage.last.totalTokens / modelContextWindow | NOT OBSERVED |
| Token | total/last 分项 | total/last 分项 | NOT OBSERVED |
| Plan | 成功 update_plan 的执行清单 | turn/plan/updated 的结构化步骤 | NOT OBSERVED；不存在可共享的修订号 |
| Tool | call_id / item ID 与执行结果 | Thread / Turn / item ID 与状态 | NOT OBSERVED |
| Agent | 明确 parent_thread_id 和子日志 | parentThreadId 或明确 spawn 接收者，子线程自身事件 | NOT OBSERVED |

## 已运行的协议与来源层对照

这些结果来自合成、脱敏样本及临时文件，**不是运行捕获**。

| 场景 | 已验证结果 | 证据 |
| --- | --- | --- |
| 同一 Token 快照从两个来源到达 | 合成输入 100、缓存读取 20、输出 10、总计 110 只形成一次已确认请求；后续 220 快照只新增一次请求 | SourceDedup.test.ts、SourceFallback.test.ts |
| Rollout 基线后 App 连续更新 | 同一 Provider/Store 更新；Token authority 可交接到 App；通知不触发 Rollout 重读 | SourceFallback.test.ts |
| Rollout 缺失 cacheWrite，App 按 schema 默认 0 | 可对齐身份；不会把 Rollout 报告里的缺失值填成已观测零 | SourceDedup.test.ts |
| 权威累计下降后的 A→B→A→B | 不把再次出现的旧内容当成永久重复；迟到 App 重放不双计 | SourceDedup.test.ts |
| 来源 generation 改变后重读 | 按 Rollout 物理行号和快照共同锚定，不在首个相同内容处提前解锁 | SourceDedup.test.ts |
| 断线期间先到达 Rollout 尾部 | 先对齐 App 已采用前缀，再释放未计入的 Rollout 事件 | SourceDedup.test.ts |
| 同轮 Plan 两个来源冲突 | 保留先确认来源，不按到达时间覆盖；缺共享修订号的差异保持诊断 | SourceDedup.test.ts |
| Plan proposal 断线重放 | 不把无法确认身份的 delta 重复拼接；等待完整 completed 正文 | SourceDedup.test.ts、AppServerEventNormalizer.test.ts |
| 历史与 live 的同一工具完成 | 同一 item 只保留一份；execution 失败不能被 call 成功覆盖 | AppServerHistoryBootstrap.test.ts、SourceDedup.test.ts |
| 断线期间发生的工具 | 后续 full 历史补回；旧连接迟到消息无效 | AppServerReconnect.test.ts |
| 历史发现子代理 | 明确父边登记后补读 child，并接收其 live Token | AppServerHistoryBootstrap.test.ts |
| 根线程卸载、子线程单独卸载 | 已确认 Token 交接到 Rollout；子线程卸载不会撤销其他线程实时权威 | AppServerSource.test.ts、SourceDedup.test.ts |
| 已缓冲新轮次与旧历史交错 | waiting 状态属于合并后已确认的新轮次，不被旧轮次过滤掉 | AppServerHistoryBootstrap.test.ts |
| 缺失历史边界与新增子线程 | 无关 child 成功不会把 root partial 清成 ready；后到新轮次不能掩盖旧缺口 | AppServerHistoryBootstrap.test.ts |

## SourceAuthorityPolicy

| 数据 | 采用规则 |
| --- | --- |
| 持久化历史 | Rollout 先提供基线；App read / turns / items 补充。保留已确认轮次边界，不能重放任意旧轮次 |
| Token / Cache / 派生 Cost | App 作为优先实时来源；两源有可确认的顺序交接后才切换，镜像只计一次。无法对齐时保留已确认值并诊断 |
| Model | 有 Rollout turn_context 时保留其来源；App Thread.model 只补缺失展示，不给请求账本补造模型 |
| Plan | 当前轮次的执行清单固定在已确认来源。App 可提供新轮次的结构化清单；重连不能用无修订号的 Rollout 覆盖它 |
| Tool | 稳定 Thread / Turn / item / 生命周期身份去重；call 与 execution 证据交给既有 ToolTracker 处理 |
| Agent | 明确父子身份与子线程自己的生命周期；父协作条目不提供子轮次终态 |
| Quota | 已观测到 App 结构化窗口且其实时有效时优先；否则使用 Rollout。稀疏更新按字段合并，不合并身份不明的桶 |
| Context compaction | 同一轮次保留已确认压缩来源；迟到镜像不能清掉压缩之后的新实测 |

Token 镜像队列、来源身份缓存均有界。超过可证明的对齐范围会显示部分覆盖/来源问题，不推算缺失请求或费用。App 历史没有 Token 与执行清单；当 Rollout fallback 关闭或缺失时，这两类历史缺口保持可见。

上述决策全部在 source 层执行。既有 TokenUsageTracker、PlanTracker、ToolTracker、AgentTracker、QuotaTracker 和 CostCalculator 不按 JSON-RPC 来源分支，也没有第二份 HUD 状态或 Renderer。
