import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { appendFile, mkdir, mkdtemp, readFile, rename, rm, utimes, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { CodexDiscoveryProvider } from "../../src/providers/codex/CodexDiscoveryProvider.js";
import { CodexSessionProvider } from "../../src/providers/codex/CodexSessionProvider.js";
import { HudStateReducer } from "../../src/core/HudStateReducer.js";
import { StateStore } from "../../src/core/StateStore.js";

let home: string;
let file: string;
let provider: CodexSessionProvider;
const now = Date.parse("2026-09-11T09:00:00Z");
const fixture = (name: string) => readFile(new URL(`../fixtures/codex/${name}`, import.meta.url), "utf8");
beforeEach(async () => {
  home = await mkdtemp(path.join(os.tmpdir(), "codex-hud-session-"));
  await mkdir(path.join(home, "sessions"));
  file = path.join(home, "sessions", "rollout-a.jsonl");
  await writeFile(file, await fixture("rollout-session.jsonl"));
  provider = new CodexSessionProvider({ discovery: new CodexDiscoveryProvider({ codexHome: home, cwd: "/example/project", env: { PATH: "" } }), now: () => now });
});
afterEach(async () => { await rm(home, { recursive: true, force: true }); });

describe("CodexSessionProvider → StateStore", () => {
  it("回放真实 schema 并发布模型、推理、会话与独立累计快照", async () => {
    await appendFile(file, await fixture("rollout-token-count.jsonl"));
    const snapshot = await provider.refresh();
    expect(snapshot.state).toMatchObject({ model: "gpt-6-astra", reasoningEffort: "high", codexVersion: "0.153.4",
      tokenUsage: { totalTokens: 6475285, inputTokens: 6375573 },
      context: { usedTokens: 18994, contextWindow: 258400, remainingTokens: 239406 },
      session: { id: "session-a", startedAt: 1789101025274, turnCount: 1, lastActivityAt: 1789114286210, durationMs: now - 1789101025274 } });
    expect(snapshot.state.context?.usedPercent).toBeCloseTo(7.3506, 3);
    expect(snapshot.state.context?.cachedInputTokens).toBeUndefined();
    expect(provider.store.get()).toEqual(snapshot.state);
    expect(snapshot.diagnostics).toEqual([{ code: "usage-tracking", severity: "warning", message: "Cumulative snapshot recalculated or history has gaps; differences were not inferred as model requests" }]);
    expect(snapshot.state.usage?.coverage).toBe("partial");
  });

  it("重复累计快照不相加，重复 turn_id 不增轮数，活动时间不倒退", async () => {
    const tokens = (await fixture("rollout-token-count.jsonl")).split("\n")[0] + "\n";
    await appendFile(file, tokens);
    await provider.refresh();
    await appendFile(file, tokens + (await fixture("rollout-session.jsonl")).split("\n")[1] + "\n");
    const snapshot = await provider.refresh();
    expect(snapshot.state.tokenUsage?.totalTokens).toBe(6475285);
    expect(snapshot.state.session?.turnCount).toBe(1);
    expect(snapshot.state.session?.lastActivityAt).toBe(1789114286178);
    expect((await provider.refresh()).read.bytesRead).toBe(0);
  });

  it("半行不进入 parser，补齐后只更新一次", async () => {
    const partial = (await fixture("rollout-partial.jsonl")).trimEnd();
    await appendFile(file, partial);
    const first = await provider.refresh();
    expect(first.state.tokenUsage).toBeUndefined();
    expect(first.diagnostics).toEqual([]);
    expect(first.read.pendingBytes).toBe(Buffer.byteLength(partial));
    await appendFile(file, '{"total_token_usage":{"total_tokens":100},"last_token_usage":{"total_tokens":10},"model_context_window":1000}}}\n');
    expect((await provider.refresh()).state.tokenUsage?.totalTokens).toBe(100);
  });

  it("切换到缺少字段的新会话时清空旧模型、Token、Context 和轮数", async () => {
    await appendFile(file, await fixture("rollout-token-count.jsonl"));
    await provider.refresh();
    await utimes(file, 1, 1);
    const next = path.join(home, "sessions", "rollout-b.jsonl");
    await writeFile(next, '{"type":"session_meta","payload":{"id":"session-b","cwd":"/example/project","source":"cli"}}\n');
    const snapshot = await provider.refresh();
    expect(snapshot.state.session).toEqual({ id: "session-b", startedAt: undefined });
    expect(snapshot.state.model).toBeUndefined();
    expect(snapshot.state.context).toBeUndefined();
    expect(snapshot.state.tokenUsage).toBeUndefined();
    expect(snapshot.detections.tokenCount).toBe(false);
  });

  it("同路径文件被替换后清空旧状态并回放", async () => {
    await appendFile(file, await fixture("rollout-token-count.jsonl"));
    await provider.refresh();
    const replacement = path.join(home, "replacement");
    await writeFile(replacement, await fixture("rollout-session.jsonl"));
    await rename(replacement, file);
    expect((await provider.refresh()).state.tokenUsage).toBeUndefined();
  });

  it("没有 rollout 时保持空状态并逐项报告缺失", async () => {
    await provider.refresh();
    await rm(file);
    const snapshot = await provider.refresh();
    expect(snapshot.read.status).toBe("missing");
    expect(snapshot.state.session).toBeUndefined();
    expect(snapshot.checks.find(check => check.id === "rollout-readable")?.ok).toBe(false);
  });

  it("损坏行的诊断可见且有界，后续真实事件仍被处理", async () => {
    await appendFile(file, ('{"secret":"不应输出",\n').repeat(55) + await fixture("rollout-token-count.jsonl"));
    const snapshot = await provider.refresh();
    expect(snapshot.state.tokenUsage?.totalTokens).toBe(6475285);
    expect(snapshot.diagnostics.filter(item => item.code === "invalid-json")).toHaveLength(50);
    expect(snapshot.diagnostics.filter(item => item.code !== "usage-tracking")).toHaveLength(51);
    expect(snapshot.diagnostics.some(item => item.message.includes("5 additional parse errors"))).toBe(true);
    expect(snapshot.diagnostics.filter(item => item.code === "usage-tracking")).toHaveLength(1);
    expect(JSON.stringify(snapshot)).not.toContain("不应输出");
  });

  it("Reader 跳过的坏行诊断在下次没有新增字节时仍可见", async () => {
    await appendFile(file, Buffer.from([0xff, 10]));
    const first = await provider.refresh();
    expect(first.diagnostics.some(item => item.code === "invalid-utf8")).toBe(true);
    const next = await provider.refresh();
    expect(next.read.bytesRead).toBe(0);
    expect(next.diagnostics).toEqual(first.diagnostics);
  });

  it("大量未知额度窗口只汇总为 warning，不误判为读取失败", async () => {
    const unknown = JSON.stringify({ type: "event_msg", payload: { type: "token_count", info: null, rate_limits: { primary: {}, secondary: {} } } });
    await appendFile(file, (unknown + "\n").repeat(26));
    const snapshot = await provider.refresh();
    expect(snapshot.diagnostics).toHaveLength(51);
    expect(snapshot.diagnostics.every(item => item.severity === "warning")).toBe(true);
    expect(snapshot.diagnostics.at(-1)?.message).toContain("2 additional parse notices");
  });
});

describe("HudStateReducer 与完整状态替换", () => {
  it("压缩先清掉旧占用，等 Codex 下一次快照；累计量保持不变", () => {
    const reducer = new HudStateReducer();
    reducer.apply({ type: "tokens", total: { totalTokens: 10000 }, last: { totalTokens: 800 }, contextWindow: 1000 });
    reducer.apply({ type: "context-compacted" });
    expect(reducer.getState(now)).toMatchObject({ tokenUsage: { totalTokens: 10000 }, context: { contextWindow: 1000 } });
    expect(reducer.getState(now).context?.usedTokens).toBeUndefined();
    reducer.apply({ type: "tokens", total: { totalTokens: 10000 }, last: { totalTokens: 100 }, contextWindow: 1000 });
    expect(reducer.getState(now).context?.usedPercent).toBe(10);
  });

  it("字段缺失不造零，模型变化不保留旧上下文占用", () => {
    const reducer = new HudStateReducer();
    reducer.apply({ type: "model", model: "first", reasoningEffort: "high" });
    reducer.apply({ type: "tokens", total: { totalTokens: 0 }, last: { totalTokens: 0 }, contextWindow: 1000 });
    expect(reducer.getState(now).context?.usedPercent).toBe(0);
    reducer.apply({ type: "model", model: "second" });
    expect(reducer.getState(now).context).toBeUndefined();
    expect(reducer.getState(now).reasoningEffort).toBeUndefined();
    reducer.apply({ type: "turn-started" });
    expect(reducer.getState(now).session?.turnCount).toBeUndefined();
  });

  it("未知容量不计算百分比，超过容量不把实际用量裁成容量", () => {
    const reducer = new HudStateReducer();
    reducer.apply({ type: "tokens", last: { totalTokens: 1200 } });
    expect(reducer.getState(now).context?.usedPercent).toBeUndefined();
    reducer.apply({ type: "tokens", last: { totalTokens: 1200 }, contextWindow: 1000 });
    expect(reducer.getState(now).context).toMatchObject({ usedTokens: 1200, remainingTokens: 0, usedPercent: 120 });
  });

  it("StateStore.replace 清除嵌套旧字段并隔离输入对象", () => {
    const store = new StateStore();
    store.patch({ model: "old", quota: { fiveHour: { usedPercent: 10 } }, tokenUsage: { totalTokens: 100 } });
    const state = { session: { id: "new" } };
    store.replace(state);
    state.session.id = "changed";
    expect(store.get()).toEqual({ session: { id: "new" } });
    store.replace();
    expect(store.get().quota).toBeUndefined();
  });
});
