import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import { appendFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createDefaultConfig } from "../../src/config/Config.js";
import { CodexDiscoveryProvider } from "../../src/providers/codex/CodexDiscoveryProvider.js";
import { CodexSessionProvider } from "../../src/providers/codex/CodexSessionProvider.js";
import { RolloutReader } from "../../src/providers/codex/RolloutReader.js";
import { HudRuntime } from "../../src/runtime/HudRuntime.js";
import { SignalHandler } from "../../src/runtime/SignalHandler.js";
import { FakeTerminal } from "./fixtures.js";

const { watchMock } = vi.hoisted(() => ({ watchMock: vi.fn() }));
vi.mock("node:fs", async original => ({ ...await original<typeof import("node:fs")>(), watch: watchMock }));

let directory: string;
let file: string;
let runtime: HudRuntime;
let provider: CodexSessionProvider;
let reader: RolloutReader;
let discovery: CodexDiscoveryProvider;
let terminal: FakeTerminal;
let startLine: string;
let completedLines: string[];
let activeWatchers: number;
let maximumWatchers: number;
const watchers: Array<{ change: (event: string, name: string) => void; emitter: EventEmitter; close: ReturnType<typeof vi.fn> }> = [];
const fixture = async (name: string) => (await readFile(new URL(`../fixtures/codex/tools/${name}`, import.meta.url), "utf8")).trimEnd().split("\n").map(line => {
  const event = JSON.parse(line);
  // 样本放入临时会话 a 时，同步替换显式线程身份，保留真实 schema。
  if (event.payload.thread_id) event.payload.thread_id = "a";
  if (event.payload.internal_chat_message_metadata_passthrough?.thread_id) event.payload.internal_chat_message_metadata_passthrough.thread_id = "a";
  return JSON.stringify(event);
});
const session = (id: string) => JSON.stringify({ timestamp: new Date(Date.now() - 1000).toISOString(), type: "session_meta",
  payload: { id, source: "cli", cwd: directory, cli_version: "0.153.4", timestamp: new Date(Date.now() - 1000).toISOString() } }) + "\n";
const waitForFrame = (text: string) => vi.waitFor(() => expect(terminal.frames.at(-1)).toContain(text));
const notify = () => watchers.at(-1)!.change("change", path.basename(file));

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout", "setInterval", "clearInterval"] });
  [startLine] = await fixture("tool-start.jsonl");
  completedLines = (await fixture("tool-complete.jsonl")).slice(1);
  vi.setSystemTime(new Date(JSON.parse(startLine).timestamp));
  directory = await mkdtemp(path.join(os.tmpdir(), "codex-hud-tools-live-"));
  file = path.join(directory, "sessions", "rollout-a.jsonl");
  await mkdir(path.dirname(file));
  watchers.length = 0;
  activeWatchers = 0;
  maximumWatchers = 0;
  watchMock.mockReset();
  watchMock.mockImplementation((_directory, change) => {
    activeWatchers++;
    maximumWatchers = Math.max(maximumWatchers, activeWatchers);
    const emitter = new EventEmitter();
    const close = vi.fn(() => { activeWatchers--; });
    watchers.push({ change, emitter, close });
    return Object.assign(emitter, { close });
  });
  reader = new RolloutReader();
  discovery = new CodexDiscoveryProvider({ codexHome: directory, cwd: directory, env: { PATH: "" } });
  provider = new CodexSessionProvider({ discovery, reader });
  terminal = new FakeTerminal();
  const config = createDefaultConfig();
  config.display.enabled = ["tools", "current-activity"];
  config.behavior.hide_when_idle = true;
  runtime = new HudRuntime(config, { provider, terminal, signals: new SignalHandler(new EventEmitter()) });
});
afterEach(async () => {
  await runtime.stop();
  await rm(directory, { recursive: true, force: true });
  vi.useRealTimers();
});

describe("工具实时文件链路与资源边界", () => {
  it("追加调用 → running → 耗时重绘 → 完成；计时不写 Store 或读取文件", async () => {
    const reads = vi.spyOn(reader, "read");
    await writeFile(file, session("a") + startLine + "\n");
    await runtime.start();
    await vi.waitFor(() => expect(reads).toHaveBeenCalledTimes(2));
    await waitForFrame("Tool call");
    const updates = vi.fn();
    const unsubscribe = provider.store.subscribe(updates);
    const before = provider.store.get();
    const readCount = reads.mock.calls.length;
    await vi.advanceTimersByTimeAsync(1100);
    expect(terminal.frames.at(-1)).toContain("1s");
    expect(provider.store.get()).toEqual(before);
    expect(updates).not.toHaveBeenCalled();
    expect(reads).toHaveBeenCalledTimes(readCount);
    await appendFile(file, completedLines.join("\n") + "\n");
    notify();
    await waitForFrame("✓ Completed package.json");
    expect(terminal.frames.at(-1)?.match(/package\.json/gu)).toHaveLength(1);
    expect(provider.store.get().tools).toMatchObject({ active: [], recent: [{ type: "read", status: "completed" }] });
    expect(provider.store.get().activity?.status).toBe("completed");
    const end = JSON.stringify({ timestamp: new Date().toISOString(), type: "event_msg", payload: { type: "task_complete", turn_id: JSON.parse(startLine).payload.internal_chat_message_metadata_passthrough.turn_id } });
    await appendFile(file, end + "\n");
    notify();
    await vi.waitFor(() => expect(provider.store.get().activity?.status).toBe("idle"));
    await vi.waitFor(() => expect(terminal.frames.at(-1)).toBe(""));
    unsubscribe();
  });

  it.each(["sync", "async"])("%s EMFILE 后仍以新增字节更新工具，降级原因保留但不占 HUD", async failure => {
    if (failure === "sync") watchMock.mockImplementation(() => { throw Object.assign(new Error("监听不可用"), { code: "EMFILE" }); });
    const reads = vi.spyOn(reader, "read");
    const initial = session("a") + startLine + "\n";
    await writeFile(file, initial);
    await runtime.start();
    await waitForFrame("Tool call");
    if (failure === "async") watchers[0].emitter.emit("error", { code: "EMFILE" });
    expect(reader.getWatchStatus()).toMatchObject({ mode: "polling", reason: "EMFILE", activeWatchers: 0, fallback: true });
    expect(runtime.getDiagnostics().some(item => item.code === "watch-unavailable")).toBe(true);
    const addition = completedLines.join("\n") + "\n";
    await appendFile(file, addition);
    await vi.advanceTimersByTimeAsync(3000);
    await waitForFrame("✓ Completed package.json");
    expect(terminal.frames.join("\n")).not.toContain("EMFILE");
    expect(provider.store.get().tools?.active).toEqual([]);
    const results = await Promise.all(reads.mock.results.map(result => result.value));
    expect(results.reduce((sum, result) => sum + result.bytesRead, 0)).toBe(Buffer.byteLength(initial + addition));
    expect(reads.mock.calls.length).toBeLessThanOrEqual(5);
    await runtime.stop();
    expect(reader.getWatchStatus()).toMatchObject({ mode: "inactive", activeWatchers: 0 });
    expect(vi.getTimerCount()).toBe(0);
  });

  it("真实格式的失败记录经完整链路显示失败，不被包装器返回覆盖", async () => {
    await writeFile(file, session("a") + startLine + "\n");
    await runtime.start();
    await waitForFrame("Tool call");
    await appendFile(file, (await fixture("tool-failed.jsonl")).join("\n") + "\n" + completedLines.at(-1) + "\n");
    notify();
    await waitForFrame("✗ Execution failed npm test");
    expect(provider.store.get().tools).toMatchObject({ active: [], recent: [{ status: "failed", error: "Exit code 128" }] });
    expect(provider.store.get().activity).toMatchObject({ status: "completed", toolStatus: "failed" });
  });

  it("真实 Provider 连续 start/stop 三次，watcher 和所有定时器均释放", async () => {
    await writeFile(file, session("a") + startLine + "\n");
    for (let index = 0; index < 3; index++) {
      await runtime.start();
      await waitForFrame("Tool call");
      expect(activeWatchers).toBe(1);
      await runtime.stop();
      expect(activeWatchers).toBe(0);
      expect(vi.getTimerCount()).toBe(0);
    }
    expect(watchMock).toHaveBeenCalledTimes(3);
    expect(maximumWatchers).toBe(1);
    expect(watchers.every(watcher => watcher.close.mock.calls.length === 1)).toBe(true);
  });

  it("A → B → C → A 关闭旧监听且工具/活动不串会话", async () => {
    await writeFile(file, session("a") + startLine + "\n");
    const base = await discovery.discover();
    const files = { a: file, b: path.join(directory, "sessions", "rollout-b.jsonl"), c: path.join(directory, "sessions", "rollout-c.jsonl") };
    await writeFile(files.b, session("b"));
    await writeFile(files.c, session("c"));
    let selected: keyof typeof files = "a";
    vi.spyOn(discovery, "discover").mockImplementation(async () => ({ ...base, currentSessionId: selected, currentRolloutPath: files[selected] }));
    await runtime.start();
    for (const id of ["b", "c", "a"] as const) {
      selected = id;
      await vi.advanceTimersByTimeAsync(3000);
      await vi.waitFor(() => expect(provider.store.get().session?.id).toBe(id));
      if (id !== "a") {
        expect(provider.store.get().tools).toMatchObject({ active: [], recent: [] });
        expect(provider.store.get().activity).toBeUndefined();
      } else expect(provider.store.get().tools?.active).toHaveLength(1);
      expect(activeWatchers).toBe(1);
    }
    expect(maximumWatchers).toBe(1);
    expect(watchers).toHaveLength(4);
    await runtime.stop();
    expect(watchers.every(watcher => watcher.close.mock.calls.length === 1)).toBe(true);
  });

  it("工具半行只在补齐后生效，同路径重放清除旧工具和关联", async () => {
    await writeFile(file, session("a"));
    await runtime.start();
    const half = Math.floor(startLine.length / 2);
    await appendFile(file, startLine.slice(0, half));
    notify();
    await vi.waitFor(async () => expect((await provider.refresh()).read.pendingBytes).toBe(Buffer.byteLength(startLine.slice(0, half))));
    expect(provider.store.get().tools?.active).toEqual([]);
    await appendFile(file, startLine.slice(half) + "\n");
    notify();
    await waitForFrame("Tool call");
    expect(provider.store.get().tools?.active).toHaveLength(1);
    await writeFile(file, session("b"));
    notify();
    await vi.waitFor(() => expect(provider.store.get().session?.id).toBe("b"));
    expect(provider.store.get().tools).toMatchObject({ active: [], recent: [] });
    expect(provider.store.get().activity).toBeUndefined();
    expect(watchMock).toHaveBeenCalledOnce();
  });

  it.each([100, 1000])("%i 条事件经同一 stream 合并读取/重绘，历史和 watcher 数量有界", async count => {
    await writeFile(file, session("a"));
    const reads = vi.spyOn(reader, "read");
    await runtime.start();
    await vi.waitFor(() => expect(reads).toHaveBeenCalledTimes(2));
    const beforeReads = reads.mock.calls.length;
    const beforeFrames = terminal.render.mock.calls.length;
    const template = JSON.parse(completedLines[0]);
    const lines = Array.from({ length: count }, (_, index) => {
      const event = structuredClone(template);
      event.payload.item.id = `item-${index}`;
      event.payload.started_at_ms = Date.now() + index;
      event.payload.completed_at_ms = Date.now() + index + 1;
      return JSON.stringify(event);
    });
    await appendFile(file, lines.join("\n") + "\n");
    for (let index = 0; index < count; index++) notify();
    await vi.waitFor(() => expect(provider.store.get().tools?.recent?.[0].id).toBe(`item-${count - 1}`));
    await waitForFrame("package.json");
    expect(provider.store.get().tools?.recent).toHaveLength(20);
    expect(JSON.stringify(provider.store.get()).length).toBeLessThan(15_000);
    expect(reads.mock.calls.length - beforeReads).toBeLessThanOrEqual(2);
    expect(terminal.render.mock.calls.length - beforeFrames).toBeLessThanOrEqual(2);
    expect(watchMock).toHaveBeenCalledOnce();
    expect(maximumWatchers).toBe(1);
  });

  it.each(["native", "async-error"])("doctor 的 %s 监听检测等待异步错误，结束后释放 watcher 和 timer", async mode => {
    await writeFile(file, session("a"));
    await provider.refresh();
    const probe = provider.probeWatcher();
    if (mode === "async-error") setTimeout(() => watchers[0].emitter.emit("error", { code: "EMFILE" }), 15);
    await vi.advanceTimersByTimeAsync(100);
    const observed = await probe;
    if (mode === "async-error") expect(observed).toMatchObject({ mode: "polling", activeWatchers: 0, fallback: true, reason: "EMFILE" });
    else expect(observed.mode).toBe("native");
    expect(reader.getWatchStatus().mode).toBe("inactive");
    expect(activeWatchers).toBe(0);
    expect(watchers[0].close).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });
});
