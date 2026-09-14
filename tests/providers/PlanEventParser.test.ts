import { readFile } from "node:fs/promises";
import { beforeAll, describe, expect, it } from "vitest";
import { HudStateReducer } from "../../src/core/HudStateReducer.js";
import { MAX_PLAN_TEXT } from "../../src/core/PlanState.js";
import { PlanEventParser } from "../../src/providers/codex/PlanEventParser.js";
import { RolloutEventParser } from "../../src/providers/codex/RolloutEventParser.js";
import { planFixture, replayPlan } from "../plans.js";

let created: string[], updated: string[], rejected: string[];
const lines = (text: string) => text.trimEnd().split("\n");
const alter = (line: string, change: (raw: any) => void): string => { const raw = JSON.parse(line); change(raw); return JSON.stringify(raw); };
const replay = (source: string[]) => replayPlan(source.join("\n"));
beforeAll(async () => {
  [created, updated, rejected] = await Promise.all(["plan-created", "plan-updated", "plan-update-rejected"].map(async name => lines(await planFixture(name))));
});

describe("真实脱敏 Plan rollout 回放", () => {
  it("调用生成完毕尚不能证明计划更新成功", () => {
    const { state, events } = replay(created.slice(0, -1));
    expect(state.planSummary?.execution).toBeUndefined(); expect(events.some(event => event.type === "plan-updated")).toBe(false);
    expect(state.tools?.active?.[0].name).toBe("update_plan");
  });
  it("匹配的成功回执确认完整清单和原始调用顺序", () => {
    const { state, events, diagnostics } = replay(created);
    expect(diagnostics).toEqual([]); expect(state.planSummary?.execution).toMatchObject({ threadId: "plan-a-1", turnId: "plan-a-2",
      source: "rollout", status: "executing", ordinal: 4, totalCount: 4, completedCount: 0, currentStepPosition: 0 });
    expect(events.filter(event => event.type === "plan-updated")).toHaveLength(1);
  });
  it("真实后续快照更新步骤并保留稳定 Plan 身份", () => {
    const first = replay(created).state.planSummary!.execution!;
    const next = replay([...created, ...updated]).state.planSummary!.execution!;
    expect(next).toMatchObject({ planId: first.planId, completedCount: 1, totalCount: 4, progressPercent: 25, currentStepPosition: 1 });
    expect(next.steps.map(step => step.status)).toEqual(["completed", "in_progress", "pending", "pending"]);
  });
  it("真实多次更新从创建到完成，不增加清单数量", async () => {
    const result = replayPlan(await planFixture("multiple-updates"));
    expect(result.state.planSummary?.execution).toMatchObject({ status: "completed", completedCount: 4, totalCount: 4, progressPercent: 100 });
    expect(result.state.planSummary?.events.filter(event => event.type === "plan-updated")).toHaveLength(4);
    expect(result.state.planSummary?.capability.approvalState).toBe("not-observed");
  });
  it("task_complete 不能完成仍未完成的清单", async () => {
    const result = replay([...created, ...lines(await planFixture("plan-turn-completed"))]);
    expect(result.state.planSummary?.execution).toMatchObject({ status: "executing", completedCount: 0 });
    expect(result.state.planSummary?.capability.completionState).toBe("not-observed");
  });
  it("实际参数失败既不产生 Plan，也不被通用工具解析伪装成成功", () => {
    const result = replay(rejected.slice(0, 5));
    expect(result.state.planSummary?.execution).toBeUndefined();
    expect(result.state.tools?.recent?.find(tool => tool.id === "plan-b-3")?.status).toBe("failed");
    expect(result.diagnostics.some(diagnostic => diagnostic.code === "plan-update-rejected")).toBe(true);
  });
  it("实际参数修正后新调用成功，失败调用状态仍独立保留", () => {
    const result = replay(rejected);
    expect(result.state.planSummary?.execution).toMatchObject({ completedCount: 1, totalCount: 4 });
    expect(result.state.tools?.recent?.find(tool => tool.id === "plan-b-3")?.status).toBe("failed");
    expect(result.state.tools?.recent?.find(tool => tool.id === "plan-b-4")?.status).toBe("completed");
  });
  it("重新初始化后 raw → event → Tracker → state 完全一致", async () => {
    const source = await planFixture("multiple-updates");
    expect(replayPlan(source).state.planSummary).toEqual(replayPlan(source).state.planSummary);
  });
});

// 以下变体用于验证边界与协议契约，不冒充实机采集 fixture。
describe("Plan 调用关联边界", () => {
  it.each([0, 1000])("重复失败回执的时间偏移为 %s 毫秒时仍保持失败", offset => {
    const repeated = alter(rejected[4], raw => { raw.timestamp = new Date(Date.parse(raw.timestamp) + offset).toISOString(); });
    const result = replay([...rejected.slice(0, 5), repeated, ...rejected.slice(5)]);
    expect(result.state.tools?.recent?.find(tool => tool.id === "plan-b-3")?.status).toBe("failed");
    expect(result.state.planSummary?.execution?.completedCount).toBe(1);
  });
  it("重复成功调用和回执不重复更新清单", () => {
    const result = replay([...created, ...created.slice(3)]);
    expect(result.state.planSummary?.events.filter(event => event.type === "plan-updated")).toHaveLength(1);
  });
  it("未知返回不会把待确认调用视为成功", () => {
    const result = replay([...created.slice(0, -1), alter(created[4], raw => { raw.payload.output = "可能成功 private-value"; })]);
    expect(result.state.planSummary?.execution).toBeUndefined();
    expect(result.diagnostics.some(diagnostic => diagnostic.code === "plan-update-unconfirmed")).toBe(true);
    expect(JSON.stringify(result.diagnostics)).not.toContain("private-value");
  });
  it("失败更新保留此前已确认的清单", () => {
    const before = replay(created).state.planSummary!.execution;
    const after = replay([...created, ...rejected.slice(3, 5)]).state.planSummary!.execution;
    expect(after).toEqual(before);
  });
  it("乱序回执按原始调用行号归并，不回退较新清单", () => {
    const parser = new RolloutEventParser(), reducer = new HudStateReducer();
    const ordered = [...created.slice(0, 4).map((line, index) => ({ line, ordinal: index + 1 })),
      { line: updated[0], ordinal: 6 }, { line: updated[1], ordinal: 7 }, { line: created[4], ordinal: 5 }];
    for (const { line, ordinal } of ordered) for (const event of parser.parse(line, ordinal).events) reducer.apply(event);
    expect(reducer.getState(0).planSummary?.execution).toMatchObject({ completedCount: 1, ordinal: 6 });
  });
  it("先交付输出再交付调用时能以原始身份完成关联", () => {
    const parser = new RolloutEventParser(), reducer = new HudStateReducer();
    for (const index of [0, 1, 2, 4, 3]) for (const event of parser.parse(created[index], index + 1).events) reducer.apply(event);
    expect(reducer.getState(0).planSummary?.execution).toMatchObject({ totalCount: 4, ordinal: 4 });
  });
  it("返回来自其他显式线程时不用于当前线程", () => {
    const wrong = alter(created[4], raw => { raw.payload.thread_id = "another-thread"; });
    expect(replay([...created.slice(0, -1), wrong]).state.planSummary?.execution).toBeUndefined();
    expect(replay([...created.slice(0, -1), wrong, created[4]]).state.planSummary?.execution?.threadId).toBe("plan-a-1");
  });
  it("没有 metadata 身份时不接收看似合法的 update_plan", () => {
    const result = replay(created.slice(3)); expect(result.state.planSummary?.execution).toBeUndefined();
    expect(result.diagnostics.some(diagnostic => diagnostic.code === "plan-call-identity")).toBe(true);
  });
  it("同名外部 namespace 不被当成本地 Plan 来源", () => {
    const call = alter(created[3], raw => { raw.payload.namespace = "mcp-server"; });
    expect(replay([...created.slice(0, 3), call, created[4]]).state.planSummary?.execution).toBeUndefined();
  });
  it.each(["failed", "inProgress", undefined])("rollout 步骤状态 %s 不在已验证 schema 中时整份更新拒绝", status => {
    const call = alter(created[3], raw => { const args = JSON.parse(raw.payload.arguments); args.plan[2].status = status; raw.payload.arguments = JSON.stringify(args); });
    const result = replay([...created.slice(0, 3), call, created[4]]);
    expect(result.state.planSummary?.execution).toBeUndefined(); expect(result.diagnostics.some(diagnostic => diagnostic.code === "plan-call-schema")).toBe(true);
  });
  it("坏参数的诊断不输出原始 prompt 或凭据", () => {
    const call = alter(created[3], raw => { raw.payload.arguments = '{"password":"private-value",bad'; });
    const result = replay([...created.slice(0, 3), call, created[4]]);
    expect(result.state.planSummary?.execution).toBeUndefined(); expect(JSON.stringify(result.diagnostics)).not.toContain("private-value");
  });
  it("步骤标题与解释在归一化事件中已经脱敏", () => {
    const call = alter(created[3], raw => { const args = JSON.parse(raw.payload.arguments); args.plan[0].step = "部署 API_KEY=private-value";
      args.explanation = "password=other-value"; raw.payload.arguments = JSON.stringify(args); });
    const result = replay([...created.slice(0, 3), call, created[4]]);
    expect(result.state.planSummary?.execution?.steps[0].title).toContain("[redacted]");
    expect(JSON.stringify(result.events.filter(event => event.type.startsWith("plan-")))).not.toMatch(/private-value|other-value/u);
  });
  it("turn_context 未重复 turn_id 时使用已确认的轮次", () => {
    const context = alter(created[2], raw => { delete raw.payload.turn_id; });
    const result = replay([...created.slice(0, 2), context, ...created.slice(3)]);
    expect(result.state.planSummary?.mode?.turnId).toBe("plan-a-2"); expect(result.state.planSummary?.execution?.turnId).toBe("plan-a-2");
  });
  it("Plan Mode 可以独立存在，default 也只代表普通模式", () => {
    const active = alter(created[2], raw => { raw.payload.collaboration_mode.mode = "plan"; });
    expect(replay([...created.slice(0, 2), active]).state.planSummary).toMatchObject({ mode: { active: true }, execution: undefined,
      capability: { available: false, planMode: "available", approvalState: "not-observed" } });
    expect(replay(created.slice(0, 3)).state.planSummary?.mode?.active).toBe(false);
  });
  it("assistant 正文里的 proposed_plan 标记不是已验证结构事件", () => {
    const line = JSON.stringify({ type: "response_item", payload: { type: "message", role: "assistant", content: [
      { type: "output_text", text: "<proposed_plan>任务已全部完成</proposed_plan>" }] } });
    expect(replay([...created.slice(0, 3), line]).state.planSummary?.proposal).toBeUndefined();
  });
  it.each(["PlanUpdate", "plan_delta"])("未核验 raw %s 保持未采用，并给出可见来源诊断", type => {
    const parser = new RolloutEventParser(); const result = parser.parse(JSON.stringify({ type: "event_msg", payload: { type, plan: [] } }), 1);
    expect(result.detections.planUnverified).toBe(true); expect(result.events.some(event => event.type.startsWith("plan-"))).toBe(false);
    expect(result.diagnostics[0].code).toBe("plan-source-unverified");
  });
  it("pending 关联有上限，淘汰旧调用有明确诊断", () => {
    const parser = new RolloutEventParser(); created.slice(0, 3).forEach(line => parser.parse(line));
    let result;
    for (let index = 0; index < 129; index++) result = parser.parse(alter(created[3], raw => { raw.payload.call_id = `call-${index}`; }));
    expect(result!.diagnostics.some(diagnostic => diagnostic.code === "plan-correlation-limit")).toBe(true);
    const returned = parser.parse(alter(created[4], raw => { raw.payload.call_id = "call-0"; }));
    expect(returned.events.some(event => event.type === "plan-updated")).toBe(false);
  });
  it("parser reset 清空关联身份后可完整重放同一文件", () => {
    const parser = new RolloutEventParser(); const once = () => created.flatMap(line => parser.parse(line).events).filter(event => event.type.startsWith("plan-"));
    const first = once(); parser.reset(); expect(once()).toEqual(first);
  });
  it("新 session 的相同 call_id 不引用旧 session 的待确认参数", () => {
    const meta = alter(created[0], raw => { raw.payload.id = "plan-other"; });
    const result = replay([...created.slice(0, -1), meta, created[4]]);
    expect(result.state.planSummary?.execution).toBeUndefined(); expect(result.state.session?.id).toBe("plan-other");
  });
});

describe("当前 CLI 导出 schema 的纯通知适配（非实时订阅）", () => {
  const params = { threadId: "schema-thread", turnId: "schema-turn" };
  it("导出的状态枚举与 camelCase 通知字段对应", async () => {
    const schema = JSON.parse(await readFile(new URL("../fixtures/plan/schema/TurnPlanUpdatedNotification.json", import.meta.url), "utf8"));
    const parser = new PlanEventParser(); const statuses = schema.definitions.TurnPlanStepStatus.enum;
    const result = parser.parseNotification({ method: "turn/plan/updated", params: { ...params, plan: statuses.map((status: string) => ({ status, step: status })) } }, 1);
    expect(statuses).toEqual(["pending", "inProgress", "completed"]);
    expect(result.events[0]).toMatchObject({ type: "plan-updated", source: "app-server", steps: [
      { status: "pending" }, { status: "in_progress" }, { status: "completed" }] });
  });
  it("item/plan/delta 产生文本片段而非步骤 patch", () => {
    const result = new PlanEventParser().parseNotification({ method: "item/plan/delta", params: { ...params, itemId: "item-a", delta: "下一步" } }, 2);
    expect(result.events[0]).toMatchObject({ type: "plan-delta", itemId: "item-a", delta: "下一步", ordinal: 2 });
    expect(result.events[0]).not.toHaveProperty("steps");
  });
  it.each(["started", "completed"])("Plan item %s 只控制提案状态，不发执行完成事件", phase => {
    const result = new PlanEventParser().parseNotification({ method: `item/${phase}`, params: { ...params, item: { type: "plan", id: "item-a", text: "提案正文" } } }, 3);
    expect(result.events).toEqual([expect.objectContaining({ type: "plan-proposed", complete: phase === "completed", text: "提案正文" })]);
  });
  it("完成 Plan item 在事件中脱敏，忽略额外 prompt 字段", () => {
    const result = new PlanEventParser().parseNotification({ method: "item/completed", params: { ...params,
      prompt: "private-prompt", item: { type: "plan", id: "item-a", text: "API_KEY=private-value" } } }, 1);
    expect(JSON.stringify(result)).not.toMatch(/private-prompt|private-value/u); expect(JSON.stringify(result.events)).toContain("[redacted]");
  });
  it.each([{}, { ...params, plan: [{ step: "非法状态", status: "in_progress" }] }, { ...params, plan: [], explanation: 42 }])("不完整或跨版本通知不猜测修补", value => {
    const result = new PlanEventParser().parseNotification({ method: "turn/plan/updated", params: value }, 1);
    expect(result.events).toEqual([]); expect(result.unverified).toBe(true); expect(result.diagnostics[0].code).toBe("plan-notification-schema");
  });
  it("超限单个 delta 保留可见错误", () => {
    const result = new PlanEventParser().parseNotification({ method: "item/plan/delta", params: { ...params, itemId: "item-a", delta: "a".repeat(MAX_PLAN_TEXT + 1) } }, 1);
    expect(result.events).toEqual([]); expect(result.diagnostics[0].severity).toBe("error");
  });
  it("其他 TurnItem 和 ThreadGoal 通知不会生成 Plan", () => {
    const parser = new PlanEventParser();
    expect(parser.parseNotification({ method: "item/completed", params: { ...params, item: { type: "commandExecution", id: "item-a", text: "done" } } }, 1).events).toEqual([]);
    expect(parser.parseNotification({ method: "thread/goal/updated", params: { ...params, status: "completed" } }, 2).events).toEqual([]);
  });
});
