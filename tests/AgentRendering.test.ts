import { describe, expect, it } from "vitest";
import { AgentTracker } from "../src/core/AgentTracker.js";
import { legacyAgentTree } from "../src/core/AgentTree.js";
import { renderAgentTree } from "../src/renderer/modules/AgentModule.js";
import { HudRenderer } from "../src/renderer/HudRenderer.js";
import { WidthPolicy } from "../src/renderer/WidthPolicy.js";
import { createDefaultConfig } from "../src/config/Config.js";
import { CapabilityDetector } from "../src/capabilities/CapabilityDetector.js";
import { debugState, formatDebug } from "../src/cli/Diagnostics.js";
import { testSessionSnapshot } from "./fixtures.js";
import { agentState } from "./agents.js";

function state() {
  const tracker = new AgentTracker(); tracker.setRoot("root");
  for (const [id, status] of [["root", "running"], ["explorer", "running"], ["reviewer", "failed"], ["tester", "completed"]] as const) {
    tracker.apply({ type: "agent-discovered", agentId: id, parentId: id === "root" ? undefined : "root", name: id, source: "rollout" });
    tracker.apply({ type: "agent-status", agentId: id, status, at: 1000, source: "rollout" });
    tracker.updateThread(id, { context: { usedPercent: 41 }, activity: { status: "running", label: "搜索中" } });
  }
  const agentSummary = tracker.getSummary();
  return { agentSummary, agents: legacyAgentTree(agentSummary.tree) };
}

describe("Agent Tree 自适应展示", () => {
  it("宽屏显示树、Context、活动与独立失败符号", () => {
    const text = renderAgentTree(state().agentSummary, { width: 120, height: 24, maxRows: 24, density: "full", now: 4000 });
    expect(text).toContain("Main agent"); expect(text).toContain("Context 41%"); expect(text).toContain("搜索中"); expect(text).toContain("✗ reviewer"); expect(text).toContain("3s");
  });
  it.each([[120, 24], [80, 12], [50, 10], [30, 8], [24, 5], [12, 4], [8, 2]])("%i×%i 不溢出终端", (width, height) => {
    const config = createDefaultConfig(); config.display.enabled = ["agents"];
    const text = new HudRenderer().render(state(), { width, height }, config);
    expect(text.split("\n").length).toBeLessThanOrEqual(height);
    for (const line of text.split("\n")) expect(new WidthPolicy().measure(line)).toBeLessThanOrEqual(width);
    expect(text).toContain("✗1"); expect(text).toContain("●2");
  });
  it("NO_COLOR 不依赖颜色表达状态", () => {
    const text = renderAgentTree(state().agentSummary, { width: 100, height: 20, density: "full" });
    expect(text).not.toContain("\x1b"); expect(text).toContain("●"); expect(text).toContain("✓"); expect(text).toContain("✗");
  });
  it("缺少 Context 使用破折号", () => {
    const value = state(); value.agentSummary.tree[0].children[0].agent.context = undefined;
    expect(renderAgentTree(value.agentSummary, { width: 120, height: 24, density: "full" })).toContain("Context —");
  });
  it("四层之后折叠", () => {
    const t = new AgentTracker(); t.setRoot("a0");
    for (let index = 0; index < 7; index++) {
      t.apply({ type: "agent-discovered", agentId: `a${index}`, parentId: index ? `a${index - 1}` : undefined, source: "rollout" });
      t.apply({ type: "agent-status", agentId: `a${index}`, status: "running", source: "rollout" });
    }
    const text = renderAgentTree(t.getSummary(), { width: 120, height: 30, density: "full" });
    expect(text).toContain("Deeper agents"); expect(text).not.toContain("Agent-a6");
  });
  it("极短高度只展示统计", () => { expect(renderAgentTree(state().agentSummary, { width: 80, height: 3, density: "full" }).split("\n")).toHaveLength(1); });
  it("用户不选 agents 时不显示", () => {
    const config = createDefaultConfig(); config.display.enabled = [];
    expect(new HudRenderer().render(state(), { width: 120, height: 24 }, config)).toBe("");
  });
  it("主线程 idle 但子代理运行时保持显示", () => {
    const config = createDefaultConfig(); config.display.enabled = ["agents"]; config.behavior.hide_when_idle = true;
    expect(new HudRenderer().render({ ...state(), activity: { status: "idle" } }, { width: 120, height: 24 }, config)).toContain("explorer");
  });
  it("同名代理使用不冲突的短身份", () => {
    const value = state(); for (const node of value.agentSummary.tree[0].children) node.agent.name = "同名";
    const text = renderAgentTree(value.agentSummary, { width: 120, height: 24, density: "full" });
    expect(text).toContain("同名-orer"); expect(text).toContain("同名-ewer");
  });
  it("名称中的凭证与终端控制字符被清除", () => {
    const value = state(); value.agentSummary.tree[0].children[0].agent.name = "\x1b[31mtoken=不能泄露";
    expect(renderAgentTree(value.agentSummary, { width: 120, height: 24, density: "full" })).not.toMatch(/不能泄露|\x1b/u);
  });
  it("布局给树分配其他模块之后的剩余行数", () => {
    const config = createDefaultConfig(); config.display.enabled = ["model", "agents", "context"];
    const value = { ...state(), model: "模型", context: { usedPercent: 10, usedTokens: 10, contextWindow: 100 } };
    const text = new HudRenderer().render(value, { width: 120, height: 6 }, config);
    expect(text.split("\n").length).toBeLessThanOrEqual(6); expect(text).toContain("Agents"); expect(text).toContain("Context");
  });
  it("有界显示完成历史", () => {
    const t = new AgentTracker(); t.setRoot("root"); t.apply({ type: "agent-discovered", agentId: "root", source: "rollout" });
    for (let index = 0; index < 20; index++) {
      t.apply({ type: "agent-discovered", agentId: `done${index}`, parentId: "root", name: `结束${index}`, source: "rollout" });
      t.apply({ type: "agent-status", agentId: `done${index}`, status: "completed", at: index, source: "rollout" });
    }
    const text = renderAgentTree(t.getSummary(), { width: 120, height: 50, density: "full" });
    expect((text.match(/✓ 结束/gu) ?? []).length).toBe(5); expect(text).toContain("15 more agents");
  });
});

describe("Agents capability 与 debug 白名单", () => {
  it("CLI 明确启用且没有历史事件时允许 setup 选择", async () => {
    const snapshot = await testSessionSnapshot(); snapshot.runtime.agentFeatureEnabled = true;
    expect(new CapabilityDetector().detectRollout(snapshot).modules.find(module => module.id === "agents")?.available).toBe(true);
  });
  it("未检测到事件不能冒称 unsupported", async () => {
    const snapshot = await testSessionSnapshot(); const capability = new CapabilityDetector().detectRollout(snapshot).modules.find(module => module.id === "agents")!;
    expect(capability.available).toBe(false); expect(capability.reason).toContain("No agent events observed"); expect(capability.reason).not.toContain("unsupported");
  });
  it("CLI disabled 与历史 Desktop 事件分开报告", async () => {
    const snapshot = await testSessionSnapshot(); snapshot.runtime.agentFeatureEnabled = false; snapshot.state = await agentState();
    expect(new CapabilityDetector().detectRollout(snapshot).modules.find(module => module.id === "agents")?.available).toBe(true);
  });
  it("debug 能显示真实 Agent Tree", async () => {
    const source = await agentState(); const safe = debugState(source);
    const config = createDefaultConfig(); config.display.enabled = ["agents"];
    expect(new HudRenderer().render(safe, { width: 120, height: 20 }, config)).toContain("explorer");
  });
  it("debug 丢弃 Agent 原始 prompt、输入、输出和额外字段", () => {
    const source = state(); Object.assign(source.agentSummary.tree[0].agent, { prompt: "隐藏正文", command: "秘密命令", output: "隐私输出", authorization: "秘密凭证" });
    expect(JSON.stringify(debugState(source))).not.toMatch(/隐藏正文|秘密命令|隐私输出|秘密凭证/u);
  });
  it("debug 包含 Agent discovery、读取及关联结果", async () => {
    const snapshot = await testSessionSnapshot(); snapshot.state = state();
    const text = formatDebug(snapshot); expect(text).toContain("Agent discovery"); expect(text).toContain("correlation"); expect(text).toContain("strong");
  });
});
