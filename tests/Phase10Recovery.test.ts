import { afterEach, describe, expect, it, vi } from "vitest";
import { AppServerSource } from "../src/providers/codex/app-server/AppServerSource.js";
import { AppServerError } from "../src/providers/codex/app-server/AppServerProtocol.js";
import { RuntimeConnectionManager } from "../src/providers/codex/runtime/RuntimeConnectionManager.js";
import { HudStateReducer } from "../src/core/HudStateReducer.js";
import { RolloutAgentProvider } from "../src/providers/codex/RolloutAgentProvider.js";
import { flattenAgentTree } from "../src/core/AgentTree.js";
import { FakeAppServer, thread, turn } from "./app-server/helpers.js";
import { RuntimeClient, makeHome, cleanupRuntimeFixtures, codexRuntime, discovery, deferred } from "./runtime-authority/helpers.js";

const sources: AppServerSource[] = [];
afterEach(async () => { await Promise.all(sources.splice(0).map(source => source.stop())); await cleanupRuntimeFixtures(); });
function source(clients: FakeAppServer[], options: { now?: () => number; staleThresholdMs?: number; healthTimeoutMs?: number } = {}) {
  const createClient = vi.fn(() => clients.shift()!);
  const instance = new AppServerSource({ createClient, reconnectDelayMs: 5, maxReconnectAttempts: 3, ...options });
  sources.push(instance);
  return { source: instance, createClient };
}

describe("Phase 10：断线、清理失败与代际隔离", () => {
  it("账户请求未结束即断线，重试预算不能被旧 connect 清零", async () => {
    const home = await makeHome(), client = new RuntimeClient(home);
    client.respond = method => {
      if (method === "account/read") {
        queueMicrotask(() => client.disconnect());
        throw new AppServerError("transport", "closed-during-account");
      }
    };
    const createClient = vi.fn(() => client);
    const manager = new RuntimeConnectionManager({ runtime: codexRuntime(home), discovery: { discover: async () => discovery() }, createClient });
    const instance = new AppServerSource({ connectionManager: manager, reconnectDelayMs: 5, maxReconnectAttempts: 3 }); sources.push(instance);
    await instance.selectThread("thread-a"); await instance.start();
    await vi.waitFor(() => expect(manager.getState().reconnectExhausted).toBe(true));
    expect(createClient).toHaveBeenCalledTimes(3);
    expect(instance.getResourceCounts().reconnectTimers).toBe(0);
    expect(manager.getState().reconnectAttempts).toBe(3);
  });

  it("A 历史迟到失败不把已切换的 B 标成 partial", async () => {
    const client = new FakeAppServer(), history = deferred<unknown>(), h = source([client]);
    client.threads.set("thread-b", thread("thread-b")); client.turns.set("thread-b", [turn("turn-b")]); client.loaded.add("thread-b");
    client.override = (method, params) => method === "thread/turns/list" && params.threadId === "thread-a" ? history.promise : undefined;
    await h.source.selectThread("thread-a"); const starting = h.source.start();
    await vi.waitFor(() => expect(client.request.mock.calls.some(([method]) => method === "thread/turns/list")).toBe(true));
    const switching = h.source.selectThread("thread-b");
    history.reject(new AppServerError("request", "old-history-failed")); await Promise.all([starting, switching]);
    expect(h.source.getStatus()).toMatchObject({ threadId: "thread-b", history: "ready", live: true });
  });

  it("长时间 idle 只做一次有界只读探测，响应正常不重连", async () => {
    let now = 0;
    const client = new FakeAppServer(), h = source([client], { now: () => now, staleThresholdMs: 100, healthTimeoutMs: 20 });
    await h.source.selectThread("thread-a"); await h.source.start();
    client.request.mockClear(); now = 101;
    const a = h.source.checkHealth(), b = h.source.checkHealth(); expect(a).toBe(b); await a;
    await h.source.checkHealth();
    expect(client.request).toHaveBeenCalledExactlyOnceWith("thread/read", { threadId: "thread-a", includeTurns: false });
    expect(h.source.getStatus()).toMatchObject({ state: "connected", live: true, lastCheckedAt: 101, reconnectCount: 0 });
    expect(h.createClient).toHaveBeenCalledOnce();
  });

  it("pipe 保持打开但无响应时超时恢复；新连接恢复已选线程", async () => {
    let now = 0;
    const first = new FakeAppServer(), next = new FakeAppServer();
    const h = source([first, next], { now: () => now, staleThresholdMs: 100, healthTimeoutMs: 15 });
    const states: string[] = []; h.source.onStatus(status => { states.push(status.state); });
    await h.source.selectThread("thread-a"); await h.source.start();
    first.override = method => method === "thread/read" ? new Promise(() => {}) : undefined;
    now = 101; await h.source.checkHealth();
    await vi.waitFor(() => expect(h.source.getStatus().reconnectCount).toBe(1));
    await vi.waitFor(() => expect(h.source.getStatus().live).toBe(true));
    expect(states).toContain("disconnected"); expect(states).toContain("reconnecting");
    expect(h.source.getStatus()).toMatchObject({ threadId: "thread-a", history: "ready" });
    expect(h.source.getStatus().lastReconnectDurationMs).toBeGreaterThanOrEqual(0);
    expect(first.notifications.size + first.closes.size + first.issues.size).toBe(0);
    expect(first.stop).toHaveBeenCalledOnce(); expect(h.createClient).toHaveBeenCalledTimes(2);
  });

  it("存活检查期间停止不会安排迟到重连", async () => {
    let now = 0;
    const client = new FakeAppServer(), h = source([client], { now: () => now, staleThresholdMs: 100, healthTimeoutMs: 15 });
    await h.source.selectThread("thread-a"); await h.source.start();
    client.override = method => method === "thread/read" ? new Promise(() => {}) : undefined;
    now = 101; const health = h.source.checkHealth(); await h.source.stop(); await health;
    expect(h.source.getStatus().state).toBe("stopped");
    expect(h.source.getResourceCounts()).toMatchObject({ reconnectTimers: 0, appConnections: 0 });
    expect(h.createClient).toHaveBeenCalledOnce();
  });

  it("失败清理保留 transport 引用、阻止自动 spawn，并允许显式重试清理", async () => {
    const client = new FakeAppServer(), h = source([client]);
    await h.source.selectThread("thread-a"); await h.source.start();
    client.stop.mockRejectedValueOnce(new Error("模拟清理失败")); client.disconnect();
    await vi.waitFor(() => expect(h.source.getStatus().reason).toContain("cleanup failed"));
    await new Promise(resolve => setTimeout(resolve, 25));
    expect(h.source.getResourceCounts()).toMatchObject({ appConnections: 1, reconnectTimers: 0 });
    expect(h.createClient).toHaveBeenCalledOnce();
    await h.source.stop();
    expect(client.stop).toHaveBeenCalledTimes(2);
    expect(h.source.getResourceCounts().appConnections).toBe(0);
  });

  it("显式 stop 失败仍可重试，不能虚报资源已释放", async () => {
    const client = new FakeAppServer(), h = source([client]);
    await h.source.selectThread("thread-a"); await h.source.start();
    client.stop.mockRejectedValueOnce(new Error("模拟清理失败"));
    await expect(h.source.stop()).rejects.toThrow("cleanup-failed");
    expect(h.source.getResourceCounts().appConnections).toBe(1);
    await h.source.stop(); expect(h.source.getResourceCounts().appConnections).toBe(0);
  });

  it("manager 保留清理失败对象；新连接不能绕开失败，成功重试后归零", async () => {
    const home = await makeHome(), client = new RuntimeClient(home), createClient = vi.fn(() => client);
    const manager = new RuntimeConnectionManager({ runtime: codexRuntime(home), discovery: { discover: async () => discovery() }, createClient });
    manager.setSelection("thread-a"); await manager.open();
    client.stop.mockRejectedValueOnce(new Error("模拟清理失败"));
    await expect(manager.disconnect()).rejects.toThrow("cleanup-failed");
    expect(manager.getResourceCounts()).toMatchObject({ runtimeClients: 1, failedCleanupClients: 1 });
    await expect(manager.open()).rejects.toThrow("cleanup-pending");
    expect(createClient).toHaveBeenCalledOnce();
    await manager.disconnect();
    expect(manager.getResourceCounts()).toEqual({ runtimeClients: 0, failedCleanupClients: 0, runtimePendingClients: 0, pendingApprovals: 0 });
  });

  it("三十轮 A→B→A、断线与 HUD source restart 后监听器和连接归零", async () => {
    for (let cycle = 0; cycle < 30; cycle++) {
      const clients = [new FakeAppServer(), new FakeAppServer()];
      for (const client of clients) { client.threads.set("thread-b", thread("thread-b")); client.turns.set("thread-b", [turn("turn-b")]); client.loaded.add("thread-b"); }
      const h = source([...clients]); await h.source.selectThread("thread-a"); await h.source.start();
      await h.source.selectThread("thread-b"); await h.source.selectThread("thread-a");
      clients[0].disconnect(); await vi.waitFor(() => expect(h.source.getStatus().reconnectCount).toBe(1));
      await h.source.stop();
      expect(h.source.getResourceCounts()).toMatchObject({ appConnections: 0, reconnectTimers: 0, appBufferedEvents: 0 });
      expect(clients.every(client => client.notifications.size + client.closes.size + client.issues.size === 0)).toBe(true);
    }
  });
});

describe("Phase 10：归档代理恢复", () => {
  it("二十五个完成代理归档后，明确的新轮次可以恢复；旧轮次不能复活", () => {
    const owner = new HudStateReducer(), children = new RolloutAgentProvider();
    owner.apply({ type: "session", id: "root" });
    owner.apply({ type: "agent-discovered", source: "app-server", agentId: "root" });
    for (let n = 0; n < 25; n++) {
      const threadId = `child-${n}`;
      children.apply({ type: "agent-discovered", source: "app-server", threadId, agentId: threadId, parentId: "root", isSubagent: true }, owner, n);
      children.apply({ type: "agent-status", source: "app-server", threadId, agentId: threadId, turnId: "old", status: "completed", at: n }, owner, n);
      owner.getState(n); children.prune(owner);
    }
    expect(owner.agents.isRetired("child-0")).toBe(true);
    const running = { type: "agent-status" as const, source: "app-server" as const, threadId: "child-0", agentId: "child-0", status: "running" as const, at: 100 };
    children.apply({ ...running, turnId: "old" }, owner, 100); expect(owner.agents.isRetired("child-0")).toBe(true);
    children.apply({ ...running, turnId: "new" }, owner, 100);
    children.apply({ ...running, turnId: "old", status: "completed" as const, at: 101 }, owner, 101);
    const state = owner.getState(101);
    expect(flattenAgentTree(state.agentSummary!.tree).find(entry => entry.agent.id === "child-0")?.agent).toMatchObject({ turnId: "new", status: "running" });
    expect(children.getResourceCounts().agentReaders).toBeLessThanOrEqual(21);
    expect(owner.agents.getResourceCounts().retiredAgents).toBeLessThanOrEqual(1024);
  });
});
