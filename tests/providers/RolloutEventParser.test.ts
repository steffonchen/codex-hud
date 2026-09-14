import { describe, expect, it } from "vitest";
import { readFile } from "node:fs/promises";
import { RolloutEventParser } from "../../src/providers/codex/RolloutEventParser.js";

const parser = new RolloutEventParser();
const fixture = async (name: string) => (await readFile(new URL(`../fixtures/codex/${name}`, import.meta.url), "utf8")).trimEnd().split("\n");
const event = (payload: unknown, type = "event_msg") => JSON.stringify({ timestamp: "2026-09-11T04:30:25Z", type, payload });

describe("RolloutEventParser", () => {
  it("按实际 session_meta 和 turn_context 字段归一化，context_window 对象不当容量", async () => {
    const [meta, turn, model] = (await fixture("rollout-session.jsonl")).map(line => parser.parse(line));
    expect(meta.events[0]).toMatchObject({ type: "session", id: "session-a", version: "0.153.4", startedAt: 1789101025274 });
    expect(meta.detections.contextWindow).toBe(false);
    expect(turn.events[0]).toMatchObject({ type: "turn-started", id: "turn-a", contextWindow: 258400 });
    expect(model.events[0]).toMatchObject({ type: "model", model: "gpt-6-astra", reasoningEffort: "high" });
    expect([meta, turn, model].flatMap(result => result.diagnostics)).toEqual([]);
  });

  it("累计与最近快照分别解析，不从 input/output 求和代替 Codex total", async () => {
    const lines = await fixture("rollout-token-count.jsonl");
    const first = parser.parse(lines[0]);
    expect(first.events[0]).toMatchObject({ type: "tokens", contextWindow: 258400, total: {
      inputTokens: 6375573, cachedInputTokens: 5700149, outputTokens: 99712, reasoningOutputTokens: 39317, totalTokens: 6475285,
    }, last: { totalTokens: 191970 } });
    expect(parser.parse(lines[1]).events[0].type).toBe("context-compacted");
    expect(parser.parse(lines[2]).events[0]).toMatchObject({ type: "tokens", last: { inputTokens: 0, outputTokens: 0, totalTokens: 18994 } });
    expect(first.detections).toMatchObject({ tokenCount: true, contextWindow: true });
    expect(JSON.stringify(first)).not.toContain("cache_write_input_tokens");
  });

  it("info=null 是可用协议中的缺失数据，不伪造零值或抛异常", () => {
    const parsed = parser.parse(event({ type: "token_count", info: null }));
    expect(parsed.events).toEqual([{ type: "activity", at: 1789101025000 }]);
    expect(parsed.detections.tokenCount).toBe(true);
    expect(parsed.diagnostics).toEqual([]);
  });

  it("未知事件仅记录活动时间，消息正文和工具数据不会泄漏到状态", () => {
    const parsed = parser.parse(event({ message: "用户正文", authorization: "敏感值" }, "response_item"));
    expect(parsed.events).toEqual([{ type: "activity", at: 1789101025000 }]);
    expect(JSON.stringify(parsed)).not.toContain("用户正文");
    expect(JSON.stringify(parsed)).not.toContain("敏感值");
  });

  it.each([-1, 1.5, "10", 9007199254740992])("拒绝非法 Token 数值 %s", value => {
    const parsed = parser.parse(event({ type: "token_count", info: { total_token_usage: { total_tokens: value }, model_context_window: 0 } }));
    expect(parsed.events[0]).toMatchObject({ type: "tokens", total: undefined, contextWindow: undefined });
    expect(parsed.diagnostics).toHaveLength(2);
  });

  it("缺失 id、错误 payload 和无效时间都有可定位诊断", () => {
    expect(parser.parse(event({}, "session_meta"), 12).diagnostics[0]).toMatchObject({ line: 12, code: "invalid-event-field" });
    expect(parser.parse(event("private body", "turn_context")).diagnostics[0].message).toContain("payload");
    expect(parser.parse('{"type":"response_item","timestamp":"invalid"}').events).toEqual([]);
  });

  it("损坏 JSON 的错误不附带原始行、消息正文或凭证", () => {
    const parsed = parser.parse('{"api_key":"测试秘密",', 42);
    expect(parsed.events).toEqual([]);
    expect(parsed.diagnostics).toEqual([{ code: "invalid-json", severity: "error", message: "JSONL line is not valid JSON; line skipped", line: 42 }]);
    expect(JSON.stringify(parsed)).not.toContain("测试秘密");
    expect(parser.parse("   ").diagnostics).toEqual([]);
  });

  it("顶层类型不符时不会当作合法事件", () => {
    expect(parser.parse("null").diagnostics).toHaveLength(1);
    expect(parser.parse("[]").diagnostics).toHaveLength(1);
  });

  it("超出日期范围的 Unix 秒不进入活动时间", () => {
    const parsed = parser.parse(event({ type: "task_started", started_at: Number.MAX_SAFE_INTEGER }));
    expect(parsed.events[0].at).toBe(1789101025000);
    expect(parsed.diagnostics[0].message).toContain("started_at");
  });
});
