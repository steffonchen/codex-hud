import { afterEach, describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import { appendFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { Writable } from "node:stream";
import stringWidth from "string-width";
import { CodexSessionProvider } from "../src/providers/codex/CodexSessionProvider.js";
import { RolloutReader } from "../src/providers/codex/RolloutReader.js";
import { RolloutAgentProvider } from "../src/providers/codex/RolloutAgentProvider.js";
import { HudStateReducer } from "../src/core/HudStateReducer.js";
import { HudRuntime } from "../src/runtime/HudRuntime.js";
import { SignalHandler } from "../src/runtime/SignalHandler.js";
import { HudRenderer } from "../src/renderer/HudRenderer.js";
import { ModuleRegistry } from "../src/renderer/modules/ModuleRegistry.js";
import { createDefaultConfig } from "../src/config/Config.js";
import { mockState } from "../src/demo/mockState.js";
import { createProgram } from "../src/cli/Program.js";
import { writeOutput } from "../src/cli/Output.js";
import { FakeCodexProvider, FakeTerminal } from "./runtime/fixtures.js";
import { testSessionSnapshot } from "./fixtures.js";
import { makeHome, cleanupRuntimeFixtures, codexRuntime } from "./runtime-authority/helpers.js";
import { AppServerSource } from "../src/providers/codex/app-server/AppServerSource.js";
import { FakeAppServer, tokenNotification } from "./app-server/helpers.js";

const { watchMock } = vi.hoisted(() => ({ watchMock: vi.fn() }));
vi.mock("node:fs", async original => ({ ...await original<typeof import("node:fs")>(), watch: watchMock }));
const providers: CodexSessionProvider[] = [], runtimes: HudRuntime[] = [];
afterEach(async () => {
  await Promise.all(runtimes.splice(0).map(runtime => runtime.stop()));
  await Promise.all(providers.splice(0).map(provider => provider.stop()));
  vi.restoreAllMocks(); vi.useRealTimers(); await cleanupRuntimeFixtures();
});
const line = (type: string, payload: object) => JSON.stringify({ timestamp: "2026-09-13T08:00:00Z", type, payload }) + "\n";
const meta = (id: string) => line("session_meta", { id, source: "cli", cli_version: "0.154.0" });
const tokens = (n: number) => line("event_msg", { type: "token_count", info: {
  total_token_usage: { input_tokens: n * 100, cached_input_tokens: n * 20, output_tokens: n * 10, reasoning_output_tokens: n * 2, total_tokens: n * 110 },
  last_token_usage: { input_tokens: 100, cached_input_tokens: 20, output_tokens: 10, reasoning_output_tokens: 2, total_tokens: 110 }, model_context_window: 1000,
} });

describe("Phase 10：文件至渲染的错误边界", () => {
  it("truncate 的空文件中间态后补入新身份，仍能重新发现并恢复", async () => {
    const home = await makeHome(), file = path.join(home, "rollout-a.jsonl");
    await writeFile(file, meta("thread-a") + tokens(1));
    let selected = "thread-a", changed = () => {}, latest: { id?: string; total?: number } = {};
    watchMock.mockImplementation((_directory, change) => {
      changed = () => change("change", path.basename(file));
      return Object.assign(new EventEmitter(), { close: vi.fn() });
    });
    const provider = new CodexSessionProvider({ discovery: { discover: async () => ({ ...codexRuntime(home), activeThreadId: undefined, currentSessionId: selected, currentRolloutPath: file }) } }); providers.push(provider);
    await provider.start({ onDiagnostic: () => {}, onSnapshot: snapshot => { latest = { id: snapshot.state.session?.id, total: snapshot.state.tokenUsage?.totalTokens }; } });
    await vi.waitFor(() => expect(latest.total).toBe(110));
    await writeFile(file, ""); changed(); await vi.waitFor(() => expect(latest.id).toBeUndefined());
    selected = "thread-b"; await writeFile(file, meta("thread-b") + tokens(2)); changed();
    await vi.waitFor(() => expect(latest).toEqual({ id: "thread-b", total: 220 }));
  });

  it("主文件追加伪造 session_meta 不污染所选会话", async () => {
    const home = await makeHome(), file = path.join(home, "rollout-a.jsonl");
    await writeFile(file, meta("thread-a") + tokens(1));
    const runtime = { ...codexRuntime(home), currentRolloutPath: file };
    const provider = new CodexSessionProvider({ discovery: { discover: async () => runtime } }); providers.push(provider);
    await provider.refresh();
    await appendFile(file, meta("thread-b") + tokens(99));
    const snapshot = await provider.refresh();
    expect(snapshot.state.session?.id).toBe("thread-a"); expect(snapshot.state.tokenUsage?.totalTokens).toBe(110);
    expect(snapshot.diagnostics.some(item => item.code === "session-identity-conflict" && item.severity === "error")).toBe(true);
    expect(snapshot.hudDiagnostics?.events.dropped).toBeGreaterThan(0);
  });

  it("单个 Reducer 异常可见，后续 Token 继续更新", async () => {
    const home = await makeHome(), file = path.join(home, "rollout-a.jsonl");
    await writeFile(file, meta("thread-a") + line("turn_context", { model: "触发故障" }) + tokens(1));
    const apply = HudStateReducer.prototype.apply;
    vi.spyOn(HudStateReducer.prototype, "apply").mockImplementation(function (this: HudStateReducer, event) {
      if (event.type === "model") throw new Error("password=不应泄露的故障内容");
      return apply.call(this, event);
    });
    const provider = new CodexSessionProvider({ discovery: { discover: async () => ({ ...codexRuntime(home), currentRolloutPath: file }) } }); providers.push(provider);
    const snapshot = await provider.refresh();
    expect(snapshot.state.tokenUsage?.totalTokens).toBe(110);
    expect(snapshot.hudDiagnostics?.events.errors).toBe(1);
    expect(snapshot.diagnostics.some(item => item.code === "event-reducer" && item.severity === "error")).toBe(true);
    expect(JSON.stringify(snapshot.diagnostics)).not.toContain("不应泄露的故障内容");
  });

  it("两万条非法 UTF-8 有限诊断，合法尾部正常送达", async () => {
    const home = await makeHome(), file = path.join(home, "invalid.jsonl");
    await writeFile(file, Buffer.concat([Buffer.alloc(0), ...Array.from({ length: 20_000 }, () => Buffer.from([255, 10])), Buffer.from('{}\n')]));
    const onLine = vi.fn(), read = await new RolloutReader().read(file, { onLine });
    expect(read.invalidLines).toBe(20_000); expect(read.diagnostics.length).toBeLessThanOrEqual(50);
    expect(onLine).toHaveBeenCalledOnce(); expect(read.diagnostics.some(item => item.severity === "error")).toBe(true);
  });

  it("子线程前五十条 warning 不会掩盖后来的 error", async () => {
    const home = await makeHome(), file = path.join(home, "child.jsonl");
    await writeFile(file, meta("child") + Array.from({ length: 60 }, () => line("future_type", {})).join("") + '{"secret":\n');
    const owner = new HudStateReducer(); owner.apply({ type: "session", id: "root" });
    const child = new RolloutAgentProvider();
    const result = await child.read([{ id: "child", parentId: "root", path: file, modifiedAt: 1, subagent: true, taskAgent: true, relationConflict: false }], owner, 0);
    expect(result.diagnostics.length).toBeLessThanOrEqual(50);
    expect(result.diagnostics.some(item => item.severity === "error")).toBe(true);
    expect(child.getResourceCounts().agentDiagnosticEntries).toBeLessThanOrEqual(50);
  });

  it("EMFILE 回退只保留集中补查，停止后诊断与计时器归零", async () => {
    const home = await makeHome(), file = path.join(home, "rollout-a.jsonl");
    await writeFile(file, meta("thread-a") + tokens(1));
    watchMock.mockImplementation(() => { throw Object.assign(new Error("模拟文件描述符不足"), { code: "EMFILE" }); });
    const provider = new CodexSessionProvider({ discovery: { discover: async () => ({ ...codexRuntime(home), currentRolloutPath: file }) } }); providers.push(provider);
    await provider.start({ onSnapshot: () => {}, onDiagnostic: () => { throw new Error("诊断消费者故障"); } });
    expect(provider.getHudDiagnostics().memory.activeWatchers).toBe(0);
    expect(provider.getHudDiagnostics().warnings.some(item => item.code === "diagnostic-consumer")).toBe(true);
    await provider.stop();
    expect(provider.getHudDiagnostics()).toMatchObject({ source: { kind: "none", state: "disconnected" }, memory: { activeWatchers: 0, providerTimers: 0, rolloutPollTimers: 0 } });
  });

  it("二十轮同一 Provider start/stop 不积累 App 订阅，旧 source 不发布", async () => {
    const home = await makeHome(), clients: FakeAppServer[] = [], sources: AppServerSource[] = [];
    const provider = new CodexSessionProvider({ discovery: { discover: async () => codexRuntime(home) }, providers: { prefer_app_server: true, use_rollout_fallback: true },
      createAppServerSource: async () => { const client = new FakeAppServer(); clients.push(client); const source = new AppServerSource({ createClient: () => client }); sources.push(source); return source; } });
    providers.push(provider);
    for (let n = 0; n < 20; n++) {
      await provider.start({ onSnapshot: () => {}, onDiagnostic: () => {} });
      expect(provider.getHudDiagnostics().memory.appEventListeners).toBe(1);
      await provider.stop();
      expect(sources[n].getResourceCounts()).toMatchObject({ appConnections: 0, appEventListeners: 0, appStatusListeners: 0, appDiagnosticListeners: 0 });
      const before = provider.store.get(); clients[n].emit(tokenNotification(99)); expect(provider.store.get()).toEqual(before);
    }
    expect(clients.every(client => !client.notifications.size && !client.closes.size && !client.issues.size)).toBe(true);
  });

  it("一次 stop 报错后直接重新启动仍有订阅；停机诊断读取不虚增恢复次数", async () => {
    const home = await makeHome(), client = new FakeAppServer();
    const source = new AppServerSource({ createClient: () => client });
    const provider = new CodexSessionProvider({ discovery: { discover: async () => codexRuntime(home) }, appServerSource: source }); providers.push(provider);
    const handlers = { onSnapshot: () => {}, onDiagnostic: () => {} };
    await provider.start(handlers);
    client.stop.mockRejectedValueOnce(new Error("一次清理失败"));
    await expect(provider.stop()).rejects.toThrow("cleanup failed");
    await provider.start(handlers); client.emit(tokenNotification(2));
    await vi.waitFor(() => expect(provider.store.get().tokenUsage?.totalTokens).toBe(220));
    expect(source.getResourceCounts().appEventListeners).toBe(1);
    await provider.stop();
    const first = provider.getHudDiagnostics().recovery;
    expect(provider.getHudDiagnostics().recovery).toEqual(first);
    expect(provider.getHudDiagnostics().source.state).toBe("disconnected");
  });
});

describe("Phase 10：终端与诊断出口", () => {
  it.each([30, 40, 50, 60, 80, 100, 120, 140, 160])("%i 列全模块含 ANSI、中文和 emoji 安全排版", width => {
    const config = createDefaultConfig(); config.display.enabled = new ModuleRegistry().all().map(module => module.id);
    const state = mockState(); state.model = "\u001b[31m中文🧑‍💻模型\u001b[0m";
    const renderer = new HudRenderer();
    for (const height of [1, 3, 6, 24]) {
      const output = renderer.render(state, { width, height }, config);
      expect(output.split("\n").length).toBeLessThanOrEqual(height);
      expect(output.split("\n").every(line => stringWidth(line) <= width)).toBe(true);
      expect(output).not.toContain("\u001b"); expect(renderer.getIssues()).toEqual([]);
    }
  });

  it("单模块 render/isAvailable 故障不丢其他模块，Runtime 下一次渲染恢复", async () => {
    const registry = new ModuleRegistry(), config = createDefaultConfig(); config.display.enabled = ["model", "context"];
    const model = registry.get("model")!, original = model.render;
    model.render = () => { throw new Error("secret=模块故障"); };
    const terminal = new FakeTerminal(), provider = new FakeCodexProvider(await testSessionSnapshot());
    const runtime = new HudRuntime(config, { provider, terminal, renderer: new HudRenderer(registry), signals: new SignalHandler(new EventEmitter()) }); runtimes.push(runtime);
    try {
      await runtime.start();
      expect(terminal.frames.at(-1)).toContain("7%"); expect(terminal.frames.at(-1)).toContain("failed to render");
      expect(runtime.getStatus()).toBe("recovering");
      model.render = original;
      terminal.events?.resize();
      await vi.waitFor(() => expect(terminal.frames.at(-1)).toContain("gpt-6-astra"));
      expect(terminal.frames.at(-1)).not.toContain("failed to render"); expect(runtime.getStatus()).toBe("running");
      expect(runtime.getHudDiagnostics().render.errors).toBeGreaterThan(0);
      expect(terminal.frames.join()).not.toContain("secret=");
    } finally { model.render = original; }
  });

  it("九宽度连续 resize 与三十轮 SIGINT/SIGTERM 清理没有订阅、timer 积累", async () => {
    vi.useFakeTimers();
    const config = createDefaultConfig(), provider = new FakeCodexProvider(await testSessionSnapshot()), terminal = new FakeTerminal(), signals = new EventEmitter();
    const runtime = new HudRuntime(config, { provider, terminal, signals: new SignalHandler(signals) }); runtimes.push(runtime);
    for (let n = 0; n < 30; n++) {
      await runtime.start();
      for (const width of [30, 40, 50, 60, 80, 100, 120, 140, 160]) {
        terminal.size.width = width; terminal.events!.resize(); await vi.advanceTimersByTimeAsync(1);
        expect(terminal.frames.at(-1)!.split("\n").every(line => stringWidth(line) <= width)).toBe(true);
      }
      signals.emit(n % 2 ? "SIGINT" : "SIGTERM"); await runtime.waitForStop();
      expect(signals.eventNames()).toEqual([]); expect(terminal.events).toBeUndefined();
      expect(provider.store.getResourceCounts().stateSubscribers).toBe(0); expect(vi.getTimerCount()).toBe(0);
    }
  });

  it("挂起的输出超时拒绝，并释放错误、关闭监听和 timer", async () => {
    const output = new Writable({ write() {} });
    await expect(writeOutput(output, "不可完成的写入", 10)).rejects.toThrow("timeout");
    await new Promise(resolve => setImmediate(resolve));
    expect(output.listenerCount("error") + output.listenerCount("close")).toBe(0);
    output.destroy();
  });

  it("输出超时释放监听后迟到的 _write 失败不会产生未捕获 error", async () => {
    let complete!: (error?: Error | null) => void;
    const output = new Writable({ write(_chunk, _encoding, done) { complete = done; } });
    await expect(writeOutput(output, "迟到输出", 10)).rejects.toThrow("timeout");
    await new Promise(resolve => setImmediate(resolve));
    expect(output.destroyed).toBe(true); expect(output.listenerCount("error")).toBe(0);
    complete(new Error("迟到失败")); await new Promise(resolve => setImmediate(resolve));
    expect(output.listenerCount("error")).toBe(0);
  });

  it("doctor 的来源和 watcher 检查失败仍展示配置、Renderer 并完成清理", async () => {
    const home = await makeHome(); let text = "";
    const output = new Writable({ write(chunk, _encoding, done) { text += String(chunk); done(); } });
    const provider = { refresh: async () => { throw new Error("api_key=private-doctor-secret"); },
      probeWatcher: async () => { throw new Error("EMFILE"); }, stop: vi.fn(async () => {}) };
    const program = createProgram({ output, errorOutput: output, configFile: path.join(home, "hud.toml"), provider });
    await program.parseAsync(["doctor"], { from: "user" });
    expect(text).toContain("✗ Session source"); expect(text).toContain("✗ File watcher check");
    expect(text).toContain("No configuration file yet"); expect(text).toContain("empty-state rendering passed");
    expect(text).not.toContain("private-doctor-secret"); expect(provider.stop).toHaveBeenCalledOnce();
  });
});
