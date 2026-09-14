import { ModelPricingRegistry } from "../src/core/usage/ModelPricingRegistry.js";
import type { TokenUsageSnapshot, UsageRecord } from "../src/core/usage/UsageState.js";
import { HudStateReducer } from "../src/core/HudStateReducer.js";

export function usage(inputTokens = 100, cachedInputTokens = 80, outputTokens = 10, cacheWriteInputTokens: number | undefined = 0): TokenUsageSnapshot {
  return { inputTokens, cachedInputTokens, outputTokens, reasoningOutputTokens: Math.min(4, outputTokens),
    totalTokens: inputTokens + outputTokens, ...(cacheWriteInputTokens === undefined ? {} : { cacheWriteInputTokens }) };
}

export function sumUsage(a: TokenUsageSnapshot, b: TokenUsageSnapshot): TokenUsageSnapshot {
  return { inputTokens: a.inputTokens + b.inputTokens, cachedInputTokens: a.cachedInputTokens + b.cachedInputTokens,
    outputTokens: a.outputTokens + b.outputTokens, reasoningOutputTokens: a.reasoningOutputTokens + b.reasoningOutputTokens,
    totalTokens: a.totalTokens + b.totalTokens,
    ...(a.cacheWriteInputTokens === undefined || b.cacheWriteInputTokens === undefined ? {}
      : { cacheWriteInputTokens: a.cacheWriteInputTokens + b.cacheWriteInputTokens }) };
}

export function usageRecord(ordinal = 1, value = usage(), overrides: Partial<UsageRecord> = {}): UsageRecord {
  return { id: `request-${ordinal}`, threadId: "thread-a", ordinal, timestamp: ordinal * 1000,
    model: "priced-a", usage: value, source: "measured", ...overrides };
}

export function testPricing(): ModelPricingRegistry {
  return new ModelPricingRegistry([
    { model: "priced-a", inputPerMillion: 2, cachedInputPerMillion: 0.5, outputPerMillion: 8,
      currency: "USD", source: "manual-config", sourceVersion: "test-a", inputContract: "separate-cache-categories" },
    { model: "priced-b", inputPerMillion: 4, cachedInputPerMillion: 1, outputPerMillion: 16,
      currency: "USD", source: "manual-config", sourceVersion: "test-b", inputContract: "separate-cache-categories" },
  ]);
}

export function usageState(value = usage(100000, 90000, 1000), threadId = "thread-a") {
  const reducer = new HudStateReducer(false, testPricing());
  reducer.apply({ type: "session", id: threadId });
  reducer.apply({ type: "model", model: "priced-a", ordinal: 1 });
  reducer.apply({ type: "tokens", threadId, model: "priced-a", ordinal: 2, at: 2000,
    total: value, last: value, contextWindow: 258400 });
  return reducer.getState(2000);
}

export function rawUsage(value: TokenUsageSnapshot) {
  return { input_tokens: value.inputTokens, cached_input_tokens: value.cachedInputTokens,
    output_tokens: value.outputTokens, reasoning_output_tokens: value.reasoningOutputTokens, total_tokens: value.totalTokens,
    ...(value.cacheWriteInputTokens === undefined ? {} : { cache_write_input_tokens: value.cacheWriteInputTokens }) };
}
