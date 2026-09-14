import { describe, expect, it } from "vitest";
import { createDefaultConfig } from "../src/config/Config.js";
import { AgentTracker } from "../src/core/AgentTracker.js";
import { flattenAgentTree, legacyAgentTree } from "../src/core/AgentTree.js";
import { HudStateReducer } from "../src/core/HudStateReducer.js";
import { PlanTracker } from "../src/core/PlanTracker.js";
import { HudRenderer } from "../src/renderer/HudRenderer.js";
import { LayoutEngine } from "../src/renderer/LayoutEngine.js";
import { WidthPolicy } from "../src/renderer/WidthPolicy.js";
import { ModuleRegistry } from "../src/renderer/modules/ModuleRegistry.js";
import { planModule } from "../src/renderer/modules/PlanModule.js";
import { planMeta, planState, planUpdate } from "./plans.js";

const renderer = new HudRenderer();
const policy = new WidthPolicy();
const config = () => { const result = createDefaultConfig(); result.display.enabled = ["plan"]; return result; };
const fiveSteps = () => planState(["completed", "completed", "in_progress", "pending", "pending"]);

describe("Plan 宽高适配与状态展示", () => {
  it.each([140, 80, 50, 30].flatMap(width => [20, 8, 6, 4].map(height => ({ width, height }))))("$width 列、$height 行内保留进度并遵守预算", size => {
    const output = renderer.render(fiveSteps(), size, config());
    expect(output).toContain("2/5"); expect(output.split("\n").length).toBeLessThanOrEqual(policy.rowBudget(size));
    expect(output.split("\n").every(line => policy.measure(line) <= size.width)).toBe(true);
  });
  it("宽屏展示原始步骤顺序、全部符号及正确完成比例", () => {
    const output = renderer.render(fiveSteps(), { width: 140, height: 20 }, config());
    expect(output).toBe("Plan 2/5 40%\n✓ 步骤 1\n✓ 步骤 2\n● 步骤 3\n○ 步骤 4\n○ 步骤 5");
  });
  it("50 列显示各步骤状态统计，30 列只保留摘要", () => {
    expect(renderer.render(fiveSteps(), { width: 50, height: 20 }, config())).toBe("Plan 2/5\n✓2 ●1 ○2");
    expect(renderer.render(fiveSteps(), { width: 30, height: 20 }, config())).toBe("P 2/5");
  });
  it("5 至 6 行只显示当前步骤，更矮时只保留摘要", () => {
    expect(renderer.render(fiveSteps(), { width: 140, height: 6 }, config())).toBe("Plan 2/5 40%\n● 步骤 3");
    expect(renderer.render(fiveSteps(), { width: 140, height: 4 }, config())).toBe("Plan 2/5 40%");
  });
  it("有限高度以当前步骤为中心，并提示省略数量", () => {
    const output = renderer.render(fiveSteps(), { width: 140, height: 8 }, config());
    expect(output).toContain("● 步骤 3"); expect(output).toContain("3 more steps"); expect(output).not.toContain("○ 步骤 5");
  });
  it.each([ ["failed", "✗"], ["cancelled", "⊘"], ["unknown", "?"] ] as const)("极窄摘要保留 %s 状态", (status, symbol) => {
    const tracker = new PlanTracker(); tracker.apply(planUpdate());
    if (status === "unknown") tracker.apply(planUpdate(2, ["completed", "unknown", "pending"]));
    else tracker.apply({ ...planMeta(2), type: "plan-status", status });
    const output = renderer.render({ planSummary: tracker.getSummary() }, { width: 8, height: 4 }, config());
    expect(output).toContain(symbol); expect(output).toContain("1/3"); expect(policy.measure(output)).toBeLessThanOrEqual(8);
  });
  it("完成、失败和取消步骤拥有独立符号", () => {
    const output = renderer.render(planState(["completed", "failed", "cancelled", "unknown", "pending"]), { width: 140, height: 20 }, config());
    for (const value of ["✗ Failed", "✓ 步骤 1", "✗ 步骤 2", "⊘ 步骤 3", "? 步骤 4", "○ 步骤 5"]) expect(output).toContain(value);
    expect(renderer.render(planState(["completed"]), { width: 140, height: 20 }, config())).toContain("✓ Completed 1/1 100%");
  });
  it.each([false, true])("提案 complete=%s 只显示生成或待确认，不显示正文与执行比例", complete => {
    const tracker = new PlanTracker(); tracker.apply(planUpdate()); tracker.apply({ ...planMeta(2), type: "plan-proposed", itemId: "proposal", turnId: "turn-a",
      text: "不应显示的完整提案正文", complete });
    const output = renderer.render({ planSummary: tracker.getSummary() }, { width: 140, height: 20 }, config());
    expect(output).toBe(complete ? "Plan proposal · Awaiting confirmation" : "Plan proposal · Generating"); expect(output).not.toMatch(/正文|1\/3|%/u);
  });
  it("模式独立显示，无状态或空清单不伪造进度", () => {
    const tracker = new PlanTracker(); expect(planModule.isAvailable({ planSummary: tracker.getSummary() })).toBe(false);
    tracker.apply({ ...planMeta(), type: "plan-mode", active: true });
    expect(renderer.render({ planSummary: tracker.getSummary() }, { width: 140, height: 20 }, config())).toBe("Plan mode");
    expect(renderer.render(planState([]), { width: 140, height: 20 }, config())).toBe("");
  });
  it("中文、emoji、超长标题与控制字符在截断前脱敏", () => {
    const state = planState(); state.planSummary.execution!.steps[1].title = 'API_KEY="private-value"\x1b[2J' + "实现👩‍💻".repeat(50);
    const output = renderer.render(state, { width: 80, height: 20 }, config());
    expect(output).toContain("●"); expect(output).not.toMatch(/private-value|\x1b/u);
    expect(output.split("\n").every(line => policy.measure(line) <= 80)).toBe(true);
  });
  it("旧接口仍可使用，标题也经过脱敏", () => {
    const output = renderer.render({ plan: { items: [{ text: "执行 password=private-value", status: "in_progress" }] } }, { width: 140, height: 20 }, config());
    expect(output).toContain("0/1"); expect(output).not.toContain("private-value");
    expect(renderer.render({ plan: { completed: 0, total: 0 } }, { width: 140, height: 20 }, config())).toContain("0/0");
  });
  it("布局按既有优先级分配空间，Activity 和 Tool 不改写 Plan", () => {
    const reducer = new HudStateReducer(); reducer.apply({ type: "session", id: "thread-a" }); reducer.apply(planUpdate());
    const before = reducer.getState(0).planSummary;
    reducer.apply({ type: "tool-started", toolId: "command", name: "exec_command", toolType: "shell", at: 10, inputSummary: "npm test" });
    const state = reducer.getState(20); expect(state.planSummary).toEqual(before);
    const modules = new ModuleRegistry().resolve(["model", "plan", "current-activity", "tools"]);
    const layout = new LayoutEngine().layout({ ...state, model: "测试模型" }, { width: 140, height: 6 }, modules);
    expect(layout.lines.length).toBeLessThanOrEqual(6); expect(layout.lines.join("\n")).toContain("1/3");
    expect(layout.lines.join("\n")).toContain("步骤 2"); expect(layout.lines.join("\n")).toContain("npm test");
    expect(state.planSummary).toEqual(before);
  });
});

describe("明确线程关联的代理计划（归一化契约）", () => {
  const setup = () => {
    const agents = new AgentTracker(); agents.setRoot("thread-a");
    agents.apply({ type: "agent-discovered", agentId: "thread-a", source: "rollout" });
    agents.apply({ type: "agent-discovered", agentId: "child", parentId: "thread-a", isSubagent: true, name: "探索者", source: "rollout" });
    const tracker = new PlanTracker(); tracker.apply({ ...planUpdate(), threadId: "child" });
    return { agents, childState: { planSummary: tracker.getSummary() } };
  };
  it("root 的计划不重复挂到主代理名下", () => {
    const { agents } = setup(); agents.updateThread("thread-a", planState());
    expect(agents.getSummary().tree[0].agent.plan).toBeUndefined();
  });
  it("子线程 ID 完全一致时才能展示其独立进度", () => {
    const { agents, childState } = setup(); agents.updateThread("child", childState);
    const settings = config(); settings.display.enabled = ["agents"];
    const summary = agents.getSummary();
    const output = renderer.render({ agentSummary: summary, agents: legacyAgentTree(summary.tree) }, { width: 140, height: 20 }, settings);
    expect(output).toContain("探索者"); expect(output).toContain("Plan 1/3");
  });
  it("最新代理不能接收不属于自己的 Plan", () => {
    const { agents } = setup(); agents.updateThread("child", planState());
    const summary = agents.getSummary(); expect(flattenAgentTree([...summary.tree, ...summary.orphans]).every(({ agent }) => !agent.plan)).toBe(true);
  });
  it.each(["executing", "failed"] as const)("80 列长 MCP 活动不挤掉子计划 %s 进度或状态", status => {
    const { agents, childState } = setup(); childState.planSummary.execution!.status = status;
    agents.updateThread("child", { ...childState, context: { usedPercent: 25 }, activity: { status: "running", label: "调用工具",
      mcp: { serverId: "search", serverName: "project_context_search", toolName: "search_repository_context_with_dependencies" } } });
    agents.apply({ type: "agent-status", agentId: "child", status: "running", source: "rollout" });
    const summary = agents.getSummary(), settings = config(); settings.display.enabled = ["agents"];
    const output = renderer.render({ agentSummary: summary, agents: legacyAgentTree(summary.tree) }, { width: 80, height: 20 }, settings);
    expect(output).toContain(status === "failed" ? "P ✗1/3" : "P 1/3");
    expect(output.split("\n").every(line => policy.measure(line) <= 80)).toBe(true);
  });
  it("代理失败不代表它的 Plan 失败，来源失联才清除旧数据", () => {
    const { agents, childState } = setup(); agents.updateThread("child", childState);
    agents.apply({ type: "agent-status", agentId: "child", status: "failed", source: "rollout", at: 10000 });
    expect(agents.getSummary().tree[0].children[0].agent.plan?.status).toBe("executing");
    agents.markUnavailable("child"); expect(agents.getSummary().tree[0].children[0].agent.plan).toBeUndefined();
  });
});
