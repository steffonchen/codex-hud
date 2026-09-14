import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import { appendFile, mkdir, mkdtemp, rename, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createDefaultConfig } from "../../src/config/Config.js";
import { flattenAgentTree } from "../../src/core/AgentTree.js";
import { CodexDiscoveryProvider } from "../../src/providers/codex/CodexDiscoveryProvider.js";
import { CodexSessionProvider } from "../../src/providers/codex/CodexSessionProvider.js";
import { RolloutReader } from "../../src/providers/codex/RolloutReader.js";
import { HudRuntime } from "../../src/runtime/HudRuntime.js";
import { SignalHandler } from "../../src/runtime/SignalHandler.js";
import { agentFixture } from "../agents.js";
import { planFixture } from "../plans.js";
import { FakeTerminal } from "./fixtures.js";

const { watchMock } = vi.hoisted(() => ({ watchMock: vi.fn() }));
vi.mock("node:fs", async original => ({ ...await original<typeof import("node:fs")>(), watch: watchMock }));
let directory: string, file: string, created: string, updated: string, completed: string;
let discovery: CodexDiscoveryProvider, provider: CodexSessionProvider, reader: RolloutReader;
let runtime: HudRuntime, terminal: FakeTerminal, signals: EventEmitter;
let activeWatchers: number, maximumWatchers: number;
const watchers: Array<{ change: (event: string, name: string) => void; emitter: EventEmitter; close: ReturnType<typeof vi.fn> }> = [];
const lines = (text: string) => text.trimEnd().split("\n");
const localize = (text: string) => lines(text).map(line => { const raw = JSON.parse(line); if (raw.type === "session_meta") raw.payload.cwd = directory; return JSON.stringify(raw); }).join("\n") + "\n";
const notify = () => watchers.at(-1)!.change("change", path.basename(file));
const waitForFrame = (text: string) => vi.waitFor(() => expect(terminal.frames.at(-1)).toContain(text));

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ["Date", "setInterval", "clearInterval", "setTimeout", "clearTimeout"] });
  vi.setSystemTime(new Date("2026-09-12T00:00:00Z"));
  directory = await mkdtemp(path.join(os.tmpdir(), "codex-hud-plan-live-")); await mkdir(path.join(directory, "sessions"));
  file = path.join(directory, "sessions", "rollout-a.jsonl");
  [created, updated, completed] = await Promise.all(["plan-created", "plan-updated", "plan-completed"].map(async name => localize(await planFixture(name))));
  watchers.length = 0; activeWatchers = 0; maximumWatchers = 0; watchMock.mockReset();
  watchMock.mockImplementation((_directory, change) => {
    activeWatchers++; maximumWatchers = Math.max(maximumWatchers, activeWatchers);
    const emitter = new EventEmitter(), close = vi.fn(() => { activeWatchers--; }); watchers.push({ change, emitter, close });
    return Object.assign(emitter, { close });
  });
  reader = new RolloutReader(); discovery = new CodexDiscoveryProvider({ codexHome: directory, cwd: directory, env: { PATH: "" } });
  provider = new CodexSessionProvider({ discovery, reader }); terminal = new FakeTerminal(); signals = new EventEmitter();
  const config = createDefaultConfig(); config.display.enabled = ["plan"];
  runtime = new HudRuntime(config, { provider, terminal, signals: new SignalHandler(signals) });
});
afterEach(async () => { await runtime.stop(); await provider.stop(); await rm(directory, { recursive: true, force: true }); vi.useRealTimers(); });

describe("Plan 历史 fixture 的文件与 Runtime 集成", () => {
  it("成功回执追加后从无清单变为真实步骤，再更新进度", async () => {
    const initial = lines(created); await writeFile(file, initial.slice(0, -1).join("\n") + "\n");
    await runtime.start(); expect(provider.store.get().planSummary?.execution).toBeUndefined();
    await appendFile(file, initial.at(-1)! + "\n"); notify(); await waitForFrame("● 检查结构");
    await appendFile(file, updated); notify(); await waitForFrame("● 实现工具函数");
    expect(provider.store.get().planSummary?.execution).toMatchObject({ completedCount: 1, totalCount: 4, progressPercent: 25 });
    expect(watchMock).toHaveBeenCalledOnce();
  });
  it("静态文件不重放，增量字节数只包含追加的 Plan 记录", async () => {
    await writeFile(file, created); const first = await provider.refresh(); const second = await provider.refresh();
    expect(first.read.bytesRead).toBe(Buffer.byteLength(created)); expect(second.read.bytesRead).toBe(0);
    expect(second.state.planSummary).toEqual(first.state.planSummary);
    await appendFile(file, updated); const third = await provider.refresh();
    expect(third.read.bytesRead).toBe(Buffer.byteLength(updated)); expect(third.state.planSummary?.execution?.completedCount).toBe(1);
    expect((await provider.refresh()).read.bytesRead).toBe(0);
  });
  it("半行回执补齐之前不提前改变计划", async () => {
    const initial = lines(created), tail = initial.at(-1)!; await writeFile(file, initial.slice(0, -1).join("\n") + "\n"); await provider.refresh();
    const half = Math.floor(tail.length / 2); await appendFile(file, tail.slice(0, half)); const pending = await provider.refresh();
    expect(pending.read.pendingBytes).toBe(Buffer.byteLength(tail.slice(0, half))); expect(pending.state.planSummary?.execution).toBeUndefined();
    await appendFile(file, tail.slice(half) + "\n"); expect((await provider.refresh()).state.planSummary?.execution?.totalCount).toBe(4);
  });
  it("同路径截断清空关联，再追加时从新文件恢复", async () => {
    await writeFile(file, created + updated); expect((await provider.refresh()).state.planSummary?.execution?.completedCount).toBe(1);
    await writeFile(file, lines(created).slice(0, 3).join("\n") + "\n"); expect((await provider.refresh()).state.planSummary?.execution).toBeUndefined();
    await appendFile(file, lines(created).slice(3).join("\n") + "\n"); expect((await provider.refresh()).state.planSummary?.execution?.completedCount).toBe(0);
  });
  it("同名文件 inode 替换不会混入旧计划身份", async () => {
    await writeFile(file, created); const before = (await provider.refresh()).state.planSummary!.execution!;
    const replacement = created.replaceAll("plan-a-1", "plan-c-1"), temporary = path.join(directory, "replacement.jsonl");
    await writeFile(temporary, replacement); await rename(temporary, file); const after = (await provider.refresh()).state.planSummary!.execution!;
    expect(after.threadId).toBe("plan-c-1"); expect(after.planId).not.toBe(before.planId); expect(after.totalCount).toBe(4);
  });
  it("缺失来源恢复时重新回放，缺失阶段能力为 unavailable", async () => {
    await writeFile(file, created + updated); const before = await provider.refresh();
    const base = await discovery.discover(); vi.spyOn(discovery, "discover").mockResolvedValue(base);
    await rm(file); const missing = await provider.refresh();
    expect(missing.state.planSummary?.capability.planEvents).toBe("unavailable"); expect(missing.state.planSummary?.execution).toBeUndefined();
    await writeFile(file, created + updated); expect((await provider.refresh()).state.planSummary).toEqual(before.state.planSummary);
  });
  it("新 Provider 重启完整恢复 Plan，Runtime 再启动显示同一进度", async () => {
    await writeFile(file, created + updated); await runtime.start(); await waitForFrame("1/4"); const before = provider.store.get().planSummary;
    await runtime.stop(); const fresh = new CodexSessionProvider({ discovery });
    expect((await fresh.refresh()).state.planSummary).toEqual(before); await fresh.stop();
    await runtime.start(); await waitForFrame("1/4"); expect(provider.store.get().planSummary).toEqual(before); expect(maximumWatchers).toBe(1);
  });
  it("A → B → A 恢复各自清单、身份和原始进度", async () => {
    await writeFile(file, created); const base = await discovery.discover(); const other = path.join(directory, "sessions", "rollout-b.jsonl");
    await writeFile(other, localize(await planFixture("plan-update-rejected"))); let selected: "a" | "b" = "a";
    vi.spyOn(discovery, "discover").mockImplementation(async () => ({ ...base, currentSessionId: selected === "a" ? "plan-a-1" : "plan-b-1",
      currentRolloutPath: selected === "a" ? file : other }));
    await runtime.start(); await waitForFrame("0/4"); const original = provider.store.get().planSummary;
    selected = "b"; await vi.advanceTimersByTimeAsync(3000); await waitForFrame("1/4");
    expect(provider.store.get().planSummary?.execution?.threadId).toBe("plan-b-1");
    selected = "a"; await vi.advanceTimersByTimeAsync(3000); await waitForFrame("0/4");
    expect(provider.store.get().planSummary).toEqual(original); expect(maximumWatchers).toBe(1);
  });
  it("compaction 和工具/轮次结束不会丢失或完成 Plan", async () => {
    await writeFile(file, created + updated); const before = (await provider.refresh()).state.planSummary;
    // 注入已支持的 compacted 结构检验模块独立性，不声称来自 Plan 样本的真实压缩时间线。
    await appendFile(file, JSON.stringify({ type: "compacted", payload: { message: "压缩后的摘要" } }) + "\n" + await planFixture("plan-turn-completed"));
    const after = await provider.refresh(); expect(after.state.planSummary).toEqual(before); expect(after.state.activity?.status).toBe("idle");
    await appendFile(file, completed); expect((await provider.refresh()).state.planSummary?.execution).toMatchObject({ status: "completed", progressPercent: 100 });
  });
  it("坏行诊断可见且不泄露正文，后续完整 Plan 继续处理", async () => {
    await writeFile(file, created); await provider.refresh(); await appendFile(file, '{"password":"private-body",bad\n' + updated);
    const result = await provider.refresh(); expect(result.diagnostics.some(item => item.code === "invalid-json" && item.line === 6)).toBe(true);
    expect(JSON.stringify(result.diagnostics)).not.toContain("private-body"); expect(result.state.planSummary?.execution?.completedCount).toBe(1);
  });
  it.each(["sync", "async"])("%s EMFILE 使用既有增量补查，无 Plan 专用 watcher", async failure => {
    if (failure === "sync") watchMock.mockImplementation(() => { throw Object.assign(new Error("监听不可用"), { code: "EMFILE" }); });
    const reads = vi.spyOn(reader, "read"); await writeFile(file, created); await runtime.start(); await waitForFrame("0/4");
    if (failure === "async") watchers[0].emitter.emit("error", { code: "EMFILE" });
    await appendFile(file, updated); await vi.advanceTimersByTimeAsync(3000); await waitForFrame("1/4");
    expect(reader.getWatchStatus()).toMatchObject({ mode: "polling", activeWatchers: 0, reason: "EMFILE" });
    expect(runtime.getDiagnostics().some(item => item.code === "watch-unavailable")).toBe(true);
    const results = await Promise.all(reads.mock.results.map(result => result.value));
    expect(results.reduce((sum, result) => sum + result.bytesRead, 0)).toBe(Buffer.byteLength(created + updated));
    expect(watchMock).toHaveBeenCalledOnce(); await runtime.stop(); expect(vi.getTimerCount()).toBe(0);
  });
  it("只选 Plan 不增加计时器；SIGINT 释放监听、订阅和定时器", async () => {
    await writeFile(file, created + updated); const unsubscribe = vi.fn(); const subscribe = provider.store.subscribe.bind(provider.store);
    vi.spyOn(provider.store, "subscribe").mockImplementation(listener => { const off = subscribe(listener); return () => { off(); unsubscribe(); }; });
    await runtime.start(); await waitForFrame("1/4"); await vi.advanceTimersByTimeAsync(200);
    expect(activeWatchers).toBe(1); expect(vi.getTimerCount()).toBe(2);
    signals.emit("SIGINT"); await runtime.waitForStop(); expect(runtime.getStatus()).toBe("stopped");
    expect(unsubscribe).toHaveBeenCalledOnce(); expect(activeWatchers).toBe(0); expect(vi.getTimerCount()).toBe(0);
    expect(signals.listenerCount("SIGINT")).toBe(0); expect(terminal.events).toBeUndefined();
    const frames = terminal.render.mock.calls.length; provider.store.patch({ model: "停止后的更新" }); await vi.advanceTimersByTimeAsync(1000);
    expect(terminal.render.mock.calls.length).toBe(frames); await runtime.start(); await waitForFrame("1/4");
  });
  it("组合契约：真实格式的子线程 metadata 与清单通过 ID 关联，根计划不挂到 main", async () => {
    await writeFile(file, created); const childMeta = JSON.parse((await agentFixture("single-agent"))[0]);
    childMeta.payload.cwd = directory; childMeta.payload.session_id = "plan-a-1"; childMeta.payload.parent_thread_id = "plan-a-1";
    childMeta.payload.source.subagent.thread_spawn.parent_thread_id = "plan-a-1";
    const childFile = path.join(directory, "sessions", "rollout-child.jsonl");
    // 组合来源仅检验 Provider 数据链路；不作为真实 Agent + Plan 验收 fixture。
    await writeFile(childFile, JSON.stringify(childMeta) + "\n" + lines(created).slice(1).join("\n") + "\n" + updated);
    const result = await provider.refresh(); const agents = flattenAgentTree(result.state.agentSummary!.tree).map(entry => entry.agent);
    expect(agents.find(agent => agent.id === "single")?.plan).toMatchObject({ threadId: "single", completedCount: 1, totalCount: 4 });
    expect(agents.find(agent => agent.id === "plan-a-1")?.plan).toBeUndefined();
    expect(result.state.planSummary?.execution?.completedCount).toBe(0); expect(result.state.planSummary?.capability.agentAssociation).toBe("available");
    expect(result.agentReads).toHaveLength(1); expect(watchMock).not.toHaveBeenCalled();
  });
});
