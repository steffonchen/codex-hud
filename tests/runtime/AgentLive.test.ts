import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import { appendFile, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { CodexDiscoveryProvider } from "../../src/providers/codex/CodexDiscoveryProvider.js";
import { CodexSessionProvider } from "../../src/providers/codex/CodexSessionProvider.js";
import type { CodexSessionSnapshot } from "../../src/providers/codex/CodexSessionProvider.js";
import { HudRuntime } from "../../src/runtime/HudRuntime.js";
import { SignalHandler } from "../../src/runtime/SignalHandler.js";
import { createDefaultConfig } from "../../src/config/Config.js";
import { agentFixture, agentsOf } from "../agents.js";
import { FakeTerminal } from "./fixtures.js";

const { watchMock } = vi.hoisted(() => ({ watchMock: vi.fn() }));
vi.mock("node:fs", async original => ({ ...await original<typeof import("node:fs")>(), watch: watchMock }));
let directory: string;
let discovery: CodexDiscoveryProvider;
let provider: CodexSessionProvider;
let maximum = 0;
let active = 0;
const providers: CodexSessionProvider[] = [];
const signals: EventEmitter[] = [];
const runtimes: HudRuntime[] = [];
let single: string[];

function remap(lines: string[], id: string, parent = "root"): string[] {
  const own = JSON.parse(lines[0]).payload.id;
  const map = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(map);
    if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, key === "parent_thread_id" ? parent : map(item)]));
    return value === own ? id : value;
  };
  return lines.map(line => JSON.stringify(map(JSON.parse(line))));
}
async function write(name: string, lines: string[]): Promise<string> {
  const file = path.join(directory, "sessions", `rollout-${name}.jsonl`);
  await writeFile(file, lines.map(line => {
    const raw = JSON.parse(line); if (raw.type === "session_meta") raw.payload.cwd = directory; return JSON.stringify(raw);
  }).join("\n") + "\n");
  return file;
}
const child = (snapshot: CodexSessionSnapshot, id = "single") => agentsOf(snapshot.state).find(agent => agent.id === id)!;
function newProvider() { const instance = new CodexSessionProvider({ discovery }); providers.push(instance); return instance; }

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "setTimeout", "clearTimeout"] });
  directory = await mkdtemp(path.join(os.tmpdir(), "codex-hud-agents-live-")); await mkdir(path.join(directory, "sessions"));
  maximum = 0; active = 0;
  watchMock.mockReset(); watchMock.mockImplementation(() => {
    active++; maximum = Math.max(maximum, active);
    return Object.assign(new EventEmitter(), { close: vi.fn(() => { active--; }) });
  });
  discovery = new CodexDiscoveryProvider({ codexHome: directory, cwd: directory, env: { PATH: "" } });
  provider = newProvider();
  await write("root", await agentFixture("parallel-agents"));
  single = await agentFixture("single-agent");
});
afterEach(async () => {
  for (const runtime of runtimes.splice(0)) await runtime.stop();
  for (const instance of providers.splice(0)) await instance.stop();
  signals.length = 0;
  await rm(directory, { recursive: true, force: true }); vi.useRealTimers();
});

describe("Agent 真实文件链路", () => {
  it("并行线程逆序结束不串 Token、Context 或父边", async () => {
    await write("a", await agentFixture("parallel-a")); await write("b", await agentFixture("parallel-b"));
    const snapshot = await provider.refresh();
    expect(child(snapshot, "explorer")).toMatchObject({ parentId: "root", tokens: { totalTokens: 1077643 }, status: "completed" });
    expect(child(snapshot, "tester")).toMatchObject({ parentId: "root", tokens: { totalTokens: 681570 }, status: "completed" });
    expect(snapshot.state.tokenUsage).toBeUndefined(); expect(snapshot.agentReads).toHaveLength(2);
  });
  it("增量追加完成记录改变对应子代理", async () => {
    const file = await write("single", single.slice(0, -1));
    expect(child(await provider.refresh()).status).toBe("running");
    await appendFile(file, single.at(-1)! + "\n");
    const snapshot = await provider.refresh(); expect(child(snapshot).status).toBe("completed");
    expect(snapshot.agentReads?.[0].bytesRead).toBe(Buffer.byteLength(single.at(-1)! + "\n"));
    expect((await provider.refresh()).agentReads?.[0].bytesRead).toBe(0);
  });
  it("不同线程使用相同 call_id 和 turn_id 仍独立处理失败", async () => {
    const altered = (lines: string[]) => lines.filter(line => JSON.parse(line).payload.type !== "task_complete").map(line => {
      const e = JSON.parse(line), p = e.payload;
      if (p.turn_id) p.turn_id = "shared-turn";
      if (p.call_id) p.call_id = "shared-call";
      if (p.item?.id) p.item.id = "shared-call";
      if (p.internal_chat_message_metadata_passthrough?.turn_id) p.internal_chat_message_metadata_passthrough.turn_id = "shared-turn";
      return JSON.stringify(e);
    });
    await write("slow", altered(await agentFixture("agent-failure"))); await write("single", altered(single));
    const snapshot = await provider.refresh();
    expect(child(snapshot, "slow").activity?.toolStatus).toBe("failed");
    expect(child(snapshot).activity?.toolStatus).toBe("completed");
    expect(snapshot.state.tools?.recent?.some(tool => tool.id === "shared-call")).toBe(false);
  });
  it("新 Provider 从相同真实文件恢复树", async () => {
    await write("single", single); const first = await provider.refresh(); const second = await newProvider().refresh();
    expect(second.state.agentSummary).toEqual(first.state.agentSummary);
  });
  it("切换主会话时旧代理不会混入", async () => {
    await write("single", single); await provider.refresh();
    await write("new-root", [JSON.stringify({ type: "session_meta", timestamp: new Date().toISOString(), payload: { id: "new-root", cwd: directory, source: "cli" } })]);
    const snapshot = await provider.refresh();
    expect(snapshot.state.session?.id).toBe("new-root"); expect(child(snapshot)).toBeUndefined();
  });
  it("child 截断只清除该线程的旧状态", async () => {
    await write("single", single); await write("b", await agentFixture("parallel-b")); await provider.refresh();
    await write("single", single.slice(0, 3));
    const snapshot = await provider.refresh(); expect(child(snapshot).status).toBe("running"); expect(child(snapshot).tokens).toBeUndefined();
    expect(child(snapshot, "tester").status).toBe("completed");
  });
  it("child 半行补齐前不消费终态", async () => {
    const file = await write("single", single.slice(0, -1)); await provider.refresh();
    const tail = single.at(-1)!; const half = Math.floor(tail.length / 2);
    await appendFile(file, tail.slice(0, half)); expect(child(await provider.refresh()).status).toBe("running");
    await appendFile(file, tail.slice(half) + "\n"); expect(child(await provider.refresh()).status).toBe("completed");
  });
  it("子线程坏行保持错误可见且不泄露正文", async () => {
    const file = await write("single", single); await appendFile(file, '{"token":"秘密正文",bad\n');
    const snapshot = await provider.refresh();
    expect(snapshot.diagnostics.some(item => item.code === "invalid-json" && item.path === file)).toBe(true);
    expect(JSON.stringify(snapshot.diagnostics)).not.toContain("秘密正文"); expect(snapshot.state.session?.id).toBe("root");
  });
  it("候选短暂缺失后即使文件未追加也恢复状态", async () => {
    await write("single", single); await provider.refresh(); const real = discovery.discover.bind(discovery);
    const spy = vi.spyOn(discovery, "discover").mockImplementationOnce(async () => ({ ...await real(), agentRollouts: [] }));
    expect(child(await provider.refresh()).status).toBe("unknown"); spy.mockRestore();
    const restored = child(await provider.refresh()); expect(restored.status).toBe("completed"); expect(restored.error).toBeUndefined();
  });
  it("文件消失与重建能够恢复", async () => {
    const file = await write("single", single); await provider.refresh(); await rm(file);
    expect(child(await provider.refresh()).status).toBe("unknown"); await write("single", single);
    expect(child(await provider.refresh()).status).toBe("completed");
  });
  it("nested 实际 metadata 在 Provider 中构成三层", async () => {
    await write("nested", await agentFixture("nested-agents")); await write("leaf", await agentFixture("nested-leaf"));
    const snapshot = await provider.refresh(); expect(snapshot.state.agentSummary?.capability.nestedSupport).toBe(true);
    expect(child(snapshot, "leaf").parentId).toBe("nested");
  });
  it("缺少中间父线程时保留同会话 orphan", async () => {
    await write("leaf", await agentFixture("nested-leaf")); const snapshot = await provider.refresh();
    expect(snapshot.state.agentSummary?.orphans[0].agent.id).toBe("leaf"); expect(snapshot.state.agentSummary?.capability.correlation).toBe("partial");
  });
  it.each([50, 100])("%i 个子代理只使用一个 watcher 和两个既有轮询 timer", async count => {
    for (let index = 0; index < count; index++) await write(`a${index}`, remap(single.slice(0, 3), `a${index}`));
    await provider.start({ onSnapshot: () => {}, onDiagnostic: () => {} });
    await vi.waitFor(() => expect(provider.store.get().agentSummary?.count).toBe(count + 1));
    expect(watchMock).toHaveBeenCalledOnce(); expect(maximum).toBe(1); expect(vi.getTimerCount()).toBe(2);
    await provider.stop(); expect(active).toBe(0); expect(vi.getTimerCount()).toBe(0);
  });
  it.each(["sync", "async"])("%s EMFILE 后共享补查仍消费子线程增量", async mode => {
    const file = await write("single", single.slice(0, -1)); const errors: string[] = [];
    if (mode === "sync") watchMock.mockImplementation(() => { throw Object.assign(new Error("监听失败"), { code: "EMFILE" }); });
    await provider.start({ onSnapshot: () => {}, onDiagnostic: d => errors.push(d.code) });
    if (mode === "async") watchMock.mock.results[0].value.emit("error", { code: "EMFILE" });
    await appendFile(file, single.at(-1)! + "\n"); await vi.advanceTimersByTimeAsync(3000);
    await vi.waitFor(() => expect(agentsOf(provider.store.get()).find(agent => agent.id === "single")?.status).toBe("completed"));
    expect(errors).toContain("watch-unavailable"); expect(watchMock).toHaveBeenCalledOnce();
    await provider.stop(); expect(vi.getTimerCount()).toBe(0);
  });
  it("真实 Runtime 的 SIGINT 释放监听、timer 和订阅，可再次启动", async () => {
    await write("single", single.slice(0, -1)); const emitter = new EventEmitter(); signals.push(emitter);
    const terminal = new FakeTerminal(); const config = createDefaultConfig(); config.display.enabled = ["agents"];
    const runtime = new HudRuntime(config, { provider, terminal, signals: new SignalHandler(emitter) }); runtimes.push(runtime);
    for (let index = 0; index < 2; index++) {
      await runtime.start(); emitter.emit("SIGINT"); await runtime.waitForStop();
      expect(runtime.getStatus()).toBe("stopped"); expect(vi.getTimerCount()).toBe(0); expect(active).toBe(0); expect(emitter.listenerCount("SIGINT")).toBe(0);
    }
    expect(maximum).toBe(1);
  });
  it("大量静态结束线程不会因退休窗口淘汰而重复回放", async () => {
    const minimal = single.filter(line => ["session_meta", "turn_context"].includes(JSON.parse(line).type) || ["task_started", "task_complete"].includes(JSON.parse(line).payload.type));
    for (let index = 0; index < 1045; index++) await write(`old${index}`, remap(minimal, `old${index}`));
    await provider.refresh(); const second = await provider.refresh();
    expect(second.agentReads).toHaveLength(20); expect(second.agentReads?.every(read => read.bytesRead === 0)).toBe(true);
    expect(second.state.agentSummary?.completedCount).toBe(20);
  }, 30000);
  it("大量旧线程失联不会永久阻塞新线程读取", async () => {
    for (let index = 0; index < 255; index++) await write(`a${index}`, remap(single.slice(0, 3), `a${index}`));
    await provider.refresh();
    await write("new-child", remap(single, "new-child")); const real = discovery.discover.bind(discovery);
    vi.spyOn(discovery, "discover").mockImplementation(async () => {
      const discovered = await real(); return { ...discovered, agentRollouts: discovered.agentRollouts?.filter(value => value.id === "new-child") };
    });
    expect(child(await provider.refresh(), "new-child").status).toBe("completed");
  }, 30000);
  it("达到 reader 上限时仍处理已有线程的完成，下一轮接入新线程", async () => {
    for (let index = 0; index < 255; index++) await write(`a${index}`, remap(single.slice(0, 3), `a${index}`));
    await provider.refresh();
    for (let index = 0; index < 30; index++) await write(`a${index}`, remap(single, `a${index}`));
    await write("new-child", remap(single.slice(0, 3), "new-child"));
    const first = await provider.refresh();
    expect(first.state.agentSummary?.completedCount).toBeGreaterThan(0);
    const next = await provider.refresh();
    expect(child(next, "new-child").status).toBe("running");
    expect(next.agentReads?.some(read => read.agentId === "new-child" && read.bytesRead > 0)).toBe(true);
    expect(next.diagnostics.some(diagnostic => diagnostic.code === "agent-reader-limit")).toBe(false);
  }, 30000);
});
