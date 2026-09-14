import { createHash } from "node:crypto";

export interface McpToolReference {
  serverId: string;
  serverName: string;
  toolName: string;
  toolId?: string;
}

export interface McpToolState {
  id: string;
  serverId: string;
  name: string;
  description?: string;
  enabled?: boolean;
  available?: boolean;
  discovery: "observed-call" | "runtime-catalog";
}

export const mcpServerId = (name: string): string => `mcp-${createHash("sha256").update(name).digest("hex").slice(0, 24)}`;
export const mcpToolId = (serverId: string, name: string): string =>
  `tool-${createHash("sha256").update(JSON.stringify([serverId, name])).digest("hex").slice(0, 24)}`;
