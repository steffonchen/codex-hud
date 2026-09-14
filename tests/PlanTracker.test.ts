import { describe, expect, it } from "vitest";
import { PlanTracker } from "../src/core/PlanTracker.js";
import { MAX_PLAN_EVENTS, MAX_PLAN_STEPS } from "../src/core/PlanState.js";
import type { NormalizedPlanEvent } from "../src/core/PlanEvents.js";
import { planMeta, planUpdate } from "./plans.js";

describe("PlanTracker", () => {
  it("只从步骤状态计算比例，进行中不计为已完成", () => {
    const tracker = new PlanTracker(); tracker.apply(planUpdate());
    expect(tracker.getSummary().execution).toMatchObject({ status: "executing", completedCount: 1, totalCount: 3,
      currentStepPosition: 1, counts: { completed: 1, in_progress: 1, pending: 1 } });
    expect(tracker.getSummary().execution?.progressPercent).toBeCloseTo(100 / 3);
  });
  it("快照更新复用稳定的 Plan 和步骤身份", () => {
    const tracker = new PlanTracker(); tracker.apply(planUpdate(1, ["in_progress", "pending", "pending"]));
    const before = tracker.getSummary().execution!;
    tracker.apply(planUpdate(2, ["completed", "in_progress", "pending"]));
    const after = tracker.getSummary().execution!;
    expect(after.planId).toBe(before.planId); expect(after.steps.map(step => step.id)).toEqual(before.steps.map(step => step.id));
    expect(after.steps.map(step => step.status)).toEqual(["completed", "in_progress", "pending"]);
  });
  it("真实完整快照可以删除步骤，不补造遗漏的旧步骤", () => {
    const tracker = new PlanTracker(); tracker.apply(planUpdate()); tracker.apply(planUpdate(2, ["completed", "in_progress"]));
    expect(tracker.getSummary().execution).toMatchObject({ totalCount: 2, completedCount: 1, progressPercent: 50 });
  });
  it("标题修订不会随机创建新步骤身份", () => {
    const tracker = new PlanTracker(); tracker.apply(planUpdate()); const id = tracker.getSummary().execution!.steps[1].id;
    const event = planUpdate(2); if (event.type === "plan-updated") event.steps[1].title = "修订后的步骤";
    tracker.apply(event); expect(tracker.getSummary().execution!.steps[1]).toMatchObject({ id, title: "修订后的步骤" });
  });
  it("全部步骤完成才从清单推导完成", () => {
    const tracker = new PlanTracker(); tracker.apply(planUpdate(1, ["completed", "completed"]));
    expect(tracker.getSummary()).toMatchObject({ execution: { status: "completed", progressPercent: 100 }, capability: { completionState: "available" } });
  });
  it("空清单保持 idle，没有 NaN 或虚构的完成百分比", () => {
    const tracker = new PlanTracker(); tracker.apply(planUpdate(1, []));
    expect(tracker.getSummary().execution).toMatchObject({ status: "idle", totalCount: 0, completedCount: 0, progressPercent: undefined });
    expect(tracker.getSummary().capability.completionState).toBe("not-observed");
  });
  it("完全重复的事件幂等，包括诊断和事件记录", () => {
    const tracker = new PlanTracker(); const event = planUpdate(); tracker.apply(event); const before = tracker.getSummary();
    tracker.apply(event); expect(tracker.getSummary()).toEqual(before);
  });
  it("相同身份在较新行重发不重复应用，仍推进顺序屏障", () => {
    const tracker = new PlanTracker(); const event = planUpdate(); tracker.apply(event);
    tracker.apply({ ...event, ordinal: 3 }); tracker.apply(planUpdate(2, ["completed", "completed"]));
    expect(tracker.getSummary().execution?.totalCount).toBe(3); expect(tracker.getSummary().eventCount).toBe(1);
  });
  it("迟到事件不能回退步骤，即使其时间戳更晚", () => {
    const tracker = new PlanTracker(); tracker.apply(planUpdate(2, ["completed", "completed"]));
    tracker.apply({ ...planUpdate(1), at: 100_000 });
    expect(tracker.getSummary().execution?.status).toBe("completed");
  });
  it("较新的物理行胜过时间戳，不猜测重排 rollout", () => {
    const tracker = new PlanTracker(); tracker.apply({ ...planUpdate(1), at: 100_000 });
    tracker.apply({ ...planUpdate(2, ["completed", "completed"]), at: 1 });
    expect(tracker.getSummary().execution?.status).toBe("completed");
  });
  it("新的真实快照可以修订已完成清单", () => {
    const tracker = new PlanTracker(); tracker.apply(planUpdate(1, ["completed"])); tracker.apply(planUpdate(2, ["completed", "in_progress"]));
    expect(tracker.getSummary().execution?.status).toBe("executing");
  });
  it("拒绝其他线程的更新，保留可见诊断", () => {
    const tracker = new PlanTracker(); tracker.setThread("thread-a"); tracker.apply(planUpdate());
    tracker.apply({ ...planUpdate(2, ["completed"]), threadId: "thread-b" });
    expect(tracker.getSummary().execution?.threadId).toBe("thread-a"); expect(tracker.getSummary().issues.join()).toContain("thread");
  });
  it("切换线程会完整清空计划、提案、模式和历史", () => {
    const tracker = new PlanTracker(); tracker.apply(planUpdate()); tracker.setThread("thread-b");
    expect(tracker.getSummary()).toMatchObject({ execution: undefined, proposal: undefined, mode: undefined, events: [], eventCount: 0 });
    tracker.apply({ ...planUpdate(), threadId: "thread-b" }); expect(tracker.getSummary().execution?.threadId).toBe("thread-b");
  });
  it("reset 后重放得到相同的状态", () => {
    const tracker = new PlanTracker(); const events = [planUpdate(), planUpdate(2, ["completed", "completed", "in_progress"])];
    events.forEach(event => tracker.apply(event)); const before = tracker.getSummary();
    tracker.reset(); events.forEach(event => tracker.apply(event)); expect(tracker.getSummary()).toEqual(before);
  });
  it("Plan Mode 可以存在但没有执行清单或进度", () => {
    const tracker = new PlanTracker(); tracker.apply({ ...planMeta(), type: "plan-mode", active: true });
    expect(tracker.getSummary()).toMatchObject({ execution: undefined, mode: { active: true }, capability: { available: false, planMode: "available", approvalState: "not-observed" } });
  });
  it("新轮次使旧模式失效，保留已经确认的执行清单", () => {
    const tracker = new PlanTracker(); tracker.apply({ ...planMeta(), type: "plan-mode", active: true }); tracker.apply(planUpdate(2));
    tracker.startTurn("turn-b"); expect(tracker.getSummary().mode).toBeUndefined(); expect(tracker.getSummary().execution?.totalCount).toBe(3);
  });
  it("普通执行清单不会自动代表用户批准", () => {
    const tracker = new PlanTracker(); tracker.apply(planUpdate()); expect(tracker.getSummary().capability.approvalState).toBe("not-observed");
    tracker.apply({ ...planMeta(2), type: "plan-status", status: "approved" });
    expect(tracker.getSummary()).toMatchObject({ execution: { status: "approved" }, capability: { approvalState: "available" } });
  });
  it.each(["failed", "cancelled"] as const)("显式 %s 与步骤及其他对象状态独立", status => {
    const tracker = new PlanTracker(); tracker.apply(planUpdate()); tracker.apply({ ...planMeta(2), type: "plan-status", status });
    expect(tracker.getSummary().execution).toMatchObject({ status, completedCount: 1 });
    expect(tracker.getSummary().execution?.steps.map(step => step.status)).toEqual(["completed", "in_progress", "pending"]);
  });
  it("完成事件与未完成步骤冲突时保留比例和诊断", () => {
    const tracker = new PlanTracker(); tracker.apply(planUpdate()); tracker.apply({ ...planMeta(2), type: "plan-status", status: "completed" });
    expect(tracker.getSummary().execution?.progressPercent).toBeCloseTo(100 / 3); expect(tracker.getSummary().issues.join()).toContain("conflicts");
  });
  it("只有生命周期时不伪造步骤能力", () => {
    const tracker = new PlanTracker(); tracker.apply({ ...planMeta(), type: "plan-status", status: "failed" });
    expect(tracker.getSummary().capability.stepStatuses).toBe("not-observed");
  });
  it("清空数据保留独立模式，旧快照不能重新出现", () => {
    const tracker = new PlanTracker(); tracker.apply({ ...planMeta(), type: "plan-mode", active: true }); tracker.apply(planUpdate(2));
    tracker.apply({ ...planMeta(3), type: "plan-cleared" }); tracker.apply(planUpdate(2));
    expect(tracker.getSummary()).toMatchObject({ execution: undefined, mode: { active: true } });
  });
  it("多个进行中步骤保留原状并报告来源约束", () => {
    const tracker = new PlanTracker(); tracker.apply(planUpdate(1, ["in_progress", "in_progress"]));
    expect(tracker.getSummary().execution?.counts.in_progress).toBe(2); expect(tracker.getSummary().issues.join()).toContain("multiple");
  });
  it("未知步骤状态不会错误地算作完成", () => {
    const tracker = new PlanTracker(); tracker.apply(planUpdate(1, ["completed", "unknown"]));
    expect(tracker.getSummary()).toMatchObject({ execution: { status: "unknown", progressPercent: 50 }, capability: { stepStatuses: "partial" } });
  });
  it("步骤数量超限时不局部更新，不破坏旧状态", () => {
    const tracker = new PlanTracker(); tracker.apply(planUpdate()); tracker.apply(planUpdate(2, Array(MAX_PLAN_STEPS + 1).fill("completed")));
    expect(tracker.getSummary().execution?.totalCount).toBe(3); expect(tracker.getSummary().issues.length).toBe(1);
  });
  it("入状态即脱敏，删除控制字符并限制标题长度", () => {
    const tracker = new PlanTracker(); tracker.apply({ ...planMeta(), type: "plan-updated", steps: [{ title: '部署 API_KEY="sensitive-value"\x1b[2J ' + "中".repeat(500), status: "in_progress" }], explanation: "password=private-value" });
    const output = JSON.stringify(tracker.getSummary()); expect(output).not.toContain("sensitive-value"); expect(output).not.toContain("private-value");
    expect(output).not.toContain("\\u001b"); expect(Array.from(tracker.getSummary().execution!.steps[0].title).length).toBeLessThanOrEqual(240);
  });
  it("输入和快照的外部修改不会污染 Tracker", () => {
    const tracker = new PlanTracker(); const event = planUpdate(); tracker.apply(event);
    if (event.type === "plan-updated") event.steps[0].title = "外部修改";
    const state = tracker.getSummary(); state.execution!.steps.length = 0; state.events.length = 0;
    expect(tracker.getSummary().execution?.steps[0].title).toBe("步骤 1"); expect(tracker.getSummary().events.length).toBe(1);
  });
  it("长会话只保留有界事件摘要，不保存步骤历史", () => {
    const tracker = new PlanTracker(); for (let index = 1; index <= 1000; index++) tracker.apply(planUpdate(index));
    const summary = tracker.getSummary(); expect(summary.eventCount).toBe(1000); expect(summary.events.length).toBe(MAX_PLAN_EVENTS);
    expect(JSON.stringify(summary).length).toBeLessThan(9000); expect(summary.events[0].ordinal).toBe(981);
  });
  it.each([0, -1, NaN, 1.5])("无效的来源顺序 %s 不进入状态", ordinal => {
    const tracker = new PlanTracker(); tracker.apply({ ...planUpdate(), ordinal } as NormalizedPlanEvent);
    expect(tracker.getSummary().execution).toBeUndefined(); expect(tracker.getSummary().issues.join()).toContain("order");
  });
});
