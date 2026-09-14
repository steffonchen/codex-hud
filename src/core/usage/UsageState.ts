export type UsageSource = "measured" | "estimated" | "unknown";
export type UsageCoverage = "complete" | "partial" | "unknown";

export interface TokenUsageSnapshot {
  inputTokens: number;
  cachedInputTokens: number;
  cacheWriteInputTokens?: number;
  outputTokens: number;
  reasoningOutputTokens: number;
  totalTokens: number;
}

export interface TokenUsageState {
  total?: TokenUsageSnapshot;
  last?: TokenUsageSnapshot;
  modelContextWindow?: number;
  timestamp?: number;
  source: UsageSource;
  totalSource: UsageSource;
  lastSource: UsageSource;
}

export interface UsageRecord {
  id: string;
  timestamp?: number;
  ordinal?: number;
  model?: string;
  threadId?: string;
  agentId?: string;
  usage: TokenUsageSnapshot;
  source: UsageSource;
  cacheWriteSemantics?: "input-subset" | "unverified";
}

export interface TokenSnapshotEvent {
  eventId?: string;
  total?: Partial<TokenUsageSnapshot>;
  last?: Partial<TokenUsageSnapshot>;
  contextWindow?: number;
  at?: number;
  ordinal?: number;
  threadId?: string;
  agentId?: string;
  model?: string;
  cacheWriteSemantics?: UsageRecord["cacheWriteSemantics"];
}

export interface CacheUsageState {
  latestInputTokens?: number;
  latestCachedInputTokens?: number;
  latestCacheWriteInputTokens?: number;
  hitRate?: number;
  cumulativeInputTokens?: number;
  cumulativeCachedInputTokens?: number;
  cumulativeHitRate?: number;
  source: UsageSource;
  coverage: UsageCoverage;
}

export interface CostEstimate {
  value?: number;
  currency?: string;
  inputCost?: number;
  cachedInputCost?: number;
  cacheWriteCost?: number;
  outputCost?: number;
  source?: string;
  sourceVersion?: string;
  basis: "standard-api-equivalent";
  confidence: "estimated" | "unknown";
  reason?: string;
}

export interface CostUsageState {
  latestCost: CostEstimate;
  sessionEstimatedCost: CostEstimate;
  pricedRequests: number;
  unpricedRequests: number;
}

export interface UsageEconomicsState {
  tokens: TokenUsageState;
  cache: CacheUsageState;
  cost: CostUsageState;
  requestCount: number;
  coverage: UsageCoverage;
  retainedRecords: number;
  droppedRecords: number;
  recentRecords: UsageRecord[];
  issues: string[];
}

export const TOKEN_FIELDS = ["inputTokens", "cachedInputTokens", "outputTokens", "reasoningOutputTokens", "totalTokens"] as const;
export const tokenNumber = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value >= 0;

export function completeUsage(value?: Partial<TokenUsageSnapshot>): TokenUsageSnapshot | undefined {
  if (!value || !TOKEN_FIELDS.every(key => tokenNumber(value[key]))
    || (value.cacheWriteInputTokens !== undefined && !tokenNumber(value.cacheWriteInputTokens))) return undefined;
  return { inputTokens: value.inputTokens!, cachedInputTokens: value.cachedInputTokens!, outputTokens: value.outputTokens!,
    reasoningOutputTokens: value.reasoningOutputTokens!, totalTokens: value.totalTokens!,
    ...(value.cacheWriteInputTokens === undefined ? {} : { cacheWriteInputTokens: value.cacheWriteInputTokens }) };
}

export function usageSource(value?: TokenUsageSnapshot): UsageSource {
  if (!value) return "unknown";
  if (value.totalTokens > 0 && value.inputTokens === 0 && value.cachedInputTokens === 0
    && value.outputTokens === 0 && value.reasoningOutputTokens === 0 && (value.cacheWriteInputTokens ?? 0) === 0) return "estimated";
  if (value.cachedInputTokens > value.inputTokens || value.reasoningOutputTokens > value.outputTokens
    || value.inputTokens + value.outputTokens !== value.totalTokens) return "unknown";
  return "measured";
}
