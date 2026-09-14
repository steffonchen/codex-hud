import { t } from "../../../i18n/Messages.js";
import path from "node:path";
import type { HudEvent, ToolEvent } from "../../../core/HudEvent.js";
import { redactSummary } from "../../../core/Redaction.js";
import { eventIdentity } from "../../../core/source/EventIdentity.js";
import type { EventPhase } from "../../../core/source/DataSource.js";
import { completeUsage } from "../../../core/usage/UsageState.js";
import { mcpServerId, mcpToolId } from "../../../core/McpToolState.js";
import { PlanEventParser } from "../PlanEventParser.js";
import { RateLimitParser } from "../RateLimitParser.js";
import { shellSummary } from "../ToolEventParser.js";
import { record, type CodexDiagnostic } from "../Diagnostics.js";
import type { RpcNotification } from "./AppServerProtocol.js";

export const APP_SERVER_NOTIFICATIONS = new Set(["thread/started", "thread/status/changed", "thread/tokenUsage/updated",
  "turn/started", "turn/completed", "turn/plan/updated", "item/started", "item/completed", "item/plan/delta",
  "thread/compacted", "account/rateLimits/updated", "error"]);
export const protocolId = (value: unknown): string | undefined => typeof value === "string" && /^[a-zA-Z0-9_-]{1,128}$/.test(value) ? value : undefined;
const time = (value: unknown): number | undefined => typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && value <= 8_640_000_000_000_000 ? value : undefined;
const seconds = (value: unknown): number | undefined => time(value) !== undefined && (value as number) <= 8_640_000_000_000 ? (value as number) * 1000 : undefined;
const label = (value: unknown, length = 160): string | undefined => typeof value === "string" && value.trim() ? redactSummary(value, length) : undefined;
const errorKinds = new Set(["contextWindowExceeded", "sessionBudgetExceeded", "usageLimitExceeded", "rateLimitExceeded", "serverOverloaded",
  "internalServerError", "unauthorized", "badRequest", "threadRollbackFailed", "sandboxError", "httpConnectionFailed",
  "responseStreamConnectionFailed", "responseStreamDisconnected", "responseTooManyFailedAttempts", "activeTurnNotSteerable"]);
const errorKind = (value: unknown): string => {
  const info = record(value)?.codexErrorInfo;
  const key = typeof info === "string" ? info : Object.keys(record(info) ?? {})[0];
  return errorKinds.has(key) ? key : "other";
};

export function threadParent(thread: Record<string, unknown>): string | undefined {
  return protocolId(thread.parentThreadId) ?? protocolId(record(record(record(thread.source)?.subAgent)?.thread_spawn)?.parent_thread_id);
}

export interface NormalizationResult { events: HudEvent[]; diagnostics: CodexDiagnostic[]; recognized: boolean }
export interface NotificationContext { ordinal: number; generation: number; phase: EventPhase; rootThreadId?: string }

export class AppServerEventNormalizer {
  private readonly plans = new PlanEventParser();
  private readonly limits = new RateLimitParser();
  private quotas = new Map<string, Record<string, unknown>>();

  reset(): void { this.quotas.clear(); }

  thread(value: unknown, context: NotificationContext): NormalizationResult {
    const thread = record(value);
    const id = protocolId(thread?.id);
    if (!thread || !id) return this.invalid();
    const parentId = threadParent(thread);
    const spawn = record(record(record(thread.source)?.subAgent)?.thread_spawn);
    if (parentId && protocolId(spawn?.parent_thread_id) && parentId !== spawn!.parent_thread_id) return this.invalid();
    const events: HudEvent[] = [
      { type: "agent-discovered", agentId: id, threadId: id, parentId, isSubagent: !!parentId,
        name: label(thread.agentNickname, 80), agentType: label(thread.agentRole, 80), source: "app-server" },
      { type: "session", id, threadId: id, startedAt: seconds(thread.createdAt), version: label(thread.cliVersion, 50) },
    ];
    if (typeof thread.model === "string") events.push({ type: "model", threadId: id, model: label(thread.model), reasoningEffort: label(thread.reasoningEffort, 40) });
    return this.finish(events, context);
  }

  turn(threadId: string, value: unknown, context: NotificationContext): NormalizationResult {
    const turn = record(value);
    const id = protocolId(turn?.id);
    if (!turn || !id || !Array.isArray(turn.items) || turn.items.length > 8192 || !["inProgress", "completed", "interrupted", "failed"].includes(String(turn.status))) return this.invalid();
    const startedAt = seconds(turn.startedAt), completedAt = seconds(turn.completedAt);
    const events: HudEvent[] = [{ type: "turn-started", id, threadId, turnId: id, at: startedAt },
      { type: "agent-status", agentId: threadId, threadId, turnId: id, status: "running", at: startedAt, source: "app-server" }];
    const diagnostics: CodexDiagnostic[] = [];
    for (const item of turn.items) {
      const raw = record(item);
      const stage = raw?.status === "inProgress" || (raw?.type === "plan" && turn.status === "inProgress") ? "started" : "completed";
      const result = this.item(threadId, id, item, stage, undefined, context);
      events.push(...result.events); diagnostics.push(...result.diagnostics);
    }
    if (turn.status !== "inProgress") {
      if (turn.status === "failed") diagnostics.push({ code: "app-server-turn-error", severity: "warning", message: t("App Server 轮次失败（{0}）", errorKind(turn.error)) });
      events.push({ type: turn.status === "completed" ? "turn-completed" : "turn-aborted", id, threadId, turnId: id, at: completedAt });
      events.push({ type: "agent-status", agentId: threadId, threadId, turnId: id, source: "app-server", at: completedAt,
        status: turn.status === "completed" ? "completed" : turn.status === "interrupted" ? "cancelled" : "failed" });
    }
    return this.finish(events, context, diagnostics);
  }

  normalize(notification: RpcNotification, context: NotificationContext): NormalizationResult {
    if (!APP_SERVER_NOTIFICATIONS.has(notification.method)) return { events: [], diagnostics: [], recognized: false };
    const params = record(notification.params);
    if (!params) return this.invalid();
    if (notification.method === "account/rateLimits/updated") return this.quota(params, context);
    if (notification.method === "thread/started") return this.thread(params.thread, context);
    const threadId = protocolId(params.threadId);
    if (!threadId) return this.invalid();
    const turnId = protocolId(params.turnId) ?? protocolId(record(params.turn)?.id);
    if (notification.method === "thread/status/changed") {
      const status = record(params.status);
      if (!status || !["notLoaded", "idle", "systemError", "active"].includes(String(status.type))) return this.invalid();
      if (status.type === "active" && !Array.isArray(status.activeFlags)) return this.invalid();
      // idle 不等于代理任务完成；终态只由所属线程的 turn/completed 确认。
      const waiting = status.type === "active" && (status.activeFlags as unknown[]).some(flag => flag === "waitingOnApproval" || flag === "waitingOnUserInput");
      return this.finish(status.type === "active" ? [{ type: "agent-status", agentId: threadId, threadId,
        source: "app-server", status: waiting ? "waiting" : "running" }] : [], context);
    }
    if (!turnId) return this.invalid();
    if (notification.method === "thread/tokenUsage/updated") {
      const usage = record(params.tokenUsage);
      const decode = (value: unknown) => {
        const raw = record(value);
        if (!raw) return undefined;
        return completeUsage({ inputTokens: raw.inputTokens as number, cachedInputTokens: raw.cachedInputTokens as number,
          cacheWriteInputTokens: (raw.cacheWriteInputTokens === undefined ? 0 : raw.cacheWriteInputTokens) as number, outputTokens: raw.outputTokens as number,
          reasoningOutputTokens: raw.reasoningOutputTokens as number, totalTokens: raw.totalTokens as number });
      };
      const total = decode(usage?.total), last = decode(usage?.last);
      const window = usage?.modelContextWindow;
      if (!total || !last || (window != null && (time(window) === undefined || (window as number) < 1))) return this.invalid();
      return this.finish([{ type: "tokens", threadId, turnId, total, last, contextWindow: window == null ? undefined : window as number,
        cacheWriteSemantics: "unverified" }], context);
    }
    if (notification.method === "turn/plan/updated" || notification.method === "item/plan/delta") {
      const result = this.plans.parseNotification(notification, context.ordinal);
      return this.finish(result.events, context, result.diagnostics);
    }
    if (notification.method === "item/started" || notification.method === "item/completed") {
      const stage = notification.method === "item/started" ? "started" : "completed";
      const at = time(params[stage === "started" ? "startedAtMs" : "completedAtMs"]);
      if (at === undefined) return this.invalid();
      return this.item(threadId, turnId, params.item, stage, at, context);
    }
    if (notification.method === "turn/started" || notification.method === "turn/completed") {
      const turn = record(params.turn);
      if (!turn || !["inProgress", "completed", "interrupted", "failed"].includes(String(turn.status))) return this.invalid();
      const start = notification.method === "turn/started";
      const at = seconds(start ? turn.startedAt : turn.completedAt);
      const type = start ? "turn-started" : turn.status === "completed" ? "turn-completed" : "turn-aborted";
      return this.finish([{ type, id: turnId, threadId, turnId, at }, { type: "agent-status", agentId: threadId, threadId, turnId, at,
        source: "app-server", status: start ? "running" : turn.status === "completed" ? "completed" : turn.status === "interrupted" ? "cancelled" : "failed" }], context,
        turn.status === "failed" ? [{ code: "app-server-turn-error", severity: "warning", message: t("App Server 轮次失败（{0}）", errorKind(turn.error)) }] : []);
    }
    if (notification.method === "thread/compacted") return this.finish([{ type: "context-compacted", threadId, turnId }], context);
    return { events: [], diagnostics: [{ code: "app-server-turn-error", severity: "warning",
      message: t("App Server 报告轮次错误（{0}），{1}", errorKind(params.error), params.willRetry === true ? t("服务器正在重试") : t("等待权威终态")) }], recognized: true };
  }

  quota(params: Record<string, unknown>, context: NotificationContext): NormalizationResult {
    const raw = record(params.rateLimits);
    if (!raw || !context.rootThreadId) return this.invalid();
    if (raw.limitId == null && this.quotas.size > 1) return this.invalid("app-server-quota-identity");
    const key = typeof raw.limitId === "string" ? raw.limitId : this.quotas.keys().next().value ?? "default";
    if (!this.quotas.has(key) && this.quotas.size >= 32) return this.invalid("app-server-quota-limit");
    const merged = { ...this.quotas.get(key) };
    for (const key of ["limitId", "limitName", "primary", "secondary", "credits", "planType", "spendControlReached", "rateLimitReachedType"]) {
      if (["primary", "secondary", "credits"].includes(key) && record(raw[key])) {
        const nested = { ...record(merged[key]) };
        const fields = key === "credits" ? ["hasCredits", "unlimited", "balance"] : ["usedPercent", "windowDurationMins", "resetsAt"];
        for (const field of fields) {
          const value = (raw[key] as Record<string, unknown>)[field];
          if (value != null) nested[field] = value;
        }
        merged[key] = nested;
      } else if (raw[key] != null || (key === "spendControlReached" && Object.hasOwn(raw, key))) merged[key] = raw[key];
    }
    const parsed = this.limits.parseNotification({ rateLimits: merged });
    if (parsed.diagnostics.some(issue => issue.severity === "error")) return { events: [], diagnostics: parsed.diagnostics, recognized: true };
    this.quotas.set(key, merged);
    return this.finish([{ type: "quota", threadId: context.rootThreadId, quota: parsed.quota }], context, parsed.diagnostics);
  }

  private item(threadId: string, turnId: string, value: unknown, stage: "started" | "completed", at: number | undefined,
    context: NotificationContext): NormalizationResult {
    const item = record(value), itemId = protocolId(item?.id);
    if (!item || typeof item.type !== "string") return this.invalid();
    const supported = ["plan", "commandExecution", "fileChange", "mcpToolCall", "dynamicToolCall", "collabAgentToolCall", "subAgentActivity", "contextCompaction"];
    if (!supported.includes(item.type)) return this.finish([], context);
    if (!itemId) return this.invalid();
    if (item.type === "plan") {
      const result = this.plans.parseNotification({ method: `item/${stage}`, params: { threadId, turnId, item } }, context.ordinal, at);
      return this.finish(result.events, context, result.diagnostics);
    }
    if (item.type === "contextCompaction") return this.finish(stage === "completed" ? [{ type: "context-compacted", threadId, turnId, at }] : [], context);
    if (item.type === "subAgentActivity") {
      if (!protocolId(item.agentThreadId) || !["started", "interacted", "interrupted", "completed"].includes(String(item.kind))) return this.invalid();
      // 该条目没有直接父身份或子 turnId，不能用父轮次更新子生命周期。
      return this.finish([], context);
    }
    const status = String(item.status);
    const known = ["inProgress", "completed", "failed", "declined", "interrupted"].includes(status);
    let type: ToolEvent["type"] = !known ? "tool-unknown" : status === "failed" ? "tool-failed"
      : status === "declined" || status === "interrupted" ? "tool-cancelled" : stage === "started" ? "tool-started"
      : status === "completed" ? "tool-completed" : "tool-unknown";
    const tool: HudEvent & ToolEvent = { type, toolId: itemId, threadId, turnId, at, resultSource: "execution",
      startedAt: stage === "started" ? at : undefined, durationMs: time(item.durationMs), name: t("工具调用"), toolType: "unknown" };
    const events: HudEvent[] = [tool];
    if (item.type === "commandExecution") {
      if (typeof item.command !== "string" || !Array.isArray(item.commandActions)) return this.invalid();
      tool.name = "shell"; tool.toolType = "shell"; tool.inputSummary = shellSummary(item.command);
      const actions = item.commandActions.map(record).filter(entry => entry !== undefined);
      const action = actions.find(entry => entry.type === "search") ?? actions.find(entry => entry.type === "read" || entry.type === "listFiles");
      if (action) {
        tool.toolType = action.type === "read" ? "read" : "search";
        tool.inputSummary = typeof action.path === "string" ? label(path.basename(action.path)) : tool.toolType === "read" ? t("读取文件") : t("搜索文件");
      }
      if (stage === "completed") {
        if (typeof item.exitCode === "number" && Number.isSafeInteger(item.exitCode)) {
          if (item.exitCode !== 0) tool.type = "tool-failed";
          tool.outputSummary = t("退出码 {0}", item.exitCode);
        } else if (tool.type === "tool-completed") tool.type = "tool-unknown";
      }
    } else if (item.type === "fileChange") {
      if (!Array.isArray(item.changes) || item.changes.some(change => typeof record(change)?.path !== "string")) return this.invalid();
      tool.name = "apply_patch"; tool.toolType = "edit";
      tool.inputSummary = item.changes.length ? `${label(path.basename((item.changes[0] as { path: string }).path), 120)}${item.changes.length > 1 ? t(" 等 {0} 个文件", item.changes.length) : ""}` : t("文件修改");
      tool.outputSummary = stage === "completed" ? t("涉及 {0} 个文件", item.changes.length) : undefined;
    } else if (item.type === "mcpToolCall") {
      if (typeof item.server !== "string" || typeof item.tool !== "string" || !item.server.trim() || !item.tool.trim()) return this.invalid();
      const serverId = mcpServerId(item.server);
      tool.mcp = { serverId, serverName: label(item.server, 100)!, toolName: label(item.tool, 120)!, toolId: mcpToolId(serverId, item.tool) };
      tool.name = `${tool.mcp.serverName}.${tool.mcp.toolName}`; tool.toolType = "mcp"; tool.inputSummary = `MCP ${tool.name}`;
      if (record(item.error) || record(item.result)?.isError === true) tool.type = "tool-failed";
    } else if (item.type === "dynamicToolCall") {
      if (typeof item.tool !== "string") return this.invalid();
      tool.name = label(item.namespace ? `${String(item.namespace)}.${item.tool}` : item.tool)!;
      tool.inputSummary = tool.name;
      if (item.success === false) tool.type = "tool-failed";
    } else if (item.type === "collabAgentToolCall") {
      if (protocolId(item.senderThreadId) !== threadId || !Array.isArray(item.receiverThreadIds) || item.receiverThreadIds.length > 256
        || item.receiverThreadIds.some(id => !protocolId(id)) || !record(item.agentsStates)) return this.invalid();
      tool.name = "collaboration"; tool.inputSummary = t("代理协作");
      if (item.tool === "spawnAgent") for (const id of item.receiverThreadIds as string[]) {
        events.push({ type: "agent-discovered", agentId: id, threadId: id, parentId: threadId, isSubagent: true, source: "app-server" });
      }
      if (item.tool === "spawnAgent" || item.tool === "wait") events.push({ type: "agent-call", agentId: threadId, threadId, turnId,
        at, callId: itemId, operation: item.tool === "wait" ? "wait" : "spawn", source: "app-server" });
    }
    if (tool.type === "tool-failed") tool.error = tool.outputSummary ?? t("工具执行失败");
    return this.finish(events, context, known ? [] : [{ code: "app-server-item-status", severity: "warning", message: t("工具状态无法识别，保持未知") }]);
  }

  private finish(events: HudEvent[], context: NotificationContext, diagnostics: CodexDiagnostic[] = []): NormalizationResult {
    return { events: events.map((event, index) => ({ ...event, source: "app-server", phase: context.phase, generation: context.generation,
      sourceOrdinal: context.ordinal, ordinal: context.ordinal,
      eventId: eventIdentity("app-server", event.threadId, event.turnId, context.generation, context.ordinal, index, event.type) })), diagnostics, recognized: true };
  }
  private invalid(code = "app-server-notification-schema"): NormalizationResult {
    return { events: [], diagnostics: [{ code, severity: "warning", message: t("App Server 消息缺少有效字段或超出安全边界，未采用该消息") }], recognized: true };
  }
}
