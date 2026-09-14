import { t } from "../../i18n/Messages.js";
import { CostCalculator, unknownCost } from "./CostCalculator.js";
import { cacheUsage } from "./CacheUsage.js";
import type { PricingProvider } from "./PricingProvider.js";
import { completeUsage, TOKEN_FIELDS, tokenNumber, usageSource, type CostEstimate, type TokenSnapshotEvent,
  type TokenUsageSnapshot, type TokenUsageState, type UsageCoverage, type UsageEconomicsState, type UsageRecord } from "./UsageState.js";

export const MAX_USAGE_RECORDS = 512;
export const MAX_RECENT_USAGE_RECORDS = 20;

const emptyTokens = (): TokenUsageState => ({ source: "unknown", totalSource: "unknown", lastSource: "unknown" });
const sameUsage = (a: TokenUsageSnapshot, b: TokenUsageSnapshot): boolean =>
  TOKEN_FIELDS.every(key => a[key] === b[key]) && a.cacheWriteInputTokens === b.cacheWriteInputTokens;
const matchesIncrement = (previous: TokenUsageSnapshot, total: TokenUsageSnapshot, last: TokenUsageSnapshot): boolean =>
  TOKEN_FIELDS.every(key => total[key] - previous[key] === last[key])
  && (previous.cacheWriteInputTokens === undefined || total.cacheWriteInputTokens === undefined || last.cacheWriteInputTokens === undefined
    || total.cacheWriteInputTokens - previous.cacheWriteInputTokens === last.cacheWriteInputTokens);

export class TokenUsageTracker {
  private tokens = emptyTokens();
  private baseline?: TokenUsageSnapshot;
  private threadId?: string;
  private ordinal?: number;
  private timestamp?: number;
  private incrementalOrdinal?: number;
  private incrementalTimestamp?: number;
  private evictedTimestamp?: number;
  private records: UsageRecord[] = [];
  private identities = new Set<string>();
  private incremental?: TokenUsageSnapshot;
  private coverage: UsageCoverage = "unknown";
  private requestCount = 0;
  private droppedRecords = 0;
  private issues = new Set<string>();
  private latestCost = unknownCost(t("尚无可确认的请求"));
  private sessionCost?: CostEstimate;
  private pricedRequests = 0;
  private unpricedRequests = 0;
  private mixedCurrencies = false;
  private readonly calculator: CostCalculator;
  private readonly limit: number;

  constructor(options: { maxRecords?: number; pricing?: PricingProvider } = {}) {
    this.limit = options.maxRecords ?? MAX_USAGE_RECORDS;
    if (!Number.isSafeInteger(this.limit) || this.limit < 1 || this.limit > 5000) throw new Error(t("用量历史上限必须在1至5000之间"));
    this.calculator = new CostCalculator(options.pricing);
  }

  reset(threadId?: string): void {
    this.tokens = emptyTokens(); this.baseline = undefined; this.threadId = threadId;
    this.ordinal = undefined; this.timestamp = undefined; this.incrementalOrdinal = undefined;
    this.incrementalTimestamp = undefined; this.evictedTimestamp = undefined;
    this.records = []; this.identities.clear(); this.incremental = undefined; this.coverage = "unknown";
    this.requestCount = 0; this.droppedRecords = 0; this.issues.clear();
    this.latestCost = unknownCost(t("尚无可确认的请求")); this.sessionCost = undefined;
    this.pricedRequests = 0; this.unpricedRequests = 0; this.mixedCurrencies = false;
  }

  setThread(threadId: string): void {
    if (this.threadId && this.threadId !== threadId) this.reset(threadId);
    else this.threadId = threadId;
  }

  consume(event: TokenSnapshotEvent): boolean {
    const previous = this.baseline;
    const previousLast = this.tokens.last;
    const previousLastSource = this.tokens.lastSource;
    if (!this.recordLatestUsage(event)) return false;
    const { total, last, totalSource, lastSource } = this.tokens;
    // 缺失或估算快照不能擦掉已确认的基线，否则恢复同一累计量会再次入账。
    if (totalSource === "measured") this.baseline = total;
    if (lastSource === "estimated") {
      if (!previous || !total || totalSource !== "measured" || !sameUsage(previous, total)) {
        this.markPartial(t("上下文估算期间累计快照变化或历史缺失，无法确认完整请求用量"));
      }
      this.latestCost = unknownCost(t("最近用量是上下文估算"));
      return true;
    }
    if (!total || !last || totalSource !== "measured" || lastSource !== "measured") {
      this.markPartial(t("用量分项缺失或不一致，不能确认请求增量"));
      this.latestCost = unknownCost(t("用量分项不完整或未经确认"));
      return true;
    }
    if (previous && sameUsage(previous, total)) {
      if (!previousLast || previousLastSource !== "measured" || !sameUsage(previousLast, last)) {
        this.tokens.lastSource = this.tokens.source = "unknown";
        this.latestCost = unknownCost(t("累计量未变，最近快照不能确认为新的模型请求"));
      }
      return true;
    }
    const confirmed = previous ? matchesIncrement(previous, total, last) : sameUsage(total, last);
    if (!confirmed) {
      this.markPartial(t("累计快照重算或历史有缺口，未将差值推算为模型请求"));
      this.latestCost = unknownCost(t("最近快照未能与独立请求对应"));
      return true;
    }
    if (!event.threadId) {
      this.markPartial(t("缺少明确线程身份，用量快照未进入请求账本"));
      this.latestCost = unknownCost(t("请求所属线程未确认"));
      return true;
    }
    const accepted = this.recordIncrementalUsage({ id: event.eventId ?? `usage:${event.threadId}:${event.ordinal ?? `sequence:${this.requestCount + 1}`}`,
      timestamp: event.at, ordinal: event.ordinal, threadId: event.threadId, agentId: event.agentId,
      model: event.model, usage: last, source: "measured", cacheWriteSemantics: event.cacheWriteSemantics });
    if (!accepted) {
      this.markPartial(t("最近请求未能安全计入账本"));
      this.latestCost = unknownCost(t("最近请求未能安全计入账本"));
    }
    return true;
  }

  recordLatestUsage(event: TokenSnapshotEvent): boolean {
    if (!this.acceptThread(event.threadId) || !this.acceptOrder(event.ordinal, event.at)) return false;
    const total = completeUsage(event.total), last = completeUsage(event.last);
    this.tokens = { total, last, modelContextWindow: tokenNumber(event.contextWindow) && event.contextWindow > 0 ? event.contextWindow : undefined,
      timestamp: event.at, totalSource: usageSource(total), lastSource: usageSource(last), source: usageSource(last) };
    return true;
  }

  recordIncrementalUsage(record: UsageRecord): boolean {
    if (!record.id || record.id.length > 1024 || this.identities.has(record.id) || !this.acceptThread(record.threadId)) return false;
    if (record.ordinal !== undefined && (!tokenNumber(record.ordinal) || (this.incrementalOrdinal !== undefined && record.ordinal <= this.incrementalOrdinal))) return false;
    if (record.timestamp !== undefined && (!Number.isFinite(record.timestamp) || record.timestamp < 0)) { this.markPartial(t("请求时间无效")); return false; }
    // 没有物理序号时，不能把去重窗口之外的旧身份当成新请求。
    if (record.ordinal === undefined && (record.timestamp === undefined ? this.droppedRecords > 0
      : (this.incrementalTimestamp !== undefined && record.timestamp < this.incrementalTimestamp)
        || (this.evictedTimestamp !== undefined && record.timestamp <= this.evictedTimestamp))) {
      this.markPartial(t("请求乱序或超出去重窗口，未重复累计无法确认的用量"));
      return false;
    }
    const usage = completeUsage(record.usage);
    if (!usage || record.source !== "measured" || usageSource(usage) !== "measured") {
      this.markPartial(t("请求没有完整实测用量，未计入累计统计")); return false;
    }
    const accumulated = { ...usage };
    if (this.incremental) {
      for (const key of TOKEN_FIELDS) accumulated[key] += this.incremental[key];
      accumulated.cacheWriteInputTokens = usage.cacheWriteInputTokens !== undefined && this.incremental.cacheWriteInputTokens !== undefined
        ? usage.cacheWriteInputTokens + this.incremental.cacheWriteInputTokens : undefined;
    }
    if (!completeUsage(accumulated)) { this.markPartial(t("请求累计Token超出安全整数范围")); return false; }
    const accepted: UsageRecord = { id: record.id, timestamp: record.timestamp, ordinal: record.ordinal, model: record.model,
      threadId: record.threadId, agentId: record.agentId, source: "measured", usage, cacheWriteSemantics: record.cacheWriteSemantics };
    this.incremental = accumulated;
    this.incrementalOrdinal = record.ordinal ?? this.incrementalOrdinal;
    if (record.timestamp !== undefined) this.incrementalTimestamp = Math.max(this.incrementalTimestamp ?? 0, record.timestamp);
    this.requestCount++;
    if (this.coverage === "unknown") this.coverage = "complete";
    this.records.push(accepted); this.identities.add(accepted.id);
    if (this.records.length > this.limit) {
      const removed = this.records.shift()!;
      if (removed.timestamp !== undefined) this.evictedTimestamp = Math.max(this.evictedTimestamp ?? 0, removed.timestamp);
      this.droppedRecords++;
    }
    if (this.identities.size > this.limit) this.identities.delete(this.identities.values().next().value!);
    this.latestCost = this.calculator.estimate(accepted);
    this.accumulateCost(this.latestCost);
    return true;
  }

  compact(ordinal?: number, at?: number): boolean {
    if (!this.acceptOrder(ordinal, at)) return false;
    this.tokens = { ...this.tokens, last: undefined, lastSource: "unknown", source: "unknown", timestamp: at };
    this.latestCost = unknownCost(t("压缩后等待新的实测请求"));
    return true;
  }

  getLatestUsage(): TokenUsageSnapshot | undefined { return this.tokens.last && { ...this.tokens.last }; }
  getTotalUsage(): TokenUsageSnapshot | undefined { return this.tokens.total && { ...this.tokens.total }; }
  getIncrementalUsage(): TokenUsageSnapshot | undefined { return this.incremental && { ...this.incremental }; }
  getRecords(): UsageRecord[] { return structuredClone(this.records); }

  snapshot(): UsageEconomicsState {
    const sessionEstimatedCost = this.coverage !== "complete" ? unknownCost(t("请求历史不完整，无法给出完整会话估算"))
      : this.unpricedRequests > 0 ? unknownCost(t("{0} 个请求的价格或计费契约不可用", this.unpricedRequests))
      : this.mixedCurrencies ? unknownCost(t("请求使用不同币种，不能直接相加"))
      : this.sessionCost ?? unknownCost(t("尚无可确认的请求"));
    return { tokens: structuredClone(this.tokens), cache: cacheUsage(this.tokens, this.incremental, this.coverage),
      cost: { latestCost: { ...this.latestCost }, sessionEstimatedCost: { ...sessionEstimatedCost }, pricedRequests: this.pricedRequests, unpricedRequests: this.unpricedRequests },
      requestCount: this.requestCount, coverage: this.coverage, retainedRecords: this.records.length, droppedRecords: this.droppedRecords,
      recentRecords: structuredClone(this.records.slice(-MAX_RECENT_USAGE_RECORDS)), issues: [...this.issues] };
  }

  private acceptThread(threadId?: string): boolean {
    if (this.threadId && threadId && this.threadId !== threadId) { this.issue(t("忽略属于其他线程的用量记录")); return false; }
    if (threadId) this.threadId = threadId;
    return true;
  }

  private acceptOrder(ordinal?: number, at?: number): boolean {
    if ((ordinal !== undefined && !tokenNumber(ordinal)) || (at !== undefined && (!Number.isFinite(at) || at < 0))) {
      this.issue(t("用量来源顺序或时间无效")); return false;
    }
    // 文件物理顺序优先于时间与数值；新的重算快照可以小于此前累计量。
    if (ordinal !== undefined) {
      if (this.ordinal !== undefined && ordinal <= this.ordinal) return false;
      this.ordinal = ordinal;
    } else if (at !== undefined && this.timestamp !== undefined && at < this.timestamp) return false;
    if (at !== undefined) this.timestamp = Math.max(this.timestamp ?? 0, at);
    return true;
  }

  private accumulateCost(cost: CostEstimate): void {
    if (cost.value === undefined || cost.confidence !== "estimated") { this.unpricedRequests++; return; }
    this.pricedRequests++;
    if (!this.sessionCost) { this.sessionCost = { ...cost }; return; }
    if (this.sessionCost.currency !== cost.currency) { this.mixedCurrencies = true; return; }
    for (const key of ["value", "inputCost", "cachedInputCost", "cacheWriteCost", "outputCost"] as const) {
      const value = (this.sessionCost[key] ?? 0) + (cost[key] ?? 0);
      if (!Number.isFinite(value)) { this.markPartial(t("会话费用超出可计算范围")); return; }
      this.sessionCost[key] = value;
    }
    if (this.sessionCost.source !== cost.source) this.sessionCost.source = "multiple-sources";
    if (this.sessionCost.sourceVersion !== cost.sourceVersion) this.sessionCost.sourceVersion = undefined;
  }

  private markPartial(message: string): void { this.coverage = "partial"; this.issue(message); }
  private issue(message: string): void { if (this.issues.size < 20) this.issues.add(message); }
}
