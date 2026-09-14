import { describe, expect, it } from "vitest";
import type { NormalizedPlanEvent, PlanDeltaEvent } from "../src/core/PlanEvents.js";
import { MAX_PLAN_TEXT, visibleProposal } from "../src/core/PlanState.js";
import { PlanTracker } from "../src/core/PlanTracker.js";
import { planMeta, planUpdate } from "./plans.js";

// 归一化输入契约测试；不作为真实 rollout 或当前 Codex 实机验收记录。
const delta = (ordinal: number, text: string, itemId = "proposal-a"): PlanDeltaEvent => ({
  ...planMeta(ordinal, { source: "app-server" }), type: "plan-delta", turnId: "turn-a", itemId, delta: text,
});
const proposed = (ordinal: number, text: string, complete = true, itemId = "proposal-a"): NormalizedPlanEvent => ({
  ...planMeta(ordinal, { source: "app-server" }), type: "plan-proposed", turnId: "turn-a", itemId, text, complete,
});

describe("Plan 提案文本增量", () => {
  it("流式提案不创建执行步骤、批准状态或百分比", () => {
    const tracker = new PlanTracker(); tracker.applyDelta(delta(1, "先分析"));
    expect(tracker.getSummary()).toMatchObject({ execution: undefined, proposal: { status: "streaming", streamedCharacters: 3 },
      capability: { planDelta: "available", stepStatuses: "not-observed", approvalState: "not-observed", completionState: "not-observed" } });
    expect(tracker.getSummary().proposal?.text).toBeUndefined();
  });
  it("重复片段事件不会再次合并", () => {
    const tracker = new PlanTracker(); const event = delta(1, "abc"); tracker.applyDelta(event);
    const before = tracker.getSummary(); tracker.applyDelta(event); expect(tracker.getSummary()).toEqual(before);
  });
  it("不同事件的相同文本必须保留各自长度", () => {
    const tracker = new PlanTracker(); tracker.applyDelta(delta(1, "ab")); tracker.applyDelta(delta(2, "ab"));
    expect(tracker.getSummary().proposal?.streamedCharacters).toBe(4); expect(tracker.getSummary().eventCount).toBe(2);
  });
  it("按来源顺序拒绝迟到片段，不按时间戳重排", () => {
    const tracker = new PlanTracker(); tracker.applyDelta(delta(2, "new")); tracker.applyDelta({ ...delta(1, "old"), at: 9000 });
    expect(tracker.getSummary().proposal).toMatchObject({ streamedCharacters: 3, ordinal: 2 });
  });
  it("完成项正文覆盖片段拼接，不能把二者相加", () => {
    const tracker = new PlanTracker(); tracker.apply(proposed(1, "", false));
    tracker.applyDelta(delta(2, "旧草案")); tracker.applyDelta(delta(3, "的续文")); tracker.apply(proposed(4, "修订后的权威正文"));
    expect(tracker.getSummary().proposal).toMatchObject({ status: "ready", text: "修订后的权威正文", streamedCharacters: 6 });
    expect(tracker.getSummary().execution).toBeUndefined();
  });
  it.each(["delta", "started"])("完成后迟到的 %s 不重新打开相同提案", type => {
    const tracker = new PlanTracker(); tracker.apply(proposed(1, "最终文本")); const before = tracker.getSummary();
    tracker.apply(type === "delta" ? delta(2, "迟到") : proposed(2, "", false)); expect(tracker.getSummary()).toEqual(before);
  });
  it("新 item 的流不继承旧提案长度和正文", () => {
    const tracker = new PlanTracker(); tracker.apply(proposed(1, "旧提案")); tracker.applyDelta(delta(2, "新", "proposal-b"));
    expect(tracker.getSummary().proposal).toMatchObject({ itemId: "proposal-b", status: "streaming", streamedCharacters: 1 });
    expect(tracker.getSummary().proposal?.text).toBeUndefined();
  });
  it("跨轮次复用 item ID 时仍视为新的提案流", () => {
    const tracker = new PlanTracker(); tracker.apply(proposed(1, "旧提案")); tracker.applyDelta({ ...delta(2, "新"), turnId: "turn-b" });
    expect(tracker.getSummary().proposal).toMatchObject({ turnId: "turn-b", status: "streaming", streamedCharacters: 1 });
  });
  it("跨片段的凭据在生成中没有任何正文出口", () => {
    const tracker = new PlanTracker(); const fragments = ["API_", "KEY=", "private-", "value\n", "Bearer ", "other-value"];
    for (const [index, text] of fragments.entries()) {
      tracker.applyDelta(delta(index + 1, text));
      const snapshot = JSON.stringify(tracker.getSummary()); expect(snapshot).not.toContain("private-"); expect(snapshot).not.toContain("other-value");
      expect(tracker.getSummary().proposal?.text).toBeUndefined();
    }
    tracker.apply(proposed(7, fragments.join("")));
    expect(tracker.getSummary().proposal?.text).toContain("[redacted]");
    expect(JSON.stringify(tracker.getSummary())).not.toMatch(/private-value|other-value/u);
  });
  it("stream 上限有可见诊断，不暴露未完成正文", () => {
    const tracker = new PlanTracker(); tracker.applyDelta(delta(1, "a".repeat(MAX_PLAN_TEXT)));
    tracker.applyDelta(delta(2, "尾部")); const summary = tracker.getSummary();
    expect(summary.proposal).toMatchObject({ truncated: true, streamedCharacters: MAX_PLAN_TEXT + 2 }); expect(summary.proposal?.text).toBeUndefined();
    expect(summary.issues.join()).toContain("safety limit"); expect(JSON.stringify(summary).length).toBeLessThan(3000);
  });
  it("有效完成正文能够消除流截断标志，历史诊断仍可见", () => {
    const tracker = new PlanTracker(); tracker.applyDelta(delta(1, "a".repeat(MAX_PLAN_TEXT + 1))); tracker.apply(proposed(2, "完整最终计划"));
    expect(tracker.getSummary().proposal).toMatchObject({ truncated: false, text: "完整最终计划", status: "ready" });
    expect(tracker.getSummary().issues.length).toBeGreaterThan(0);
  });
  it("归一化完成正文先脱敏再限长", () => {
    const tracker = new PlanTracker(); tracker.apply(proposed(1, "API_KEY=private-value\n" + "中".repeat(MAX_PLAN_TEXT)));
    const proposal = tracker.getSummary().proposal!; expect(proposal.truncated).toBe(true); expect(proposal.text?.length).toBeLessThanOrEqual(MAX_PLAN_TEXT);
    expect(proposal.text).not.toContain("private-value"); expect(proposal.text).toContain("[redacted]");
  });
  it("较新的提案隐藏旧清单，后续真实清单更新恢复进度显示", () => {
    const tracker = new PlanTracker(); tracker.apply({ ...planUpdate(1), source: "app-server" }); tracker.apply(proposed(2, "待确认提案"));
    expect(visibleProposal(tracker.getSummary())?.status).toBe("ready"); expect(tracker.getSummary().execution?.completedCount).toBe(1);
    tracker.apply({ ...planUpdate(3), source: "app-server" }); expect(visibleProposal(tracker.getSummary())).toBeUndefined();
    expect(tracker.getSummary().capability.approvalState).toBe("not-observed");
  });
  it("模式与提案、清单使用独立顺序屏障", () => {
    const tracker = new PlanTracker(); tracker.apply({ ...planMeta(10, { source: "app-server" }), type: "plan-mode", active: true });
    tracker.applyDelta(delta(2, "计划")); tracker.apply({ ...planUpdate(1), source: "app-server" });
    expect(tracker.getSummary()).toMatchObject({ mode: { active: true }, proposal: { streamedCharacters: 2 }, execution: { totalCount: 3 } });
  });
  it("clear 后旧提案事件不能复活", () => {
    const tracker = new PlanTracker(); tracker.applyDelta(delta(1, "草案"));
    tracker.apply({ ...planMeta(3, { source: "app-server" }), type: "plan-cleared" }); tracker.apply(proposed(2, "旧完成文本"));
    expect(tracker.getSummary().proposal).toBeUndefined();
  });
  it("迟到的 clear 不清掉更晚的提案", () => {
    const tracker = new PlanTracker(); tracker.apply(proposed(3, "新提案"));
    tracker.apply({ ...planMeta(2, { source: "app-server" }), type: "plan-cleared" }); expect(tracker.getSummary().proposal?.text).toBe("新提案");
  });
  it("reset 后没有前一会话的流内容、能力或事件", () => {
    const tracker = new PlanTracker(); tracker.applyDelta(delta(1, "旧片段")); tracker.reset(); tracker.applyDelta(delta(1, "新"));
    expect(tracker.getSummary()).toMatchObject({ eventCount: 1, proposal: { streamedCharacters: 1 } }); expect(tracker.getSummary().proposal?.text).toBeUndefined();
  });
});
