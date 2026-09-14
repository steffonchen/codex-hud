import { t } from "../../i18n/Messages.js";
import type { HudModule } from "./HudModule.js";
import { toolCounts } from "./helpers.js";
import { plainText, WidthPolicy } from "../WidthPolicy.js";
import { formatToolSummary } from "../Formatter.js";
import { selectActiveTool } from "../../core/ActivityTracker.js";

export const toolsModule: HudModule = {
  id: "tools", get label() { return t("工具"); }, get category() { return t("活动"); }, defaultEnabled: true, priority: 75,
  isAvailable: state => !!selectActiveTool(state.tools?.active) || !!state.tools?.recent?.length || toolCounts(state).some(([, count]) => count > 0),
  render(state, { density, width, now, currentActivityToolId }) {
    const counts = toolCounts(state);
    const active = (state.tools?.active ?? []).filter(tool => (tool.status === "running" || tool.status === "pending") && tool.id !== currentActivityToolId);
    const recent = (state.tools?.recent ?? []).filter(tool => tool.id !== currentActivityToolId);
    const current = selectActiveTool(active);
    const entries = current ? [current, ...active.filter(tool => tool.id !== current.id)] : recent;
    if (!entries.length) {
      if (currentActivityToolId && !counts.some(([, count]) => count > 0)) return "";
      return density === "full" ? t("工具\n{0}", counts.map(([name, count]) => `${plainText(name)}×${count}`).join(" · "))
        : t("工具 {0}", counts.reduce((total, [, count]) => total + count, 0));
    }
    const heading = active.length ? t("工具 {0} 个活动", active.length) : t("最近工具");
    if (density === "minimal" && active.length) return width < 20 ? t("{0} 个工具", active.length) : heading;
    if (density === "minimal") {
      const policy = new WidthPolicy();
      const available = width - policy.measure(t("工具 {0}", ""));
      return policy.fitLine(t("工具 {0}", formatToolSummary(entries[0], available, { now, duration: false })), width);
    }
    const lines = entries.slice(0, density === "full" ? 3 : 1).map(tool => formatToolSummary(tool, width, { now }));
    return [heading, ...lines].join("\n");
  },
};
