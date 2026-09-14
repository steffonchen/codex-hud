import { t } from "../i18n/Messages.js";
import { currentLanguage, withLanguage } from "../i18n/Language.js";
import type { HudState, TokenUsage, ToolActivity } from "../core/HudState.js";
import type { CostEstimate, TokenUsageSnapshot, UsageEconomicsState, UsageRecord } from "../core/usage/UsageState.js";
import type { QuotaWindow } from "../core/usage/QuotaTracker.js";
import type { RolloutWatchStatus } from "../providers/codex/RolloutReader.js";
import { redact, redactText } from "../core/Redaction.js";
import type { CodexSessionSnapshot } from "../providers/codex/CodexSessionProvider.js";
import type { CodexDiagnostic } from "../providers/codex/Diagnostics.js";
import type { HudConfig } from "../config/Config.js";
import { LayoutEngine } from "../renderer/LayoutEngine.js";
import { ModuleRegistry } from "../renderer/modules/ModuleRegistry.js";
import type { TerminalSize } from "../renderer/WidthPolicy.js";
import type { HudOutput } from "../terminal/TerminalController.js";
import { buildAgentTree, flattenAgentTree, legacyAgentTree } from "../core/AgentTree.js";
import type { AgentState, AgentSummary } from "../core/AgentState.js";
import { redactSummary } from "../core/Redaction.js";
import path from "node:path";
import type { McpToolReference } from "../core/McpToolState.js";
import { MAX_PLAN_EVENTS, MAX_PLAN_STEPS, MAX_PLAN_TEXT, type PlanState, type PlanSummary } from "../core/PlanState.js";
import type { RuntimeSessionState } from "../providers/codex/runtime/RuntimeCandidate.js";
import { PERFORMANCE_STAGES, type HudDiagnostics } from "../core/HudDiagnostics.js";

const safePath = (file: string): string => redactSummary(`…/${path.basename(path.dirname(file))}/${path.basename(file)}`);

export function debugHudDiagnostics(value?: HudDiagnostics): unknown {
  if (!value) return undefined;
  const number = (value: unknown) => typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
  const metrics = Object.fromEntries(PERFORMANCE_STAGES.flatMap(stage => {
    const sample = value.performance[stage];
    return sample ? [[stage, { count: number(sample.count), lastMs: number(sample.lastMs), maxMs: number(sample.maxMs),
      meanMs: sample.count ? number(sample.totalMs / sample.count) : undefined }]] : [];
  }));
  return redact({
    [t("运行时")]: { authority: value.runtime.authority, kind: value.runtime.kind, connection: value.runtime.connection, ownership: value.runtime.ownership },
    [t("来源")]: { kind: value.source.kind, state: value.source.state, lastEventAt: number(value.source.lastEventAt), ageMs: number(value.source.ageMs),
      lastCheckedAt: number(value.source.lastCheckedAt), staleThresholdMs: number(value.source.staleThresholdMs) },
    [t("会话")]: { session: value.session.sessionId?.slice(0, 8), thread: value.session.threadId?.slice(0, 8), switches: number(value.session.switches) },
    [t("事件")]: Object.fromEntries(["received", "accepted", "processed", "deduplicated", "outOfOrder", "dropped", "invalid", "unknown", "errors", "rawReceived", "rawInvalid", "rawUnknown"]
      .map(key => [key, number(value.events[key as keyof HudDiagnostics["events"]])])),
    [t("渲染")]: { count: number(value.render.count), errors: number(value.render.errors), lastRenderAt: number(value.render.lastRenderAt) },
    [t("恢复")]: { state: value.recovery.state, reconnects: number(value.recovery.reconnectCount), fallbacks: number(value.recovery.fallbackCount),
      recoveries: number(value.recovery.recoveryCount), lastReconnectDurationMs: number(value.recovery.lastReconnectDurationMs) },
    [t("性能毫秒")]: metrics,
    [t("内存与资源")]: Object.fromEntries(["heapUsed", "rss", "toolCount", "agentCount", "historySize", "retainedTurns", "turnHistoryLimited", "dedupEntries", "sourceThreads", "sourceWatermarks",
      "watermarkIdentities", "tokenPending", "agentReaders", "retiredAgentFiles", "agentDiagnosticEntries", "stateSubscribers", "pendingStateNotifications", "appConnections",
      "appEventListeners", "appStatusListeners", "appDiagnosticListeners", "appThreads", "appBufferedEvents", "appBufferedBytes", "reconnectTimers", "pendingRequests", "pendingWrites",
      "activeWatchers", "providerTimers", "rolloutPollTimers", "runtimeClients", "runtimePendingClients", "failedCleanupClients", "pendingApprovals",
      "trackedAgents", "retiredAgents", "retiredAgentTurns", "uncertainTurns"].map(key => [key, number(value.memory[key])])),
    [t("告警")]: value.warnings.slice(-20).map(warning => ({ code: redactSummary(warning.code, 80), message: redactSummary(warning.message), count: number(warning.count), lastAt: number(warning.lastAt) })),
  });
}
const mcpReference = (value?: McpToolReference): McpToolReference | undefined => value && ({
  serverId: value.serverId, serverName: redactSummary(value.serverName, 100), toolName: redactSummary(value.toolName, 120), toolId: value.toolId,
});

function debugUsage(value: (Omit<UsageEconomicsState, "recentRecords"> & { recentRecords?: UsageRecord[] }) | undefined, verbose = false): UsageEconomicsState | undefined {
  if (!value) return undefined;
  const tokens = (usage?: TokenUsageSnapshot): TokenUsageSnapshot | undefined => usage && ({ inputTokens: usage.inputTokens,
    cachedInputTokens: usage.cachedInputTokens, cacheWriteInputTokens: usage.cacheWriteInputTokens, outputTokens: usage.outputTokens,
    reasoningOutputTokens: usage.reasoningOutputTokens, totalTokens: usage.totalTokens });
  const cost = (estimate: CostEstimate): CostEstimate => ({ value: estimate.value, currency: estimate.currency,
    inputCost: estimate.inputCost, cachedInputCost: estimate.cachedInputCost, cacheWriteCost: estimate.cacheWriteCost, outputCost: estimate.outputCost,
    basis: estimate.basis, confidence: estimate.confidence, source: estimate.source, sourceVersion: estimate.sourceVersion,
    reason: estimate.reason && redactSummary(estimate.reason) });
  return { tokens: { total: tokens(value.tokens.total), last: tokens(value.tokens.last), modelContextWindow: value.tokens.modelContextWindow,
      timestamp: value.tokens.timestamp, source: value.tokens.source, totalSource: value.tokens.totalSource, lastSource: value.tokens.lastSource },
    cache: { latestInputTokens: value.cache.latestInputTokens, latestCachedInputTokens: value.cache.latestCachedInputTokens,
      latestCacheWriteInputTokens: value.cache.latestCacheWriteInputTokens, hitRate: value.cache.hitRate,
      cumulativeInputTokens: value.cache.cumulativeInputTokens, cumulativeCachedInputTokens: value.cache.cumulativeCachedInputTokens,
      cumulativeHitRate: value.cache.cumulativeHitRate, source: value.cache.source, coverage: value.cache.coverage },
    cost: { latestCost: cost(value.cost.latestCost), sessionEstimatedCost: cost(value.cost.sessionEstimatedCost),
      pricedRequests: value.cost.pricedRequests, unpricedRequests: value.cost.unpricedRequests },
    requestCount: value.requestCount, coverage: value.coverage, retainedRecords: value.retainedRecords, droppedRecords: value.droppedRecords,
    recentRecords: verbose ? (value.recentRecords ?? []).slice(-20).map(record => ({ id: record.id, timestamp: record.timestamp,
      ordinal: record.ordinal, model: record.model, threadId: record.threadId, agentId: record.agentId, usage: tokens(record.usage)!,
      source: record.source, cacheWriteSemantics: record.cacheWriteSemantics })) : [],
    issues: value.issues.slice(0, 20).map(issue => redactSummary(issue)) };
}

function debugPlan(plan: PlanState | undefined, verbose = false, includeSteps = true): PlanState | undefined {
  if (!plan) return undefined;
  return { planId: plan.planId, threadId: plan.threadId, turnId: plan.turnId, source: plan.source, status: plan.status,
    steps: (includeSteps ? plan.steps.slice(0, MAX_PLAN_STEPS) : []).map(step => ({ id: step.id, position: step.position, title: redactSummary(step.title), status: step.status })),
    counts: { pending: plan.counts.pending, in_progress: plan.counts.in_progress, completed: plan.counts.completed,
      failed: plan.counts.failed, cancelled: plan.counts.cancelled, unknown: plan.counts.unknown },
    currentStepId: plan.currentStepId, currentStepPosition: plan.currentStepPosition, completedCount: plan.completedCount,
    totalCount: plan.totalCount, progressPercent: plan.progressPercent, createdAt: plan.createdAt, updatedAt: plan.updatedAt,
    ordinal: plan.ordinal, explanation: verbose && plan.explanation ? redactSummary(plan.explanation, 1000) : undefined };
}

function debugPlans(summary: PlanSummary | undefined, verbose = false): PlanSummary | undefined {
  if (!summary) return undefined;
  const capability = summary.capability;
  const proposal = summary.proposal;
  const mode = summary.mode;
  return { execution: debugPlan(summary.execution, verbose),
    mode: mode && { active: mode.active, threadId: mode.threadId, turnId: mode.turnId, updatedAt: mode.updatedAt },
    proposal: proposal && { itemId: proposal.itemId, threadId: proposal.threadId, turnId: proposal.turnId, source: proposal.source,
      status: proposal.status, text: verbose && proposal.status === "ready" && proposal.text !== undefined ? redactText(proposal.text).slice(0, MAX_PLAN_TEXT) : undefined,
      streamedCharacters: proposal.streamedCharacters, truncated: proposal.truncated, updatedAt: proposal.updatedAt, ordinal: proposal.ordinal },
    capability: { available: capability.available, planEvents: capability.planEvents, stepStatuses: capability.stepStatuses,
      planMode: capability.planMode, planDelta: capability.planDelta, approvalState: capability.approvalState,
      completionState: capability.completionState, agentAssociation: capability.agentAssociation },
    eventCount: summary.eventCount, events: summary.events.slice(-MAX_PLAN_EVENTS).map(event => ({ eventId: event.eventId,
      type: event.type, source: event.source, ordinal: event.ordinal, at: event.at, stepCount: event.stepCount })),
    issues: summary.issues.slice(0, 20).map(issue => redactSummary(issue)) };
}

function debugAgents(summary: AgentSummary | undefined, verbose = false): AgentSummary | undefined {
  if (!summary) return undefined;
  const agents = flattenAgentTree([...summary.tree, ...summary.orphans]).slice(0, 256).map(({ agent }): AgentState => ({
    id: agent.id, parentId: agent.parentId, isSubagent: agent.isSubagent, name: agent.name && redactSummary(agent.name, 80),
    agentPath: agent.agentPath && redactSummary(agent.agentPath), agentType: agent.agentType,
    status: agent.status, turnId: agent.turnId, model: agent.model, reasoningEffort: agent.reasoningEffort,
    startedAt: agent.startedAt, completedAt: agent.completedAt, lastUpdatedAt: agent.lastUpdatedAt,
    tokens: agent.tokens && { inputTokens: agent.tokens.inputTokens, outputTokens: agent.tokens.outputTokens,
      cachedInputTokens: agent.tokens.cachedInputTokens, cacheWriteInputTokens: agent.tokens.cacheWriteInputTokens,
      reasoningOutputTokens: agent.tokens.reasoningOutputTokens, totalTokens: agent.tokens.totalTokens },
    usage: debugUsage(agent.usage),
    context: agent.context && { usedTokens: agent.context.usedTokens, contextWindow: agent.context.contextWindow,
      remainingTokens: agent.context.remainingTokens, usedPercent: agent.context.usedPercent },
    activity: agent.activity && { status: agent.activity.status, label: agent.activity.label && redactSummary(agent.activity.label),
      description: agent.activity.description && redactSummary(agent.activity.description), mcp: mcpReference(agent.activity.mcp),
      toolId: agent.activity.toolId, toolType: agent.activity.toolType, toolStatus: agent.activity.toolStatus },
    plan: agent.isSubagent && agent.plan?.threadId === agent.id ? debugPlan(agent.plan, verbose, verbose) : undefined,
    error: agent.error && redactSummary(agent.error),
  }));
  const graph = buildAgentTree(agents);
  return { rootId: summary.rootId, count: summary.count, activeCount: summary.activeCount, activeSubagentCount: summary.activeSubagentCount, completedCount: summary.completedCount,
    failedCount: summary.failedCount, cancelledCount: summary.cancelledCount, omittedCount: summary.omittedCount,
    ...graph, issues: summary.issues.slice(0, 50).map(value => redactSummary(value)), lastUpdatedAt: summary.lastUpdatedAt,
    capability: { enabled: summary.capability.enabled, eventSupport: summary.capability.eventSupport,
      correlation: summary.capability.correlation, nestedSupport: summary.capability.nestedSupport,
      contextSupport: summary.capability.contextSupport, tokenSupport: summary.capability.tokenSupport } };
}

export function formatFailure(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  const cause = error instanceof Error && error.cause instanceof Error ? error.cause.message : "";
  const failures = error instanceof AggregateError ? error.errors.map(item => item instanceof Error ? item.message : String(item)) : [];
  const details = [...new Set([cause, ...failures].filter(detail => detail && !message.includes(detail)))];
  return t("错误：{0}{1}\n", redactText(message), details.length ? `（${details.map(redactText).join("；")}）` : "");
}

export function formatDiagnostic(diagnostic: CodexDiagnostic): string {
  const location = diagnostic.path && safePath(diagnostic.path);
  return redactText(`${diagnostic.severity === "error" ? t("错误") : t("提示")}：${diagnostic.message}${location ? `；${location}` : ""}${diagnostic.line === undefined ? "" : `:${diagnostic.line}`}`);
}

function debugRuntime(runtime?: RuntimeSessionState): RuntimeSessionState | undefined {
  if (!runtime) return undefined;
  const capabilities = runtime.capabilities;
  return { runtimeId: runtime.runtimeId?.slice(0, 8), runtimeStatus: runtime.runtimeStatus, kind: runtime.kind,
    transport: runtime.transport, ownership: runtime.ownership, compatibility: runtime.compatibility, health: runtime.health,
    authority: runtime.authority, source: runtime.source, discovery: runtime.discovery, candidateCount: runtime.candidateCount,
    managed: runtime.managed, socket: runtime.socket, probe: runtime.probe, serverVersion: runtime.serverVersion,
    authenticated: runtime.authenticated, lastEventAt: runtime.lastEventAt, eventCount: runtime.eventCount,
    pendingApprovals: runtime.pendingApprovals, approvalRequestsObserved: runtime.approvalRequestsObserved,
    reconnectAttempts: runtime.reconnectAttempts, reconnectExhausted: runtime.reconnectExhausted,
    reason: runtime.reason && redactSummary(runtime.reason),
    thread: { state: runtime.thread.state, threadId: runtime.thread.threadId?.slice(0, 8), runtimeId: runtime.thread.runtimeId?.slice(0, 8),
      attachmentSource: runtime.thread.attachmentSource },
    capabilities: { loadedThreads: capabilities.loadedThreads, threadRead: capabilities.threadRead, turnsList: capabilities.turnsList,
      itemsList: capabilities.itemsList, unsubscribe: capabilities.unsubscribe, accountRead: capabilities.accountRead, rateLimits: capabilities.rateLimits } };
}

export function debugState(state: HudState, verbose = false): HudState {
  const agents = debugAgents(state.agentSummary, verbose);
  const usage = (value: TokenUsage | undefined) => value && ({ inputTokens: value.inputTokens, outputTokens: value.outputTokens,
    cachedInputTokens: value.cachedInputTokens, cacheWriteInputTokens: value.cacheWriteInputTokens,
    reasoningOutputTokens: value.reasoningOutputTokens, totalTokens: value.totalTokens });
  const window = (value: QuotaWindow | undefined) => value && ({ usedPercent: value.usedPercent, remainingPercent: value.remainingPercent,
    windowDurationMins: value.windowDurationMins, resetsAt: value.resetsAt, source: value.source });
  const tool = (value: ToolActivity): ToolActivity => ({ id: value.id, name: value.name, type: value.type, status: value.status,
    startedAt: value.startedAt, completedAt: value.completedAt, durationMs: value.durationMs,
    inputSummary: value.inputSummary, outputSummary: value.outputSummary, error: value.error, mcp: mcpReference(value.mcp) });
  const mcp = state.mcpSummary;
  const skills = state.skillSummary;
  const sources = state.dataSources, app = sources?.appServer;
  return redact({
    dataSources: sources && { preferred: sources.preferred, active: sources.active, degraded: sources.degraded,
      rolloutAvailable: sources.rolloutAvailable, fallbackEnabled: sources.fallbackEnabled, tokenSource: sources.tokenSource, deduplicated: sources.deduplicated,
      issues: sources.issues.slice(0, 20).map(issue => redactSummary(issue)),
      appServer: app && { runtime: debugRuntime(app.runtime), state: app.state, available: app.available, live: app.live, transport: app.transport,
        protocol: app.protocol, schema: app.schema, threadId: app.threadId?.slice(0, 8), history: app.history,
        eventCount: app.eventCount, unknownCount: app.unknownCount, reconnectCount: app.reconnectCount,
        lastEvent: app.lastEvent && redactSummary(app.lastEvent, 80), reason: app.reason && redactSummary(app.reason),
        capabilities: { liveEvents: app.capabilities.liveEvents, history: app.capabilities.history, tokenUsage: app.capabilities.tokenUsage,
          plans: app.capabilities.plans, tools: app.capabilities.tools, agents: app.capabilities.agents, quota: app.capabilities.quota, context: app.capabilities.context } } },
    planSummary: debugPlans(state.planSummary, verbose),
    mcpSummary: mcp && { enabled: mcp.enabled, configurationStatus: mcp.configurationStatus, serverCount: mcp.serverCount,
      configuredCount: mcp.configuredCount, runtimeCount: mcp.runtimeCount, readyCount: mcp.readyCount, failedCount: mcp.failedCount, disabledCount: mcp.disabledCount,
      capability: { configured: mcp.capability.configured, runtimeDiscovery: mcp.capability.runtimeDiscovery, serverStatus: mcp.capability.serverStatus,
        toolDiscovery: mcp.capability.toolDiscovery, resourceDiscovery: mcp.capability.resourceDiscovery, promptDiscovery: mcp.capability.promptDiscovery },
      servers: mcp.servers.slice(0, 128).map(server => ({ id: server.id, name: server.name, status: server.status,
        configured: server.configured, runtimeObserved: server.runtimeObserved, transport: server.transport, toolCount: server.toolCount,
        observedToolCount: server.observedToolCount, lastUpdatedAt: server.lastUpdatedAt, lastObservedAt: server.lastObservedAt, error: server.error })),
      tools: mcp.tools.slice(0, 1024).map(tool => ({ id: tool.id, serverId: tool.serverId, name: tool.name, description: tool.description,
        enabled: tool.enabled, available: tool.available, discovery: tool.discovery })),
      issues: mcp.issues.slice(0, 50).map(value => redactSummary(value)), lastUpdatedAt: mcp.lastUpdatedAt },
    skillSummary: skills && { enabled: skills.enabled, count: skills.count, availableCount: skills.availableCount, activeCount: skills.activeCount,
      failedCount: skills.failedCount, disabledCount: skills.disabledCount, directoryStatus: skills.directoryStatus,
      capability: { directoryDiscovery: skills.capability.directoryDiscovery, runtimeDiscovery: skills.capability.runtimeDiscovery,
        activeState: skills.capability.activeState, versionInfo: skills.capability.versionInfo },
      skills: skills.skills.slice(0, 512).map(skill => ({ id: skill.id, name: skill.name, description: skill.description,
        status: skill.status, source: skill.source, advertised: skill.advertised, version: skill.version, error: skill.error,
        path: verbose && skill.path ? safePath(skill.path) : undefined })), issues: skills.issues.slice(0, 50).map(value => redactSummary(value)) },
    agentSummary: agents,
    agents: agents?.capability.eventSupport ? legacyAgentTree([...agents.tree, ...agents.orphans]) : undefined,
    model: state.model, reasoningEffort: state.reasoningEffort, codexVersion: state.codexVersion,
    context: state.context && { ...usage(state.context), usedTokens: state.context.usedTokens, contextWindow: state.context.contextWindow,
      remainingTokens: state.context.remainingTokens, usedPercent: state.context.usedPercent },
    tokenUsage: usage(state.tokenUsage),
    usage: debugUsage(state.usage, verbose),
    cost: state.cost && { amount: state.cost.amount, currency: state.cost.currency, estimated: state.cost.estimated },
    session: state.session && { id: state.session.id, startedAt: state.session.startedAt, durationMs: state.session.durationMs,
      lastActivityAt: state.session.lastActivityAt, turnCount: state.session.turnCount },
    quota: state.quota && { primary: window(state.quota.primary), secondary: window(state.quota.secondary),
      fiveHour: window(state.quota.fiveHour), weekly: window(state.quota.weekly), source: state.quota.source,
      scope: state.quota.scope, availability: state.quota.availability, timestamp: state.quota.timestamp,
      planType: state.quota.planType, limitId: state.quota.limitId, limitName: state.quota.limitName,
      rateLimitReachedType: state.quota.rateLimitReachedType, spendControlReached: state.quota.spendControlReached,
      credits: state.quota.credits && { hasCredits: state.quota.credits.hasCredits, unlimited: state.quota.credits.unlimited, balance: state.quota.credits.balance } },
    tools: state.tools && { active: state.tools.active?.slice(0, 64).map(tool), recent: state.tools.recent?.slice(0, 20).map(tool) },
    activity: state.activity && { status: state.activity.status, label: state.activity.label, description: state.activity.description,
      mcp: mcpReference(state.activity.mcp),
      toolId: state.activity.toolId, toolType: state.activity.toolType, toolStatus: state.activity.toolStatus,
      startedAt: state.activity.startedAt, completedAt: state.activity.completedAt, durationMs: state.activity.durationMs },
  }) as HudState;
}

export function formatDebug(snapshot: CodexSessionSnapshot, display?: { config: HudConfig; terminal: TerminalSize; isTTY: boolean; verbose?: boolean }): string {
  return withLanguage(display?.config.display.language ?? currentLanguage(), () => formatLocalizedDebug(snapshot, display));
}

function formatLocalizedDebug(snapshot: CodexSessionSnapshot, display: Parameters<typeof formatDebug>[1]): string {
  const runtime = snapshot.runtime;
  const modules = display && new ModuleRegistry().resolve(display.config.display.enabled, display.config.display.order)
    .filter(module => module.isAvailable(snapshot.state));
  const layout = display && modules && new LayoutEngine().layout(snapshot.state, display.terminal, modules, display.config.behavior.auto_compact);
  const state = debugState(snapshot.state, display?.verbose);
  const mcp = state.mcpSummary;
  const skills = state.skillSummary;
  const summaryState = display?.verbose ? state : { ...state, mcpSummary: undefined, skillSummary: undefined, planSummary: undefined };
  const plan = state.planSummary;
  const data = {
    [t("内部诊断")]: debugHudDiagnostics(snapshot.hudDiagnostics),
    [t("运行时")]: display && {
      [t("运行方式")]: t("单次快照；不查询其他 start 进程"), [t("持续运行")]: false, "TTY": display.isTTY,
      [t("终端")]: display.terminal, [t("渲染间隔毫秒")]: display.config.behavior.refresh_ms,
    },
    "Codex": {
      [t("版本")]: runtime.version, [t("rollout 写入版本")]: runtime.rolloutVersion,
      "binary": runtime.codexBinary ? t("已发现") : t("未发现"), "home": "<CODEX_HOME>", "sessions": "<CODEX_HOME>/sessions",
      [t("会话")]: runtime.currentSessionId?.slice(0, 8), "rollout": runtime.currentRolloutPath ? "<CODEX_HOME>/sessions/…" : undefined,
      [t("实时线程")]: runtime.activeThreadId?.slice(0, 8),
      [t("选择依据")]: runtime.selection === "environment" ? t("环境线程 ID") : runtime.selection === "explicit" ? t("明确指定的线程 ID")
        : runtime.selection === "working-directory" ? t("当前目录历史主会话；无实时附着依据") : runtime.selection === "recent" ? t("最近历史主会话；无实时附着依据") : t("未发现"),
    },
    [t("状态")]: summaryState,
    [t("计划")]: plan && { [t("来源")]: plan.execution?.source ?? plan.proposal?.source, [t("能力")]: plan.capability,
      [t("执行状态")]: plan.execution?.status, [t("完成步骤")]: plan.execution?.completedCount, [t("总步骤")]: plan.execution?.totalCount,
      [t("进度百分比")]: plan.execution?.progressPercent, [t("模式")]: plan.mode?.active === undefined ? t("未确认") : plan.mode.active ? "Plan Mode" : t("普通模式"),
      [t("提案")]: plan.proposal?.status, [t("事件数")]: plan.eventCount, [t("诊断")]: plan.issues },
    [t("MCP 发现")]: mcp && { [t("配置来源")]: mcp.configurationStatus, [t("已配置")]: mcp.configuredCount, [t("服务数")]: mcp.serverCount,
      [t("调用中发现")]: mcp.runtimeCount, [t("已观测工具")]: mcp.tools.length, [t("能力")]: mcp.capability,
      [t("就绪")]: mcp.capability.serverStatus ? mcp.readyCount : t("未观测"), [t("失败")]: mcp.capability.serverStatus ? mcp.failedCount : t("未观测"), [t("已禁用")]: mcp.disabledCount, [t("诊断")]: mcp.issues },
    [t("Skills 发现")]: skills && { [t("目录来源")]: skills.directoryStatus, [t("发现")]: skills.count, [t("当前目录确认可用")]: skills.availableCount,
      [t("活动")]: skills.capability.activeState ? skills.activeCount : t("未观测"), [t("失败或不可用")]: skills.failedCount,
      [t("已禁用")]: skills.disabledCount, [t("能力")]: skills.capability, [t("诊断")]: skills.issues },
    [t("能力发现 IO")]: snapshot.discoveryIO,
    [t("读取")]: { [t("结果")]: snapshot.read.status, [t("采样时间")]: snapshot.sampledAt, [t("本次字节")]: snapshot.read.bytesRead,
      "offset": snapshot.read.offset, [t("本次完整行")]: snapshot.read.linesRead, [t("待补齐字节")]: snapshot.read.pendingBytes },
    [t("检测")]: snapshot.detections,
    [t("代理发现")]: { [t("CLI 配置")]: runtime.agentFeatureEnabled ?? null, [t("配置来源")]: runtime.agentFeatureDetail,
      [t("子 rollout 数")]: runtime.agentRollouts?.length ?? 0, [t("能力")]: debugAgents(snapshot.state.agentSummary)?.capability },
    [t("代理读取")]: snapshot.agentReads?.map(item => ({ [t("代理")]: item.agentId, [t("路径")]: safePath(item.path), [t("结果")]: item.status, [t("新增字节")]: item.bytesRead, "offset": item.offset })),
    [t("工具")]: { [t("活动")]: snapshot.state.tools?.active?.length ?? 0, [t("近期")]: snapshot.state.tools?.recent?.length ?? 0 },
    "Watcher": snapshot.watcher ?? { mode: "inactive", activeWatchers: 0, fallback: false },
    "Renderer": display && { [t("启用模块")]: display.config.display.enabled, [t("可见模块")]: layout?.moduleIds, [t("因空间隐藏")]: layout?.hiddenModuleIds },
    [t("诊断")]: snapshot.diagnostics.map(formatDiagnostic),
  };
  const source = snapshot.state.dataSources?.active === "app-server" ? t("Codex App Server 归一化快照")
    : snapshot.read.status === "ready" ? t("真实 Codex rollout 快照") : snapshot.read.status === "missing" ? t("未发现可读的 Codex rollout") : t("Codex rollout 读取失败");
  return t("数据来源：{0}\nContext 按最近用量快照估算；累计 Token 单独显示。\n{1}\n", source, JSON.stringify(redact(data), null, 2));
}

export function formatRuntimeChecks(snapshot: CodexSessionSnapshot, output?: HudOutput): string {
  const terminal = output ? [output.isTTY ? t("✓ 交互终端 TTY") : t("⚠ 非交互终端：start 输出一次纯文本快照"),
    t("{0} stdout 可写", output.writable && !output.destroyed && !output.writableEnded ? "✓" : "✗")] : [];
  const health = snapshot.hudDiagnostics;
  const state = snapshot.state, sources = state.dataSources;
  const merged = sources?.appServer?.available ? t("归一化历史与实时事件（逐条来源未保存在展示状态）") : snapshot.read.status === "ready" ? "rollout" : t("未取得");
  return [...terminal, t("Codex CLI：{0}；Rollout 写入版本：{1}", snapshot.runtime.version ?? t("未取得"), snapshot.runtime.rolloutVersion ?? t("未取得")),
    t("会话来源：{0}；Token 来源：{1}；Plan 来源：{2}", sources?.active ?? (snapshot.read.status === "ready" ? "rollout" : t("未取得")), sources?.tokenSource ?? (snapshot.detections.tokenCount && snapshot.read.status === "ready" ? "rollout" : t("未取得")), state.planSummary?.execution?.source ?? state.planSummary?.proposal?.source ?? t("未取得")),
    t("Tool / Agent 来源：{0}；MCP 来源：配置与已观测调用；Skills 来源：目录与运行目录事件；Quota 来源：{1}", merged, state.quota?.source ?? t("未取得")),
    ...(health ? [
    t("来源健康：{0}；来源={1}；数据年龄={2}；stale 不表示连接失败", health.source.state, health.source.kind, health.source.ageMs === undefined ? t("未知") : `${Math.round(health.source.ageMs)}ms`),
    t("事件统计：收到={0}；处理={1}；去重={2}；乱序={3}；丢弃={4}；无效原始消息={5}", health.events.received, health.events.processed, health.events.deduplicated, health.events.outOfOrder, health.events.dropped, health.events.rawInvalid),
    t("恢复统计：重连={0}；回退={1}；恢复={2}", health.recovery.reconnectCount, health.recovery.fallbackCount, health.recovery.recoveryCount),
  ] : []), ...snapshot.checks.map(check => {
    const detail = check.ok && ["binary", "home", "sessions"].includes(check.id)
      ? check.id === "home" ? t("<CODEX_HOME>（已发现）") : check.id === "sessions" ? "<CODEX_HOME>/sessions" : t("已发现可执行文件")
      : check.detail;
    return redactText(`${check.ok ? "✓" : check.warning ? "⚠" : "✗"} ${check.label}${detail ? `：${detail}` : ""}`);
  })].join("\n") + "\n";
}

export function formatWatcherProbe(watcher: RolloutWatchStatus): string {
  if (watcher.mode === "inactive") return t("⚠ 文件监听：没有可检测的 rollout\n");
  const native = watcher.mode === "native" ? t("✓ 原生文件监听：本次短时检测未报错，监听已关闭；事件送达未验证")
    : t("⚠ 原生文件监听不可用：{0}", watcher.reason ?? t("原因未确认"));
  return redactText(t("{0}\n✓ 增量补查：已配置 {1} 毫秒 stat/offset 补查；不读取其他 HUD 进程的状态\n", native, watcher.fallbackMs));
}
