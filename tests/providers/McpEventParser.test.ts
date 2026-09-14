import { describe, expect, it } from "vitest";
import { McpEventParser } from "../../src/providers/codex/McpEventParser.js";
import { RolloutEventParser } from "../../src/providers/codex/RolloutEventParser.js";
import { HudStateReducer } from "../../src/core/HudStateReducer.js";
import type { ToolEvent } from "../../src/core/HudEvent.js";
import { mcpResult } from "../capabilities.js";

describe("MCP 真实事件解析", () => {
  it("从真实 item 层取得服务器和工具，不读取参数", async () => {
    const raw = await mcpResult();
    raw.payload.item.arguments = { token: "private-argument" };
    const result = new McpEventParser().parse(raw.payload.item);
    expect(result).toMatchObject({ serverName: "codex_app", toolName: "open_in_codex" });
    expect(JSON.stringify(result)).not.toContain("private-argument");
  });
  it("真实失败仅产生工具失败及未知服务器状态", async () => {
    const reducer = new HudStateReducer();
    for (const event of new RolloutEventParser().parse(JSON.stringify(await mcpResult("tool-failed"))).events) reducer.apply(event);
    const state = reducer.getState(0);
    expect(state.tools?.recent?.[0]).toMatchObject({ type: "mcp", status: "failed", mcp: { serverName: "cua_repl", toolName: "js" } });
    expect(state.mcpSummary).toMatchObject({ failedCount: 0, readyCount: 0, capability: { serverStatus: false, toolDiscovery: false } });
    expect(state.mcpSummary?.servers[0].status).toBe("unknown");
  });
  it("保留完成、实际开始时间和纳秒耗时", async () => {
    const raw = await mcpResult();
    const result = new RolloutEventParser().parse(JSON.stringify(raw));
    const event = result.events.find(event => event.type === "tool-completed") as ToolEvent;
    expect(event.startedAt).toBe(raw.payload.started_at_ms);
    expect(event.durationMs).toBeCloseTo(raw.payload.item.duration.secs * 1000 + raw.payload.item.duration.nanos / 1e6);
    expect(result.detections.mcp).toBe(true);
  });
  it("result.isError 优先于 completed 的边界组合", async () => {
    const raw = await mcpResult(); raw.payload.item.result.isError = true;
    expect(new RolloutEventParser().parse(JSON.stringify(raw)).events[0].type).toBe("tool-failed");
  });
  it.each([{}, { type: "mcpToolCall", server: "a", tool: "b" }, { type: "McpToolCall", server: "a" },
    { type: "McpToolCall", server: "", tool: "b" }, { type: "McpToolCall", server: 1, tool: "b" }])("不猜缺失字段或不同 schema：%j", item => {
    expect(new McpEventParser().parse(item)).toBeUndefined();
  });
  it("未知普通 namespace 不成为 MCP", () => {
    const result = new RolloutEventParser().parse(JSON.stringify({ type: "response_item", payload: { type: "function_call", namespace: "github", name: "read", call_id: "call" } }));
    expect((result.events[0] as ToolEvent).mcp).toBeUndefined();
  });
  it("显式其他线程的 MCP 结果不会进入当前线程", async () => {
    const parser = new RolloutEventParser();
    parser.parse(JSON.stringify({ type: "session_meta", payload: { id: "owner" } }));
    expect(parser.parse(JSON.stringify(await mcpResult())).events).toEqual([]);
  });
  it("名称截断和脱敏不导致不同工具身份相撞", () => {
    const parser = new McpEventParser();
    const a = parser.parse({ type: "McpToolCall", server: "a", tool: "x".repeat(150) + "a" })!;
    const b = parser.parse({ type: "McpToolCall", server: "a", tool: "x".repeat(150) + "b" })!;
    expect(a.toolName).toBe(b.toolName); expect(a.toolId).not.toBe(b.toolId);
  });
});
