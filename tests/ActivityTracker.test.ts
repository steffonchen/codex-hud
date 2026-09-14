import { describe, expect, it } from "vitest";
import { ActivityTracker, selectActiveTool } from "../src/core/ActivityTracker.js";
import { HudStateReducer } from "../src/core/HudStateReducer.js";
import type { ToolActivity } from "../src/core/HudState.js";

const tool = (type: string, patch: Partial<ToolActivity> = {}): ToolActivity => ({
  id: type, name: type, type, status: "running", inputSummary: "目标", startedAt: 1000, ...patch,
});

describe("ActivityTracker", () => {
  it("没有生命周期证据时保持未知，明确结束后才是 idle", () => {
    const tracker = new ActivityTracker();
    expect(tracker.getState({ active: [], recent: [] })).toBeUndefined();
    tracker.apply({ type: "turn-started", id: "a", at: 1000 });
    expect(tracker.getState({ active: [], recent: [] })).toMatchObject({ status: "running", label: "Processing" });
    tracker.apply({ type: "turn-completed", id: "a", at: 2000 });
    expect(tracker.getState({ active: [], recent: [] })).toEqual({ status: "idle" });
    tracker.apply({ type: "turn-started", id: "a", at: 1000 });
    expect(tracker.getState({ active: [], recent: [] })).toEqual({ status: "idle" });
  });

  it.each([["shell", "Executing"], ["search", "Searching"], ["read", "Reading"], ["edit", "Editing"]])("%s 产生对应用户活动", (type, label) => {
    expect(new ActivityTracker().getState({ active: [tool(type)], recent: [] })).toMatchObject({ status: "running", label, description: "目标", toolId: type });
  });

  it("运行优先于排队，命令优先于搜索，同类选择最近开始的活动", () => {
    const entries = [tool("shell", { id: "old" }), tool("shell", { id: "new", startedAt: 2000 }),
      tool("search", { startedAt: 3000 }), tool("edit", { status: "pending", startedAt: 4000 })];
    expect(selectActiveTool(entries)?.id).toBe("new");
    expect(new ActivityTracker().getState({ active: entries.reverse(), recent: [] })?.toolId).toBe("new");
  });

  it.each(["completed", "failed", "cancelled", "unknown"] as const)("终态 %s 不会被显示成运行中", status => {
    const activity = new ActivityTracker().getState({ active: [], recent: [tool("shell", { status, completedAt: 2000 })] });
    expect(activity?.status).not.toBe("running");
    expect(activity?.toolStatus).toBe(status);
  });

  it("新轮次不选择旧近期记录，其他轮次的迟到终止不使当前轮次 idle", () => {
    const tracker = new ActivityTracker();
    tracker.apply({ type: "turn-started", id: "new", at: 3000 });
    tracker.apply({ type: "turn-completed", id: "old", at: 4000 });
    expect(tracker.getState({ active: [], recent: [tool("shell", { status: "completed", turnId: "old", completedAt: 2000 })] }))
      .toMatchObject({ status: "running", label: "Processing" });
  });

  it("Reducer 会话切换和 reset 同时清工具、活动及旧轮次关联", () => {
    const reducer = new HudStateReducer();
    reducer.apply({ type: "session", id: "a" });
    reducer.apply({ type: "turn-started", id: "turn-a", at: 1000 });
    reducer.apply({ type: "tool-started", toolId: "a", name: "shell", toolType: "shell", turnId: "turn-a", at: 1000 });
    expect(reducer.getState(2000).activity?.status).toBe("running");
    reducer.apply({ type: "session", id: "b" });
    expect(reducer.getState(2000).tools).toMatchObject({ active: [], recent: [] });
    expect(reducer.getState(2000).activity).toBeUndefined();
    reducer.apply({ type: "tool-completed", toolId: "b", name: "shell", at: 2000 });
    reducer.reset();
    expect(reducer.getState(3000).tools).toMatchObject({ active: [], recent: [] });
    expect(reducer.getState(3000).activity).toBeUndefined();
  });
});
