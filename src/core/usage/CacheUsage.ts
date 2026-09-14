import type { CacheUsageState, TokenUsageSnapshot, TokenUsageState, UsageCoverage } from "./UsageState.js";

export function cacheUsage(tokens: TokenUsageState, incremental: TokenUsageSnapshot | undefined, coverage: UsageCoverage): CacheUsageState {
  const last = tokens.lastSource === "measured" ? tokens.last : undefined;
  return { source: tokens.lastSource, coverage,
    latestInputTokens: last?.inputTokens, latestCachedInputTokens: last?.cachedInputTokens,
    latestCacheWriteInputTokens: last?.cacheWriteInputTokens,
    hitRate: last && last.inputTokens > 0 ? last.cachedInputTokens / last.inputTokens : undefined,
    cumulativeInputTokens: incremental?.inputTokens, cumulativeCachedInputTokens: incremental?.cachedInputTokens,
    cumulativeHitRate: incremental && incremental.inputTokens > 0 ? incremental.cachedInputTokens / incremental.inputTokens : undefined };
}
