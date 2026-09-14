import { afterEach, describe, expect, it, vi } from "vitest";
import { AppServerSource } from "../src/providers/codex/app-server/AppServerSource.js";
import type { HudEvent } from "../src/core/HudEvent.js";
import { HudStateReducer } from "../src/core/HudStateReducer.js";
import { SourceDeduplicator } from "../src/core/source/SourceDeduplicator.js";
import { FakeAppServer, settle, thread, tokenEvent, tokenNotification, turn } from "./app-server/helpers.js";

const sources: AppServerSource[] = [];
afterEach(async () => { await Promise.all(sources.splice(0).map(source => source.stop())); vi.useRealTimers(); });
const create = (client = new FakeAppServer(), options = {}) => {
  const source = new AppServerSource({ createClient: () => client, ...options }); sources.push(source); return { source, client };
};
describe("AppServerSource", () => {
  it("单连接握手、已承载线程 rejoin，然后投递 normalized live", async () => {
    const { source, client } = create(); const events: HudEvent[] = []; source.onEvent(event => events.push(event));
    await source.selectThread("thread-a"); await Promise.all([source.start(), source.start()]);
    expect(client.start).toHaveBeenCalledOnce(); expect(client.request.mock.calls[0][0]).toBe("initialize");
    expect(client.notify).toHaveBeenCalledWith("initialized");
    expect(client.request).toHaveBeenCalledWith("thread/resume", { threadId: "thread-a", excludeTurns: true });
    expect(source.getStatus()).toMatchObject({ state: "connected", protocol: "detected", schema: "v2", history: "ready", live: true });
    client.emit(tokenNotification(1)); expect(events.at(-1)).toMatchObject({ type: "tokens", source: "app-server", threadId: "thread-a" });
  });
  it("独立 stdio 可读历史但不能订阅另一个实例的线程", async () => {
    const { source, client } = create(); client.loaded.clear(); await source.selectThread("thread-a"); await source.start();
    expect(source.getStatus()).toMatchObject({ available: true, live: false, history: "ready" });
    expect(source.getStatus().reason).toContain("does not host");
    expect(client.request.mock.calls.some(([method]) => method === "thread/resume" || method === "turn/start")).toBe(false);
  });
  it("notLoaded 立即交接 Rollout；周期检查承载状态，不重复读取卸载线程历史", async () => {
    const { source, client } = create(), reducer = new HudStateReducer(), dedup = new SourceDeduplicator();
    const apply = (event: HudEvent) => dedup.consume(event).forEach(event => reducer.apply(event));
    source.onEvent(apply); source.onStatus(status => dedup.setAppServerLive(status.live, status.unloadedThreadIds).forEach(event => reducer.apply(event)));
    await source.selectThread("thread-a"); await source.start(); apply(tokenEvent("rollout", 1, 1)); client.emit(tokenNotification(1));
    client.loaded.delete("thread-a"); client.emit({ method: "thread/status/changed", params: { threadId: "thread-a", status: { type: "notLoaded" } } });
    apply(tokenEvent("rollout", 2, 2)); expect(source.getStatus().live).toBe(false);
    expect(reducer.getState(0).usage?.requestCount).toBe(2); expect(dedup.getTokenSource("thread-a")).toBe("rollout");
    await source.selectThread("thread-a"); await source.selectThread("thread-a");
    expect(client.request.mock.calls.filter(([method]) => method === "thread/loaded/list")).toHaveLength(3);
    expect(client.request.mock.calls.filter(([method]) => method === "thread/read")).toHaveLength(1);
    client.loaded.add("thread-a"); client.turns.set("thread-a", [turn(), turn("turn-b")]); await source.selectThread("thread-a");
    expect(source.getStatus()).toMatchObject({ live: true, unloadedThreadIds: [] });
    expect(client.request.mock.calls.filter(([method]) => method === "thread/resume")).toHaveLength(2);
    expect(reducer.getState(0).session?.turnCount).toBe(2);
  });
  it("resume 等待期间卸载，迟到响应不能重新标记实时连接", async () => {
    const { source, client } = create();
    client.override = method => {
      if (method === "thread/resume") client.emit({ method: "thread/status/changed", params: { threadId: "thread-a", status: { type: "notLoaded" } } });
    };
    await source.selectThread("thread-a"); await source.start();
    expect(source.getStatus()).toMatchObject({ live: false, unloadedThreadIds: ["thread-a"] });
  });
  it("无当前身份不选择任意 loaded 线程", async () => {
    const { source, client } = create(); const listener = vi.fn(); source.onEvent(listener); await source.start();
    client.emit(tokenNotification(1)); expect(listener).not.toHaveBeenCalled(); expect(source.getStatus().live).toBe(false);
    expect(client.request.mock.calls.some(([method]) => method === "thread/read")).toBe(false);
  });
  it("无关线程不切换 HUD；明确子线程才被接收", async () => {
    const { source, client } = create(); const events: HudEvent[] = []; source.onEvent(event => events.push(event));
    await source.selectThread("thread-a"); await source.start(); const before = events.length;
    client.emit(tokenNotification(1, 1, "unrelated")); client.emit({ method: "thread/started", params: { thread: thread("other", "unrelated") } });
    expect(events).toHaveLength(before);
    client.emit({ method: "thread/started", params: { thread: thread("child-a", "thread-a") } }); client.emit(tokenNotification(1, 1, "child-a"));
    expect(events.at(-1)?.threadId).toBe("child-a"); expect(source.getStatus().threadId).toBe("thread-a");
  });
  it("通知风暴不重读历史，也不产生按模块连接", async () => {
    const { source, client } = create(); await source.selectThread("thread-a"); await source.start(); const reads = client.request.mock.calls.length;
    for (let n = 1; n <= 3000; n++) client.emit(tokenNotification(n));
    expect(client.request.mock.calls).toHaveLength(reads); expect(client.start).toHaveBeenCalledOnce(); expect(source.getStatus().eventCount).toBe(3000);
  });
  it("未知方法和坏通知保持可观察且不使连接退出", async () => {
    const { source, client } = create(); const issues = vi.fn(); source.onDiagnostic(issues); await source.selectThread("thread-a"); await source.start();
    client.emit({ method: "future/value", params: { secret: "SECRET" } }); client.emit({ method: "thread/tokenUsage/updated", params: {} });
    client.emit(tokenNotification(1)); expect(source.getStatus()).toMatchObject({ state: "connected", unknownCount: 1, eventCount: 1 });
    expect(issues).toHaveBeenCalled(); expect(JSON.stringify(issues.mock.calls)).not.toContain("SECRET");
  });
  it("历史同步期间事件有界，溢出明确断开并安排恢复", async () => {
    vi.useFakeTimers(); const { source, client } = create(undefined, { maxBufferedEvents: 8 });
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    client.override = async method => { if (method === "thread/turns/list") await gate; };
    await source.selectThread("thread-a"); const ready = source.start();
    await settle(); await settle();
    for (let n = 1; n <= 20; n++) client.emit(tokenNotification(n));
    expect(source.getStatus().reason).toContain("bounded buffer"); release(); await ready; await settle();
    expect(source.getStatus().live).toBe(false); expect(client.stop).toHaveBeenCalled();
  });
  it("切换目标使旧同步失效，并只在同一连接订阅新目标", async () => {
    const { source, client } = create(); client.threads.set("thread-b", thread("thread-b")); client.turns.set("thread-b", [turn("turn-b")]); client.loaded.add("thread-b");
    const events: HudEvent[] = []; source.onEvent(event => events.push(event));
    await source.selectThread("thread-a"); await source.start(); await source.selectThread("thread-b"); const length = events.length;
    client.emit(tokenNotification(1)); expect(events).toHaveLength(length); client.emit(tokenNotification(1, 1, "thread-b", "turn-b"));
    expect(events.at(-1)?.threadId).toBe("thread-b"); expect(client.start).toHaveBeenCalledOnce();
  });
  it("stop/restart 幂等，清除监听与重连 timer", async () => {
    vi.useFakeTimers(); const { source, client } = create(); await source.selectThread("thread-a"); await source.start();
    await Promise.all([source.stop(), source.stop()]); expect(client.notifications.size).toBe(0); expect(client.closes.size).toBe(0);
    expect(vi.getTimerCount()).toBe(0); await source.start(); expect(source.getStatus().state).toBe("connected"); expect(client.start).toHaveBeenCalledTimes(2);
  });
});
