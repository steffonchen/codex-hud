import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { AppServerEventNormalizer } from "../src/providers/codex/app-server/AppServerEventNormalizer.js";
import { SourceDeduplicator } from "../src/core/source/SourceDeduplicator.js";
import { HudStateReducer } from "../src/core/HudStateReducer.js";
import { command, itemNotification, thread, tokenNotification, turn } from "./app-server/helpers.js";

const context = { generation: 1, ordinal: 1, phase: "live" as const, rootThreadId: "thread-a" };
describe("AppServerEventNormalizer 当前 0.154.0 契约", () => {
  it("脱敏协议语料经同一 normalizer 解析，schema 默认值保留证据", () => {
    const normalizer = new AppServerEventNormalizer();
    const corpus = JSON.parse(readFileSync(new URL("./fixtures/app-server/notifications.json", import.meta.url), "utf8"));
    for (const [index, notification] of corpus.entries()) {
      const result = normalizer.normalize(notification, { ...context, ordinal: index + 1 });
      expect(result.recognized).toBe(true); expect(result.diagnostics).toEqual([]); expect(result.events.length).toBeGreaterThan(0);
    }
    const schema = JSON.parse(readFileSync(new URL("./fixtures/app-server/schema/ThreadTokenUsageUpdatedNotification.json", import.meta.url), "utf8"));
    expect(schema.definitions.TokenUsageBreakdown.properties.cacheWriteInputTokens).toMatchObject({ type: "integer", default: 0 });
    expect(schema.definitions.TokenUsageBreakdown.required).not.toContain("cacheWriteInputTokens");
  });
  it("thread.id 是 session；forkedFromId 和共享 sessionId 不建立父边", () => {
    const result = new AppServerEventNormalizer().thread({ ...thread(), forkedFromId: "fork-origin" }, context);
    expect(result.events.find(event => event.type === "session")).toMatchObject({ id: "thread-a", startedAt: 1789257600000 });
    expect(result.events.find(event => event.type === "agent-discovered")).toMatchObject({ parentId: undefined, isSubagent: false });
  });
  it("生命周期语料保留真实终态与错误路径，malformed 不伪装成功", () => {
    const normalizer = new AppServerEventNormalizer();
    const corpus = JSON.parse(readFileSync(new URL("./fixtures/app-server/lifecycle.json", import.meta.url), "utf8"));
    for (const notification of corpus.notifications) {
      const result = normalizer.normalize(notification, context);
      expect(result.recognized).toBe(true);
      if (notification.method === "error") expect(result.diagnostics[0].code).toBe("app-server-turn-error");
      else { expect(result.diagnostics).toEqual([]); expect(result.events.length).toBeGreaterThan(0); }
    }
    const malformed = normalizer.normalize(corpus.malformed, context);
    expect(malformed.events).toEqual([]); expect(malformed.diagnostics[0].code).toBe("app-server-notification-schema");
  });
  it("完整 Token 字段进入现有 tracker，不使用线程配置模型给请求定价", () => {
    const result = new AppServerEventNormalizer().normalize(tokenNotification(1), context);
    expect(result.events[0]).toMatchObject({ type: "tokens", total: { totalTokens: 110 }, last: { totalTokens: 110 }, contextWindow: 1000, source: "app-server" });
    expect(result.events[0]).not.toHaveProperty("model");
  });
  it.each([null, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, "0"])("非法缓存写入字段 %s 不变成零", bad => {
    const notification = tokenNotification(1);
    (notification.params as any).tokenUsage.total.cacheWriteInputTokens = bad;
    const result = new AppServerEventNormalizer().normalize(notification, context);
    expect(result.events).toEqual([]); expect(result.diagnostics).not.toHaveLength(0);
  });
  it("仅省略缓存写入字段应用协议默认值", () => {
    const notification = tokenNotification(1); delete (notification.params as any).tokenUsage.total.cacheWriteInputTokens;
    expect(new AppServerEventNormalizer().normalize(notification, context).events[0]).toMatchObject({ total: { cacheWriteInputTokens: 0 } });
  });
  it("schema未知字段可接受，未知方法与条目不会崩溃", () => {
    const normalizer = new AppServerEventNormalizer();
    expect(normalizer.normalize({ method: "future/method", params: { secret: "不应保留" } }, context).recognized).toBe(false);
    expect(normalizer.normalize(itemNotification({ type: "futureItem", id: "item-a" }), context).events).toEqual([]);
  });
  it("工具完成通知中的非零退出码保持失败且不输出命令正文", () => {
    const result = new AppServerEventNormalizer().normalize(itemNotification({ ...command("a", "completed", 7), command: "curl -H 'Authorization: SECRET' https://example.com/private", aggregatedOutput: "SECRET" }), context);
    expect(result.events[0]).toMatchObject({ type: "tool-failed", outputSummary: "Exit code 7", resultSource: "execution" });
    expect(JSON.stringify(result)).not.toContain("SECRET"); expect(JSON.stringify(result)).not.toContain("https://example");
  });
  it.each(["fileChange", "mcpToolCall", "dynamicToolCall"])("映射 %s 的明确失败", kind => {
    const value = kind === "fileChange" ? { changes: [{ path: "/example/a.ts", kind: { type: "update" }, diff: "SECRET" }], status: "failed" }
      : kind === "mcpToolCall" ? { server: "example", tool: "search", status: "completed", error: null, result: { content: [], isError: true }, arguments: { secret: "SECRET" } }
      : { tool: "example", namespace: null, status: "completed", success: false, arguments: { secret: "SECRET" } };
    const result = new AppServerEventNormalizer().normalize(itemNotification({ id: "tool-a", type: kind, ...value }), context);
    expect(result.events[0].type).toBe("tool-failed"); expect(JSON.stringify(result)).not.toContain("SECRET");
  });
  it("等待标志解除后恢复 running，idle 不伪造完成", () => {
    const normalizer = new AppServerEventNormalizer();
    normalizer.normalize({ method: "turn/started", params: { threadId: "thread-a", turn: turn("turn-a", "inProgress") } }, context);
    const status = (type: string, activeFlags: string[] = []) => normalizer.normalize({ method: "thread/status/changed", params: { threadId: "thread-a", status: { type, activeFlags } } }, context);
    expect(status("active", ["waitingOnApproval"]).events[0]).toMatchObject({ status: "waiting", threadId: "thread-a" });
    expect(status("active").events[0].turnId).toBeUndefined();
    expect(status("active").events[0]).toMatchObject({ status: "running" }); expect(status("idle").events).toEqual([]);
  });
  it("子代理只由明确 receiver 身份发现，不借父轮次推进子状态", () => {
    const result = new AppServerEventNormalizer().normalize(itemNotification({ type: "collabAgentToolCall", id: "spawn-a", tool: "spawnAgent",
      status: "completed", senderThreadId: "thread-a", receiverThreadIds: ["child-a"], agentsStates: { "child-a": { status: "completed" } }, prompt: "SECRET" }), context);
    expect(result.events.find(event => event.type === "agent-discovered")).toMatchObject({ agentId: "child-a", parentId: "thread-a", threadId: "child-a" });
    expect(result.events.some(event => event.type === "agent-status")).toBe(false); expect(JSON.stringify(result)).not.toContain("SECRET");
  });
  it("活动轮次提案保持 streaming；历史多提案经来源层使用独立 ordinal", () => {
    const normalizer = new AppServerEventNormalizer(), source = new SourceDeduplicator(), reducer = new HudStateReducer();
    reducer.apply({ type: "session", id: "thread-a" });
    for (const event of normalizer.turn("thread-a", turn("turn-a", "inProgress", [{ type: "plan", id: "p1", text: "一" }, { type: "plan", id: "p2", text: "二" }]), { ...context, phase: "history" }).events)
      for (const accepted of source.consume(event)) reducer.apply(accepted);
    expect(reducer.getState(0).planSummary?.proposal).toMatchObject({ itemId: "p2", status: "streaming" });
  });
  it("稀疏额度保留窗口时长、reset 和账户 metadata", () => {
    const normalizer = new AppServerEventNormalizer();
    const send = (rateLimits: unknown) => normalizer.normalize({ method: "account/rateLimits/updated", params: { rateLimits } }, context);
    send({ limitId: "primary-model", primary: { usedPercent: 5, windowDurationMins: 300, resetsAt: 2000000000 }, secondary: { usedPercent: 1, windowDurationMins: 10080 }, planType: "pro" });
    const event = send({ primary: { usedPercent: 6 }, planType: null }).events[0];
    expect(event).toMatchObject({ type: "quota", quota: { primary: { usedPercent: 6, windowDurationMins: 300, resetsAt: 2000000000 }, secondary: { usedPercent: 1 }, planType: "pro" } });
  });
  it("错误只输出白名单分类，不输出服务端 message", () => {
    const result = new AppServerEventNormalizer().normalize({ method: "error", params: { threadId: "thread-a", turnId: "turn-a", willRetry: false,
      error: { message: "SECRET", codexErrorInfo: "unauthorized" } } }, context);
    expect(result.diagnostics[0].message).toContain("unauthorized"); expect(JSON.stringify(result)).not.toContain("SECRET");
  });
});
