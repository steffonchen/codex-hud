import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { EventEmitter } from "node:events";
import { fileURLToPath } from "node:url";
import { CodexSessionProvider } from "../src/providers/codex/CodexSessionProvider.js";
import type { CodexRuntime } from "../src/providers/codex/CodexDiscoveryProvider.js";
import { AppServerSource } from "../src/providers/codex/app-server/AppServerSource.js";
import { AppServerProtocol } from "../src/providers/codex/app-server/AppServerProtocol.js";
import { createDefaultConfig } from "../src/config/Config.js";
import { HudRuntime } from "../src/runtime/HudRuntime.js";
import { SignalHandler } from "../src/runtime/SignalHandler.js";
import { FakeTerminal } from "./runtime/fixtures.js";
import { RolloutReader } from "../src/providers/codex/RolloutReader.js";
import { FakeAppServer, itemNotification, settle, thread, tokenNotification, turn, usage } from "./app-server/helpers.js";
import { flattenAgentTree } from "../src/core/AgentTree.js";

let home: string, file: string, provider: CodexSessionProvider | undefined;
beforeEach(async () => { home = await mkdtemp(path.join(os.tmpdir(), "hud-source-")); file = path.join(home, "rollout.jsonl"); });
afterEach(async () => { await provider?.stop(); provider = undefined; await rm(home, { recursive: true, force: true }); });
const rows = () => [{ type: "session_meta", payload: { id: "thread-a", cli_version: "0.153.4", cwd: "/example", source: "cli" } },
  { type: "event_msg", payload: { type: "task_started", turn_id: "turn-a" } },
  { type: "turn_context", payload: { model: "gpt-6-astra", effort: "high", turn_id: "turn-a" } },
  { type: "event_msg", payload: { type: "token_count", info: { total_token_usage: { input_tokens: 100, cached_input_tokens: 20, output_tokens: 10, reasoning_output_tokens: 2, total_tokens: 110 },
    last_token_usage: { input_tokens: 100, cached_input_tokens: 20, output_tokens: 10, reasoning_output_tokens: 2, total_tokens: 110 }, model_context_window: 1000 } } }].map(value => JSON.stringify(value)).join("\n") + "\n";
function create(client: FakeAppServer, options: { fallback?: boolean; prefer?: boolean; reader?: RolloutReader; withFile?: boolean } = {}) {
  const runtime: CodexRuntime = { codexHome: home, userHome: home, sessionsPath: home, workingDirectory: "/example", currentSessionId: "thread-a",
    currentRolloutPath: options.withFile === false ? undefined : file, checks: [], diagnostics: [], agentRollouts: [] };
  const source = new AppServerSource({ createClient: () => client, reconnectDelayMs: 10000 });
  provider = new CodexSessionProvider({ discovery: { discover: async () => runtime }, appServerSource: source, reader: options.reader,
    providers: { prefer_app_server: options.prefer ?? true, use_rollout_fallback: options.fallback ?? true } });
  return { provider, runtime, source };
}
describe("双来源 Provider 与 Rollout fallback", () => {
  it("App 连接失败时 HUD 仍发布完整 Rollout 状态", async () => {
    await writeFile(file, rows()); const client = new FakeAppServer(); client.start.mockRejectedValue(new Error("SECRET"));
    const h = create(client); const snapshot = await h.provider.refresh();
    expect(snapshot.state.usage?.requestCount).toBe(1); expect(snapshot.state.dataSources).toMatchObject({ active: "rollout", degraded: true });
    expect(JSON.stringify(snapshot)).not.toContain("SECRET");
  });
  it("关闭 prefer_app_server 时完全不启动 App Server", async () => {
    await writeFile(file, rows()); const client = new FakeAppServer(); const h = create(client, { prefer: false });
    expect((await h.provider.refresh()).state.usage?.requestCount).toBe(1); expect(client.start).not.toHaveBeenCalled();
  });
  it("关闭 Rollout fallback 后可以仅靠 App 历史启动，不新增文件 watcher", async () => {
    await writeFile(file, rows()); const reader = new RolloutReader(); const watch = vi.spyOn(reader, "watch");
    const h = create(new FakeAppServer(), { fallback: false, reader }); await h.provider.start({ onSnapshot: () => {}, onDiagnostic: () => {} });
    expect(h.provider.store.get().session?.id).toBe("thread-a"); expect(h.provider.store.get().usage).toBeUndefined();
    expect(watch).not.toHaveBeenCalled(); expect(h.provider.store.get().dataSources?.active).toBe("app-server");
  });
  it("App 增量更新同一 store；通知不触发 Rollout read 或 discovery", async () => {
    await writeFile(file, rows()); const reader = new RolloutReader(); const reads = vi.spyOn(reader, "read"); const client = new FakeAppServer();
    const h = create(client, { reader }); await h.provider.start({ onSnapshot: () => {}, onDiagnostic: () => {} }); await h.provider.refresh();
    const before = reads.mock.calls.length; client.emit(tokenNotification(1)); client.emit(tokenNotification(2)); await settle();
    expect(h.provider.store.get().usage?.requestCount).toBe(2); expect(h.provider.store.get().dataSources?.tokenSource).toBe("app-server");
    expect(reads.mock.calls.length).toBe(before); expect(client.start).toHaveBeenCalledOnce();
  });
  it("App-only 子线程复用现有 Agent 状态，后续 discovery 不将其清掉", async () => {
    const client = new FakeAppServer(), h = create(client, { withFile: false }); await h.provider.start({ onSnapshot: () => {}, onDiagnostic: () => {} });
    client.emit({ method: "thread/started", params: { thread: thread("child-a", "thread-a") } });
    client.emit({ method: "turn/started", params: { threadId: "child-a", turn: turn("child-turn", "inProgress") } });
    client.emit(tokenNotification(1, 1, "child-a", "child-turn")); await settle();
    const children = () => { const summary = h.provider.store.get().agentSummary!; return flattenAgentTree([...summary.tree, ...summary.orphans]).map(row => row.agent); };
    expect(children().find(agent => agent.id === "child-a")).toMatchObject({ parentId: "thread-a", status: "running", tokens: { totalTokens: 110 }, usage: { requestCount: 1 } });
    client.emit(itemNotification({ type: "collabAgentToolCall", id: "wait-a", tool: "wait", status: "completed", senderThreadId: "thread-a",
      receiverThreadIds: ["child-a"], agentsStates: { "child-a": { status: "completed" } } }));
    await h.provider.refresh(); expect(children().find(agent => agent.id === "child-a")?.status).toBe("running");
    expect(client.start).toHaveBeenCalledOnce();
  });
  it("切换线程清空旧 Token/Plan，旧线程通知不跟随进入", async () => {
    const client = new FakeAppServer(), h = create(client, { withFile: false }); await h.provider.start({ onSnapshot: () => {}, onDiagnostic: () => {} });
    client.emit(tokenNotification(1)); await settle(); expect(h.provider.store.get().usage?.requestCount).toBe(1);
    client.threads.set("thread-b", thread("thread-b")); client.turns.set("thread-b", [turn("turn-b")]); client.loaded.add("thread-b"); h.runtime.currentSessionId = "thread-b";
    await h.provider.refresh(); expect(h.provider.store.get().usage).toBeUndefined();
    client.emit(tokenNotification(3)); await settle(); expect(h.provider.store.get().session?.id).toBe("thread-b"); expect(h.provider.store.get().usage).toBeUndefined();
  });
  it("一次性 refresh 的 stop 也关闭 App 子进程，用户配置内容不变", async () => {
    const config = path.join(home, "config.toml"); await writeFile(config, "fixture = true\n");
    const client = new FakeAppServer(), h = create(client, { withFile: false }); await h.provider.refresh(); await h.provider.stop();
    expect(client.stop).toHaveBeenCalledOnce(); expect(await readFile(config, "utf8")).toBe("fixture = true\n");
  });
  it.each(["SIGINT", "SIGTERM"])("%s 经 Runtime 关闭协议子进程并清除监听", async signal => {
    const before = process.listenerCount("exit");
    const client = new AppServerProtocol({ executable: process.execPath,
      args: [fileURLToPath(new URL("./fixtures/app-server/protocol-child.mjs", import.meta.url))] });
    const source = new AppServerSource({ createClient: () => client });
    provider = new CodexSessionProvider({ appServerSource: source, providers: { prefer_app_server: true, use_rollout_fallback: false },
      discovery: { discover: async () => ({ codexHome: home, userHome: home, sessionsPath: home, workingDirectory: "/example",
        currentSessionId: "thread-a", checks: [], diagnostics: [], agentRollouts: [] }) } });
    const signals = new EventEmitter(), terminal = new FakeTerminal();
    const hud = new HudRuntime(createDefaultConfig(), { provider, terminal, signals: new SignalHandler(signals) });
    try {
      await hud.start(); expect(source.getStatus()).toMatchObject({ state: "connected", live: true });
      signals.emit(signal); await hud.waitForStop();
      expect(source.getStatus().state).toBe("stopped"); expect(terminal.dispose).toHaveBeenCalledOnce();
      expect(client.getDiagnostics().pending).toBe(0); await expect(client.request("ping")).rejects.toMatchObject({ code: "closed" });
      expect(process.listenerCount("exit")).toBe(before); expect(signals.listenerCount(signal)).toBe(0);
    } finally { await hud.stop(); }
  });
});
