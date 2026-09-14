import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import { appendFile, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { createDefaultConfig } from "../../src/config/Config.js";
import { CodexDiscoveryProvider } from "../../src/providers/codex/CodexDiscoveryProvider.js";
import { CodexSessionProvider } from "../../src/providers/codex/CodexSessionProvider.js";
import { HudRuntime } from "../../src/runtime/HudRuntime.js";
import { SignalHandler } from "../../src/runtime/SignalHandler.js";
import { FakeTerminal } from "./fixtures.js";

const { watchMock } = vi.hoisted(() => ({ watchMock: vi.fn() }));
vi.mock("node:fs", async original => ({ ...await original<typeof import("node:fs")>(), watch: watchMock }));

let directory: string;
let file: string;
let terminal: FakeTerminal;
let provider: CodexSessionProvider;
let discovery: CodexDiscoveryProvider;
let runtime: HudRuntime;
const watchers: Array<{ change: (event: string, file: string) => void; close: ReturnType<typeof vi.fn> }> = [];
const event = (type: string, payload: object) => JSON.stringify({ timestamp: "2026-09-11T09:00:00Z", type, payload }) + "\n";
const session = (id: string) => event("session_meta", { id, cwd: directory, source: "cli", cli_version: "0.154.0", timestamp: "2026-09-11T08:59:00Z" })
  + event("turn_context", { model: "测试模型", effort: "high" });
const tokens = (total: number, last = total) => event("event_msg", { type: "token_count", info: {
  total_token_usage: { total_tokens: total, input_tokens: total - 1000, output_tokens: 1000, cached_input_tokens: 500, reasoning_output_tokens: 300 },
  last_token_usage: { total_tokens: last }, model_context_window: 100_000,
}, rate_limits: { primary: null, secondary: null } });

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout", "setInterval", "clearInterval"] });
  vi.setSystemTime(new Date("2026-09-11T09:00:00Z"));
  directory = await mkdtemp(path.join(os.tmpdir(), "codex-hud-live-test-"));
  file = path.join(directory, "sessions", "rollout-a.jsonl");
  watchers.length = 0;
  watchMock.mockImplementation((_directory, change) => {
    const watcher = Object.assign(new EventEmitter(), { close: vi.fn() });
    watchers.push({ change, close: watcher.close });
    return watcher;
  });
  discovery = new CodexDiscoveryProvider({ codexHome: directory, cwd: directory, env: { PATH: "" } });
  provider = new CodexSessionProvider({ discovery });
  terminal = new FakeTerminal();
  const config = createDefaultConfig();
  config.display.enabled = ["model", "reasoning", "context", "session", "token-details", "five-hour-usage", "weekly-usage"];
  runtime = new HudRuntime(config, { provider, terminal, signals: new SignalHandler(new EventEmitter()) });
});
afterEach(async () => {
  await runtime.stop();
  await rm(directory, { recursive: true, force: true });
  vi.useRealTimers();
});

const frameContains = async (text: string) => vi.waitFor(() => expect(terminal.frames.at(-1)).toContain(text));
const notify = () => watchers.at(-1)!.change("change", path.basename(file));

describe("真实文件 → Provider → StateStore → Scheduler → HUD", () => {
  it("先等待、自动发现，再持续更新两次；累计快照覆盖而不求和", async () => {
    const discover = vi.spyOn(discovery, "discover");
    await runtime.start();
    expect(terminal.frames.at(-1)).toContain("Waiting for a Codex session");
    await mkdir(path.dirname(file));
    await writeFile(file, session("session-a") + event("event_msg", { type: "task_started", turn_id: "turn-a" }) + tokens(10_000));
    await vi.advanceTimersByTimeAsync(3000);
    await frameContains("10%");
    expect(provider.store.get().tokenUsage?.totalTokens).toBe(10_000);
    const discoveries = discover.mock.calls.length;
    await appendFile(file, tokens(15_000));
    notify();
    await frameContains("15%");
    await appendFile(file, event("event_msg", { type: "task_started", turn_id: "turn-b" }) + tokens(18_000));
    notify();
    await frameContains("18%");
    expect(terminal.frames.at(-1)).toContain("Total 18.0K");
    expect(terminal.frames.at(-1)).toContain("2 turns");
    expect(discover.mock.calls.length).toBe(discoveries);
    expect(provider.store.get().tokenUsage?.totalTokens).toBe(18_000);
    await vi.advanceTimersByTimeAsync(6000);
    await frameContains("18%");
    expect(runtime.getStatus()).toBe("running");
    expect(provider.store.get().tokenUsage?.totalTokens).toBe(18_000);
    await runtime.stop();
    const frames = terminal.frames.length;
    notify();
    await vi.advanceTimersByTimeAsync(6000);
    expect(terminal.frames).toHaveLength(frames);
    expect(watchers.every(watcher => watcher.close.mock.calls.length === 1)).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("会话消失后继续等待，跨日期的新 Session 自动跟随且不带入旧 Token", async () => {
    await mkdir(path.dirname(file));
    await writeFile(file, session("session-a") + tokens(100_000));
    await runtime.start();
    expect(provider.store.get().tokenUsage?.totalTokens).toBe(100_000);
    await rm(file);
    notify();
    await frameContains("waiting for a new session");
    expect(provider.store.get().tokenUsage).toBeUndefined();
    const next = path.join(directory, "sessions", "2026", "09", "12", "rollout-b.jsonl");
    await mkdir(path.dirname(next), { recursive: true });
    await writeFile(next, session("session-b") + tokens(2000, 1000));
    await vi.advanceTimersByTimeAsync(3000);
    await frameContains("Total 2.0K");
    expect(provider.store.get().session?.id).toBe("session-b");
    expect(provider.store.get().tokenUsage?.totalTokens).toBe(2000);
    expect(watchers[0].close).toHaveBeenCalledOnce();
    expect(watchers).toHaveLength(2);
    expect(runtime.getStatus()).toBe("running");
  });

  it("坏行、半行及截断都可恢复，错误可见且不泄露正文", async () => {
    await mkdir(path.dirname(file));
    await writeFile(file, session("session-a") + tokens(10_000));
    await runtime.start();
    await appendFile(file, '{"secret":"私密正文",\n' + tokens(15_000).slice(0, -2));
    notify();
    await vi.waitFor(() => expect(runtime.getDiagnostics().some(item => item.code === "invalid-json")).toBe(true));
    expect(provider.store.get().tokenUsage?.totalTokens).toBe(10_000);
    await appendFile(file, "}\n");
    notify();
    await frameContains("15%");
    expect(terminal.frames.join("\n")).not.toContain("私密正文");
    await writeFile(file, session("session-a") + tokens(2000));
    notify();
    await frameContains("Total 2.0K");
    expect(provider.store.get().tokenUsage?.totalTokens).toBe(2000);
    expect(runtime.getDiagnostics().some(item => item.code === "invalid-json")).toBe(false);
    expect(runtime.getDiagnostics()).toEqual([{ code: "usage-tracking", severity: "warning", message: "Usage breakdown missing or inconsistent; request increment unconfirmed" }]);
  });
});
