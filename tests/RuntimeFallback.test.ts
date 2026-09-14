import { afterEach, describe, expect, it, vi } from "vitest";
import { appendFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { CodexSessionProvider } from "../src/providers/codex/CodexSessionProvider.js";
import { AppServerSource } from "../src/providers/codex/app-server/AppServerSource.js";
import { RuntimeConnectionManager } from "../src/providers/codex/runtime/RuntimeConnectionManager.js";
import type { RuntimePolicy } from "../src/providers/codex/runtime/RuntimePolicy.js";
import { RolloutReader } from "../src/providers/codex/RolloutReader.js";
import { RolloutSource } from "../src/providers/codex/RolloutSource.js";
import { flattenAgentTree } from "../src/core/AgentTree.js";
import { RuntimeClient, cleanupRuntimeFixtures, codexRuntime, discovery, makeHome } from "./runtime-authority/helpers.js";
import { command, itemNotification, settle, thread, tokenNotification, turn } from "./app-server/helpers.js";

const { watchMock } = vi.hoisted(() => ({ watchMock: vi.fn() }));
vi.mock("node:fs", async original => ({ ...await original<typeof import("node:fs")>(), watch: watchMock }));
const providers: CodexSessionProvider[] = [];
afterEach(async () => { await Promise.all(providers.splice(0).map(provider => provider.stop())); await cleanupRuntimeFixtures(); watchMock.mockReset(); vi.restoreAllMocks(); });
const row = (type: string, payload: object) => JSON.stringify({ timestamp: "2026-09-13T00:00:00Z", type, payload }) + "\n";
const tokens = (n: number) => row("event_msg", { type: "token_count", info: {
  total_token_usage: { input_tokens: n * 100, cached_input_tokens: n * 20, cache_write_input_tokens: 0, output_tokens: n * 10, reasoning_output_tokens: n * 2, total_tokens: n * 110 },
  last_token_usage: { input_tokens: 100, cached_input_tokens: 20, cache_write_input_tokens: 0, output_tokens: 10, reasoning_output_tokens: 2, total_tokens: 110 }, model_context_window: 1000 } });
const initial = () => row("session_meta", { id: "thread-a", cli_version: "0.153.4", cwd: "/fixture", source: "cli" })
  + row("event_msg", { type: "task_started", turn_id: "turn-a" })
  + row("turn_context", { turn_id: "turn-a", model: "gpt-6-astra", effort: "medium" }) + tokens(1);
async function fixture(options: { clients?: RuntimeClient[]; active?: boolean; policy?: Partial<RuntimePolicy>; unavailable?: boolean } = {}) {
  const home = await makeHome(), file = path.join(home, "rollout-a.jsonl"), runtime = codexRuntime(home);
  runtime.currentRolloutPath = file; if (options.active === false) runtime.activeThreadId = undefined;
  await writeFile(file, initial());
  const clients = options.clients ?? [new RuntimeClient(home)], createClient = vi.fn(() => clients.shift()!);
  const reader = new RolloutReader();
  let manager!: RuntimeConnectionManager, source!: AppServerSource;
  const factory = vi.fn(async (_runtime: typeof runtime, policy?: Partial<RuntimePolicy>) => {
    manager = new RuntimeConnectionManager({ runtime, policy, discovery: { discover: async () => discovery([], options.unavailable
      ? { status: "error", processScan: "unavailable", issues: ["合成进程表不可读"] } : {}) }, createClient });
    source = new AppServerSource({ connectionManager: manager, reconnectDelayMs: 100 }); return source;
  });
  const provider = new CodexSessionProvider({ discovery: { discover: async () => runtime }, reader,
    providers: { prefer_app_server: true, use_rollout_fallback: true }, runtime: options.policy, createAppServerSource: factory });
  providers.push(provider);
  return { home, file, runtime, reader, factory, provider, clients, createClient, manager: () => manager, source: () => source };
}

describe("Runtime manager → Source → 既有 trackers 的完整链路", () => {
  it("缺少明确线程仅回放历史，默认 allow_spawn 也不会启动", async () => {
    const h = await fixture({ active: false }), snapshot = await h.provider.refresh();
    expect(snapshot.state).toMatchObject({ model: "gpt-6-astra", tokenUsage: { totalTokens: 110 }, usage: { requestCount: 1 },
      dataSources: { active: "rollout", degraded: true, appServer: { runtime: { authority: "thread-authority-unknown" } } } });
    expect(h.createClient).not.toHaveBeenCalled();
  });
  it("runtime 配置穿过 Provider factory，未知进程表回退时保留用量和费用", async () => {
    const policy = { allow_spawn: false, auto_reconnect: false }, h = await fixture({ policy, unavailable: true });
    const snapshot = await h.provider.refresh();
    expect(h.factory).toHaveBeenCalledWith(h.runtime, policy); expect(h.createClient).not.toHaveBeenCalled();
    expect(snapshot.state.usage).toMatchObject({ requestCount: 1, cache: { hitRate: 0.2 } });
    expect(snapshot.state.usage?.cost.sessionEstimatedCost.value).toBeGreaterThan(0);
    expect(snapshot.state.dataSources).toMatchObject({ active: "rollout", fallbackEnabled: true });
  });
  it("实时事件与断线补读共用 tracker，不重复 Token、工具、计划或费用", async () => {
    const h = await fixture(), first = h.clients[0], second = new RuntimeClient(h.home); h.clients.push(second);
    watchMock.mockImplementation(() => { throw Object.assign(new Error("合成监听故障"), { code: "EMFILE" }); });
    await h.provider.start({ onSnapshot: () => {}, onDiagnostic: () => {} });
    first.emit(tokenNotification(1)); first.emit(itemNotification(command()));
    const plan = { method: "turn/plan/updated", params: { threadId: "thread-a", turnId: "turn-a", explanation: null,
      plan: [{ step: "已确认步骤", status: "inProgress" }] } };
    first.emit(plan); await h.provider.refresh();
    const planBefore = h.provider.store.get().planSummary!.execution!, previousId = h.manager().getState().runtimeId;
    first.disconnect(); await appendFile(h.file, tokens(2)); await h.provider.refresh();
    second.turns.set("thread-a", [turn("turn-a", "completed", [command()])]);
    await vi.waitFor(() => expect(h.source().getStatus().live).toBe(true));
    second.emit(tokenNotification(2)); second.emit(itemNotification(command())); second.emit(plan); await settle();
    const state = h.provider.store.get();
    expect(state.usage?.requestCount).toBe(2); expect(state.tokenUsage?.totalTokens).toBe(220);
    expect(state.tools?.recent).toHaveLength(1);
    expect(state.planSummary?.execution).toMatchObject({ planId: planBefore.planId, totalCount: 1, steps: planBefore.steps });
    expect(h.manager().getState().runtimeId).not.toBe(previousId);
    const cost = state.usage?.cost.sessionEstimatedCost.value; second.emit(tokenNotification(2)); await settle();
    expect(h.provider.store.get().usage?.cost.sessionEstimatedCost.value).toBe(cost);
    expect(h.reader.getWatchStatus()).toMatchObject({ mode: "polling", activeWatchers: 0, reason: "EMFILE" });
    await appendFile(h.file, tokens(3)); await h.provider.refresh(); second.emit(tokenNotification(3)); await settle();
    expect(h.provider.store.get().tokenUsage?.totalTokens).toBe(330);
  });
  it("明确的 App Server 子线程关系沿用 AgentTracker，不建立第二套状态", async () => {
    const h = await fixture(), client = h.clients[0]; await h.provider.refresh();
    client.emit({ method: "thread/started", params: { thread: thread("child-a", "thread-a") } });
    client.emit({ method: "turn/started", params: { threadId: "child-a", turn: turn("child-turn", "inProgress") } });
    client.emit(tokenNotification(1, 1, "child-a", "child-turn"));
    const snapshot = await h.provider.refresh(), summary = snapshot.state.agentSummary!;
    expect(flattenAgentTree([...summary.tree, ...summary.orphans]).find(({ agent }) => agent.id === "child-a")?.agent)
      .toMatchObject({ parentId: "thread-a", tokens: { totalTokens: 110 } });
  });
  it("Provider stop 首项失败也会释放 Rollout，并保留失败结果", async () => {
    const h = await fixture({ active: false }), stopRollout = vi.spyOn(RolloutSource.prototype, "stop"); await h.provider.refresh();
    vi.spyOn(h.source(), "stop").mockRejectedValueOnce(new Error("合成清理失败"));
    await expect(h.provider.stop()).rejects.toThrow("Session source cleanup failed"); expect(stopRollout).toHaveBeenCalled();
  });
});
