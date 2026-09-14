import { afterEach, describe, expect, it, vi } from "vitest";
import { AppServerSource } from "../src/providers/codex/app-server/AppServerSource.js";
import { SourceDeduplicator } from "../src/core/source/SourceDeduplicator.js";
import { HudStateReducer } from "../src/core/HudStateReducer.js";
import { FakeAppServer, command, itemNotification, settle, tokenNotification, turn } from "./app-server/helpers.js";

let source: AppServerSource | undefined;
afterEach(async () => { await source?.stop(); vi.useRealTimers(); });
describe("App Server reconnect", () => {
  it("断线期间的工具用历史补回，保留 tracker，旧连接消息不再进入", async () => {
    vi.useFakeTimers(); const first = new FakeAppServer(), second = new FakeAppServer(); const clients = [first, second];
    const reducer = new HudStateReducer(), dedup = new SourceDeduplicator();
    source = new AppServerSource({ createClient: () => clients.shift()!, reconnectDelayMs: 10 });
    source.onStatus(status => dedup.setAppServerLive(status.live).forEach(event => reducer.apply(event)));
    source.onEvent(event => dedup.consume(event).forEach(accepted => reducer.apply(accepted)));
    await source.selectThread("thread-a"); await source.start(); first.emit(tokenNotification(1));
    const obsolete = [...first.notifications][0]; first.disconnect();
    second.turns.set("thread-a", [turn("turn-a"), turn("turn-b", "completed", [command("during-gap")])]);
    await settle(); await vi.advanceTimersByTimeAsync(10);
    expect(source.getStatus()).toMatchObject({ state: "connected", live: true, reconnectCount: 1 });
    expect(reducer.getState(0).tools?.recent?.[0].id).toBe("during-gap"); expect(reducer.getState(0).usage?.requestCount).toBe(1);
    obsolete(tokenNotification(100)); expect(reducer.getState(0).tokenUsage?.totalTokens).toBe(110);
    second.emit(itemNotification(command("during-gap"), "completed", "thread-a", "turn-b")); expect(reducer.getState(0).tools?.recent).toHaveLength(1);
    expect(first.stop).toHaveBeenCalledOnce();
  });
  it("连接失败只进入 failed/reconnecting，停止取消重试", async () => {
    vi.useFakeTimers(); const failed = new FakeAppServer(); failed.start.mockRejectedValue(new Error("SECRET"));
    source = new AppServerSource({ createClient: () => failed, reconnectDelayMs: 10 }); await source.selectThread("thread-a"); await source.start();
    expect(source.getStatus().state).toBe("failed"); expect(JSON.stringify(source.getStatus())).not.toContain("SECRET");
    await settle(); await source.stop(); await vi.advanceTimersByTimeAsync(1000);
    expect(failed.start).toHaveBeenCalledOnce(); expect(vi.getTimerCount()).toBe(0);
  });
  it("停止发生在 initialize 未完成时，不在迟到响应后重新激活", async () => {
    const client = new FakeAppServer(); let resolve!: (value: unknown) => void;
    client.override = method => method === "initialize" ? new Promise(done => { resolve = done; }) : undefined;
    source = new AppServerSource({ createClient: () => client }); const start = source.start(); await settle();
    const stop = source.stop(); resolve({ userAgent: "codex/0.154.0" }); await Promise.all([start, stop]);
    expect(source.getStatus().state).toBe("stopped"); expect(client.notify).not.toHaveBeenCalled();
  });
});
