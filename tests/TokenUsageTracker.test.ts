import { describe, expect, it } from "vitest";
import { TokenUsageTracker } from "../src/core/usage/TokenUsageTracker.js";
import { usageSource } from "../src/core/usage/UsageState.js";
import { sumUsage, testPricing, usage, usageRecord } from "./usage.js";

const snapshot = (ordinal: number, total = usage(), last = total) => ({ ordinal, at: ordinal * 1000, total, last,
  threadId: "thread-a", model: "priced-a", contextWindow: 258400 });
const tracker = (maxRecords?: number) => new TokenUsageTracker({ pricing: testPricing(), maxRecords });

describe("TokenUsageTracker 用量语义与账本", () => {
  it("累计快照覆盖，最近请求独立保存，缓存累计仅使用请求增量", () => {
    const subject = tracker(), first = usage(), second = usage(200, 150, 20);
    subject.consume(snapshot(1, first)); subject.consume(snapshot(2, sumUsage(first, second), second));
    expect(subject.getTotalUsage()?.totalTokens).toBe(330);
    expect(subject.getLatestUsage()?.totalTokens).toBe(220);
    expect(subject.getIncrementalUsage()?.totalTokens).toBe(330);
    expect(subject.snapshot()).toMatchObject({ requestCount: 2, coverage: "complete",
      cache: { cumulativeInputTokens: 300, cumulativeCachedInputTokens: 230, hitRate: 0.75 } });
    expect(subject.snapshot().cache.cumulativeHitRate).toBeCloseTo(230 / 300);
  });

  it("缓存与推理是分项，不能加到源端总量", () => {
    const subject = tracker();
    subject.consume(snapshot(1, { ...usage(100000, 90000, 1000), reasoningOutputTokens: 700 }));
    expect(subject.getTotalUsage()?.totalTokens).toBe(101000);
    expect(subject.snapshot().cache.hitRate).toBe(0.9);
  });

  it("从不完整历史开始，不把累计快照冒充一次请求", () => {
    const subject = tracker(); subject.consume(snapshot(1, usage(1000, 800), usage()));
    expect(subject.snapshot()).toMatchObject({ requestCount: 0, coverage: "partial",
      cost: { sessionEstimatedCost: { confidence: "unknown" } } });
    expect(subject.snapshot().cost.sessionEstimatedCost.value).toBeUndefined();
    expect(subject.getTotalUsage()?.inputTokens).toBe(1000);
  });

  it("不同物理行重复同一完整快照也不重复入账", () => {
    const subject = tracker(); subject.consume(snapshot(1)); subject.consume(snapshot(2));
    expect(subject.snapshot().requestCount).toBe(1);
    expect(subject.getIncrementalUsage()?.inputTokens).toBe(100);
  });

  it("两个用量完全相同的独立请求仍分别累计", () => {
    const subject = tracker(); subject.consume(snapshot(1)); subject.consume(snapshot(2, sumUsage(usage(), usage()), usage()));
    expect(subject.snapshot().requestCount).toBe(2);
    expect(subject.getIncrementalUsage()?.totalTokens).toBe(220);
  });

  it("物理序号阻止旧快照和重复回放，即使时间戳更新", () => {
    const subject = tracker(); subject.consume(snapshot(10));
    expect(subject.consume({ ...snapshot(9, usage(999)), at: 20000 })).toBe(false);
    expect(subject.consume({ ...snapshot(10), at: 30000 })).toBe(false);
    expect(subject.getTotalUsage()?.inputTokens).toBe(100);
  });

  it("没有物理序号时拒绝旧时间的快照", () => {
    const subject = tracker(); subject.consume({ ...snapshot(2), ordinal: undefined });
    expect(subject.consume({ ...snapshot(1, usage(999)), ordinal: undefined })).toBe(false);
    expect(subject.getTotalUsage()?.inputTokens).toBe(100);
  });

  it("压缩清除最近缓存数据，但不清除已确认的会话累计", () => {
    const subject = tracker(); subject.consume(snapshot(1)); subject.compact(2, 2000);
    expect(subject.getLatestUsage()).toBeUndefined(); expect(subject.getTotalUsage()?.totalTokens).toBe(110);
    expect(subject.snapshot().cache).toMatchObject({ source: "unknown", cumulativeInputTokens: 100 });
    expect(subject.snapshot().cache.hitRate).toBeUndefined();
    expect(subject.snapshot().cost.latestCost.confidence).toBe("unknown");
  });

  it("压缩估算不入账，累计量不变时保留完整会话统计", () => {
    const subject = tracker(); subject.consume(snapshot(1)); subject.compact(2);
    const estimated = { ...usage(0, 0, 0), totalTokens: 50 };
    subject.consume(snapshot(3, usage(), estimated)); subject.consume(snapshot(4, usage(), estimated));
    expect(subject.snapshot()).toMatchObject({ requestCount: 1, coverage: "complete", tokens: { lastSource: "estimated" } });
    expect(subject.snapshot().cache.hitRate).toBeUndefined();
    expect(subject.snapshot().cost.sessionEstimatedCost.value).toBeCloseTo(0.00016);
    subject.consume(snapshot(5, sumUsage(usage(), usage(200, 150, 20)), usage(200, 150, 20)));
    expect(subject.snapshot()).toMatchObject({ requestCount: 2, coverage: "complete", tokens: { lastSource: "measured" } });
  });

  it("压缩估算期间累计量增加时不能继续宣称完整费用", () => {
    const subject = tracker(); subject.consume(snapshot(1)); subject.compact(2);
    subject.consume(snapshot(3, sumUsage(usage(), usage(200, 150, 20)), { ...usage(0, 0, 0), totalTokens: 50 }));
    expect(subject.snapshot()).toMatchObject({ requestCount: 1, coverage: "partial", tokens: { total: { inputTokens: 300 }, lastSource: "estimated" } });
    expect(subject.snapshot().cost.sessionEstimatedCost.value).toBeUndefined();
    expect(subject.snapshot().issues.join(" ")).toContain("Cumulative snapshot changed");
  });

  it("首次只有估算与历史总量时不建立虚假的完整账本", () => {
    const subject = tracker(); subject.consume(snapshot(1, usage(1000, 800), { ...usage(0, 0, 0), totalTokens: 50 }));
    expect(subject.snapshot()).toMatchObject({ requestCount: 0, coverage: "partial" });
  });

  it("累计量下降接受权威快照，但不把重算作为请求或完整会话费用", () => {
    const subject = tracker(); subject.consume(snapshot(1, usage(1000, 800)));
    subject.consume(snapshot(2, usage(100, 80), usage(0, 0, 0)));
    expect(subject.getTotalUsage()?.inputTokens).toBe(100);
    expect(subject.snapshot()).toMatchObject({ requestCount: 1, coverage: "partial" });
    expect(subject.snapshot().cost.sessionEstimatedCost.value).toBeUndefined();
  });

  it("累计量未变但 last 改变，重复该快照不会把未知重新升级为实测", () => {
    const subject = tracker(); subject.consume(snapshot(1));
    subject.consume(snapshot(2, usage(), usage(50, 30)));
    subject.consume(snapshot(3, usage(), usage(50, 30)));
    expect(subject.snapshot().tokens.lastSource).toBe("unknown");
    expect(subject.snapshot().cache.hitRate).toBeUndefined(); expect(subject.snapshot().requestCount).toBe(1);
  });

  it("零输入保留零值，但缓存命中率未定义", () => {
    const subject = tracker(); subject.consume(snapshot(1, usage(0, 0, 0)));
    expect(subject.snapshot().cache.latestInputTokens).toBe(0);
    expect(subject.snapshot().cache.hitRate).toBeUndefined(); expect(subject.snapshot().cache.cumulativeHitRate).toBeUndefined();
  });

  it("缺少用量时不可用，不补零", () => {
    const subject = tracker(); expect(subject.snapshot().cache.source).toBe("unknown");
    subject.consume({ threadId: "thread-a", ordinal: 1, total: { totalTokens: 100 } });
    expect(subject.getTotalUsage()).toBeUndefined(); expect(subject.snapshot().cache.latestInputTokens).toBeUndefined();
  });

  it("累计字段短暂缺失后恢复同一快照，不会把同一请求再次入账", () => {
    const subject = tracker(); subject.consume(snapshot(1));
    subject.consume({ ...snapshot(2), total: undefined }); subject.consume(snapshot(3));
    expect(subject.snapshot()).toMatchObject({ requestCount: 1, coverage: "partial" });
    expect(subject.getIncrementalUsage()?.totalTokens).toBe(110);
    expect(subject.snapshot().cost.sessionEstimatedCost.value).toBeUndefined();
  });

  it("无序号快照因去重边界拒绝入账时，最近费用不能沿用上一请求", () => {
    const subject = tracker(1), a = usage(), b = usage(200, 150, 20), c = usage(300, 250, 30);
    subject.consume({ ...snapshot(1, a), ordinal: undefined, at: 1000 });
    subject.consume({ ...snapshot(2, sumUsage(a, b), b), ordinal: undefined, at: 1000 });
    expect(subject.snapshot().cost.latestCost.value).toBeDefined();
    subject.consume({ ...snapshot(3, sumUsage(sumUsage(a, b), c), c), ordinal: undefined, at: 1000 });
    expect(subject.getLatestUsage()).toEqual(c); expect(subject.snapshot().requestCount).toBe(2);
    expect(subject.snapshot().cost.latestCost).toMatchObject({ confidence: "unknown", reason: expect.stringContaining("could not be safely") });
    expect(subject.snapshot().cost.latestCost.value).toBeUndefined();
  });

  it("累计重算后请求账本溢出时，不遗留前一请求费用", () => {
    const subject = tracker(); const large = usage(Number.MAX_SAFE_INTEGER - 10, 0, 0);
    subject.consume(snapshot(1, large)); subject.consume(snapshot(2, usage(0, 0, 0)));
    subject.consume(snapshot(3, usage(5, 0, 0))); expect(subject.snapshot().cost.latestCost.value).toBeDefined();
    subject.consume(snapshot(4, usage(15, 0, 0), usage(10, 0, 0)));
    expect(subject.getLatestUsage()?.totalTokens).toBe(10); expect(subject.snapshot().cost.latestCost.value).toBeUndefined();
    expect(subject.snapshot().issues.join(" ")).toContain("safe integer");
  });

  it("有序号和无序号快照混用时，请求身份不会碰撞而漏计", () => {
    const subject = tracker(), a = usage(), b = usage(200, 150, 20);
    subject.consume(snapshot(2, a)); subject.consume({ ...snapshot(3, sumUsage(a, b), b), ordinal: undefined });
    expect(subject.snapshot()).toMatchObject({ requestCount: 2, coverage: "complete", issues: [] });
    expect(subject.getIncrementalUsage()?.totalTokens).toBe(330);
    expect(new Set(subject.getRecords().map(record => record.id)).size).toBe(2);
  });

  it.each([
    { ...usage(), cachedInputTokens: 101 }, { ...usage(), reasoningOutputTokens: 11 },
    { ...usage(), totalTokens: 999 }, { ...usage(), inputTokens: -1 }, { ...usage(), outputTokens: Number.NaN },
  ])("不一致或非法分项保持未知，不能进入费用账本", value => {
    const subject = tracker(); subject.consume(snapshot(1, value));
    expect(subject.snapshot().tokens.source).toBe("unknown"); expect(subject.snapshot().requestCount).toBe(0);
    expect(subject.snapshot().cost.sessionEstimatedCost.value).toBeUndefined();
  });

  it("全零分项且 total>0 是 estimated，而非 measured", () => {
    expect(usageSource({ ...usage(0, 0, 0), totalTokens: 18448 })).toBe("estimated");
  });

  it("有界去重淘汰后，旧时间请求不能重复增加缓存与费用", () => {
    const subject = tracker(1), a = usageRecord(1, usage(), { ordinal: undefined }), b = usageRecord(2, usage(200, 150), { ordinal: undefined });
    subject.recordIncrementalUsage(a); subject.recordIncrementalUsage(b);
    expect(subject.recordIncrementalUsage(a)).toBe(false);
    expect(subject.snapshot()).toMatchObject({ requestCount: 2, retainedRecords: 1, droppedRecords: 1, coverage: "partial",
      cache: { cumulativeInputTokens: 300, cumulativeCachedInputTokens: 230 } });
    expect(subject.snapshot().cost.sessionEstimatedCost.value).toBeUndefined();
  });

  it("同时间不同请求在去重窗口内可用，淘汰后无法确认的同时间身份不重计", () => {
    const subject = tracker(1), a = usageRecord(1, usage(), { ordinal: undefined });
    const b = usageRecord(2, usage(), { ordinal: undefined, timestamp: 1000 });
    expect(subject.recordIncrementalUsage(a)).toBe(true); expect(subject.recordIncrementalUsage(b)).toBe(true);
    expect(subject.recordIncrementalUsage(a)).toBe(false); expect(subject.snapshot().requestCount).toBe(2);
  });

  it("无时间和序号的记录在身份淘汰后保持不确定，不猜是新请求", () => {
    const subject = tracker(1), a = usageRecord(1, usage(), { ordinal: undefined, timestamp: undefined });
    subject.recordIncrementalUsage(a); subject.recordIncrementalUsage({ ...a, id: "b" });
    expect(subject.recordIncrementalUsage(a)).toBe(false); expect(subject.snapshot().requestCount).toBe(2);
  });

  it("有物理序号的完整历史不会因淘汰或旧事件重放而重复累计", () => {
    const subject = tracker(1); for (let ordinal = 1; ordinal <= 25; ordinal++) subject.recordIncrementalUsage(usageRecord(ordinal));
    expect(subject.recordIncrementalUsage(usageRecord(1))).toBe(false);
    expect(subject.snapshot()).toMatchObject({ requestCount: 25, retainedRecords: 1, droppedRecords: 24, coverage: "complete" });
    expect(subject.getIncrementalUsage()?.inputTokens).toBe(2500);
  });

  it("每请求按当时模型价格累计，不重定价历史请求", () => {
    const subject = tracker(); subject.recordIncrementalUsage(usageRecord(1));
    subject.recordIncrementalUsage(usageRecord(2, usage(), { model: "priced-b" }));
    expect(subject.snapshot().cost.latestCost.value).toBeCloseTo(0.00032);
    expect(subject.snapshot().cost.sessionEstimatedCost.value).toBeCloseTo(0.00048);
    expect(subject.getRecords().map(record => record.model)).toEqual(["priced-a", "priced-b"]);
  });

  it("任何未定价请求使会话估算不可用，但之后的最近请求仍可计算", () => {
    const subject = tracker(); subject.recordIncrementalUsage(usageRecord(1, usage(), { model: "unknown" }));
    subject.recordIncrementalUsage(usageRecord(2));
    expect(subject.snapshot().cost).toMatchObject({ pricedRequests: 1, unpricedRequests: 1, latestCost: { confidence: "estimated" }, sessionEstimatedCost: { confidence: "unknown" } });
  });

  it("同一 tracker 只接收明确所属线程，setThread 切换时清空所有统计", () => {
    const subject = tracker(); subject.consume(snapshot(1));
    expect(subject.consume({ ...snapshot(2), threadId: "thread-b" })).toBe(false);
    subject.setThread("thread-b"); expect(subject.snapshot().requestCount).toBe(0);
    expect(subject.getTotalUsage()).toBeUndefined(); expect(subject.snapshot().cost.pricedRequests).toBe(0);
    expect(subject.consume({ ...snapshot(1), threadId: "thread-b" })).toBe(true);
  });

  it("没有明确线程不生成请求归属，agentId 只保留显式值", () => {
    const subject = tracker(); subject.consume({ ...snapshot(1), threadId: undefined }); expect(subject.snapshot().requestCount).toBe(0);
    subject.reset(); subject.consume(snapshot(1)); expect(subject.getRecords()[0].agentId).toBeUndefined();
    subject.reset(); subject.consume({ ...snapshot(1), agentId: "thread-a" }); expect(subject.getRecords()[0].agentId).toBe("thread-a");
  });

  it("reset 后从相同记录恢复相同结果，外部修改不会影响内部状态", () => {
    const subject = tracker(); const event = snapshot(1); subject.consume(event); const before = subject.snapshot();
    event.total.inputTokens = 999; const records = subject.getRecords(); records[0].usage.inputTokens = 999;
    expect(subject.snapshot()).toEqual(before); subject.reset(); subject.consume(snapshot(1)); expect(subject.snapshot()).toEqual(before);
  });

  it("超出安全整数的累计拒绝入账并报告不完整", () => {
    const subject = tracker(); subject.recordIncrementalUsage(usageRecord(1, usage(Number.MAX_SAFE_INTEGER, 0, 0)));
    expect(subject.recordIncrementalUsage(usageRecord(2, usage(1, 0, 0)))).toBe(false);
    expect(subject.snapshot()).toMatchObject({ requestCount: 1, coverage: "partial" });
  });

  it.each([0, -1, 1.5, 5001])("拒绝无效历史上限 %s", maxRecords => { expect(() => tracker(maxRecords)).toThrow("history limit"); });
});
