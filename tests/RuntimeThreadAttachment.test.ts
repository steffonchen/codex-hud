import { afterEach, describe, expect, it, vi } from "vitest";
import { AppServerSource } from "../src/providers/codex/app-server/AppServerSource.js";
import { AppServerError } from "../src/providers/codex/app-server/AppServerProtocol.js";
import { RuntimeConnectionManager } from "../src/providers/codex/runtime/RuntimeConnectionManager.js";
import { HudStateReducer } from "../src/core/HudStateReducer.js";
import { SourceDeduplicator } from "../src/core/source/SourceDeduplicator.js";
import { thread, turn, command, tokenNotification } from "./app-server/helpers.js";
import { RuntimeClient, cleanupRuntimeFixtures, codexRuntime, deferred, discovery, makeHome } from "./runtime-authority/helpers.js";

const sources: AppServerSource[] = [];
afterEach(async () => { await Promise.all(sources.splice(0).map(source => source.stop())); await cleanupRuntimeFixtures(); });
function fixture(home: string, clients: RuntimeClient[], options: { historyTimeoutMs?: number; maxReconnectAttempts?: number; autoReconnect?: boolean } = {}) {
  const createClient = vi.fn(() => clients.shift()!);
  const manager = new RuntimeConnectionManager({ runtime: codexRuntime(home), discovery: { discover: async () => discovery() },
    createClient, policy: { auto_reconnect: options.autoReconnect ?? true } });
  const source = new AppServerSource({ connectionManager: manager, reconnectDelayMs: 10, ...options }); sources.push(source);
  const reducer = new HudStateReducer(), dedup = new SourceDeduplicator();
  source.onStatus(status => dedup.setAppServerLive(status.live, status.unloadedThreadIds).forEach(event => reducer.apply(event)));
  source.onEvent(event => dedup.consume(event).forEach(accepted => reducer.apply(accepted)));
  return { source, manager, reducer, createClient };
}
function selectClient(client: RuntimeClient, id: string) {
  client.threads.clear(); client.turns.clear(); client.loaded.clear();
  client.threads.set(id, thread(id)); client.turns.set(id, [turn(`${id}-turn`)]); client.loaded.add(id); return client;
}

describe("Runtime 线程附着、历史和异步边界", () => {
  it.each(["thread/closed", "thread/archived", "thread/deleted"])("%s 在 resume 期间到达后保持 lost", async method => {
    const home = await makeHome(), client = new RuntimeClient(home), resume = deferred<unknown>(), h = fixture(home, [client]);
    client.respond = method => method === "thread/resume" ? resume.promise : undefined;
    await h.source.selectThread("thread-a"); const starting = h.source.start();
    await vi.waitFor(() => expect(client.request.mock.calls.some(([method]) => method === "thread/resume")).toBe(true));
    client.emit({ method, params: { threadId: "thread-a" } }); resume.resolve({ thread: thread() }); await starting;
    expect(h.source.getStatus()).toMatchObject({ live: false, unloadedThreadIds: ["thread-a"], runtime: { thread: { state: "lost" } } });
  });
  it("快速 A→B→C 换选不会由 B 的迟到清理重开 C 或泄漏连接", async () => {
    const home = await makeHome(), first = new RuntimeClient(home), third = selectClient(new RuntimeClient(home), "thread-c");
    const stopped = deferred<void>(), h = fixture(home, [first, third]);
    await h.source.selectThread("thread-a"); await h.source.start(); first.stop.mockReturnValue(stopped.promise);
    const toB = h.source.selectThread("thread-b"); await h.source.selectThread("thread-c"); stopped.resolve(); await toB;
    expect(h.source.getStatus()).toMatchObject({ live: true, threadId: "thread-c" });
    expect(h.createClient).toHaveBeenCalledTimes(2); expect(third.stop).not.toHaveBeenCalled();
    first.emit(tokenNotification(100)); expect(h.reducer.getState(0).usage).toBeUndefined();
  });
  it("旧失败清理不为新线程安排额外 reconnect", async () => {
    const home = await makeHome(), first = new RuntimeClient(home), second = selectClient(new RuntimeClient(home), "thread-b");
    const stopped = deferred<void>(), h = fixture(home, [first, second]);
    await h.source.selectThread("thread-a"); await h.source.start(); first.stop.mockReturnValue(stopped.promise); first.disconnect();
    const switching = h.source.selectThread("thread-b"); stopped.resolve(); await switching;
    await new Promise(resolve => setTimeout(resolve, 40));
    expect(h.createClient).toHaveBeenCalledTimes(2); expect(h.source.getStatus()).toMatchObject({ threadId: "thread-b", live: true, reconnectCount: 0 });
  });
  it.each(["turns", "items"])("不支持 %s 分页时 read 补偿历史，并如实记录方法能力", async unsupported => {
    const home = await makeHome(), client = new RuntimeClient(home), h = fixture(home, [client]); client.loaded.clear();
    const history = turn("turn-a", "completed", [command()]); client.threads.get("thread-a")!.turns = [history];
    client.respond = method => {
      if (method === (unsupported === "turns" ? "thread/turns/list" : "thread/items/list")) throw new AppServerError("request", -32601);
      if (unsupported === "items" && method === "thread/turns/list") return { data: [{ ...history, itemsView: "notLoaded", items: [] }], nextCursor: null };
    };
    await h.source.selectThread("thread-a"); await h.source.start();
    expect(h.source.getStatus()).toMatchObject({ history: "ready", live: false });
    expect(client.request).toHaveBeenCalledWith("thread/read", { threadId: "thread-a", includeTurns: true });
    expect(h.reducer.getState(0).tools?.recent).toHaveLength(1);
    expect(h.manager.getState().capabilities).toMatchObject(unsupported === "items" ? { turnsList: "supported", itemsList: "unsupported" } : { turnsList: "unsupported" });
    expect(client.request.mock.calls.some(([method]) => method === "thread/resume")).toBe(false);
  });
  it("历史超时后结束等待、回退并停止连接", async () => {
    const home = await makeHome(), client = new RuntimeClient(home), h = fixture(home, [client], { historyTimeoutMs: 20, maxReconnectAttempts: 1 });
    client.respond = method => method === "thread/turns/list" ? new Promise(() => {}) : undefined;
    await h.source.selectThread("thread-a"); await h.source.start();
    await vi.waitFor(() => expect(client.stop).toHaveBeenCalled());
    expect(h.source.getStatus()).toMatchObject({ live: false, available: false, runtime: { reconnectExhausted: true } });
    expect(h.source.getStatus().reason).toContain("timeout");
  });
  it("审批只观察明确线程，resolved 仅清除待处理计数", async () => {
    const home = await makeHome(), client = new RuntimeClient(home), h = fixture(home, [client]);
    await h.source.selectThread("thread-a"); await h.source.start();
    const request = { id: "approval-a", threadId: "thread-a", method: "item/commandExecution/requestApproval" };
    client.emitRequest(request); client.emitRequest(request); client.emitRequest({ ...request, id: "other", threadId: "thread-b" });
    expect(h.manager.getState()).toMatchObject({ pendingApprovals: 1, approvalRequestsObserved: 1 });
    client.emit({ method: "serverRequest/resolved", params: { threadId: "thread-a", requestId: "approval-a" } });
    expect(h.manager.getState()).toMatchObject({ pendingApprovals: 0, approvalRequestsObserved: 1 });
    expect(client.notify).toHaveBeenCalledExactlyOnceWith("initialized");
  });
  it("关闭子线程不改变主线程健康和附着；账户 read 不伪装 live 事件", async () => {
    const home = await makeHome(), client = new RuntimeClient(home), h = fixture(home, [client]);
    client.threads.set("child", thread("child", "thread-a")); client.turns.set("child", []); client.loaded.add("child");
    await h.source.selectThread("thread-a", [{ id: "child", parentId: "thread-a" }]); await h.source.start();
    expect(h.manager.getState().eventCount).toBe(0);
    client.emit({ method: "thread/closed", params: { threadId: "child" } });
    expect(h.source.getStatus()).toMatchObject({ live: true, runtime: { thread: { state: "attached" }, health: "healthy" } });
  });
  it.each([true, false])("auto_reconnect=%s 遵守有界次数；stop 清除后续重试", async autoReconnect => {
    const home = await makeHome(), failed = new RuntimeClient(home); failed.start.mockRejectedValue(new AppServerError("transport", "ECONNREFUSED"));
    const h = fixture(home, [failed, failed, failed], { autoReconnect, maxReconnectAttempts: 3 });
    await h.source.selectThread("thread-a"); await h.source.start();
    await vi.waitFor(() => expect(h.manager.getState().reconnectExhausted).toBe(true));
    expect(h.createClient).toHaveBeenCalledTimes(autoReconnect ? 3 : 1);
    await h.source.stop(); await new Promise(resolve => setTimeout(resolve, 50));
    expect(h.createClient).toHaveBeenCalledTimes(autoReconnect ? 3 : 1);
  });
});
