import { describe, expect, it } from "vitest";
import { AgentTracker } from "../src/core/AgentTracker.js";
import { flattenAgentTree } from "../src/core/AgentTree.js";
import type { NormalizedAgentEvent } from "../src/core/AgentEvents.js";

const event = (agentId: string, status: NonNullable<NormalizedAgentEvent["status"]>, at = 10, turnId = "turn-a"): NormalizedAgentEvent =>
  ({ type: "agent-status", agentId, status, at, turnId, source: "rollout" });
const values = (tracker: AgentTracker) => { const summary = tracker.getSummary(); return flattenAgentTree([...summary.tree, ...summary.orphans]).map(item => item.agent); };
const tracker = () => { const result = new AgentTracker(); result.setRoot("root"); result.apply({ type: "agent-discovered", agentId: "root", source: "rollout" }); return result; };

describe("AgentTracker 生命周期与边界", () => {
  it("按 ID 去重", () => { const t = tracker(); t.apply(event("child", "running")); t.apply(event("child", "running")); expect(values(t)).toHaveLength(2); });
  it.each(["completed", "failed", "cancelled"] as const)("%s 先于 start 到达时不复活", status => {
    const t = tracker(); t.apply(event("child", status, 20)); t.apply(event("child", "running", 10));
    expect(values(t).find(agent => agent.id === "child")).toMatchObject({ status, startedAt: 10, completedAt: 20 });
  });
  it("并行 A/B 逆序完成时保留准确身份", () => {
    const t = tracker(); t.apply(event("a", "running", 1)); t.apply(event("b", "running", 2)); t.apply(event("b", "completed", 3)); t.apply(event("a", "failed", 4));
    expect(values(t).find(agent => agent.id === "a")?.status).toBe("failed"); expect(values(t).find(agent => agent.id === "b")?.status).toBe("completed");
  });
  it("新 turn 可重新运行并清除旧完成时间", () => {
    const t = tracker(); t.apply(event("a", "completed", 20)); t.apply(event("a", "running", 30, "turn-b"));
    expect(values(t).find(agent => agent.id === "a")).toMatchObject({ status: "running", startedAt: 30, completedAt: undefined, turnId: "turn-b" });
  });
  it("旧 turn 的迟到 start 不覆盖新 turn", () => {
    const t = tracker(); t.apply(event("a", "running", 30, "turn-b")); t.apply(event("a", "running", 10));
    expect(values(t).find(agent => agent.id === "a")?.turnId).toBe("turn-b");
  });
  it("旧轮次返回时间较晚也不能复活已结束的新轮次", () => {
    const t = tracker(); t.apply(event("a", "running", 10)); t.apply(event("a", "cancelled", 20));
    t.apply(event("a", "running", 30, "turn-b")); t.apply(event("a", "completed", 40, "turn-b")); t.apply(event("a", "running", 50));
    expect(values(t).find(agent => agent.id === "a")).toMatchObject({ status: "completed", turnId: "turn-b", completedAt: 40 });
  });
  it("大量父边冲突诊断保持有界", () => {
    const t = tracker();
    for (let index = 0; index < 500; index++) {
      t.apply({ type: "agent-discovered", agentId: `a${index}`, parentId: "root", source: "rollout" });
      t.apply({ type: "agent-discovered", agentId: `a${index}`, parentId: "other", source: "rollout" });
      t.apply(event(`a${index}`, "completed", index)); t.trimHistory();
    }
    expect(t.getSummary().issues.length).toBeLessThanOrEqual(50);
    expect(t.getSummary().issues).toContain("Further agent relationship diagnostics omitted; check the original source");
  });
  it("waiting 保留同一轮的起始时间", () => {
    const t = tracker(); t.apply(event("a", "running", 10)); t.apply(event("a", "waiting", 20)); t.apply(event("a", "running", 30));
    expect(values(t).find(agent => agent.id === "a")?.startedAt).toBe(10);
  });
  it("所有终态计数可见", () => {
    const t = tracker(); t.apply(event("a", "failed")); t.apply(event("b", "completed")); t.apply(event("c", "cancelled")); t.apply(event("d", "waiting"));
    expect(t.getSummary()).toMatchObject({ failedCount: 1, completedCount: 1, cancelledCount: 1, activeCount: 1, activeSubagentCount: 1 });
  });
  it("仅保留最近 20 个结束代理", () => {
    const t = tracker(); for (let index = 0; index < 80; index++) t.apply(event(`a-${index}`, "completed", index));
    expect(values(t)).toHaveLength(21); expect(values(t).some(agent => agent.id === "a-0")).toBe(false);
  });
  it("已淘汰的重复开始不复活", () => {
    const t = tracker(); for (let index = 0; index < 30; index++) t.apply(event(`a-${index}`, "completed", index));
    t.getSummary(); t.apply(event("a-0", "running", 0)); expect(values(t).some(agent => agent.id === "a-0")).toBe(false);
  });
  it("100 个活动代理保持跟踪", () => {
    const t = tracker(); for (let index = 0; index < 100; index++) t.apply(event(`a-${index}`, "running"));
    expect(t.getSummary().activeCount).toBe(100);
  });
  it("安全上限可配置且不会伪造结束", () => {
    const t = new AgentTracker(2); t.apply(event("a", "running")); t.apply(event("b", "running")); t.apply(event("c", "running"));
    expect(t.getSummary()).toMatchObject({ count: 2, activeCount: 2, omittedCount: 1 }); expect(t.getSummary().issues[0]).toContain("safety limit");
  });
  it("reset 清理会话树和关联", () => { const t = tracker(); t.apply(event("a", "running")); t.reset(); expect(t.getSummary().count).toBe(0); });
  it("子线程不可读时保留节点并清除过期数据", () => {
    const t = tracker(); t.apply(event("a", "running")); t.updateThread("a", { tokenUsage: { totalTokens: 10 }, context: { usedPercent: 12 }, activity: { status: "running" } });
    t.markUnavailable("a"); expect(values(t).find(agent => agent.id === "a")).toMatchObject({ status: "unknown", tokens: undefined, context: undefined });
  });
  it("子线程替换只重建该节点", () => { const t = tracker(); t.apply(event("a", "running")); t.apply(event("b", "running")); t.resetThread("a"); expect(values(t).map(agent => agent.id)).toEqual(["root", "b"]); });
  it("快照无 Token 时不会保留上次估算", () => {
    const t = tracker(); t.apply(event("a", "running")); t.updateThread("a", { tokenUsage: { totalTokens: 10 } }); t.updateThread("a", {});
    expect(values(t).find(agent => agent.id === "a")?.tokens).toBeUndefined();
  });
  it("名称在进入状态时脱敏", () => {
    const t = tracker(); t.apply({ type: "agent-discovered", agentId: "a", name: "api_key=秘密", source: "rollout" }); expect(JSON.stringify(t.getSummary())).not.toContain("秘密");
  });
  it("返回快照无法改写内部状态", () => {
    const t = tracker(); t.apply(event("a", "running")); const result = values(t); result[1].status = "failed"; expect(values(t)[1].status).toBe("running");
  });
  it("有活动后代时保留其结束祖先", () => {
    const t = new AgentTracker(256, 0); t.setRoot("root"); t.apply({ type: "agent-discovered", agentId: "root", source: "rollout" });
    t.apply({ type: "agent-discovered", agentId: "parent", parentId: "root", source: "rollout" }); t.apply(event("parent", "completed"));
    t.apply({ type: "agent-discovered", agentId: "child", parentId: "parent", source: "rollout" }); t.apply(event("child", "running"));
    expect(t.getSummary().tree[0].children[0].children[0].agent.id).toBe("child");
  });
});
