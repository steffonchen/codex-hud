import { afterEach, describe, expect, it, vi } from "vitest";
import { readFile } from "node:fs/promises";
import { StateStore, MAX_REENTRANT_NOTIFICATIONS } from "../src/core/StateStore.js";
import { HudStateReducer, MAX_RETAINED_TURNS } from "../src/core/HudStateReducer.js";
import { HudDiagnosticsTracker, appServerHealth, emptyEventStatistics, MAX_DIAGNOSTIC_WARNINGS } from "../src/core/HudDiagnostics.js";
import type { HudEvent } from "../src/core/HudEvent.js";
import { SourceDeduplicator } from "../src/core/source/SourceDeduplicator.js";
import { SourceAuthorityPolicy } from "../src/core/source/SourceAuthorityPolicy.js";
import { APP_SERVER_CAPABILITIES, type SourceStatus } from "../src/core/source/DataSource.js";
import { debugHudDiagnostics } from "../src/cli/Diagnostics.js";
import { tokenEvent } from "./app-server/helpers.js";
import { testPricing } from "./usage.js";

afterEach(() => vi.useRealTimers());
const status = (patch: Partial<SourceStatus> = {}): SourceStatus => ({ state: "connected", available: true, live: true, transport: "stdio",
  protocol: "detected", schema: "v2", history: "ready", eventCount: 0, unknownCount: 0, reconnectCount: 0,
  capabilities: { ...APP_SERVER_CAPABILITIES }, connectedAt: 0, ...patch });

describe("Phase 10：事件、状态与计量不变量", () => {
  it("相同 Token 的 contextWindow A→B→A 不重复计费且恢复最终窗口", () => {
    const source = new SourceDeduplicator(), reducer = new HudStateReducer(false, testPricing());
    reducer.apply({ type: "session", id: "thread-a" }); source.setAppServerLive(true);
    for (const [i, contextWindow] of [1000, 2000, 1000].entries()) {
      for (const event of source.consume({ ...tokenEvent("app-server", 1, i + 1), model: "priced-a", contextWindow } as HudEvent)) reducer.apply(event);
      expect(reducer.getState(0).context?.contextWindow).toBe(contextWindow);
    }
    const state = reducer.getState(0);
    expect(state.usage?.requestCount).toBe(1);
    expect(state.usage?.cost.sessionEstimatedCost.value).toBeCloseTo((80 * 2 + 20 * 0.5 + 10 * 8) / 1_000_000);
    expect(state.cost?.estimated).toBe(true);
  });

  it("首次迟到的旧轮次不能抢占当前计划、Token、活动", () => {
    const source = new SourceDeduplicator(new SourceAuthorityPolicy(false)), reducer = new HudStateReducer();
    reducer.apply({ type: "session", id: "thread-a" });
    const apply = (event: HudEvent) => source.consume({ source: "rollout", threadId: "thread-a", ...event }).forEach(event => reducer.apply(event));
    apply({ type: "turn-started", id: "B", turnId: "B", at: 200 });
    apply({ type: "turn-started", id: "A", turnId: "A", at: 100 });
    apply({ type: "plan-updated", threadId: "thread-a", turnId: "B", source: "rollout", ordinal: 3, eventId: "plan-b", steps: [{ title: "当前计划", status: "in_progress" }] });
    apply({ type: "tokens", turnId: "A", total: { totalTokens: 999 }, at: 110 });
    apply({ type: "turn-completed", id: "B", turnId: "B", at: 300 });
    expect(reducer.getState(300).planSummary?.execution?.turnId).toBe("B");
    expect(reducer.getState(300).activity?.status).toBe("idle");
    expect(reducer.getState(300).tokenUsage).toBeUndefined();
    expect(source.getStatistics().outOfOrder).toBe(2);
  });

  it("旧 start 在新 turn 期间重复不让活动永久 running", () => {
    const reducer = new HudStateReducer();
    for (const event of [
      { type: "turn-started", id: "A", at: 1 }, { type: "turn-completed", id: "A", at: 2 },
      { type: "turn-started", id: "B", at: 3 }, { type: "turn-started", id: "A", at: 1 },
      { type: "turn-completed", id: "B", at: 4 },
    ] as HudEvent[]) reducer.apply(event);
    expect(reducer.getState(4).activity?.status).toBe("idle");
    expect(reducer.getState(4).session?.turnCount).toBe(2);
  });

  it.each([null, {}, { type: "未来事件" }, { type: "activity", at: NaN }, { type: "activity", at: -1 },
    { type: "activity", source: "app-server" }, { type: "activity", sourceOrdinal: 0.5 },
    { type: "tool-started", toolId: "" }, { type: "agent-status", agentId: "" },
    { type: "session", id: "A", threadId: "B" }, { type: "model", generation: Infinity }])("无效信封独立丢弃并计数：%j", event => {
    const source = new SourceDeduplicator();
    expect(source.consume(event as HudEvent)).toEqual([]);
    expect(source.getStatistics()).toMatchObject({ received: 1, accepted: 0, dropped: 1 });
    expect(source.getStatistics().invalid + source.getStatistics().unknown).toBe(1);
  });

  it("水位同序号一万条身份攻击不会增长缓存", () => {
    const source = new SourceDeduplicator(new SourceAuthorityPolicy(), 8);
    for (let n = 0; n < 10_000; n++) source.consume({ type: "activity", threadId: "thread-a", source: "app-server", sourceOrdinal: 1, eventId: `id-${n}` });
    expect(source.getResourceCounts().watermarkIdentities).toBe(8);
    expect(source.getStatistics()).toMatchObject({ received: 10_000, accepted: 8, dropped: 9992 });
    source.consume({ type: "activity", threadId: "thread-a", source: "app-server", sourceOrdinal: 2, generation: 2 });
    expect(source.consume({ type: "activity", threadId: "thread-a", source: "app-server", sourceOrdinal: 99, generation: 1 })).toEqual([]);
    expect(source.getStatistics().outOfOrder).toBe(1);
  });

  it("五千轮只保存有界身份，同时保留准确轮数；淘汰旧轮次不能复活", () => {
    const reducer = new HudStateReducer();
    reducer.apply({ type: "session", id: "thread-a" });
    for (let n = 1; n <= 5000; n++) reducer.apply({ type: "turn-started", id: `turn-${n}`, at: n });
    reducer.apply({ type: "turn-started", id: "turn-1", at: 1 });
    reducer.apply({ type: "turn-completed", id: "turn-5000", at: 5001 });
    expect(reducer.getResourceCounts()).toMatchObject({ retainedTurns: MAX_RETAINED_TURNS, turnHistoryLimited: 1 });
    expect(reducer.getState(5001).session?.turnCount).toBe(5000);
    expect(reducer.getState(5001).activity?.status).toBe("idle");
  });

  it("有界跨来源回放：镜像、断线、新增、迟到旧事件均不重复用量与费用", async () => {
    const fixture = JSON.parse(await readFile(new URL("./fixtures/reliability/handoff.json", import.meta.url), "utf8")) as {
      steps: Array<{ source?: "rollout" | "app-server"; cumulative?: number; ordinal?: number; live?: boolean }>;
    };
    const source = new SourceDeduplicator(), reducer = new HudStateReducer(false, testPricing());
    reducer.apply({ type: "session", id: "thread-a" });
    for (const step of fixture.steps) {
      const events = step.live !== undefined ? source.setAppServerLive(step.live)
        : source.consume({ ...tokenEvent(step.source!, step.cumulative!, step.ordinal!), model: "priced-a" } as HudEvent);
      events.forEach(event => reducer.apply(event));
    }
    const state = reducer.getState(0);
    expect(state.usage?.requestCount).toBe(4);
    expect(state.tokenUsage).toMatchObject({ inputTokens: 400, cachedInputTokens: 80, outputTokens: 40, reasoningOutputTokens: 8, totalTokens: 440 });
    expect(state.usage?.cost.sessionEstimatedCost.value).toBeCloseTo(4 * (80 * 2 + 20 * 0.5 + 10 * 8) / 1_000_000);
    expect(source.getPendingCount()).toBe(0);
    expect(source.getStatistics().deduplicated).toBeGreaterThan(0);
    expect(source.getStatistics().outOfOrder).toBe(1);
  });

  it("旧轮次的已计量镜像仍能完成交接，下一轮 Rollout 用量不会卡住", () => {
    const source = new SourceDeduplicator(), reducer = new HudStateReducer();
    reducer.apply({ type: "session", id: "thread-a" }); source.setAppServerLive(true);
    const apply = (event: HudEvent) => source.consume(event).forEach(event => reducer.apply(event));
    apply({ type: "turn-started", id: "turn-a", turnId: "turn-a", threadId: "thread-a", source: "app-server", at: 100 });
    apply(tokenEvent("app-server", 1, 1));
    apply({ type: "turn-started", id: "turn-b", turnId: "turn-b", threadId: "thread-a", source: "app-server", at: 200 });
    apply(tokenEvent("rollout", 1, 1));
    source.setAppServerLive(false).forEach(event => reducer.apply(event));
    apply({ ...tokenEvent("rollout", 2, 2), turnId: "turn-b" });
    expect(source.getPendingCount()).toBe(0); expect(source.getTokenSource("thread-a")).toBe("rollout");
    expect(reducer.getState(200).usage?.requestCount).toBe(2); expect(reducer.getState(200).tokenUsage?.totalTokens).toBe(220);
  });

  it("没有时间依据且身份已淘汰时，宁可报告不完整也不把旧轮次重复计数", () => {
    const reducer = new HudStateReducer(), source = new SourceDeduplicator(new SourceAuthorityPolicy(false));
    for (let n = 1; n <= MAX_RETAINED_TURNS + 1; n++) {
      const event = { type: "turn-started" as const, id: `t${n}`, threadId: "thread-a" };
      reducer.apply(event); source.consume(event);
    }
    reducer.apply({ type: "turn-started", id: "t1" });
    expect(reducer.getState(0).session?.turnCount).toBe(MAX_RETAINED_TURNS + 1);
    expect(reducer.getResourceCounts().uncertainTurns).toBe(1);
    expect(source.consume({ type: "turn-started", id: "t1", threadId: "thread-a" })).toEqual([]);
    expect(source.getIssues().join()).toContain("lacks timing evidence");
  });
});

describe("Phase 10：诊断与通知边界", () => {
  it("无限重入回调有界结束、最新状态可读、后续健康订阅恢复", () => {
    const store = new StateStore();
    let calls = 0;
    const stop = store.subscribe(() => { calls++; store.patch({ model: String(calls) }); });
    store.replace(); stop();
    expect(calls).toBe(MAX_REENTRANT_NOTIFICATIONS);
    expect(store.get().model).toBe(String(calls));
    expect(store.getNotificationErrors().count).toBeGreaterThan(0);
    expect(store.getResourceCounts().pendingStateNotifications).toBe(0);
    const received = vi.fn(); store.subscribe(received); store.patch({ model: "恢复" });
    expect(received).toHaveBeenCalledOnce();
  });

  it("突发通知队列合并而不无限增长，patch 不持有调用方引用", () => {
    const store = new StateStore();
    store.subscribe(state => { if (state.model === "入口") for (let n = 0; n < 1000; n++) store.patch({ model: String(n) }); });
    const received: string[] = []; store.subscribe(state => { received.push(state.model!); });
    store.replace({ model: "入口" });
    expect(received.length).toBeLessThanOrEqual(65); expect(received.at(-1)).toBe("999");
    const context = { usedTokens: 10 }; store.patch({ context }); context.usedTokens = 1000;
    expect(store.get().context?.usedTokens).toBe(10);
  });

  it("九种健康状态中 idle 变 stale，不假装断线", () => {
    expect(appServerHealth(status(), 60_001)).toBe("stale");
    expect(appServerHealth(status(), 100)).toBe("healthy");
    expect(appServerHealth(status({ live: false }), 100)).toBe("fallback");
    for (const [state, health] of [["starting", "connecting"], ["reconnecting", "reconnecting"], ["failed", "failed"], ["stopped", "disconnected"]] as const) {
      expect(appServerHealth(status({ state }), 100)).toBe(health);
    }
  });

  it("诊断固定计时阶段、有限告警、白名单脱敏与停止状态", () => {
    const tracker = new HudDiagnosticsTracker(() => 100);
    tracker.select("thread-a-private-tail"); tracker.select("thread-b-private-tail");
    for (let n = 0; n < 100; n++) tracker.warn(`code-${n}`, "api_key=private-diagnostic-secret");
    tracker.measure("render", 2); tracker.measure("render", 4); tracker.measure("render", NaN);
    tracker.observe({}, true, emptyEventStatistics(), { rawSecret: 42 });
    const snapshot = tracker.snapshot();
    Object.assign(snapshot, { rawPayload: "不得输出的正文" });
    Object.assign(snapshot.events, { rawSecret: "不得输出的正文" });
    expect(snapshot.warnings).toHaveLength(MAX_DIAGNOSTIC_WARNINGS);
    expect(snapshot.session.switches).toBe(1);
    expect(snapshot.performance.render).toEqual({ count: 2, lastMs: 4, totalMs: 6, maxMs: 4 });
    const debug = JSON.stringify(debugHudDiagnostics(snapshot));
    expect(debug).not.toMatch(/private-diagnostic-secret|private-tail|rawSecret|不得输出的正文/);
    tracker.stopped(); expect(tracker.snapshot()).toMatchObject({ source: { kind: "none", state: "disconnected" }, recovery: { state: "disconnected" } });
  });
});
