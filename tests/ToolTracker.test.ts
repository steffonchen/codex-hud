import { describe, expect, it } from "vitest";
import { ToolTracker, MAX_ACTIVE_TOOLS, MAX_RECENT_TOOLS } from "../src/core/ToolTracker.js";
import type { ToolEvent } from "../src/core/HudEvent.js";

const start = (toolId = "a", patch: Partial<ToolEvent> = {}): ToolEvent => ({
  type: "tool-started", toolId, name: "shell", toolType: "shell", inputSummary: "npm test", at: 1000, ...patch,
});

describe("ToolTracker", () => {
  it.each(["completed", "failed", "cancelled", "unknown"] as const)("从 start 到 %s，结束时从 active 移入 recent", status => {
    const tracker = new ToolTracker();
    tracker.apply(start());
    expect(tracker.getState().active[0]).toMatchObject({ id: "a", status: "running", startedAt: 1000 });
    tracker.apply({ type: `tool-${status}`, toolId: "a", at: 5000 });
    expect(tracker.getState()).toMatchObject({ active: [], recent: [{ id: "a", status, durationMs: 4000 }] });
  });

  it("pending/update 保持一个身份和原始开始时间", () => {
    const tracker = new ToolTracker();
    tracker.apply(start("a", { status: "pending" }));
    tracker.apply({ type: "tool-updated", toolId: "a", status: "running", at: 2000, inputSummary: "npm run build" });
    expect(tracker.getState().active).toEqual([expect.objectContaining({ status: "running", startedAt: 1000, inputSummary: "npm run build" })]);
  });

  it("重复 start/result 和迟到 start 不会重复记录或重新激活", () => {
    const tracker = new ToolTracker();
    tracker.apply(start());
    tracker.apply(start());
    const result: ToolEvent = { type: "tool-completed", toolId: "a", at: 3000 };
    tracker.apply(result);
    tracker.apply(result);
    tracker.apply(start());
    expect(tracker.getState()).toMatchObject({ active: [], recent: [{ id: "a", status: "completed", durationMs: 2000 }] });
    expect(tracker.getState().recent).toHaveLength(1);
  });

  it("先 result 后 start 补齐摘要与耗时，结束状态不回退", () => {
    const tracker = new ToolTracker();
    tracker.apply({ type: "tool-failed", toolId: "a", at: 3000 });
    tracker.apply(start());
    expect(tracker.getState()).toMatchObject({ active: [], recent: [{ name: "shell", status: "failed", inputSummary: "npm test", durationMs: 2000 }] });
  });

  it("结构化失败不会被随后到达的外层返回覆盖为成功", () => {
    const tracker = new ToolTracker();
    tracker.apply(start());
    tracker.apply({ type: "tool-failed", toolId: "a", at: 2000, resultSource: "execution", error: "执行失败" });
    tracker.apply({ type: "tool-completed", toolId: "a", at: 3000, resultSource: "call" });
    expect(tracker.getState().recent[0]).toMatchObject({ status: "failed", completedAt: 2000, error: "执行失败" });
  });

  it("先收到外层返回时，迟到但时间较早的结构化失败仍具有更强证据", () => {
    const tracker = new ToolTracker();
    tracker.apply(start());
    tracker.apply({ type: "tool-completed", toolId: "a", at: 3000, resultSource: "call" });
    tracker.apply({ type: "tool-failed", toolId: "a", at: 2000, resultSource: "execution", error: "执行失败" });
    expect(tracker.getState().recent[0]).toMatchObject({ status: "failed", completedAt: 2000, durationMs: 1000 });
  });

  it("包装器先返回再补到 start 时，移除未知孤立结果", () => {
    const tracker = new ToolTracker();
    tracker.apply({ type: "tool-completed", toolId: "exec", at: 2000, resultSource: "call" });
    tracker.apply(start("exec", { name: "exec", toolType: "wrapper" }));
    expect(tracker.getState()).toEqual({ active: [], recent: [] });
  });

  it("相同结束时间按事件到达次序展示，重复结果不改变近期选择", () => {
    const tracker = new ToolTracker();
    for (const toolId of ["a", "b"]) tracker.apply({ type: "tool-completed", toolId, at: 2000 });
    tracker.apply({ type: "tool-completed", toolId: "a", at: 2000 });
    expect(tracker.getState().recent.map(tool => tool.id)).toEqual(["b", "a"]);
  });

  it("exec 让出与 wait 续跑保持同一个工具，包装器完成不重复计入近期命令", () => {
    const tracker = new ToolTracker();
    tracker.apply(start("exec", { name: "exec", toolType: "wrapper" }));
    tracker.apply({ type: "tool-updated", toolId: "exec", at: 2000, continuationId: "cell:1", resultSource: "call" });
    tracker.apply(start("wait", { name: "wait", toolType: "unknown", at: 3000, continuationId: "cell:1" }));
    expect(tracker.getState().active).toEqual([expect.objectContaining({ id: "exec", name: "exec", startedAt: 1000 })]);
    tracker.apply({ type: "tool-completed", toolId: "wait", at: 4000, resultSource: "call" });
    tracker.apply(start("wait", { name: "wait", toolType: "unknown", at: 3000, continuationId: "cell:1" }));
    expect(tracker.getState()).toEqual({ active: [], recent: [] });
  });

  it("结束轮次只归档匹配工具为未知，迟到的真实结果仍能补齐", () => {
    const tracker = new ToolTracker();
    tracker.apply(start("a", { turnId: "turn-a" }));
    tracker.apply(start("b", { turnId: "turn-b" }));
    tracker.endTurn("turn-a", 2000);
    expect(tracker.getState().active.map(tool => tool.id)).toEqual(["b"]);
    expect(tracker.getState().recent[0]).toMatchObject({ id: "a", status: "unknown", error: "Turn ended; tool final status unconfirmed" });
    tracker.apply({ type: "tool-completed", toolId: "a", at: 1800, resultSource: "execution" });
    expect(tracker.getState().recent[0]).toMatchObject({ status: "completed", durationMs: 800 });
    expect(tracker.getState().recent[0].error).toBeUndefined();
    tracker.apply(start("late", { turnId: "turn-a" }));
    expect(tracker.getState().active.map(tool => tool.id)).toEqual(["b"]);
  });

  it.each([100, 1000])("%i 次完成后历史保持上限，重放旧开始事件不复活已结束工具", count => {
    const tracker = new ToolTracker();
    for (let i = 0; i < count; i++) {
      tracker.apply(start(`tool-${i}`, { at: i * 10 }));
      tracker.apply({ type: "tool-completed", toolId: `tool-${i}`, at: i * 10 + 5 });
    }
    const state = tracker.getState();
    expect(state.active).toHaveLength(0);
    expect(state.recent).toHaveLength(MAX_RECENT_TOOLS);
    expect(state.recent[0].id).toBe(`tool-${count - 1}`);
    expect(JSON.stringify(state).length).toBeLessThan(10_000);
    tracker.apply(start("tool-0", { at: 0 }));
    expect(tracker.getState().active).toEqual([]);
    if (count > 256) expect(tracker.getUncertainStartCount()).toBe(1);
    tracker.apply(start("fresh", { at: count * 10 }));
    expect(tracker.getState().active.map(tool => tool.id)).toEqual(["fresh"]);
  });

  it("缺少结果的活动有上限，超限计数可供诊断且不伪造成功", () => {
    const tracker = new ToolTracker();
    for (let i = 0; i < 1000; i++) tracker.apply(start(`tool-${i}`));
    expect(tracker.getState().active).toHaveLength(MAX_ACTIVE_TOOLS);
    expect(tracker.getState().recent).toHaveLength(MAX_RECENT_TOOLS);
    expect(tracker.getState().recent.every(tool => tool.status === "unknown")).toBe(true);
    expect(tracker.getOverflowCount()).toBe(1000 - MAX_ACTIVE_TOOLS);
  });

  it("只保留有界脱敏摘要，并隔离查询快照的修改", () => {
    const tracker = new ToolTracker();
    tracker.apply(start("a", { inputSummary: 'curl --password "private-value" ' + "长".repeat(1000) }));
    tracker.apply({ type: "tool-failed", toolId: "a", error: "MY_API_KEY=private-error", outputSummary: "credential=private-output" });
    const state = tracker.getState();
    expect(JSON.stringify(state)).not.toMatch(/private-value|private-error|private-output/u);
    expect(state.recent[0].inputSummary!.length).toBeLessThanOrEqual(240);
    state.recent[0].name = "已修改";
    expect(tracker.getState().recent[0].name).toBe("shell");
    tracker.reset();
    expect(tracker.getState()).toEqual({ active: [], recent: [] });
    expect(tracker.getOverflowCount()).toBe(0);
  });
});
