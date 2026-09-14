import { t } from "../i18n/Messages.js";
import type { ToolEvent } from "./HudEvent.js";
import type { ToolActivity, ToolStatus } from "./HudState.js";
import { redactSummary } from "./Redaction.js";

export const MAX_RECENT_TOOLS = 20;
export const MAX_ACTIVE_TOOLS = 64;
const MAX_TOOL_IDENTITIES = 256;
const activeStatus = (status: ToolStatus) => status === "running" || status === "pending";
const validTime = (value: number | undefined): value is number => value !== undefined && Number.isFinite(value) && value >= 0;

export class ToolTracker {
  private active = new Map<string, ToolActivity>();
  private recent = new Map<string, ToolActivity>();
  private settled = new Map<string, ToolActivity>();
  private aliases = new Map<string, string>();
  private continuations = new Map<string, string>();
  private closedTurns = new Map<string, number | undefined>();
  private resultSources = new Map<string, "call" | "execution">();
  private lastEnd?: number;
  private overflow = 0;
  private retiredBefore?: number;
  private retiredHistory = false;
  private uncertainStarts = 0;

  reset(): void {
    this.active.clear();
    this.recent.clear();
    this.settled.clear();
    this.aliases.clear();
    this.continuations.clear();
    this.closedTurns.clear();
    this.resultSources.clear();
    this.lastEnd = undefined;
    this.overflow = 0;
    this.retiredBefore = undefined;
    this.retiredHistory = false;
    this.uncertainStarts = 0;
  }

  apply(event: ToolEvent): void {
    const resumed = event.continuationId && this.continuations.get(event.continuationId);
    const id = resumed || this.aliases.get(event.toolId) || event.toolId;
    if (resumed && event.type === "tool-started") this.remember(this.aliases, event.toolId, id);
    const orphan = resumed && id !== event.toolId ? this.settled.get(event.toolId) : undefined;
    if (orphan) {
      const resultSource = this.resultSources.get(event.toolId);
      this.recent.delete(event.toolId);
      this.settled.delete(event.toolId);
      this.resultSources.delete(event.toolId);
      // wait 的结果可能先于带 cell_id 的调用到达，获得关联后补到原始 exec。
      this.apply({ type: `tool-${orphan.status}` as ToolEvent["type"], toolId: id, at: orphan.completedAt,
        durationMs: orphan.durationMs, outputSummary: orphan.outputSummary, error: orphan.error, resultSource, turnId: orphan.turnId });
    }
    const previous = this.active.get(id) ?? this.settled.get(id);
    if (event.resultSource === "call" && this.resultSources.get(id) === "execution") return;
    const strongerResult = event.resultSource === "execution" && this.resultSources.get(id) !== "execution";
    if (event.resultSource) this.remember(this.resultSources, id, event.resultSource);
    const isStart = event.type === "tool-started" || event.type === "tool-updated";
    const terminal = { "tool-completed": "completed", "tool-failed": "failed", "tool-cancelled": "cancelled", "tool-unknown": "unknown" } as const;
    let status: ToolStatus = isStart ? event.status ?? "running" : terminal[event.type as keyof typeof terminal];
    if (event.type === "tool-updated" && event.resultSource === "call" && previous?.type !== "wrapper") status = previous ? "completed" : "unknown";
    if (previous && !activeStatus(previous.status)) {
      if (isStart || (previous.status !== "unknown" && status === "unknown")
        || (!strongerResult && validTime(event.at) && validTime(previous.completedAt) && event.at < previous.completedAt && previous.status !== "unknown")) {
        status = previous.status;
      }
    }
    const ended = event.turnId ? this.closedTurns.has(event.turnId)
      : validTime(event.at) && validTime(this.lastEnd) && event.at < this.lastEnd;
    if (isStart && ended && !previous) status = "unknown";
    const startAt = event.startedAt ?? event.at;
    const retired = !previous && isStart && this.retiredHistory
      && (!validTime(startAt) || (this.retiredBefore !== undefined && startAt <= this.retiredBefore));
    if (retired) { status = "unknown"; this.uncertainStarts++; }
    const clean = (value: string | undefined) => value === undefined ? undefined : redactSummary(value);
    const tool: ToolActivity = { ...previous, id, status, name: previous?.name ?? t("未知工具") };
    if (id === event.toolId) {
      if (event.name) tool.name = clean(event.name)!;
      if (event.toolType) tool.type = clean(event.toolType);
      if (event.inputSummary !== undefined) tool.inputSummary = clean(event.inputSummary);
      if (event.mcp) tool.mcp = { serverId: event.mcp.serverId, serverName: clean(event.mcp.serverName)!, toolName: clean(event.mcp.toolName)!, toolId: event.mcp.toolId };
    }
    if (event.turnId && tool.turnId === undefined) tool.turnId = event.turnId;
    if (event.outputSummary !== undefined) tool.outputSummary = clean(event.outputSummary);
    if (event.error !== undefined) tool.error = clean(event.error);
    else if (status === "completed" && event.type === "tool-completed") tool.error = undefined;
    if (retired) tool.error = t("开始事件已超出有界跟踪窗口，运行状态未确认");
    const start = event.startedAt ?? (event.type === "tool-started" ? event.at : undefined);
    if (validTime(start)) tool.startedAt = Math.min(tool.startedAt ?? start, start);
    if ((!isStart || (event.type === "tool-updated" && status === "completed")) && validTime(event.at)
      && (strongerResult || previous?.completedAt === undefined || status !== previous.status || event.at >= previous.completedAt)) {
      tool.completedAt = event.at;
    }
    if (validTime(event.durationMs)) tool.durationMs = event.durationMs;
    else if (validTime(tool.startedAt) && validTime(tool.completedAt) && tool.completedAt >= tool.startedAt) {
      tool.durationMs = tool.completedAt - tool.startedAt;
    }
    if (activeStatus(tool.status)) {
      this.active.set(id, tool);
      if (event.continuationId) this.remember(this.continuations, event.continuationId, id);
      if (this.active.size > MAX_ACTIVE_TOOLS) {
        const oldest = this.active.values().next().value!;
        this.finish({ ...oldest, status: "unknown", error: t("超过工具跟踪上限，终态未确认") });
        this.overflow++;
      }
    } else this.finish(tool);
  }

  endTurn(turnId: string | undefined, at: number | undefined): void {
    if (turnId) this.remember(this.closedTurns, turnId, at);
    if (validTime(at)) this.lastEnd = Math.max(this.lastEnd ?? 0, at);
    for (const tool of this.active.values()) {
      if (turnId && turnId !== tool.turnId) continue;
      // 轮次终止并不证明后台进程已结束；没有工具级结果时保留未知终态。
      this.finish({ ...tool, status: "unknown", error: t("轮次已结束，工具终态未确认") });
    }
  }

  getState(): { active: ToolActivity[]; recent: ToolActivity[] } {
    return structuredClone({ active: [...this.active.values()], recent: [...this.recent.values()] });
  }

  getOverflowCount(): number { return this.overflow; }
  getUncertainStartCount(): number { return this.uncertainStarts; }

  private finish(tool: ToolActivity): void {
    const previous = this.settled.get(tool.id);
    this.active.delete(tool.id);
    for (const [continuation, id] of this.continuations) if (id === tool.id) this.continuations.delete(continuation);
    if (!this.settled.has(tool.id) && this.settled.size >= MAX_TOOL_IDENTITIES) {
      const retired = this.settled.values().next().value!;
      if (retired.status !== "unknown") {
        this.retiredHistory = true;
        const at = retired.startedAt ?? retired.completedAt;
        if (validTime(at)) this.retiredBefore = Math.max(this.retiredBefore ?? 0, at);
      }
    }
    this.remember(this.settled, tool.id, tool);
    // exec 是执行容器。其返回不等于内层命令成功，也不计作另一条已完成命令。
    if (tool.type === "wrapper") { this.recent.delete(tool.id); return; }
    if (previous && previous.status === tool.status && previous.completedAt === tool.completedAt && this.recent.has(tool.id)) this.recent.set(tool.id, tool);
    else this.recent = new Map([[tool.id, tool], ...[...this.recent].filter(([id]) => id !== tool.id)]);
    this.recent = new Map([...this.recent].sort(([, a], [, b]) =>
      (b.completedAt ?? b.startedAt ?? 0) - (a.completedAt ?? a.startedAt ?? 0)).slice(0, MAX_RECENT_TOOLS));
  }

  private remember<T>(map: Map<string, T>, key: string, value: T): void {
    map.delete(key);
    map.set(key, value);
    if (map.size > MAX_TOOL_IDENTITIES) map.delete(map.keys().next().value!);
  }
}
