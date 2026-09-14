import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import { appendFile, mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createDefaultConfig } from "../../src/config/Config.js";
import type { HudState } from "../../src/core/HudState.js";
import { flattenAgentTree } from "../../src/core/AgentTree.js";
import { CodexDiscoveryProvider } from "../../src/providers/codex/CodexDiscoveryProvider.js";
import { CodexSessionProvider } from "../../src/providers/codex/CodexSessionProvider.js";
import { RolloutReader } from "../../src/providers/codex/RolloutReader.js";
import { HudRuntime } from "../../src/runtime/HudRuntime.js";
import { SignalHandler } from "../../src/runtime/SignalHandler.js";
import { rawUsage, sumUsage, usage } from "../usage.js";
import { FakeTerminal } from "./fixtures.js";

const { watchMock } = vi.hoisted(() => ({ watchMock: vi.fn() }));
vi.mock("node:fs", async original => ({ ...await original<typeof import("node:fs")>(), watch: watchMock }));
let directory: string, file: string;
let discovery: CodexDiscoveryProvider, provider: CodexSessionProvider, reader: RolloutReader;
let runtime: HudRuntime, terminal: FakeTerminal, signals: EventEmitter;
let activeWatchers: number, maximumWatchers: number;
const watchers: Array<{ change: (event: string, name: string) => void; emitter: EventEmitter; close: ReturnType<typeof vi.fn> }> = [];
const first = usage(1000, 250, 100), second = usage(2000, 1800, 200), total = sumUsage(first, second);
const event = (type: string, payload: object) => JSON.stringify({ timestamp: "2026-09-12T00:00:00Z", type, payload }) + "\n";
const session = (id = "usage-a", model = "gpt-6-astra") => event("session_meta", { id, cwd: directory, source: "cli", cli_version: "0.154.0" })
  + event("turn_context", { model });
const limits = (primary = 28, secondary = 42) => ({ primary: { used_percent: primary, window_minutes: 300 }, secondary: { used_percent: secondary, window_minutes: 10080 } });
const count = (value = first, last = value, quota?: unknown) => event("event_msg", { type: "token_count", info: {
  total_token_usage: rawUsage(value), last_token_usage: rawUsage(last), model_context_window: 258400,
}, ...(quota === undefined ? {} : { rate_limits: quota }) });
const initial = () => session() + count(first, first, limits());
const appended = () => count(total, second, limits(35, 50));
const notify = () => watchers.at(-1)!.change("change", path.basename(file));
const waitForFrame = (text: string) => vi.waitFor(() => expect(terminal.frames.at(-1)).toContain(text));
const economics = (state: HudState) => ({ usage: state.usage, quota: state.quota, cost: state.cost, tokenUsage: state.tokenUsage });
const fixture = async (name: string) => (await readFile(new URL(`../fixtures/usage/${name}.jsonl`, import.meta.url), "utf8"))
  .trimEnd().split("\n").map(line => { const raw = JSON.parse(line); if (raw.type === "session_meta") raw.payload.cwd = directory; return JSON.stringify(raw); });

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ["Date", "setInterval", "clearInterval", "setTimeout", "clearTimeout"] });
  vi.setSystemTime(new Date("2026-09-12T00:00:00Z"));
  directory = await mkdtemp(path.join(os.tmpdir(), "codex-hud-usage-live-")); await mkdir(path.join(directory, "sessions"));
  file = path.join(directory, "sessions", "rollout-a.jsonl"); watchers.length = 0; activeWatchers = 0; maximumWatchers = 0;
  watchMock.mockReset(); watchMock.mockImplementation((_directory, change) => {
    activeWatchers++; maximumWatchers = Math.max(maximumWatchers, activeWatchers);
    const emitter = new EventEmitter(), close = vi.fn(() => { activeWatchers--; }); watchers.push({ change, emitter, close });
    return Object.assign(emitter, { close });
  });
  reader = new RolloutReader(); discovery = new CodexDiscoveryProvider({ codexHome: directory, userHome: directory, cwd: directory, env: { PATH: "" } });
  provider = new CodexSessionProvider({ discovery, reader }); terminal = new FakeTerminal(); signals = new EventEmitter();
  const config = createDefaultConfig(); config.display.enabled = ["token-details", "cache", "cost", "five-hour-usage", "weekly-usage"];
  runtime = new HudRuntime(config, { provider, terminal, signals: new SignalHandler(signals) });
});
afterEach(async () => { await runtime.stop(); await provider.stop(); await rm(directory, { recursive: true, force: true }); vi.useRealTimers(); });

describe("用量的文件 → Provider → Runtime 数据链路（合成契约）", () => {
  it("追加更新四类状态，重复快照不增加费用且没有用量专用 watcher", async () => {
    await writeFile(file, initial()); await runtime.start(); await waitForFrame("Cache hit 25.0%");
    expect(provider.store.get().usage?.cost.latestCost.value).toBeCloseTo(0.01275);
    await appendFile(file, appended()); notify(); await waitForFrame("Cache hit 90.0%");
    expect(provider.store.get().usage).toMatchObject({ requestCount: 2, coverage: "complete", tokens: { total: { totalTokens: 3300 } } });
    expect(provider.store.get().quota?.primary?.usedPercent).toBe(35); expect(provider.store.get().quota?.secondary?.usedPercent).toBe(50);
    expect(provider.store.get().usage?.cost.sessionEstimatedCost.value).toBeCloseTo(0.02655);
    expect(terminal.frames.at(-1)).toContain("Session estimate USD 0.03");
    await appendFile(file, appended()); notify(); await vi.advanceTimersByTimeAsync(200);
    expect(provider.store.get().usage?.requestCount).toBe(2); expect(watchMock).toHaveBeenCalledOnce();
  });
  it("静态刷新读取零字节，增量只读取追加部分，Doctor 接入五项独立检查", async () => {
    await writeFile(file, initial()); const firstRead = await provider.refresh(); const stable = await provider.refresh();
    expect(firstRead.read.bytesRead).toBe(Buffer.byteLength(initial())); expect(stable.read.bytesRead).toBe(0);
    expect(economics(stable.state)).toEqual(economics(firstRead.state));
    await appendFile(file, appended()); const changed = await provider.refresh();
    expect(changed.read.bytesRead).toBe(Buffer.byteLength(appended())); expect(changed.state.usage?.requestCount).toBe(2);
    for (const id of ["token-source", "cache-source", "rate-limit", "pricing-source", "estimated-cost"]) {
      expect(changed.checks.filter(check => check.id === id)).toEqual([expect.objectContaining({ id, ok: true })]);
    }
  });
  it("坏行有脱敏诊断，半行补齐之前四类状态保持原值", async () => {
    await writeFile(file, initial()); await runtime.start(); const before = economics(provider.store.get()), tail = appended(), half = Math.floor(tail.length / 2);
    await appendFile(file, '{"password":"private-body",bad\n' + tail.slice(0, half)); notify();
    await vi.waitFor(() => expect(runtime.getDiagnostics().some(item => item.code === "invalid-json")).toBe(true));
    expect(economics(provider.store.get())).toEqual(before); expect(terminal.frames.join("\n")).not.toContain("private-body");
    await appendFile(file, tail.slice(half)); notify(); await waitForFrame("Cache hit 90.0%");
    expect(provider.store.get().usage?.requestCount).toBe(2);
  });
  it("新 Provider 与同一 Runtime 重启后恢复同一账本和额度", async () => {
    await writeFile(file, initial() + appended()); await runtime.start(); await waitForFrame("Cache hit 90.0%");
    const before = economics(provider.store.get()); await runtime.stop();
    const fresh = new CodexSessionProvider({ discovery });
    try { expect(economics((await fresh.refresh()).state)).toEqual(before); } finally { await fresh.stop(); }
    await runtime.start(); await waitForFrame("Cache hit 90.0%");
    expect(economics(provider.store.get())).toEqual(before); expect(maximumWatchers).toBe(1);
  });
  it("A → B → A 隔离 Token、Cache、Cost、Quota，未知价格不继承 A 的金额", async () => {
    await writeFile(file, initial() + appended()); const base = await discovery.discover();
    const other = path.join(directory, "sessions", "rollout-b.jsonl"), b = usage(500, 0, 20);
    await writeFile(other, session("usage-b", "unknown-price") + count(b, b, limits(80, 90))); let selected = "a";
    vi.spyOn(discovery, "discover").mockImplementation(async () => ({ ...base, currentSessionId: selected === "a" ? "usage-a" : "usage-b", currentRolloutPath: selected === "a" ? file : other }));
    await runtime.start(); await waitForFrame("Cache hit 90.0%"); const before = economics(provider.store.get());
    selected = "b"; await vi.advanceTimersByTimeAsync(3000); await waitForFrame("Cache hit 0.0%");
    expect(provider.store.get().session?.id).toBe("usage-b"); expect(provider.store.get().usage?.tokens.total?.totalTokens).toBe(520);
    expect(provider.store.get().usage?.requestCount).toBe(1); expect(provider.store.get().quota?.primary?.usedPercent).toBe(80);
    expect(provider.store.get().cost).toBeUndefined(); expect(provider.store.get().usage?.cost.latestCost.value).toBeUndefined();
    selected = "a"; await vi.advanceTimersByTimeAsync(3000); await waitForFrame("Cache hit 90.0%");
    expect(economics(provider.store.get())).toEqual(before); expect(maximumWatchers).toBe(1);
  });
  it.each(["truncate", "replace"])("同路径 %s 后不带入旧累计、费用和额度", async mode => {
    await writeFile(file, initial() + appended()); await runtime.start(); await waitForFrame("Cache hit 90.0%");
    const b = usage(50, 0, 2), replacement = session("usage-b", "unknown-price") + count(b, b, null);
    if (mode === "truncate") await writeFile(file, replacement);
    else { const temporary = path.join(directory, "replacement.jsonl"); await writeFile(temporary, replacement); await rename(temporary, file); }
    notify(); await waitForFrame("Cache hit 0.0%");
    expect(provider.store.get().usage).toMatchObject({ requestCount: 1, tokens: { total: { totalTokens: 52 } }, cache: { cumulativeInputTokens: 50 } });
    expect(provider.store.get().quota).toMatchObject({ availability: "unavailable" }); expect(provider.store.get().cost).toBeUndefined();
  });
  it("压缩估算不进入请求账本；之后实测追加恢复最近缓存和费用", async () => {
    await writeFile(file, initial() + appended()); const before = (await provider.refresh()).state;
    await appendFile(file, event("compacted", {}) + count(total, { ...usage(0, 0, 0), totalTokens: 50 }));
    const compacted = (await provider.refresh()).state;
    expect(compacted.usage).toMatchObject({ requestCount: 2, coverage: "complete", tokens: { lastSource: "estimated" } });
    expect(compacted.usage?.cache.hitRate).toBeUndefined(); expect(compacted.usage?.cost.latestCost.value).toBeUndefined();
    expect(compacted.usage?.cost.sessionEstimatedCost).toEqual(before.usage?.cost.sessionEstimatedCost); expect(compacted.quota).toEqual(before.quota);
    const third = usage(500, 100, 10); await appendFile(file, count(sumUsage(total, third), third));
    const resumed = (await provider.refresh()).state;
    expect(resumed.usage).toMatchObject({ requestCount: 3, coverage: "complete", tokens: { lastSource: "measured" }, cache: { hitRate: 0.2 } });
    expect(resumed.usage?.cost.latestCost.value).toBeCloseTo(0.0046);
  });
  it.each(["sync", "async"])("%s EMFILE 后既有增量补查仍更新全部用量并报告原因", async failure => {
    if (failure === "sync") watchMock.mockImplementation(() => { throw Object.assign(new Error("监听不可用"), { code: "EMFILE" }); });
    const reads = vi.spyOn(reader, "read"); await writeFile(file, initial()); await runtime.start(); await waitForFrame("Cache hit 25.0%");
    if (failure === "async") watchers[0].emitter.emit("error", { code: "EMFILE" });
    await appendFile(file, appended()); await vi.advanceTimersByTimeAsync(3000); await waitForFrame("Cache hit 90.0%");
    expect(reader.getWatchStatus()).toMatchObject({ mode: "polling", activeWatchers: 0, reason: "EMFILE" });
    expect(runtime.getDiagnostics().some(item => item.code === "watch-unavailable")).toBe(true);
    expect(provider.store.get().usage?.requestCount).toBe(2); expect(provider.store.get().usage?.cost.sessionEstimatedCost.value).toBeCloseTo(0.02655);
    expect(provider.store.get().quota?.primary?.usedPercent).toBe(35);
    const results = await Promise.all(reads.mock.results.map(result => result.value));
    expect(results.reduce((sum, result) => sum + result.bytesRead, 0)).toBe(Buffer.byteLength(initial() + appended()));
    expect(watchMock).toHaveBeenCalledOnce(); await runtime.stop(); expect(vi.getTimerCount()).toBe(0);
  });
  it("五个用量模块不增加专用计时器；SIGINT 释放所有监听、订阅与计时器", async () => {
    await writeFile(file, initial()); const unsubscribe = vi.fn(), subscribe = provider.store.subscribe.bind(provider.store);
    vi.spyOn(provider.store, "subscribe").mockImplementation(listener => { const off = subscribe(listener); return () => { off(); unsubscribe(); }; });
    await runtime.start(); await waitForFrame("Cache hit 25.0%"); await vi.advanceTimersByTimeAsync(200);
    expect(activeWatchers).toBe(1); expect(vi.getTimerCount()).toBe(2);
    signals.emit("SIGINT"); await runtime.waitForStop(); expect(runtime.getStatus()).toBe("stopped");
    expect(unsubscribe).toHaveBeenCalledOnce(); expect(activeWatchers).toBe(0); expect(vi.getTimerCount()).toBe(0);
    expect(signals.listenerCount("SIGINT")).toBe(0); expect(terminal.events).toBeUndefined();
    const frames = terminal.frames.length; provider.store.patch({ model: "停止后的更新" }); await vi.advanceTimersByTimeAsync(1000);
    expect(terminal.frames).toHaveLength(frames); await runtime.start(); await waitForFrame("Cache hit 25.0%");
  });
});

describe("匿名真实样本的文件与 Runtime 回放", () => {
  it("从真实首请求逐步追加到最后重复事件，11 次请求只读一次", async () => {
    const lines = await fixture("main-sequence"), start = lines.slice(0, 3).join("\n") + "\n", tail = lines.slice(3).join("\n") + "\n";
    await writeFile(file, start); await runtime.start(); await waitForFrame("Cache hit 0.0%");
    await appendFile(file, tail); notify(); await waitForFrame("Cache hit 94.1%");
    expect(provider.store.get().usage).toMatchObject({ requestCount: 11, coverage: "complete", tokens: { total: { totalTokens: 660916 } } });
    expect(provider.store.get().usage?.cost.sessionEstimatedCost.value).toBeUndefined(); expect(provider.store.get().quota?.availability).toBe("empty");
    const stable = await provider.refresh(); expect(stable.read.bytesRead).toBe(0);
    expect(stable.checks.find(check => check.id === "estimated-cost")).toMatchObject({ ok: false, warning: true });
    expect(watchMock).toHaveBeenCalledOnce();
  });
  it("组合契约：明确 parent ID 的真实子样本保持独立，不累加到根用量", async () => {
    await writeFile(file, initial()); const lines = await fixture("child-sequence"), meta = JSON.parse(lines[0]);
    // 只改匿名关联字段检验数据链路，不将两个样本声明为真实父子会话。
    meta.payload.parent_thread_id = "usage-a"; meta.payload.session_id = "usage-a"; meta.payload.source.subagent.thread_spawn.parent_thread_id = "usage-a";
    lines[0] = JSON.stringify(meta); await writeFile(path.join(directory, "sessions", "rollout-child.jsonl"), lines.join("\n") + "\n");
    await runtime.start(); await waitForFrame("Cache hit 25.0%");
    const state = provider.store.get(), child = flattenAgentTree(state.agentSummary!.tree).find(entry => entry.agent.id === "usage-child")!.agent;
    expect(child.usage).toMatchObject({ requestCount: 1, coverage: "complete", tokens: { total: { totalTokens: 22801 } } });
    expect(child.usage?.cost.sessionEstimatedCost.value).toBeCloseTo(0.057521);
    expect(state.usage).toMatchObject({ requestCount: 1, tokens: { total: { totalTokens: 1100 } } });
    expect(state.quota?.primary?.usedPercent).toBe(28); expect(maximumWatchers).toBe(1); expect(watchMock).toHaveBeenCalledOnce();
  });
});
