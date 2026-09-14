import { describe, expect, it } from "vitest";
import { MAX_MCP_SERVERS, MAX_MCP_TOOLS, McpTracker } from "../src/core/McpTracker.js";
import { mcpServerId, mcpToolId } from "../src/core/McpToolState.js";
import { parseMcpConfiguration } from "../src/providers/codex/McpDiscovery.js";
import { capabilityFixture } from "./capabilities.js";

const ref = (server = "a", tool = "read") => ({ serverId: mcpServerId(server), serverName: server, toolName: tool });

describe("MCP Tracker", () => {
  it("相同服务与工具重复观察保持一份", () => {
    const tracker = new McpTracker();
    tracker.observeTool(ref(), 10); tracker.observeTool(ref(), 20);
    expect(tracker.getSummary()).toMatchObject({ serverCount: 1, lastUpdatedAt: 20, tools: [{ name: "read", discovery: "observed-call" }] });
    expect(tracker.getSummary()?.tools).toHaveLength(1);
  });
  it("已观测数量不填充完整 toolCount 或 available", () => {
    const tracker = new McpTracker(); tracker.observeTool(ref()); tracker.observeTool(ref("a", "write"));
    expect(tracker.getSummary()?.servers[0]).toMatchObject({ observedToolCount: 2 });
    expect(tracker.getSummary()?.servers[0].toolCount).toBeUndefined();
    expect(tracker.getSummary()?.tools.every(tool => tool.available === undefined)).toBe(true);
  });
  it("同名工具在不同服务下保持独立", () => {
    const tracker = new McpTracker(); tracker.observeTool(ref()); tracker.observeTool(ref("b"));
    expect(tracker.getSummary()).toMatchObject({ serverCount: 2 }); expect(tracker.getSummary()?.tools).toHaveLength(2);
  });
  it("配置 A 替换为 B 不累积旧服务", () => {
    const tracker = new McpTracker();
    tracker.replaceConfiguration({ status: "ready", servers: parseMcpConfiguration('[mcp_servers.a]') });
    tracker.replaceConfiguration({ status: "ready", servers: parseMcpConfiguration('[mcp_servers.b]') });
    expect(tracker.getSummary()?.servers.map(server => server.name)).toEqual(["b"]);
  });
  it("配置失败清除旧配置，不假装服务器失败", () => {
    const tracker = new McpTracker(); tracker.replaceConfiguration({ status: "ready", servers: parseMcpConfiguration('[mcp_servers.a]') });
    tracker.replaceConfiguration({ status: "error", servers: [] });
    expect(tracker.getSummary()).toMatchObject({ serverCount: 0, failedCount: 0, configurationStatus: "error" });
  });
  it("全局配置和运行观察按服务身份合并", async () => {
    const tracker = new McpTracker(); tracker.observeTool(ref("node_repl"));
    tracker.replaceConfiguration({ status: "ready", servers: parseMcpConfiguration(await capabilityFixture("mcp", "multiple-servers.toml")) });
    expect(tracker.getSummary()).toMatchObject({ serverCount: 2, configuredCount: 2, runtimeCount: 1, disabledCount: 1 });
    expect(tracker.getSummary()?.servers.find(server => server.name === "node_repl")?.status).toBe("configured");
  });
  it("观察到调用不重写明确服务终态", () => {
    const tracker = new McpTracker();
    tracker.updateServer({ id: ref().serverId, name: "a", configured: false, status: "failed", lastUpdatedAt: 20 });
    tracker.observeTool(ref(), 30);
    expect(tracker.getSummary()?.servers[0].status).toBe("failed");
    expect(tracker.getSummary()?.capability.serverStatus).toBe(true);
  });
  it("较旧的服务更新不会覆盖新状态", () => {
    const tracker = new McpTracker();
    tracker.updateServer({ id: "a", name: "a", configured: false, status: "ready", lastUpdatedAt: 20 });
    tracker.updateServer({ id: "a", name: "a", configured: false, status: "starting", lastUpdatedAt: 10 });
    expect(tracker.getSummary()?.readyCount).toBe(1);
  });
  it("较新的调用不会阻挡乱序到达的明确生命周期", () => {
    const tracker = new McpTracker(), id = ref().serverId;
    tracker.updateServer({ id, name: "a", configured: false, status: "ready", lastUpdatedAt: 10 });
    tracker.observeTool(ref(), 30);
    tracker.updateServer({ id, name: "a", configured: false, status: "failed", lastUpdatedAt: 20 });
    expect(tracker.getSummary()?.servers[0]).toMatchObject({ status: "failed", lastUpdatedAt: 20, lastObservedAt: 30, runtimeObserved: true });
    expect(tracker.getSummary()?.lastUpdatedAt).toBe(30);
  });
  it.each([true, false])("跨线程调用不会清除明确服务失败，主线程状态=%s", rootStatus => {
    const root = new McpTracker(), child = new McpTracker();
    (rootStatus ? root : child).updateServer({ id: ref().serverId, name: "a", configured: false, status: "failed", lastUpdatedAt: 20 });
    (rootStatus ? child : root).observeTool(ref(), 30); root.replaceThread("child", child.getSummary());
    expect(root.getSummary()?.servers[0]).toMatchObject({ status: "failed", lastUpdatedAt: 20, lastObservedAt: 30, runtimeObserved: true });
  });
  it("明确工具目录不依赖调用或服务就绪", () => {
    const tracker = new McpTracker(), serverId = ref().serverId;
    tracker.replaceConfiguration({ status: "ready", servers: parseMcpConfiguration('[mcp_servers.a]') });
    tracker.updateTool({ id: mcpToolId(serverId, "read"), serverId, name: "read", discovery: "runtime-catalog", available: true });
    expect(tracker.getSummary()).toMatchObject({ readyCount: 0, tools: [{ name: "read", discovery: "runtime-catalog" }], capability: { toolDiscovery: true } });
    expect(tracker.getSummary()?.servers[0].toolCount).toBeUndefined();
  });
  it("达到运行服务上限时仍保留明确配置，截断可见", () => {
    const tracker = new McpTracker();
    for (let index = 0; index < MAX_MCP_SERVERS; index++) tracker.observeTool(ref(`runtime-${index}`));
    tracker.replaceConfiguration({ status: "ready", servers: parseMcpConfiguration('[mcp_servers.configured]') });
    expect(tracker.getSummary()).toMatchObject({ serverCount: MAX_MCP_SERVERS, configuredCount: 1 });
    expect(tracker.getSummary()?.servers.some(server => server.name === "configured")).toBe(true);
    expect(tracker.getSummary()?.issues.length).toBeGreaterThan(0);
  });
  it("线程快照去重，移除一个线程不影响兄弟", () => {
    const root = new McpTracker(), a = new McpTracker(), b = new McpTracker(); a.observeTool(ref()); b.observeTool(ref("b"));
    root.replaceThread("a", a.getSummary()); root.replaceThread("a", a.getSummary()); root.replaceThread("b", b.getSummary());
    expect(root.getSummary()?.serverCount).toBe(2); root.replaceThread("a");
    expect(root.getSummary()?.servers.map(server => server.name)).toEqual(["b"]);
  });
  it("reset 清除会话观察，重新应用全局配置", () => {
    const tracker = new McpTracker(); tracker.observeTool(ref()); tracker.reset();
    expect(tracker.getSummary()).toBeUndefined();
    tracker.replaceConfiguration({ status: "ready", servers: [] });
    expect(tracker.getSummary()?.serverCount).toBe(0);
  });
  it("没有来源就不声明 resources/prompts 发现", () => {
    const tracker = new McpTracker(); tracker.observeTool(ref());
    expect(tracker.getSummary()?.capability).toMatchObject({ resourceDiscovery: false, promptDiscovery: false, toolDiscovery: false });
  });
  it("服务和工具达到上限时保持可观察且有界", () => {
    const tracker = new McpTracker();
    for (let i = 0; i < MAX_MCP_SERVERS + 10; i++) tracker.observeTool(ref(`server-${i}`));
    for (let i = 0; i < MAX_MCP_TOOLS + 10; i++) tracker.observeTool(ref("server-0", `tool-${i}`));
    expect(tracker.getSummary()?.serverCount).toBe(MAX_MCP_SERVERS);
    expect(tracker.getSummary()!.tools.length).toBeLessThanOrEqual(MAX_MCP_TOOLS);
    expect(tracker.getSummary()?.issues.length).toBeGreaterThan(0);
  });
  it("快照与输入不能回写内部状态", () => {
    const tracker = new McpTracker(); const reference = ref(); tracker.observeTool(reference); reference.serverName = "changed";
    tracker.getSummary()!.servers[0].name = "changed";
    expect(tracker.getSummary()!.servers[0].name).toBe("a");
  });
});
