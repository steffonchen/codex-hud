import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Writable } from "node:stream";
import { CapabilityDetector } from "../src/capabilities/CapabilityDetector.js";
import { debugState, formatDebug } from "../src/cli/Diagnostics.js";
import { createProgram } from "../src/cli/Program.js";
import { recommendedConfig, runSetup } from "../src/cli/Setup.js";
import type { HudOutput } from "../src/cli/RunHud.js";
import { createDefaultConfig, parseConfig, serializeConfig } from "../src/config/Config.js";
import { AgentTracker } from "../src/core/AgentTracker.js";
import { emptyPlanCapability, type PlanEvidence } from "../src/core/PlanState.js";
import { PlanTracker } from "../src/core/PlanTracker.js";
import { HudRenderer } from "../src/renderer/HudRenderer.js";
import { discoverRolloutPlan, planChecks, planEvidenceLabel } from "../src/providers/codex/PlanDiscovery.js";
import { testSessionSnapshot } from "./fixtures.js";
import { planFixture, planMeta, planState, planUpdate, replayPlan } from "./plans.js";

const directories: string[] = [];
afterEach(async () => { for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true }); });
async function configFile() { const directory = await mkdtemp(path.join(os.tmpdir(), "codex-hud-plan-cli-")); directories.push(directory); return path.join(directory, "config.toml"); }
async function snapshot() {
  const result = await testSessionSnapshot(); result.state = replayPlan(await planFixture("plan-created")).state;
  result.checks.push(...planChecks(result.state.planSummary!)); return result;
}
const detector = () => new CapabilityDetector(() => { throw new Error("不得启动网络或协议探测"); });
const display = () => ({ config: createDefaultConfig(), terminal: { width: 140, height: 24 }, isTTY: false });

describe("Plan 来源发现和配置兼容", () => {
  it("没有事件是未观测，不能报告不支持", () => {
    expect(discoverRolloutPlan(undefined, "ready")).toEqual(emptyPlanCapability());
    expect(planChecks(new PlanTracker().getSummary()).find(check => check.id === "plan-source")?.detail).toContain("not observed does not imply");
  });
  it.each(["missing", "error"] as const)("来源 %s 时现有字段不能冒充当前可用", status => {
    const capability = discoverRolloutPlan(planState().planSummary, status);
    expect(capability.available).toBe(false); expect(capability.planEvents).toBe("unavailable"); expect(capability.stepStatuses).toBe("unavailable");
  });
  it("未核验的高层事件只增加 partial，不凭空创建可用数据", () => {
    expect(discoverRolloutPlan(undefined, "ready", true)).toMatchObject({ available: false, planEvents: "partial", stepStatuses: "not-observed" });
    expect(discoverRolloutPlan(planState().planSummary, "ready", true)).toMatchObject({ available: true, planEvents: "partial" });
  });
  it.each([ ["available", "Available"], ["unsupported", "Unsupported"], ["not-observed", "Not observed"],
    ["disabled", "Disabled"], ["unavailable", "Source unavailable"], ["partial", "Partially available"] ] as Array<[PlanEvidence, string]>)("诊断分类 %s 保持独立含义", (evidence, label) => {
    expect(planEvidenceLabel(evidence)).toBe(label);
  });
  it("有真实清单时 setup 推荐 Plan，不触发在线探测", async () => {
    const report = detector().detectRollout(await snapshot());
    expect(report.modules.find(module => module.id === "plan")).toMatchObject({ available: true, protocolSupported: null });
    expect(recommendedConfig(report).display.enabled).toContain("plan");
  });
  it("仅明确模式字段也可选择 Plan，但不能称已经有执行清单", async () => {
    const value = await snapshot(); const tracker = new PlanTracker(); tracker.apply({ ...planMeta(), type: "plan-mode", active: false });
    value.state.planSummary = tracker.getSummary(); const report = detector().detectRollout(value);
    expect(report.modules.find(module => module.id === "plan")).toMatchObject({ available: true, evidence: [expect.stringContaining("no execution checklist yet")] });
    expect(value.state.planSummary.capability.stepStatuses).toBe("not-observed");
  });
  it("已有显式 enabled 不被新默认值补选", () => {
    const config = parseConfig('version = 1\n[display]\nenabled = ["model"]\n');
    expect(createDefaultConfig().display.enabled).toContain("plan"); expect(config.display.enabled).toEqual(["model"]);
  });
  it("setup 保留旧配置时文件字节不变", async () => {
    const filePath = await configFile(); const old = createDefaultConfig(); old.display.enabled = ["model"];
    const original = "# 手动说明\n" + serializeConfig(old); await writeFile(filePath, original);
    await runSetup({ filePath, capabilities: detector().detectRollout(await snapshot()), prompt: {
      choose: async () => "keep", modules: async () => { throw new Error("不应打开多选"); } }, write: () => {} });
    expect(await readFile(filePath, "utf8")).toBe(original);
  });
  it("自定义从用户原选择开始，Plan 仅在主动选中后写入", async () => {
    const filePath = await configFile(); const old = createDefaultConfig(); old.display.enabled = ["model"];
    await writeFile(filePath, serializeConfig(old));
    const result = await runSetup({ filePath, capabilities: detector().detectRollout(await snapshot()), prompt: { choose: async () => "customize", modules: async choices => {
      expect(choices.find(choice => choice.id === "plan")).toMatchObject({ checked: false, disabled: false });
      return ["model", "plan"]; } }, write: () => {} });
    expect(result.display.enabled).toEqual(["model", "plan"]); expect(result.behavior).toEqual(old.behavior);
  });
  it("doctor 区分显示关闭、来源可用与 App Server 未订阅", async () => {
    const filePath = await configFile(); const config = createDefaultConfig(); config.display.enabled = ["model"];
    await writeFile(filePath, serializeConfig(config)); let text = "";
    const output: HudOutput = new Writable({ write(chunk, _encoding, callback) { text += String(chunk); callback(); } }); output.isTTY = false;
    const value = await snapshot(); const refresh = vi.fn(async () => value);
    await createProgram({ configFile: filePath, output, errorOutput: output, detector: detector(), provider: { refresh } }).parseAsync(["doctor"], { from: "user" });
    expect(text).toContain("Disabled"); expect(text).toContain("confirmed plan data"); expect(text).toContain("Disabled; using confirmed Rollout plans");
    expect(await readFile(filePath, "utf8")).toBe(serializeConfig(config)); expect(refresh).toHaveBeenCalledOnce();
  });
});

describe("Plan debug 白名单与正文隐私", () => {
  it("默认 stderr 只显示摘要，stdout HUD 仍有步骤", async () => {
    const value = await snapshot(); const output = formatDebug(value, display());
    expect(output).toContain("\"Plan\""); expect(output).toContain("\"Completed steps\""); expect(output).not.toContain('"planSummary"');
    expect(output).not.toContain("检查结构"); expect(output).not.toContain("plan-event-");
    const config = createDefaultConfig(); config.display.enabled = ["plan"];
    expect(new HudRenderer().render(debugState(value.state), { width: 140, height: 24 }, config)).toContain("● 检查结构");
  });
  it("verbose 包含脱敏步骤、来源、能力和事件摘要", async () => {
    const value = await snapshot(); const output = formatDebug(value, { ...display(), verbose: true });
    for (const field of ["planSummary", "检查结构", "plan-event-", "rollout", "stepStatuses"]) expect(output).toContain(field);
  });
  it.each([false, true])("verbose=%s 都不会输出任意原始字段或敏感标题", async verbose => {
    const value = await snapshot(); const plan = value.state.planSummary!.execution!;
    Object.assign(plan, { prompt: "private-prompt", raw: "private-raw" }); plan.steps[0].title = "API_KEY=private-title";
    Object.assign(plan.steps[0], { arguments: "private-args" }); plan.explanation = "password=private-explanation";
    const output = formatDebug(value, { ...display(), verbose }); expect(output).not.toMatch(/private-(?:prompt|raw|title|args|explanation)/u);
  });
  it("完整提案仅在 verbose 且 authoritative ready 时输出", async () => {
    const value = await snapshot(); const tracker = new PlanTracker(); tracker.apply({ ...planMeta(), type: "plan-proposed", itemId: "item", turnId: "turn-a",
      text: "完整方案第一段\n部署 API_KEY=private-value", complete: true }); value.state.planSummary = tracker.getSummary();
    expect(formatDebug(value, display())).not.toContain("完整方案第一段");
    const verbose = formatDebug(value, { ...display(), verbose: true }); expect(verbose).toContain("完整方案第一段"); expect(verbose).not.toContain("private-value");
    value.state.planSummary.proposal!.status = "streaming";
    expect(formatDebug(value, { ...display(), verbose: true })).not.toContain("完整方案第一段");
  });
  it("子计划默认只有计数，verbose 才展开标题", async () => {
    const value = await snapshot(); const agents = new AgentTracker(); agents.setRoot("root");
    agents.apply({ type: "agent-discovered", agentId: "root", source: "rollout" });
    agents.apply({ type: "agent-discovered", agentId: "child", parentId: "root", isSubagent: true, source: "rollout" });
    const tracker = new PlanTracker(); const event = planUpdate(); if (event.type === "plan-updated") event.steps[0].title = "子计划详细步骤";
    tracker.apply({ ...event, threadId: "child" }); agents.updateThread("child", { planSummary: tracker.getSummary() }); value.state.agentSummary = agents.getSummary();
    expect(formatDebug(value, display())).not.toContain("子计划详细步骤");
    expect(formatDebug(value, { ...display(), verbose: true })).toContain("子计划详细步骤");
  });
});
