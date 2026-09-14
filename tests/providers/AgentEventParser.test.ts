import { describe, expect, it } from "vitest";
import { parseAgentMetadata } from "../../src/providers/codex/AgentMetadata.js";
import { RolloutEventParser } from "../../src/providers/codex/RolloutEventParser.js";
import { AgentEventParser } from "../../src/providers/codex/AgentEventParser.js";
import { agentEvents, agentFixture, agentState, agentsOf } from "../agents.js";

describe("真实 Agent metadata discovery", () => {
  it("真实子线程以自身 id 标识，session_id 不充当自身身份", async () => {
    const raw = JSON.parse((await agentFixture("single-agent"))[0]).payload;
    expect(parseAgentMetadata(raw)).toMatchObject({ id: "single", sessionId: "root", parentId: "root", taskAgent: true, subagent: true });
  });
  it("真实嵌套子线程保留直接父边", async () => {
    const raw = JSON.parse((await agentFixture("nested-leaf"))[0]).payload;
    expect(parseAgentMetadata(raw)).toMatchObject({ id: "leaf", parentId: "nested" });
  });
  it.each([undefined, "", "a\nb", "a b", "x".repeat(129)])("拒绝不可靠身份 %s", id => {
    expect(parseAgentMetadata({ id })).toBeUndefined();
  });
  it("顶层 parent 与 thread_spawn 冲突时不选择其中一方", () => {
    expect(parseAgentMetadata({ id: "child", parent_thread_id: "a", source: { subagent: { thread_spawn: { parent_thread_id: "b" } } } }))
      .toMatchObject({ parentId: undefined, relationConflict: true });
  });
  it("只有 session_id 不会产生 parent", () => {
    expect(parseAgentMetadata({ id: "child", session_id: "root", thread_source: "subagent" })?.parentId).toBeUndefined();
  });
  it("不把 guardian_review 算作任务代理", () => {
    expect(parseAgentMetadata({ id: "review", parent_thread_id: "root", thread_source: "guardian_review", source: { subagent: { other: "guardian_review" } } }))
      .toMatchObject({ subagent: true, taskAgent: false });
  });
  it("原始 prompt 和凭证不进入 metadata", () => {
    const meta = parseAgentMetadata({ id: "child", agent_path: "/root/password=秘密", base_instructions: "隐私正文", api_key: "密钥" });
    expect(JSON.stringify(meta)).not.toMatch(/秘密|隐私正文|密钥/u);
  });
});

describe("真实 Agent 事件归一化", () => {
  it("单代理完整生命周期来自真实 JSONL", async () => {
    const events = await agentEvents("single-agent");
    expect(events).toContainEqual(expect.objectContaining({ type: "agent-discovered", agentId: "single", parentId: "root" }));
    expect(events).toContainEqual(expect.objectContaining({ type: "agent-status", agentId: "single", status: "running" }));
    expect(events).toContainEqual(expect.objectContaining({ type: "agent-status", agentId: "single", status: "completed" }));
  });
  it("spawn 调用只有父身份，不根据任务路径伪造 child ID", async () => {
    const events = (await agentEvents("parallel-agents")).filter(event => event.type === "agent-call");
    expect(events).toHaveLength(2);
    expect(events.every(event => event.type === "agent-call" && event.agentId === "root" && event.operation === "spawn")).toBe(true);
  });
  it("同名外部工具不能冒充 Codex collaboration", async () => {
    const parser = new AgentEventParser(); parser.parse(JSON.parse((await agentFixture("single-agent"))[0]));
    const result = parser.parse({ type: "response_item", payload: { type: "function_call", namespace: "external", name: "spawn_agent", call_id: "call-1" } });
    expect(result.events).toEqual([]); expect(result.detected).toBe(false);
  });
  it("工具失败不代表 Agent 失败", async () => {
    const events = await agentEvents("agent-failure");
    expect(events.some(event => event.type === "tool-failed")).toBe(true);
    expect(events.filter(event => event.type === "agent-status").at(-1)).toMatchObject({ status: "completed" });
    expect(events.some(event => event.type === "agent-status" && event.status === "failed")).toBe(false);
  });
  it("真实 interrupted 轮次归一化为 cancelled", async () => {
    expect((await agentEvents("agent-cancelled")).filter(event => event.type === "agent-status").at(-1)).toMatchObject({ status: "cancelled" });
  });
  it("运行中样本前缀没有伪造完成", async () => {
    const events = await agentEvents("agent-restart");
    expect(events.some(event => event.type === "agent-status" && event.status === "running")).toBe(true);
    expect(events.some(event => event.type === "agent-status" && event.status === "completed")).toBe(false);
  });
  it("等待只改变调用线程，不把 wait 调用完成当成子代理完成", async () => {
    const parser = new AgentEventParser();
    parser.parse(JSON.parse((await agentFixture("single-agent"))[0]));
    const waiting = parser.parse({ type: "response_item", payload: { type: "function_call", name: "wait_agent", namespace: "collaboration", call_id: "wait-1", arguments: "{}" } }, 10);
    expect(waiting.events.at(-1)).toMatchObject({ agentId: "single", status: "waiting" });
    const returned = parser.parse({ type: "response_item", payload: { type: "function_call_output", call_id: "wait-1", output: "completed" } }, 20);
    expect(returned.events).toEqual([expect.objectContaining({ agentId: "single", status: "running" })]);
  });
  it("reset 清除旧线程与 wait 关联", async () => {
    const parser = new RolloutEventParser();
    parser.parse((await agentFixture("single-agent"))[0]);
    parser.reset();
    expect(parser.parse(JSON.stringify({ type: "event_msg", payload: { type: "task_complete", turn_id: "old" } })).events.some(event => event.type.startsWith("agent-"))).toBe(false);
  });
  it("旧 turn 的 wait 返回不改变新 turn", async () => {
    const parser = new AgentEventParser(); parser.parse(JSON.parse((await agentFixture("single-agent"))[0]));
    parser.parse({ type: "event_msg", payload: { type: "task_started", turn_id: "t1" } });
    parser.parse({ type: "response_item", payload: { type: "function_call", name: "wait_agent", namespace: "collaboration", call_id: "w" } });
    parser.parse({ type: "event_msg", payload: { type: "task_started", turn_id: "t2" } });
    expect(parser.parse({ type: "response_item", payload: { type: "function_call_output", call_id: "w" } }).events).toEqual([]);
  });
  it("输出先到时不会在迟到的 wait 调用后卡住", async () => {
    const parser = new AgentEventParser(); parser.parse(JSON.parse((await agentFixture("single-agent"))[0]));
    parser.parse({ type: "response_item", payload: { type: "function_call_output", call_id: "w" } });
    const result = parser.parse({ type: "response_item", payload: { type: "function_call", name: "wait_agent", namespace: "collaboration", call_id: "w" } });
    expect(result.events.some(event => event.status === "waiting")).toBe(false);
  });
  it("明确属于其他线程的工具事件不串入当前线程", async () => {
    const parser = new RolloutEventParser();
    parser.parse((await agentFixture("single-agent"))[0]);
    const raw = { timestamp: "2026-09-12T00:00:00Z", type: "event_msg", payload: { type: "item_completed", thread_id: "foreign", item: { type: "CommandExecution", id: "same", status: "failed", exit_code: 7 } } };
    expect(parser.parse(JSON.stringify(raw)).events).toEqual([]);
  });
  it("完整并行链路保留各自 Token，B 先完成也不换身份", async () => {
    const state = await agentState();
    const values = agentsOf(state);
    const a = values.find(agent => agent.id === "explorer")!;
    const b = values.find(agent => agent.id === "tester")!;
    expect(a.completedAt).toBeGreaterThan(b.completedAt!);
    expect(a.tokens?.totalTokens).toBe(1077643);
    expect(b.tokens?.totalTokens).toBe(681570);
    expect(a.context?.usedTokens).toBe(118392);
    expect(b.context?.usedTokens).toBe(93708);
    expect(state.agentSummary?.capability.correlation).toBe("strong");
  });
  it("完整真实嵌套链路生成第三层", async () => {
    const state = await agentState(["nested-agents", "nested-leaf"]);
    expect(state.agentSummary?.tree[0].children[0].children[0].agent.id).toBe("leaf");
    expect(state.agentSummary?.capability.nestedSupport).toBe(true);
  });
  it("未知取消原因保持 unknown", async () => {
    const parser = new AgentEventParser();
    parser.parse(JSON.parse((await agentFixture("single-agent"))[0]));
    expect(parser.parse({ type: "event_msg", payload: { type: "turn_aborted", reason: "future-reason" } }).events[0]).toMatchObject({ status: "unknown" });
  });
  it.each(["single-agent", "parallel-a", "parallel-b", "nested-agents", "nested-leaf", "agent-failure", "agent-restart", "agent-cancelled"])("%s 样本不会把输入输出正文存入状态", async name => {
    const serialized = JSON.stringify(await agentEvents(name));
    expect(serialized).not.toMatch(/已移除任务正文|已移除工具输入|已移除工具输出/u);
  });
});
