import { describe, expect, it } from "vitest";
import { CostCalculator } from "../src/core/usage/CostCalculator.js";
import { ModelPricingRegistry } from "../src/core/usage/ModelPricingRegistry.js";
import { TokenUsageTracker } from "../src/core/usage/TokenUsageTracker.js";
import type { ModelPricing } from "../src/core/usage/PricingProvider.js";
import { testPricing, usage, usageRecord } from "./usage.js";

const base = (): ModelPricing => testPricing().getPricing("priced-a")!;

describe("CostCalculator 标准 API 等价估算", () => {
  it("缓存输入只按独立缓存费率收费，不重复按普通输入收费", () => {
    const result = new CostCalculator(testPricing()).estimate(usageRecord(1, usage(100000, 90000, 1000)));
    expect(result).toMatchObject({ confidence: "estimated", basis: "standard-api-equivalent", currency: "USD", source: "manual-config", sourceVersion: "test-a" });
    expect(result.inputCost).toBeCloseTo(0.02); expect(result.cachedInputCost).toBeCloseTo(0.045);
    expect(result.outputCost).toBeCloseTo(0.008); expect(result.value).toBeCloseTo(0.073);
  });
  it("reasoning 只是 output 分项，改变它不会额外收费", () => {
    const calculator = new CostCalculator(testPricing()), record = usageRecord(1, usage(100000, 90000, 1000));
    expect(calculator.estimate({ ...record, usage: { ...record.usage, reasoningOutputTokens: 700 } })).toEqual(calculator.estimate(record));
  });
  it("只有明确的缓存写入契约才从输入总量扣除后分别计价", () => {
    const calculator = new CostCalculator(new ModelPricingRegistry([{ ...base(), cacheWriteInputPerMillion: 3 }]));
    const record = usageRecord(1, usage(100000, 80000, 1000, 10000));
    expect(calculator.estimate(record).value).toBeUndefined();
    const confirmed = calculator.estimate({ ...record, cacheWriteSemantics: "input-subset" });
    expect(confirmed.inputCost).toBeCloseTo(0.02); expect(confirmed.cacheWriteCost).toBeCloseTo(0.03);
    expect(confirmed.value).toBeCloseTo(0.098);
  });
  it("计费需要写入字段时，缺失不能当作零", () => {
    const calculator = new CostCalculator(new ModelPricingRegistry([{ ...base(), cacheWriteInputPerMillion: 3 }]));
    const record = usageRecord(); delete record.usage.cacheWriteInputTokens;
    expect(calculator.estimate(record)).toMatchObject({ confidence: "unknown", reason: "Cache-write usage missing" });
  });
  it("显式零缓存写入不需要猜测正数写入的映射", () => {
    const calculator = new CostCalculator(new ModelPricingRegistry([{ ...base(), cacheWriteInputPerMillion: 3 }]));
    expect(calculator.estimate(usageRecord()).confidence).toBe("estimated");
  });
  it.each([
    usageRecord(1, usage(), { model: undefined }), usageRecord(1, usage(), { model: "missing" }),
    usageRecord(1, usage(), { source: "estimated" }), usageRecord(1, { ...usage(), totalTokens: 999 }),
    usageRecord(1, usage(100, 80, 10, 30), { cacheWriteSemantics: "input-subset" }),
  ])("未知模型、非实测或冲突输入不会返回虚假的零费用", record => {
    const calculator = new CostCalculator(new ModelPricingRegistry([{ ...base(), cacheWriteInputPerMillion: 3 }]));
    const estimate = calculator.estimate(record);
    expect(estimate.confidence).toBe("unknown"); expect(estimate.value).toBeUndefined(); expect(estimate.reason).toBeTruthy();
  });
  it("长上下文门槛取单次完整输入，严格超过后作用于整请求", () => {
    const calculator = new CostCalculator(new ModelPricingRegistry([{ ...base(), cacheWriteInputPerMillion: 3,
      longContext: { inputTokensAbove: 100, inputMultiplier: 2, outputMultiplier: 1.5 } }]));
    const below = calculator.estimate(usageRecord(1, usage(100, 80, 10)));
    const above = calculator.estimate(usageRecord(2, usage(101, 80, 10)));
    expect(below.value).toBeCloseTo(0.00016, 10);
    expect(above.inputCost).toBeCloseTo(0.000084, 10);
    expect(above.cachedInputCost).toBeCloseTo(0.00008, 10);
    expect(above.outputCost).toBeCloseTo(0.00012, 10);
    expect(above.value).toBeCloseTo(0.000284, 10);
  });
  it("实际零用量可以估算为零，与 unavailable 区分", () => {
    expect(new CostCalculator(testPricing()).estimate(usageRecord(1, usage(0, 0, 0)))).toMatchObject({ value: 0, confidence: "estimated" });
  });
  it("费用溢出保持不可用", () => {
    const calculator = new CostCalculator(new ModelPricingRegistry([{ ...base(), inputPerMillion: Number.MAX_VALUE }]));
    expect(calculator.estimate(usageRecord()).confidence).toBe("unknown");
  });
  it("不同币种不能直接生成会话合计", () => {
    const tracker = new TokenUsageTracker({ pricing: new ModelPricingRegistry([base(), { ...base(), model: "eur", currency: "EUR" }]) });
    tracker.recordIncrementalUsage(usageRecord()); tracker.recordIncrementalUsage(usageRecord(2, usage(), { model: "eur" }));
    expect(tracker.snapshot().cost.latestCost.currency).toBe("EUR");
    expect(tracker.snapshot().cost.sessionEstimatedCost).toMatchObject({ confidence: "unknown", reason: "Requests use different currencies and cannot be summed directly" });
  });
});

describe("ModelPricingRegistry", () => {
  it("已有官方条目保存模型、来源、版本与URL，未知别名不猜价格", () => {
    const registry = new ModelPricingRegistry();
    for (const model of ["gpt-6-astra", "gpt-5.6-sol"]) expect(registry.getPricing(model)).toMatchObject({
      model, currency: "USD", source: "official-openai", sourceVersion: "2026-09-12", sourceUrl: `https://developers.openai.com/api/docs/models/${model}` });
    expect(registry.getPricing("gpt-6-astra-unknown")).toBeUndefined();
    expect(registry.getPricing("unknown")).toBeUndefined();
  });
  it("输入条目及查询结果不会被调用方回写", () => {
    const entry = base(), registry = new ModelPricingRegistry([entry]); entry.inputPerMillion = 999;
    registry.getPricing("priced-a")!.inputPerMillion = 888;
    expect(registry.getPricing("priced-a")!.inputPerMillion).toBe(2);
  });
  it.each([
    { inputPerMillion: -1 }, { cachedInputPerMillion: Number.NaN }, { currency: "usd" }, { source: " " },
    { longContext: { inputTokensAbove: 10, inputMultiplier: 0, outputMultiplier: 1 } },
  ])("拒绝无效定价条目", change => { expect(() => new ModelPricingRegistry([{ ...base(), ...change }])).toThrow("Invalid model pricing entry"); });
  it("拒绝重复模型条目，避免隐式覆盖", () => { expect(() => new ModelPricingRegistry([base(), base()])).toThrow("Invalid model pricing entry"); });
});
