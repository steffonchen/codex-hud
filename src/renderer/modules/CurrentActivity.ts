import { t } from "../../i18n/Messages.js";
import type { HudModule } from "./HudModule.js";
import { selectActiveTool, toolActivity } from "../../core/ActivityTracker.js";
import { formatToolSummary } from "../Formatter.js";

export const currentActivityModule: HudModule = {
  id: "current-activity", get label() { return t("当前活动"); }, get category() { return t("活动"); }, defaultEnabled: false, priority: 82,
  isAvailable: state => state.activity?.status !== "idle" && (!!selectActiveTool(state.tools?.active)
    || !!state.activity && (state.activity.status !== "unknown" || !!state.activity.toolId)),
  render(state, { density, width, now }) {
    if (state.activity?.status === "idle") return "";
    const active = selectActiveTool(state.tools?.active);
    const activity = active ? toolActivity(active) : state.activity;
    if (!activity) return "";
    const label = activity.label ?? (activity.status === "waiting" ? t("等待输入") : activity.status === "completed" ? t("已完成") : activity.status === "unknown" ? t("状态未确认") : t("运行中"));
    const line = formatToolSummary({ id: activity.toolId ?? "activity", name: activity.description ?? label,
      status: activity.toolStatus ?? (activity.status === "waiting" ? "pending" : activity.status === "completed" ? "completed" : activity.status === "unknown" ? "unknown" : "running"),
      type: activity.toolType, mcp: activity.mcp, startedAt: activity.startedAt, completedAt: activity.completedAt, durationMs: activity.durationMs }, width,
    { now, duration: density !== "minimal", label: density === "full" && activity.description ? label : undefined });
    return density === "full" ? t("当前活动\n{0}", line) : line;
  },
};
