import { describe, expect, it } from "vitest";
import { readFile } from "node:fs/promises";
import { HudStateReducer } from "../../src/core/HudStateReducer.js";
import { RolloutEventParser } from "../../src/providers/codex/RolloutEventParser.js";
import { rawUsage, sumUsage, testPricing, usage } from "../usage.js";

const fixture = async (name: string) => (await readFile(new URL(`../fixtures/usage/${name}.jsonl`, import.meta.url), "utf8")).trimEnd().split("\n");
const event = (type: string, payload: unknown) => JSON.stringify({ type, payload });
const token = (total = usage(), last = total) => event("event_msg", { type: "token_count", info: {
  total_token_usage: rawUsage(total), last_token_usage: rawUsage(last), model_context_window: 258400,
} });
const setup = () => ({ parser: new RolloutEventParser(), reducer: new HudStateReducer(false, testPricing()) });

describe("真实匿名用量样本的解析与归约", () => {
  it("主线程连续 12 条事件形成 11 个请求，重复快照不重算缓存或费用", async () => {
    const { parser, reducer } = setup(); const lines = await fixture("main-sequence");
    for (const [index, line] of lines.entries()) {
      const result = parser.parse(line, index + 1); expect(result.diagnostics).toEqual([]);
      for (const entry of result.events) reducer.apply(entry);
    }
    const state = reducer.getState(0), details = state.usage!;
    expect(state.session?.id).toBe("usage-main"); expect(state.model).toBe("gpt-6-astra");
    expect(details).toMatchObject({ requestCount: 11, coverage: "complete", tokens: { totalSource: "measured", lastSource: "measured",
      total: { inputTokens: 649981, cachedInputTokens: 554422, cacheWriteInputTokens: 95526, outputTokens: 10935, reasoningOutputTokens: 2668, totalTokens: 660916 },
      last: { inputTokens: 95529, cachedInputTokens: 89932, cacheWriteInputTokens: 5594, outputTokens: 2098, reasoningOutputTokens: 516, totalTokens: 97627 } } });
    expect(details.cache.cumulativeInputTokens).toBe(649981); expect(details.cache.cumulativeCachedInputTokens).toBe(554422);
    expect(details.cache.hitRate).toBeCloseTo(89932 / 95529); expect(details.cost.sessionEstimatedCost.value).toBeUndefined();
    expect(details.recentRecords.every(record => record.threadId === "usage-main" && record.agentId === undefined)).toBe(true);
    expect(state.quota).toMatchObject({ source: "rollout", availability: "empty" });
  });
  it("子线程的 null info 和重复首请求不补零、不挂到其他线程", async () => {
    const { parser, reducer } = setup(), lines = await fixture("child-sequence");
    for (const [index, line] of lines.entries()) {
      const parsed = parser.parse(line, index + 1); for (const entry of parsed.events) reducer.apply(entry);
      if (index === 4) expect(reducer.getState(0).usage).toBeUndefined();
    }
    const details = reducer.getState(0).usage!;
    expect(details).toMatchObject({ requestCount: 1, coverage: "complete", tokens: { last: { inputTokens: 22167, cachedInputTokens: 21761, cacheWriteInputTokens: 0, totalTokens: 22801 } } });
    expect(details.recentRecords[0]).toMatchObject({ threadId: "usage-child", agentId: "usage-child", model: "gpt-6-astra" });
    expect(details.cache.hitRate).toBeCloseTo(21761 / 22167);
  });
  it("既有真实压缩样本的零分项 total>0 只用于上下文估算", async () => {
    const { parser, reducer } = setup();
    const source = await readFile(new URL("../fixtures/codex/rollout-token-count.jsonl", import.meta.url), "utf8");
    for (const line of source.trimEnd().split("\n")) for (const entry of parser.parse(line).events) reducer.apply(entry);
    const state = reducer.getState(0);
    expect(state.usage).toMatchObject({ requestCount: 0, coverage: "partial", tokens: { totalSource: "measured", lastSource: "estimated", total: { totalTokens: 6475285 }, last: { totalTokens: 18994 } } });
    expect(state.context?.usedTokens).toBe(18994); expect(state.usage?.cache.hitRate).toBeUndefined();
    expect(state.usage?.cost.latestCost.value).toBeUndefined();
  });
});

describe("用量解析的合成边界契约", () => {
  it("模型变化按请求发生时的模型计算，旧请求不重定价", () => {
    const { parser, reducer } = setup();
    const source = [event("session_meta", { id: "thread-a" }), event("turn_context", { model: "priced-a" }), token(),
      event("turn_context", { model: "priced-b" }), token(sumUsage(usage(), usage()), usage())];
    for (const [index, line] of source.entries()) for (const entry of parser.parse(line, index + 1).events) reducer.apply(entry);
    expect(reducer.getState(0).usage?.recentRecords.map(record => record.model)).toEqual(["priced-a", "priced-b"]);
    expect(reducer.getState(0).usage?.cost.sessionEstimatedCost.value).toBeCloseTo(0.00048);
  });
  it("未来模型不能套用到较早物理行的 Token，诊断保留行号", () => {
    const { parser, reducer } = setup();
    for (const entry of parser.parse(event("session_meta", { id: "thread-a" }), 1).events) reducer.apply(entry);
    for (const entry of parser.parse(event("turn_context", { model: "priced-b" }), 10).events) reducer.apply(entry);
    const parsed = parser.parse(token(), 9);
    expect(parsed.diagnostics).toEqual([expect.objectContaining({ code: "usage-model-order", line: 9, severity: "warning" })]);
    const tokens = parsed.events.find(entry => entry.type === "tokens")!;
    expect(tokens).toMatchObject({ type: "tokens", model: undefined });
    for (const entry of parsed.events) reducer.apply(entry);
    expect(reducer.getState(0).usage?.cost.latestCost.value).toBeUndefined();
  });
  it("没有 metadata 时不猜所属线程，外来显式 thread_id 被忽略", () => {
    const { parser, reducer } = setup();
    for (const entry of parser.parse(token()).events) reducer.apply(entry);
    expect(reducer.getState(0).usage).toMatchObject({ requestCount: 0, coverage: "partial" });
    parser.parse(event("session_meta", { id: "thread-a" }));
    const raw = JSON.parse(token()); raw.payload.thread_id = "thread-b";
    expect(parser.parse(JSON.stringify(raw)).events).toEqual([]);
  });
  it("缺少 quota 不清除原窗口，null 明确清除；info=null 不伪造请求", () => {
    const { parser, reducer } = setup();
    const quota = (value: unknown) => event("event_msg", { type: "token_count", info: null, rate_limits: value });
    for (const entry of parser.parse(quota({ primary: { used_percent: 28, window_minutes: 300 }, secondary: null })).events) reducer.apply(entry);
    for (const entry of parser.parse(token()).events) reducer.apply(entry);
    expect(reducer.getState(0).quota?.primary?.usedPercent).toBe(28);
    for (const entry of parser.parse(quota(null)).events) reducer.apply(entry);
    expect(reducer.getState(0).quota).toMatchObject({ availability: "unavailable" });
    expect(reducer.getState(0).quota?.primary).toBeUndefined(); expect(reducer.getState(0).usage?.requestCount).toBe(0);
  });
  it("缺失累计字段后的恢复不能重复入账，reset 后回放结果一致", () => {
    const { parser, reducer } = setup();
    const source = [event("session_meta", { id: "thread-a" }), event("turn_context", { model: "priced-a" }), token(),
      event("event_msg", { type: "token_count", info: { last_token_usage: rawUsage(usage()) } }), token()];
    const replay = () => { for (const [index, line] of source.entries()) for (const entry of parser.parse(line, index + 1).events) reducer.apply(entry); };
    replay(); const before = reducer.getState(0).usage;
    expect(before).toMatchObject({ requestCount: 1, coverage: "partial", cache: { cumulativeInputTokens: 100 } });
    parser.reset(); reducer.reset(); replay(); expect(reducer.getState(0).usage).toEqual(before);
  });
});
