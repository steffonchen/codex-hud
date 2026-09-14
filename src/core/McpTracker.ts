import { t } from "../i18n/Messages.js";
import type { McpConfiguration, McpServerState, McpSummary } from "./McpState.js";
import { mcpToolId, type McpToolReference, type McpToolState } from "./McpToolState.js";
import { redactSummary } from "./Redaction.js";

export const MAX_MCP_SERVERS = 128;
export const MAX_MCP_TOOLS = 1024;

const cleanServer = (server: McpServerState): McpServerState => ({
  id: server.id, name: redactSummary(server.name, 100), status: server.status, configured: server.configured,
  runtimeObserved: server.runtimeObserved, transport: server.transport, toolCount: server.toolCount,
  lastUpdatedAt: server.lastUpdatedAt, lastObservedAt: server.lastObservedAt, error: server.error && redactSummary(server.error),
});

const latest = (a?: number, b?: number): number | undefined => a === undefined ? b : b === undefined ? a : Math.max(a, b);
const explicitStatus = (server: McpServerState): boolean => !["unknown", "configured"].includes(server.status);

function mergeServer(previous: McpServerState, incoming: McpServerState): McpServerState {
  const incomingStatus = explicitStatus(incoming), previousStatus = explicitStatus(previous);
  const newer = incomingStatus !== previousStatus ? incomingStatus : (incoming.lastUpdatedAt ?? 0) >= (previous.lastUpdatedAt ?? 0);
  const selected = newer ? incoming : previous, other = newer ? previous : incoming;
  return { ...selected, configured: previous.configured || incoming.configured,
    runtimeObserved: previous.runtimeObserved || incoming.runtimeObserved,
    transport: selected.transport ?? other.transport, toolCount: selected.toolCount ?? other.toolCount,
    lastObservedAt: latest(previous.lastObservedAt, incoming.lastObservedAt) };
}

export class McpTracker {
  private configuration?: McpConfiguration;
  private servers = new Map<string, McpServerState>();
  private tools = new Map<string, McpToolState>();
  private threads = new Map<string, McpSummary>();
  private limited = false;

  reset(): void {
    this.configuration = undefined;
    this.servers.clear(); this.tools.clear(); this.threads.clear(); this.limited = false;
  }

  replaceConfiguration(configuration: McpConfiguration): void {
    this.configuration = { status: configuration.status, servers: configuration.servers.slice(0, MAX_MCP_SERVERS).map(cleanServer) };
    if (configuration.servers.length > MAX_MCP_SERVERS) this.limited = true;
  }

  observeTool(reference: McpToolReference, at?: number): void {
    const previous = this.servers.get(reference.serverId);
    if (!previous && this.servers.size >= MAX_MCP_SERVERS) { this.limited = true; return; }
    // 调用观察与服务生命周期各自保留时间，乱序调用不能覆盖明确连接状态。
    this.servers.set(reference.serverId, cleanServer({ ...previous, id: reference.serverId, name: reference.serverName,
      configured: previous?.configured ?? false, status: previous?.status ?? "unknown", runtimeObserved: true,
      lastObservedAt: latest(previous?.lastObservedAt, at) }));
    const id = reference.toolId ?? mcpToolId(reference.serverId, reference.toolName);
    if (!this.tools.has(id)) this.updateTool({ id, serverId: reference.serverId, name: reference.toolName, discovery: "observed-call" });
  }

  // 此入口只接受已归一化的明确服务状态，普通调用结果不会进入它来改变连接状态。
  updateServer(server: McpServerState): void {
    const previous = this.servers.get(server.id);
    if (previous?.lastUpdatedAt !== undefined && server.lastUpdatedAt !== undefined && server.lastUpdatedAt < previous.lastUpdatedAt) return;
    if (!previous && this.servers.size >= MAX_MCP_SERVERS) { this.limited = true; return; }
    this.servers.set(server.id, cleanServer({ ...server, runtimeObserved: server.runtimeObserved || previous?.runtimeObserved,
      lastObservedAt: latest(previous?.lastObservedAt, server.lastObservedAt) }));
  }

  updateTool(tool: McpToolState): void {
    if (!this.tools.has(tool.id) && this.tools.size >= MAX_MCP_TOOLS) { this.limited = true; return; }
    this.tools.set(tool.id, { id: tool.id, serverId: tool.serverId, name: redactSummary(tool.name, 120),
      description: tool.description && redactSummary(tool.description), enabled: tool.enabled,
      available: tool.available, discovery: tool.discovery });
  }

  replaceThread(id: string, summary?: McpSummary): void {
    if (!summary) { this.threads.delete(id); return; }
    if (!this.threads.has(id) && this.threads.size >= 256) { this.limited = true; return; }
    this.threads.set(id, structuredClone(summary));
  }

  getSummary(): McpSummary | undefined {
    if (!this.configuration && !this.servers.size && !this.threads.size) return undefined;
    // 配置清单先占位，运行观察达到上限时也不能挤掉用户明确配置的服务。
    const servers = new Map<string, McpServerState>((this.configuration?.servers ?? []).map(server => [server.id, { ...server }]));
    const tools = new Map<string, McpToolState>();
    let limited = this.limited;
    for (const source of [this.servers.values(), ...[...this.threads.values()].map(thread => thread.servers.values())]) {
      for (const server of source) {
        const previous = servers.get(server.id);
        if (!previous && servers.size >= MAX_MCP_SERVERS) { limited = true; continue; }
        servers.set(server.id, previous ? mergeServer(previous, server) : { ...server });
      }
    }
    for (const source of [this.tools.values(), ...[...this.threads.values()].map(thread => thread.tools.values())]) {
      for (const tool of source) {
        if (!servers.has(tool.serverId)) continue;
        if (!tools.has(tool.id) && tools.size >= MAX_MCP_TOOLS) { limited = true; continue; }
        if (tools.get(tool.id)?.discovery !== "runtime-catalog") tools.set(tool.id, { ...tool });
      }
    }
    for (const configured of this.configuration?.servers ?? []) {
      const runtime = servers.get(configured.id);
      servers.set(configured.id, { ...configured, ...runtime, configured: true, transport: configured.transport ?? runtime?.transport,
        status: configured.status === "disabled" ? "disabled" : runtime?.status === "unknown" || !runtime ? "configured" : runtime.status });
    }
    const counts = new Map<string, number>();
    for (const tool of tools.values()) if (tool.discovery === "observed-call") counts.set(tool.serverId, (counts.get(tool.serverId) ?? 0) + 1);
    const list = [...servers.values()].sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id))
      .map(server => ({ ...server, observedToolCount: counts.get(server.id) || undefined }));
    const runtimeStatus = list.some(server => ["starting", "connected", "ready", "failed"].includes(server.status));
    const times = list.flatMap(server => { const at = latest(server.lastUpdatedAt, server.lastObservedAt); return at === undefined ? [] : [at]; });
    return { enabled: true, configurationStatus: this.configuration?.status ?? "missing",
      serverCount: list.length, configuredCount: list.filter(server => server.configured).length,
      runtimeCount: list.filter(server => server.runtimeObserved).length, readyCount: list.filter(server => server.status === "ready").length,
      failedCount: list.filter(server => server.status === "failed").length, disabledCount: list.filter(server => server.status === "disabled").length,
      servers: list, tools: [...tools.values()].sort((a, b) => a.id.localeCompare(b.id)),
      capability: { configured: !!this.configuration?.servers.length, runtimeDiscovery: list.some(server => server.runtimeObserved),
        serverStatus: runtimeStatus, toolDiscovery: [...tools.values()].some(tool => tool.discovery === "runtime-catalog"),
        resourceDiscovery: false, promptDiscovery: false },
      issues: limited || [...this.threads.values()].some(thread => thread.issues.length) ? [t("MCP 发现达到安全上限，清单不完整")] : [],
      lastUpdatedAt: times.length ? Math.max(...times) : undefined };
  }
}
