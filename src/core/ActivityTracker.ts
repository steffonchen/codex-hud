import { t } from "../i18n/Messages.js";
import type { ActivityState, ToolActivity } from "./HudState.js";
import type { HudEvent } from "./HudEvent.js";

const toolPriority: Record<string, number> = { mcp: 5, shell: 4, edit: 3, search: 2, read: 1 };

export function selectActiveTool(tools: readonly ToolActivity[] = []): ToolActivity | undefined {
  return tools.filter(tool => tool.status === "running" || tool.status === "pending").sort((a, b) =>
    Number(b.status === "running") - Number(a.status === "running")
    || (toolPriority[b.type ?? ""] ?? 0) - (toolPriority[a.type ?? ""] ?? 0)
    || (b.startedAt ?? 0) - (a.startedAt ?? 0) || a.id.localeCompare(b.id))[0];
}

export function toolActivity(tool: ToolActivity): ActivityState {
  const running = tool.status === "running";
  const labels: Record<string, string> = { shell: t("执行中"), search: t("搜索中"), read: t("读取中"), edit: t("编辑中"), wrapper: t("执行工具") };
  const label = running ? labels[tool.type ?? ""] ?? t("运行中") : tool.status === "pending" ? t("等待执行")
    : tool.status === "failed" ? t("执行失败") : tool.status === "cancelled" ? t("已取消") : tool.status === "unknown" ? t("状态未确认") : t("已完成");
  return { status: running ? "running" : tool.status === "pending" ? "waiting" : tool.status === "unknown" ? "unknown" : "completed",
    label, description: tool.inputSummary ?? tool.description ?? tool.name, startedAt: tool.startedAt,
    completedAt: tool.completedAt, durationMs: tool.durationMs, toolId: tool.id, toolType: tool.type, toolStatus: tool.status,
    mcp: tool.mcp && { ...tool.mcp } };
}

export class ActivityTracker {
  private turn?: { id?: string; at?: number; endedAt?: number; status: "running" | "idle" };

  reset(): void { this.turn = undefined; }

  apply(event: HudEvent): void {
    if (event.type === "turn-started") {
      if (this.turn?.id && this.turn.id === event.id) return;
      if (event.at !== undefined && this.turn?.at !== undefined && event.at < this.turn.at) return;
      this.turn = { id: event.id, at: event.at, status: "running" };
    } else if (event.type === "turn-completed" || event.type === "turn-aborted") {
      if (event.id && this.turn?.id && event.id !== this.turn.id) return;
      this.turn = { ...this.turn, id: event.id ?? this.turn?.id, endedAt: event.at, status: "idle" };
    }
  }

  getState(tools: { active: ToolActivity[]; recent: ToolActivity[] }): ActivityState | undefined {
    const active = selectActiveTool(tools.active);
    if (active) return toolActivity(active);
    if (this.turn?.status === "idle") return { status: "idle" };
    const recent = tools.recent.find(tool => (!this.turn?.id || !tool.turnId || tool.turnId === this.turn.id)
      && (this.turn?.at === undefined || (tool.completedAt ?? tool.startedAt ?? 0) >= this.turn.at));
    if (recent) return toolActivity(recent);
    if (this.turn?.status === "running") return { status: "running", label: t("处理中"), startedAt: this.turn.at };
    return undefined;
  }
}
