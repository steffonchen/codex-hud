import type { McpToolState } from "./McpToolState.js";

export type McpServerStatus = "configured" | "starting" | "connected" | "ready" | "failed" | "disabled" | "unknown";

export interface McpServerState {
  id: string;
  name: string;
  status: McpServerStatus;
  configured: boolean;
  runtimeObserved?: boolean;
  transport?: "stdio";
  toolCount?: number;
  observedToolCount?: number;
  // 明确服务状态与调用观察分开计时，防止跨线程或乱序合并改变连接状态。
  lastUpdatedAt?: number;
  lastObservedAt?: number;
  error?: string;
}

export interface McpCapability {
  configured: boolean;
  runtimeDiscovery: boolean;
  serverStatus: boolean;
  toolDiscovery: boolean;
  resourceDiscovery: boolean;
  promptDiscovery: boolean;
}

export interface McpConfiguration {
  status: "ready" | "missing" | "error";
  servers: McpServerState[];
}

export interface McpSummary {
  enabled: boolean;
  configurationStatus: McpConfiguration["status"];
  serverCount: number;
  configuredCount: number;
  runtimeCount: number;
  readyCount: number;
  failedCount: number;
  disabledCount: number;
  servers: McpServerState[];
  tools: McpToolState[];
  capability: McpCapability;
  issues: string[];
  lastUpdatedAt?: number;
}
