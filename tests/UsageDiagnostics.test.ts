import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { CapabilityDetector } from "../src/capabilities/CapabilityDetector.js";
import { debugState, formatDebug, formatRuntimeChecks } from "../src/cli/Diagnostics.js";
import { formatCapabilities, runSetup } from "../src/cli/Setup.js";
import { createDefaultConfig, parseConfig, serializeConfig } from "../src/config/Config.js";
import { AgentTracker } from "../src/core/AgentTracker.js";
import { flattenAgentTree } from "../src/core/AgentTree.js";
import { TokenUsageTracker } from "../src/core/usage/TokenUsageTracker.js";
import { RateLimitParser } from "../src/providers/codex/RateLimitParser.js";
import { usageChecks } from "../src/providers/codex/UsageDiagnostics.js";
import { HudRenderer } from "../src/renderer/HudRenderer.js";
import { ModuleRegistry } from "../src/renderer/modules/ModuleRegistry.js";
import { testSessionSnapshot } from "./fixtures.js";
import { testPricing, usage, usageRecord, usageState } from "./usage.js";

const directories: string[] = [];
afterEach(async () => { for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true }); });
const display = () => {
  const config = createDefaultConfig(); config.display.enabled = ["token-details", "cache", "cost", "five-hour-usage", "weekly-usage"];
  return { config, terminal: { width: 140, height: 24 }, isTTY: false };
};
async function snapshot() {
  const value = await testSessionSnapshot(); value.state = usageState();
  value.state.quota = new RateLimitParser().parse({ primary: { used_percent: 28, window_minutes: 10080 }, secondary: { used_percent: 42, window_minutes: 60 },
    credits: { has_credits: true, balance: "12.34" } }).quota;
  value.checks = usageChecks(value.state, true); return value;
}

describe("用量 Debug 的字段、显示与隐私", () => {
  it("新旧 Token、Cache、Cost、Quota 数值和可见模块在 debug 前后保持一致", async () => {
    const value = await snapshot(), settings = display(), safe = debugState(value.state);
    const available = (state: typeof safe) => new ModuleRegistry().all().filter(module => module.isAvailable(state)).map(module => module.id);
    expect(available(safe)).toEqual(available(value.state));
    expect(safe.usage).toEqual({ ...value.state.usage, recentRecords: [] });
    expect(safe.tokenUsage).toEqual(value.state.tokenUsage); expect(safe.cost).toEqual(value.state.cost); expect(safe.quota).toEqual(value.state.quota);
    const renderer = new HudRenderer();
    expect(renderer.render(safe, settings.terminal, settings.config, 2000)).toEqual(renderer.render(value.state, settings.terminal, settings.config, 2000));
    const text = formatDebug(value, settings); expect(text).toContain('"coverage": "complete"'); expect(text).toContain('"balance": "12.34"');
  });
  it("旧 Context 分项和子代理的 cache-write 字段也保留", () => {
    const state = { context: { ...usage(), usedTokens: 110, contextWindow: 1000, usedPercent: 11 } };
    expect(debugState(state).context).toEqual(state.context);
    const agents = new AgentTracker(); agents.setRoot("thread-a");
    agents.apply({ type: "agent-discovered", agentId: "thread-a", source: "rollout" });
    agents.apply({ type: "agent-discovered", agentId: "child", parentId: "thread-a", isSubagent: true, source: "rollout" });
    agents.updateThread("child", usageState(usage(100, 50, 10, 5), "child"));
    const child = flattenAgentTree(debugState({ agentSummary: agents.getSummary() }).agentSummary!.tree).find(entry => entry.agent.id === "child")!.agent;
    expect(child.tokens?.cacheWriteInputTokens).toBe(5); expect(child.usage?.tokens.last?.cacheWriteInputTokens).toBe(5);
  });
  it.each([false, true])("verbose=%s 逐层白名单且凭据脱敏，历史最多保留二十条", async verbose => {
    const value = await snapshot(), state = value.state, details = state.usage!;
    details.recentRecords = Array.from({ length: 25 }, (_, i) => usageRecord(i + 1));
    details.issues = Array.from({ length: 25 }, () => "password=private-issue");
    details.cost.latestCost.reason = "API_KEY=private-reason";
    details.recentRecords[24].model = "API_KEY=private-model";
    state.quota!.limitName = "authorization=private-name";
    for (const object of [details, details.tokens, details.tokens.total!, details.cache, details.cost, details.cost.latestCost,
      details.recentRecords[24], details.recentRecords[24].usage, state.quota!, state.quota!.credits!]) {
      Object.assign(object, { raw: "private-raw", prompt: "private-prompt", arguments: "private-args" });
    }
    const safe = debugState(state, verbose), text = formatDebug(value, { ...display(), verbose });
    expect(safe.usage?.recentRecords).toHaveLength(verbose ? 20 : 0); expect(safe.usage?.issues).toHaveLength(20);
    if (verbose) expect(safe.usage?.recentRecords[0].id).toBe("request-6");
    expect(text).not.toMatch(/private-(?:raw|prompt|args|reason|model|issue|name)/u);
    expect(safe.usage?.requestCount).toBe(1); expect(safe.usage?.tokens.total?.totalTokens).toBe(101000);
    expect(JSON.stringify(state)).toContain("private-raw");
  });
  it("子代理默认和 verbose 都只显示独立用量摘要，不展开请求历史", () => {
    const agents = new AgentTracker(); agents.setRoot("thread-a");
    agents.apply({ type: "agent-discovered", agentId: "thread-a", source: "rollout" });
    agents.apply({ type: "agent-discovered", agentId: "child", parentId: "thread-a", isSubagent: true, source: "rollout" });
    agents.updateThread("child", usageState(undefined, "child"));
    for (const verbose of [false, true]) {
      const child = flattenAgentTree(debugState({ agentSummary: agents.getSummary() }, verbose).agentSummary!.tree).find(entry => entry.agent.id === "child")!.agent;
      expect(child.usage).toMatchObject({ requestCount: 1, coverage: "complete", recentRecords: [] });
      expect(child.usage?.cost.sessionEstimatedCost.value).toBeCloseTo(0.073);
    }
  });
});

describe("Doctor 的独立来源与不可用原因", () => {
  it("实测 Token/Cache 不要求有额度或当前模型价格", () => {
    const checks = usageChecks(usageState(), true);
    expect(checks.find(check => check.id === "token-source")).toMatchObject({ ok: true, detail: expect.stringContaining("cumulative=measured") });
    expect(checks.find(check => check.id === "cache-source")).toMatchObject({ ok: true });
    expect(checks.find(check => check.id === "rate-limit")).toMatchObject({ ok: false, warning: true, detail: expect.stringContaining("unavailable") });
    expect(checks.find(check => check.id === "pricing-source")).toMatchObject({ ok: false, warning: true });
    expect(checks.find(check => check.id === "estimated-cost")).toMatchObject({ ok: true, detail: expect.stringContaining("estimated") });
  });
  it("已有价格但 rollout 缓存写入计费契约未知，费用保持不可用", () => {
    const tracker = new TokenUsageTracker(); tracker.consume({ threadId: "a", ordinal: 1, model: "gpt-6-astra", total: usage(100, 50, 10, 5), last: usage(100, 50, 10, 5) });
    const checks = usageChecks({ model: "gpt-6-astra", usage: tracker.snapshot() }, true);
    expect(checks.find(check => check.id === "pricing-source")).toMatchObject({ ok: true, detail: expect.stringContaining("registry/") });
    expect(checks.find(check => check.id === "estimated-cost")).toMatchObject({ ok: false, warning: true, detail: expect.stringContaining("contract") });
  });
  it("压缩估算的最近 Cache 不可用，但累计 Token 和会话费用仍独立报告", () => {
    const tracker = new TokenUsageTracker({ pricing: testPricing() });
    tracker.consume({ threadId: "a", ordinal: 1, model: "priced-a", total: usage(), last: usage() }); tracker.compact(2);
    tracker.consume({ threadId: "a", ordinal: 3, total: usage(), last: { ...usage(0, 0, 0), totalTokens: 50 } });
    const checks = usageChecks({ usage: tracker.snapshot() }, true);
    expect(checks.find(check => check.id === "token-source")).toMatchObject({ ok: true, detail: expect.stringContaining("latest=estimated") });
    expect(checks.find(check => check.id === "cache-source")).toMatchObject({ ok: false, detail: expect.stringContaining("data=estimated") });
    expect(checks.find(check => check.id === "estimated-cost")).toMatchObject({ ok: true, detail: expect.stringContaining("context estimate") });
  });
  it("零输入的命中率未定义；来源不可读时旧状态不能报告当前可用", () => {
    const state = usageState(usage(0, 0, 0)); state.model = "gpt-6-astra";
    expect(usageChecks(state, true).find(check => check.id === "cache-source")?.detail).toContain("zero input, hit rate undefined");
    const checks = usageChecks(state, false);
    for (const id of ["token-source", "cache-source", "rate-limit", "estimated-cost"]) {
      expect(checks.find(check => check.id === id)).toMatchObject({ ok: false, warning: true, detail: expect.stringContaining("unavailable") });
    }
    expect(checks.find(check => check.id === "pricing-source")?.ok).toBe(true);
  });
  it("额度独立于 Token，检查输出使用警告符号且原因脱敏", async () => {
    const value = await snapshot(); delete value.state.usage; delete value.state.tokenUsage;
    value.checks = usageChecks(value.state, true);
    const text = formatRuntimeChecks(value);
    expect(text).toContain("✓ Quota windows"); expect(text).toContain("⚠ Token source"); expect(text).toContain("⚠ Estimated cost");
    value.state = usageState(); value.state.usage!.cost.sessionEstimatedCost.reason = "password=private-reason";
    expect(JSON.stringify(usageChecks(value.state, true))).not.toContain("private-reason");
  });
});

describe("Setup 的预选能力和原配置保留", () => {
  const detector = () => new CapabilityDetector(async () => { throw new Error("不能进行在线探测"); });
  it("来源存在但当前数据缺失时可预选，输出隐藏和费用不可用原因", async () => {
    const value = await testSessionSnapshot(), report = detector().detectRollout(value), text = formatCapabilities(report);
    expect(report.modules.find(module => module.id === "cost")?.available).toBe(true);
    expect(text).toContain("Selectable in advance; hidden when data is unavailable");
    expect(text).toContain(value.state.usage!.cost.sessionEstimatedCost.reason!);
    expect(new ModuleRegistry().get("cost")!.isAvailable(value.state)).toBe(false);
  });
  it("已有 enabled 不被新默认值补选；来源暂缺时自定义保留原用量选择", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "codex-hud-usage-setup-")); directories.push(directory);
    const filePath = path.join(directory, "config.toml"), config = parseConfig('version = 1\n[display]\nenabled = ["cost", "cache"]\n');
    const original = "# 用户选择\n" + serializeConfig(config); await writeFile(filePath, original);
    const value = await snapshot(); value.read.status = "missing"; const capabilities = detector().detectRollout(value);
    await runSetup({ filePath, capabilities, write: () => {}, prompt: { choose: async () => "keep", modules: async () => [] } });
    expect(await readFile(filePath, "utf8")).toBe(original);
    const result = await runSetup({ filePath, capabilities, write: () => {}, prompt: { choose: async () => "customize", modules: async choices => {
      for (const id of ["cost", "cache"]) expect(choices.find(choice => choice.id === id)).toMatchObject({ checked: true, disabled: false });
      expect(choices.find(choice => choice.id === "token-details")?.checked).toBe(false); return ["cost", "cache"];
    } } });
    expect(result.display.enabled).toEqual(["cost", "cache"]);
  });
});
