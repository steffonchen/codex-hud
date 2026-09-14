import { t } from "../../i18n/Messages.js";
import type { HudModule } from "./HudModule.js";
import { WidthPolicy } from "../WidthPolicy.js";
import { redactSummary } from "../../core/Redaction.js";
import type { McpServerStatus } from "../../core/McpState.js";
import { knownNumber } from "./helpers.js";

const labels: Record<McpServerStatus, string> = { get configured() { return t("已配置"); }, get starting() { return t("启动中"); }, get connected() { return t("已连接"); }, get ready() { return t("就绪"); }, get failed() { return t("失败"); }, get disabled() { return t("已禁用"); }, get unknown() { return t("状态未知"); } };
const icons: Record<McpServerStatus, string> = { configured: "○", starting: "◷", connected: "●", ready: "●", failed: "✗", disabled: "⊘", unknown: "?" };
const priority: Record<McpServerStatus, number> = { failed: 0, starting: 1, ready: 2, connected: 2, unknown: 3, configured: 4, disabled: 5 };

export const mcpModule: HudModule = {
  id: "mcp", label: "MCP", get category() { return t("高级"); }, defaultEnabled: false, priority: 40,
  isAvailable: state => state.mcpSummary ? state.mcpSummary.enabled && (state.mcpSummary.serverCount > 0 || state.mcpSummary.configurationStatus !== "missing") : !!state.mcp?.length,
  render(state, { density, width, maxRows }) {
    const summary = state.mcpSummary;
    if (!summary) {
      const servers = state.mcp ?? [];
      if (density !== "full") return `MCP ${servers.filter(server => server.status === "connected").length}/${servers.length}`;
      return ["MCP", ...servers.map(server => `${redactSummary(server.name, 100)} · ${server.status === "connecting" ? t("连接中") : labels[server.status]}${knownNumber(server.toolCount) ? t(" · {0} 个工具", server.toolCount) : ""}`)].join("\n");
    }
    const policy = new WidthPolicy();
    const alert = summary.failedCount ? ` ✗${summary.failedCount}` : "";
    if (!summary.serverCount && summary.configurationStatus === "error") return policy.fitLine(t("MCP 配置不可读"), width);
    if (density === "minimal" || (maxRows ?? 2) < 2) {
      return policy.fitLine(width < 20 ? `M:${summary.serverCount}${summary.failedCount ? " !" : ""}`
        : `MCP ${summary.serverCount}${summary.readyCount ? ` ●${summary.readyCount}` : ""}${alert}${summary.disabledCount ? ` ⊘${summary.disabledCount}` : ""}`, width);
    }
    const servers = [...summary.servers].sort((a, b) => priority[a.status] - priority[b.status] || a.name.localeCompare(b.name));
    const limit = Math.max(0, Math.min(density === "full" ? 5 : 2, (maxRows ?? 7) - 2));
    const rows = servers.slice(0, limit).map(server => {
      const count = knownNumber(server.toolCount) ? density === "full" ? t(" {0} 个工具", server.toolCount) : ` ${server.toolCount}`
        : server.observedToolCount ? t(" 观测{0}", server.observedToolCount) : "";
      return policy.fitLine(`${icons[server.status]} ${redactSummary(server.name, 100)} ${labels[server.status]}${count}`, width);
    });
    return [`MCP ${summary.serverCount}${alert}`, ...rows, ...(servers.length > limit ? [t("… 另 {0} 个服务", servers.length - limit)] : [])].join("\n");
  },
};
