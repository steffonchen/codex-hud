import { t } from "../i18n/Messages.js";
import { currentLanguage } from "../i18n/Language.js";
import type { ToolActivity } from "../core/HudState.js";
import { redactSummary } from "../core/Redaction.js";
import { WidthPolicy } from "./WidthPolicy.js";

export function formatTokens(value?: number): string {
  if (value === undefined || !Number.isFinite(value)) return "—";
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  if (value >= 1_000) return `${Math.round(value / 1_000)}K`;
  return String(value);
}

export function formatDetailedTokens(value?: number): string {
  if (value === undefined || !Number.isFinite(value)) return "—";
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}K`;
  return String(value);
}

export function formatQuotaReset(unixSeconds: number, now: number): string {
  const remaining = unixSeconds * 1000 - now;
  if (remaining <= 0) return t("重置时间已到，待更新");
  const minutes = Math.ceil(remaining / 60_000);
  const days = Math.floor(minutes / 1440), hours = Math.floor(minutes % 1440 / 60);
  return t("{0} 后重置", days ? `${days}d${hours}h` : hours ? `${hours}h${minutes % 60}m` : `${minutes}m`);
}

export function formatPercent(value?: number): string {
  return value === undefined ? "—" : `${Math.round(value)}%`;
}

export function formatDuration(ms?: number): string {
  if (ms === undefined || !Number.isFinite(ms) || ms < 0) return "—";
  const totalSeconds = Math.floor(ms / 1000);
  const h = Math.floor(totalSeconds / 3600);
  const m = Math.floor((totalSeconds % 3600) / 60);
  const s = totalSeconds % 60;
  if (h) return `${h}h ${m}m ${s}s`;
  if (m) return `${m}m ${s}s`;
  return `${s}s`;
}

export function toolDuration(tool: ToolActivity, now = Date.now()): number | undefined {
  if (tool.status === "running" || tool.status === "pending") {
    return tool.startedAt !== undefined && Number.isFinite(tool.startedAt) ? Math.max(0, now - tool.startedAt) : undefined;
  }
  if (tool.durationMs !== undefined && Number.isFinite(tool.durationMs) && tool.durationMs >= 0) return tool.durationMs;
  return tool.completedAt !== undefined && tool.startedAt !== undefined && tool.completedAt >= tool.startedAt
    ? tool.completedAt - tool.startedAt : undefined;
}

export function formatToolSummary(tool: ToolActivity, width: number, options: { now?: number; duration?: boolean; label?: string } = {}): string {
  const policy = new WidthPolicy();
  const icons: Record<string, string> = { shell: "⚙", wrapper: "⚙", search: "🔍", read: "📖", edit: "✎" };
  const icon = tool.status === "completed" ? "✓" : tool.status === "failed" ? "✗" : tool.status === "cancelled" ? "⊘"
    : tool.status === "unknown" ? "?" : tool.status === "pending" ? "◷" : icons[tool.type ?? ""] ?? "⚙";
  const detail = redactSummary(tool.mcp ? `MCP ${tool.mcp.serverName}.${tool.mcp.toolName}` : tool.inputSummary ?? tool.description ?? tool.name);
  const prefix = `${icon} ${options.label ? `${redactSummary(options.label)} ` : ""}`;
  const duration = toolDuration(tool, options.now);
  const suffix = options.duration !== false && duration !== undefined && Number.isFinite(duration) ? ` · ${formatDuration(duration)}` : "";
  const available = width - policy.measure(prefix) - policy.measure(suffix);
  if (available < 4) return policy.fitLine(`${prefix}${detail}`, width);
  return policy.fitLine(`${prefix}${policy.fitLine(detail, available)}${suffix}`, width);
}

export function formatReset(unixSeconds?: number): string {
  if (!unixSeconds) return "—";
  return new Date(unixSeconds * 1000).toLocaleTimeString(currentLanguage(), {
    hour: "2-digit",
    minute: "2-digit",
  });
}
