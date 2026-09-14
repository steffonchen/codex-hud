import { afterEach, describe, expect, it } from "vitest";
import { AppServerSource } from "../src/providers/codex/app-server/AppServerSource.js";
import { SourceDeduplicator } from "../src/core/source/SourceDeduplicator.js";
import { HudStateReducer } from "../src/core/HudStateReducer.js";
import type { HudEvent } from "../src/core/HudEvent.js";
import { FakeAppServer, command, itemNotification, thread, tokenNotification, turn } from "./app-server/helpers.js";

const sources: AppServerSource[] = [];
afterEach(async () => { await Promise.all(sources.splice(0).map(source => source.stop())); });
function setup() {
  const client = new FakeAppServer(), source = new AppServerSource({ createClient: () => client }), reducer = new HudStateReducer(), dedup = new SourceDeduplicator();
  const accepted: HudEvent[] = [];
  sources.push(source); source.onStatus(status => dedup.setAppServerLive(status.live, status.unloadedThreadIds).forEach(event => reducer.apply(event)));
  source.onEvent(event => dedup.consume(event).forEach(event => { accepted.push(event); reducer.apply(event); }));
  return { client, source, accepted, state: () => reducer.getState(0) };
}
describe("App Server history bootstrap", () => {
  it("history 与 live 重叠完成不重复工具；token 只来自真实通知", async () => {
    const h = setup(); h.client.turns.set("thread-a", [turn("turn-a", "completed", [command()])]);
    h.client.override = method => { if (method === "thread/turns/list") { h.client.emit(itemNotification(command())); h.client.emit(tokenNotification(1)); } };
    await h.source.selectThread("thread-a"); await h.source.start();
    expect(h.state().tools?.recent).toHaveLength(1); expect(h.state().usage?.requestCount).toBe(1); expect(h.state().session?.turnCount).toBe(1);
  });
  it("初次历史使用 asc/full，跟随 cursor，而非反复 thread/read", async () => {
    const h = setup();
    h.client.override = (method, params) => method === "thread/turns/list" ? { data: [turn(params.cursor ? "turn-b" : "turn-a")], nextCursor: params.cursor ? null : "cursor-2", backwardsCursor: null } : undefined;
    await h.source.selectThread("thread-a"); await h.source.start();
    expect(h.state().session?.turnCount).toBe(2);
    expect(h.client.request.mock.calls.filter(([method]) => method === "thread/read")).toHaveLength(1);
    expect(h.client.request).toHaveBeenCalledWith("thread/turns/list", expect.objectContaining({ sortDirection: "asc", itemsView: "full", cursor: "cursor-2" }));
    expect(h.state().usage).toBeUndefined();
  });
  it("summary turn 用 items/list 补全，保持条目所属轮次校验", async () => {
    const h = setup();
    h.client.override = method => method === "thread/turns/list" ? { data: [{ ...turn(), itemsView: "summary" }], nextCursor: null }
      : method === "thread/items/list" ? { data: [{ turnId: "turn-a", item: command() }], nextCursor: null } : undefined;
    await h.source.selectThread("thread-a"); await h.source.start();
    expect(h.state().tools?.recent?.[0].name).toBe("shell"); expect(h.source.getStatus().history).toBe("ready");
  });
  it("已知 Rollout 边界只补最新轮次，旧历史不回放", async () => {
    const h = setup(); const events: HudEvent[] = []; h.source.onEvent(event => events.push(event));
    h.client.turns.set("thread-a", [turn("old-a"), turn("old-b"), turn("turn-a")]);
    await h.source.selectThread("thread-a", [], new Map([["thread-a", "turn-a"]])); await h.source.start();
    expect(events.filter(event => event.type === "turn-started").map(event => event.turnId)).toEqual(["turn-a"]);
  });
  it("找不到明确边界时报告 partial，不能把任意旧轮次当作新轮次", async () => {
    const h = setup(); const issues: string[] = []; h.source.onDiagnostic(issue => issues.push(issue.message));
    await h.source.selectThread("thread-a", [], new Map([["thread-a", "absent-turn"]])); await h.source.start();
    expect(h.source.getStatus().history).toBe("partial"); expect(h.state().session?.turnCount).toBeUndefined(); expect(issues.join()).toContain("boundary");
  });
  it("历史 spawn 的明确子线程继续补读，并接收后续实时通知", async () => {
    const h = setup();
    h.client.threads.set("child-a", thread("child-a", "thread-a")); h.client.loaded.add("child-a");
    h.client.turns.set("child-a", [turn("child-turn")]);
    h.client.turns.set("thread-a", [turn("turn-a", "completed", [{ type: "collabAgentToolCall", id: "spawn-a", tool: "spawnAgent",
      status: "completed", senderThreadId: "thread-a", receiverThreadIds: ["child-a"], agentsStates: {} }])]);
    await h.source.selectThread("thread-a"); await h.source.start();
    expect(h.client.request).toHaveBeenCalledWith("thread/read", { threadId: "child-a", includeTurns: false });
    expect(h.client.request).toHaveBeenCalledWith("thread/resume", { threadId: "child-a", excludeTurns: true });
    h.client.emit(tokenNotification(1, 1, "child-a", "child-turn"));
    expect(h.accepted.at(-1)).toMatchObject({ type: "tokens", threadId: "child-a" });
  });
  it("历史回放不改变已缓冲新轮次的等待通知归属", async () => {
    const h = setup();
    const waiting = { method: "thread/status/changed", params: { threadId: "thread-a", status: { type: "active", activeFlags: ["waitingOnApproval"] } } };
    h.client.override = method => {
      if (method === "thread/turns/list") {
        h.client.emit({ method: "turn/started", params: { threadId: "thread-a", turn: turn("new-turn", "inProgress") } });
        h.client.emit(waiting);
        return { data: [turn("old-turn")], nextCursor: null };
      }
    };
    await h.source.selectThread("thread-a"); await h.source.start(); h.client.emit(waiting);
    const statuses = h.accepted.filter(event => event.type === "agent-status" && event.status === "waiting");
    expect(statuses).toHaveLength(2); expect(statuses.every(event => event.turnId === "new-turn")).toBe(true);
  });
  it("无关子线程成功补读不掩盖根线程缺口，重连仍使用原缺失边界", async () => {
    const h = setup();
    await h.source.selectThread("thread-a", [], new Map([["thread-a", "absent-turn"]])); await h.source.start();
    h.client.threads.set("child-a", thread("child-a", "thread-a")); h.client.loaded.add("child-a");
    await h.source.selectThread("thread-a", [{ id: "child-a", parentId: "thread-a" }]);
    expect(h.source.getStatus().history).toBe("partial");
    expect(h.client.request.mock.calls.filter(([method, params]) => method === "thread/read" && (params as { threadId: string }).threadId === "thread-a")).toHaveLength(1);
    h.client.emit({ method: "turn/started", params: { threadId: "thread-a", turn: turn("new-turn", "inProgress") } });
    h.client.turns.set("thread-a", [turn("new-turn")]); await h.source.stop(); await h.source.start();
    expect(h.source.getStatus().history).toBe("partial");
    h.client.turns.set("thread-a", [turn("absent-turn"), turn("new-turn")]); await h.source.stop(); await h.source.start();
    expect(h.source.getStatus().history).toBe("ready");
  });
  it("循环 cursor 和错配 thread identity 不无限重试或污染当前状态", async () => {
    const h = setup(); h.client.override = method => method === "thread/turns/list" ? { data: [turn()], nextCursor: "same" } : undefined;
    await h.source.selectThread("thread-a"); await h.source.start(); expect(h.source.getStatus().history).toBe("partial");
    expect(h.client.request.mock.calls.filter(([method]) => method === "thread/turns/list")).toHaveLength(2);
  });
});
