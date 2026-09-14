import { mcpServerId, mcpToolId, type McpToolReference } from "../../core/McpToolState.js";
import { redactSummary } from "../../core/Redaction.js";

export class McpEventParser {
  parse(item: Record<string, unknown>): McpToolReference | undefined {
    if (item.type !== "McpToolCall") return undefined;
    const valid = (value: unknown): value is string => typeof value === "string" && value.trim().length > 0 && value.length <= 512;
    if (!valid(item.server) || !valid(item.tool)) return undefined;
    const serverId = mcpServerId(item.server);
    return { serverId, serverName: redactSummary(item.server, 100), toolName: redactSummary(item.tool, 120), toolId: mcpToolId(serverId, item.tool) };
  }
}
