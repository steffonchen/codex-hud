import { t } from "../../i18n/Messages.js";
import { parse } from "smol-toml";
import type { McpConfiguration, McpServerState } from "../../core/McpState.js";
import { mcpServerId } from "../../core/McpToolState.js";
import { redactSummary } from "../../core/Redaction.js";
import { MAX_MCP_SERVERS } from "../../core/McpTracker.js";
import { DiscoveryFormatError } from "./DiscoveryFiles.js";
import { record } from "./Diagnostics.js";

export function parseMcpConfiguration(text: string): McpServerState[] {
  let config: Record<string, unknown>;
  try { config = parse(text); }
  catch { throw new DiscoveryFormatError(t("Codex 配置不是有效 TOML；原文已省略")); }
  if (config.mcp_servers === undefined) return [];
  const servers = record(config.mcp_servers);
  if (!servers) throw new DiscoveryFormatError(t("mcp_servers 必须是配置表"));
  if (Object.keys(servers).length > MAX_MCP_SERVERS) throw new DiscoveryFormatError(t("MCP 配置超过服务器安全上限"));
  return Object.entries(servers).map(([name, raw]) => {
    const server = record(raw);
    if (!name.trim() || name.length > 512 || !server || (server.enabled !== undefined && typeof server.enabled !== "boolean")) {
      throw new DiscoveryFormatError(t("MCP 服务名称、配置表或 enabled 字段无效"));
    }
    return { id: mcpServerId(name), name: redactSummary(name, 100), configured: true,
      status: server.enabled === false ? "disabled" : "configured",
      transport: typeof server.command === "string" ? "stdio" : undefined };
  });
}

export const missingMcpConfiguration = (): McpConfiguration => ({ status: "missing", servers: [] });
