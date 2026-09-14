import { describe, expect, it } from "vitest";
import { SkillTracker } from "../src/core/SkillTracker.js";
import { MAX_SKILLS } from "../src/core/SkillState.js";
import { HudStateReducer } from "../src/core/HudStateReducer.js";
import { skill } from "./capabilities.js";

describe("Skill Tracker", () => {
  it("目录发现不等于可用或 active", () => {
    const tracker = new SkillTracker(); tracker.replaceDirectory({ status: "ready", skills: [skill()] });
    expect(tracker.getSummary()).toMatchObject({ count: 1, activeCount: 0, availableCount: 0, capability: { directoryDiscovery: true, activeState: false } });
  });
  it("当前任务目录明确可用仍不等于 active", () => {
    const tracker = new SkillTracker(); tracker.replaceCatalog([{ name: "review", path: "/fixture/review/SKILL.md" }]);
    tracker.replaceDirectory({ status: "ready", skills: [skill("review", "available")] });
    expect(tracker.getSummary()).toMatchObject({ availableCount: 1, activeCount: 0, capability: { runtimeDiscovery: true, activeState: false } });
  });
  it("替换目录清除删除的定义", () => {
    const tracker = new SkillTracker(); tracker.replaceDirectory({ status: "ready", skills: [skill("a")] });
    tracker.replaceDirectory({ status: "ready", skills: [skill("b")] });
    expect(tracker.getSummary()?.skills.map(skill => skill.id)).toEqual(["b"]);
  });
  it("相同身份去重，名称相同的不同身份保留", () => {
    const tracker = new SkillTracker(); tracker.replaceDirectory({ status: "ready", skills: [skill("a"), skill("a"), { ...skill("b"), name: "a" }] });
    expect(tracker.getSummary()?.count).toBe(2);
  });
  it("明确的归一化状态分别统计", () => {
    const tracker = new SkillTracker();
    for (const status of ["active", "loaded", "available", "disabled", "failed", "unavailable"] as const) tracker.update(skill(status, status));
    expect(tracker.getSummary()).toMatchObject({ count: 6, activeCount: 1, availableCount: 3, disabledCount: 1, failedCount: 2 });
  });
  it("工具失败不能改变 Skill 状态", () => {
    const reducer = new HudStateReducer(); reducer.skills.update(skill("review", "available"));
    reducer.apply({ type: "tool-failed", toolId: "tool", error: "执行失败" });
    expect(reducer.getState(0).skillSummary).toMatchObject({ failedCount: 0, availableCount: 1 });
  });
  it("能力刷新不更新会话活动时间", () => {
    const reducer = new HudStateReducer(); reducer.apply({ type: "session", id: "a", at: 10 });
    reducer.apply({ type: "skills-listed", skills: [], at: 100 });
    expect(reducer.getState(0).session?.lastActivityAt).toBe(10);
  });
  it("reset 清除运行目录与旧状态", () => {
    const tracker = new SkillTracker(); tracker.replaceCatalog([{ name: "a", path: "/a/SKILL.md" }]); tracker.update(skill()); tracker.reset();
    expect(tracker.getSummary()).toBeUndefined(); expect(tracker.getCatalog()).toBeUndefined();
  });
  it("版本存在时才声明版本能力", () => {
    const tracker = new SkillTracker(); tracker.update(skill()); expect(tracker.getSummary()?.capability.versionInfo).toBe(false);
    tracker.update({ ...skill(), version: "2.16" }); expect(tracker.getSummary()?.capability.versionInfo).toBe(true);
  });
  it("快照和目录参数不暴露内部可变对象", () => {
    const tracker = new SkillTracker(), value = skill(); tracker.update(value); value.name = "changed";
    tracker.getSummary()!.skills[0].name = "changed";
    expect(tracker.getSummary()!.skills[0].name).toBe("review");
  });
  it("数量上限可观察，定义正文及多余字段不保留", () => {
    const tracker = new SkillTracker();
    for (let i = 0; i < MAX_SKILLS + 2; i++) tracker.update(Object.assign(skill(String(i)), { body: "private-body" }));
    expect(tracker.getSummary()?.count).toBe(MAX_SKILLS); expect(tracker.getSummary()?.issues.length).toBeGreaterThan(0);
    expect(JSON.stringify(tracker.getSummary())).not.toContain("private-body");
  });
});
