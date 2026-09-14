import { t } from "../../i18n/Messages.js";
import type { HudEvent } from "../HudEvent.js";
import { TOKEN_FIELDS, completeUsage } from "../usage/UsageState.js";
import type { DataSourceKind } from "./DataSource.js";
import { canonicalIdentity, eventIdentity, usageIdentity } from "./EventIdentity.js";
import { SourceAuthorityPolicy } from "./SourceAuthorityPolicy.js";
import { emptyEventStatistics, type EventStatistics } from "../HudDiagnostics.js";
import { eventProblem } from "./EventValidation.js";

type Tokens = Extract<HudEvent, { type: "tokens" }>;
interface UsageStream {
  owner: DataSourceKind;
  last?: Tokens;
  appPending: string[];
  rolloutPending: Tokens[];
  overflow: boolean;
  rolloutGeneration?: number;
  rolloutSeen?: Tokens;
  replayAnchor?: { signature: string; ordinal?: number };
  alignmentPending?: boolean;
  rolloutAccepted: string[];
  historyComplete: boolean;
}
interface ThreadOrder {
  current?: string;
  currentAt?: number;
  turnsLimited?: boolean;
  turns: Map<string, number>;
  sequence: number;
  plans: Map<string, DataSourceKind>;
  proposals: Map<string, number>;
  rolloutModel: boolean;
  blockedPlan?: boolean;
  compactions: Map<string, DataSourceKind>;
}

const family = (event: HudEvent): string => event.type === "plan-mode" ? "plan-mode"
  : ["plan-updated", "plan-status", "plan-cleared"].includes(event.type) ? "plan-execution" : event.type;
const continuous = (previous: Tokens, next: Tokens): boolean => {
  const before = completeUsage(previous.total), total = completeUsage(next.total), last = completeUsage(next.last);
  return !!before && !!total && !!last && TOKEN_FIELDS.every(key => total[key] - before[key] === last[key])
    && (before.cacheWriteInputTokens === undefined || total.cacheWriteInputTokens === undefined || last.cacheWriteInputTokens === undefined
      || total.cacheWriteInputTokens - before.cacheWriteInputTokens === last.cacheWriteInputTokens);
};

export class SourceDeduplicator {
  private ordinal = 0;
  private appLive = false;
  private unavailableThreads = new Set<string>();
  private watermarks = new Map<string, { threadId: string; generation: number; ordinal: number; ids: Set<string> }>();
  private seen = new Map<string, string>();
  private threads = new Map<string, ThreadOrder>();
  private usage = new Map<string, UsageStream>();
  private issues = new Set<string>();
  private duplicates = 0;
  private readonly statistics = emptyEventStatistics();

  constructor(readonly policy = new SourceAuthorityPolicy(), private readonly limit = 2048) {
    if (!Number.isSafeInteger(limit) || limit < 8 || limit > 16384) throw new Error(t("来源缓存上限无效"));
  }

  reset(): void {
    this.ordinal = 0; this.watermarks.clear(); this.seen.clear(); this.threads.clear(); this.usage.clear();
    this.issues.clear(); this.duplicates = 0;
    this.appLive = false; this.unavailableThreads.clear();
  }
  getStatistics(): EventStatistics { return { ...this.statistics }; }
  getResourceCounts(): Record<string, number> {
    return { dedupEntries: this.seen.size, sourceThreads: this.threads.size, sourceWatermarks: this.watermarks.size,
      watermarkIdentities: [...this.watermarks.values()].reduce((sum, mark) => sum + mark.ids.size, 0), tokenPending: this.getPendingCount() };
  }
  rejectEvent(reason: "invalid" | "unknown" | "outOfOrder" | "dropped", received = true): HudEvent[] {
    if (received) this.statistics.received++;
    if (reason !== "dropped") this.statistics[reason]++;
    this.statistics.dropped++;
    return [];
  }
  getIssues(): string[] {
    const streams = [...this.usage.values()];
    return [...this.issues,
      ...(streams.some(stream => stream.alignmentPending) ? [t("Token 来源尚未对齐，继续保留 Rollout 已确认快照")] : []),
      ...(streams.some(stream => stream.replayAnchor) ? [t("Rollout 已重新读取，Token 等待历史到达已确认快照，未重复入账")] : []),
      ...([...this.usage].some(([id, stream]) => !this.isAppLive(id) && stream.appPending.length) ? [t("实时来源断开，Token 等待 Rollout 按顺序补齐已采用快照，期间保留已确认用量")] : []),
      ...([...this.threads.values()].some(thread => thread.blockedPlan) ? [t("同轮计划缺少跨来源修订号，保留已确认清单，等待下一轮或原来源恢复")] : [])];
  }
  getTokenSource(threadId?: string): DataSourceKind | undefined { return threadId ? this.usage.get(threadId)?.owner : undefined; }
  forgetThread(threadId: string): void {
    this.threads.delete(threadId); this.usage.delete(threadId);
    for (const [key, value] of this.watermarks) if (value.threadId === threadId) this.watermarks.delete(key);
    for (const [key, owner] of this.seen) if (owner === threadId) this.seen.delete(key);
  }
  getDeduplicatedCount(): number { return this.duplicates; }
  getPendingCount(): number { return [...this.usage.values()].reduce((sum, stream) => sum + stream.appPending.length + stream.rolloutPending.length, 0); }

  setAppServerLive(live: boolean, unloadedThreadIds: readonly string[] = []): HudEvent[] {
    this.appLive = live;
    this.unavailableThreads = new Set(unloadedThreadIds);
    const events: HudEvent[] = [];
    for (const [id, stream] of this.usage) if (!this.isAppLive(id)) events.push(...this.releaseFallback(stream));
    return events;
  }

  consume(event: HudEvent): HudEvent[] {
    this.statistics.received++;
    const problem = eventProblem(event);
    if (problem) { this.issue(t("来源事件信封无效或类型未知，已跳过并计数")); return this.rejectEvent(problem, false); }
    const source = event.source ?? "rollout";
    if (!this.policy.accepts(source)) return this.rejectEvent("dropped", false);
    const threadId = event.threadId ?? (event.type === "session" ? event.id : undefined);
    if (!threadId) return [this.accept(event)];
    let order = this.threads.get(threadId);
    if (!order) {
      if (this.threads.size >= 256) { this.issue(t("来源线程达到 256 项安全上限，部分事件未采集")); return this.rejectEvent("dropped", false); }
      order = { turns: new Map(), sequence: 0, plans: new Map(), proposals: new Map(), compactions: new Map(), rolloutModel: false };
      this.threads.set(threadId, order);
    }
    const orderProblem = this.nativeOrder(event, threadId);
    if (orderProblem) return orderProblem === "deduplicated" ? this.duplicate() : this.rejectEvent(orderProblem, false);
    const oldTurn = event.turnId && order.current && event.turnId !== order.current && order.turns.has(event.turnId)
      && (order.turns.get(event.turnId)! < order.turns.get(order.current)!);
    const stream = event.type === "tokens" ? this.usage.get(threadId) : undefined;
    const signature = event.type === "tokens" ? usageIdentity(event) : undefined;
    // 已计量的旧轮次镜像仍须清空交接队列；它只确认身份，不能倒退当前 Token。
    const mirror = stream && stream.owner !== source && signature !== undefined && (stream.owner === "app-server"
      ? stream.appPending[0] === signature || !stream.appPending.length && !!stream.last && usageIdentity(stream.last) === signature
      : stream.rolloutAccepted.includes(signature));
    if (oldTurn && !mirror && (event.type.startsWith("plan-") || ["agent-status", "activity", "tokens", "model", "context-compacted"].includes(event.type))) {
      return this.rejectEvent("outOfOrder", false);
    }
    if (event.type === "tokens") return this.tokens({ ...event, source, threadId });
    if (event.type === "context-compacted") {
      const usage = this.usage.get(threadId), key = event.turnId ?? "unknown";
      const owner = order.compactions.get(key);
      if ((source === "app-server" && event.phase === "history" && usage?.last)
        || (source === "rollout" && usage?.owner === "app-server") || (owner && owner !== source)) return this.duplicate();
      order.compactions.set(key, source); this.trim(order.compactions);
    }
    if (event.type === "model") {
      if (source === "app-server" && order.rolloutModel) return this.duplicate();
      if (source === "rollout") order.rolloutModel = true;
    }
    if (event.type === "turn-started" && event.id) {
      if (!order.turns.has(event.id)) {
        if (order.turnsLimited && (event.at === undefined || order.currentAt === undefined)) {
          this.issue(t("轮次身份超出保留窗口且缺少时间依据，未把无法确认的新旧轮次重新计数"));
          return this.rejectEvent("dropped", false);
        }
        const late = event.at !== undefined && order.currentAt !== undefined && event.at < order.currentAt;
        order.turns.set(event.id, late ? 0 : ++order.sequence);
        if (!late) { order.current = event.id; order.currentAt = event.at; order.blockedPlan = false; }
        else this.statistics.outOfOrder++;
        if (order.turns.size > this.limit) order.turnsLimited = true;
        this.trim(order.turns);
      } else if (event.id !== order.current) return this.duplicate();
    }
    const turn = event.turnId;
    if (event.type.startsWith("plan-")) {
      const scope = event.type === "plan-mode" ? "mode" : event.type === "plan-proposed" || event.type === "plan-delta" ? "proposal" : "execution";
      const key = eventIdentity(scope, turn);
      const owner = order.plans.get(key);
      if (owner && owner !== source) {
        if (!this.isAppLive(threadId) && owner === "app-server") order.blockedPlan = true;
        return this.duplicate();
      }
      order.plans.set(key, source); this.trim(order.plans);
      order.blockedPlan = false;
      if (event.type === "plan-delta" || event.type === "plan-proposed") {
        const item = eventIdentity(turn, event.itemId);
        const generation = event.generation ?? 0;
        if ((event.type === "plan-delta" || !event.complete) && order.proposals.has(item) && order.proposals.get(item) !== generation) {
          this.issue(t("计划提案跨断线缺少片段身份，等待完整条目文本，未拼接不确定的片段")); return this.rejectEvent("dropped", false);
        }
        order.proposals.set(item, generation); this.trim(order.proposals);
      }
      // 同源 A→B→A 是三次更新；delta 没有片段 ID，相同文本不能作为去重依据。
      if (event.type !== "plan-proposed") return [this.accept(event)];
    }
    if (event.type === "quota" && source === "rollout" && this.isAppLive(threadId) && this.seen.has(eventIdentity("app-quota", threadId))) return this.duplicate();
    if (event.type === "quota" && source === "app-server") this.remember(eventIdentity("app-quota", threadId), threadId);
    const stable = event.type === "session" || event.type.startsWith("tool-") || event.type.startsWith("turn-") || event.type === "plan-proposed";
    if (stable) {
      const identity = canonicalIdentity(event);
      if (this.seen.has(identity)) return this.duplicate();
      this.remember(identity, threadId);
    }
    return [this.accept(event)];
  }

  private nativeOrder(event: HudEvent, threadId: string): "invalid" | "outOfOrder" | "deduplicated" | "dropped" | undefined {
    if (event.sourceOrdinal === undefined) return;
    const generation = event.generation ?? 0;
    const key = eventIdentity(event.source, event.source === "app-server" ? event.phase : "file", threadId, family(event));
    const last = this.watermarks.get(key);
    const ordinal = event.type.startsWith("plan-") && "ordinal" in event ? event.ordinal : event.sourceOrdinal;
    if (typeof ordinal !== "number" || !Number.isSafeInteger(ordinal) || ordinal < 0) return "invalid";
    if (last && (generation < last.generation || (generation === last.generation && ordinal < last.ordinal))) return "outOfOrder";
    const id = event.eventId ?? canonicalIdentity(event);
    if (last && generation === last.generation && ordinal === last.ordinal) {
      if (last.ids.has(id)) return "deduplicated";
      if (last.ids.size >= this.limit) { this.issue(t("单条来源消息产生过多事件，超出部分未采用")); return "dropped"; }
      last.ids.add(id);
    } else this.watermarks.set(key, { threadId, generation, ordinal, ids: new Set([id]) });
  }

  private tokens(event: Tokens): HudEvent[] {
    const source = event.source!;
    let stream = this.usage.get(event.threadId!);
    if (!stream) {
      stream = { owner: source, appPending: [], rolloutPending: [], overflow: false, rolloutAccepted: [], historyComplete: true };
      this.usage.set(event.threadId!, stream);
    }
    const signature = usageIdentity(event);
    const same = stream.last && usageIdentity(stream.last) === signature;
    if (source === "rollout") {
      if (stream.rolloutGeneration !== undefined && event.generation !== stream.rolloutGeneration && stream.rolloutSeen) {
        stream.replayAnchor = { signature: usageIdentity(stream.rolloutSeen), ordinal: stream.rolloutSeen.sourceOrdinal };
      }
      stream.rolloutGeneration = event.generation;
      if (stream.replayAnchor) {
        if (stream.replayAnchor.ordinal !== undefined && event.sourceOrdinal === stream.replayAnchor.ordinal
          && stream.replayAnchor.signature === signature) stream.replayAnchor = undefined;
        return this.duplicate();
      }
      if (!stream.rolloutSeen && stream.owner === "app-server" && stream.appPending.length && stream.appPending[0] !== signature) return this.duplicate();
      stream.rolloutSeen = event;
    }
    if (stream.owner === "rollout") {
      if (source === "app-server") {
        if (!this.isAppLive(event.threadId!)) return this.rejectEvent("dropped", false);
        const first = stream.rolloutAccepted.indexOf(signature);
        const unique = first >= 0 && stream.rolloutAccepted.lastIndexOf(signature) === first;
        if (stream.historyComplete && (first === 0 || unique)) {
          stream.rolloutAccepted.splice(0, first + 1);
          if (stream.rolloutAccepted.length) { stream.alignmentPending = true; return this.duplicate(); }
          stream.owner = "app-server"; stream.alignmentPending = false;
          return this.duplicate();
        }
        if (!stream.historyComplete || first >= 0 || (stream.last && !continuous(stream.last, event))) {
          stream.alignmentPending = true; return this.rejectEvent("dropped", false);
        }
        stream.owner = "app-server";
        stream.alignmentPending = false;
        stream.rolloutAccepted = [];
        if (same) return this.duplicate();
        if (this.policy.useRolloutFallback) this.pending(stream, signature);
      } else {
        if (stream.rolloutAccepted.at(-1) !== signature) stream.rolloutAccepted.push(signature);
        if (stream.rolloutAccepted.length > this.limit) { stream.rolloutAccepted.shift(); stream.historyComplete = false; }
      }
      stream.last = event;
      return [this.accept(event)];
    }
    if (source === "app-server") {
      if (same) {
        if (stream.last?.contextWindow === event.contextWindow) return this.duplicate();
        stream.last = event;
        return [this.accept(event)];
      }
      if (stream.rolloutPending.length && usageIdentity(stream.rolloutPending[0]) === signature) stream.rolloutPending.shift();
      else if (this.policy.useRolloutFallback) this.pending(stream, signature);
      stream.last = event;
      return [this.accept(event)];
    }
    if (stream.overflow) return this.rejectEvent("dropped", false);
    if (stream.appPending[0] === signature) {
      stream.appPending.shift(); this.duplicate();
    } else if (!stream.appPending.length && same) this.duplicate();
    else {
      stream.rolloutPending.push(event);
      if (stream.rolloutPending.length > this.limit) this.overflow(stream);
    }
    return this.isAppLive(event.threadId!) ? [] : this.releaseFallback(stream);
  }

  private isAppLive(threadId: string): boolean { return this.appLive && !this.unavailableThreads.has(threadId); }

  private releaseFallback(stream: UsageStream): HudEvent[] {
    if (stream.owner !== "app-server" || stream.overflow || !this.policy.useRolloutFallback) return [];
    if (stream.appPending.length) {
      return [];
    }
    stream.owner = "rollout";
    stream.rolloutAccepted = stream.last ? [usageIdentity(stream.last)] : [];
    stream.historyComplete = true;
    const result = stream.rolloutPending.map(event => {
      stream.last = event;
      if (stream.rolloutAccepted.at(-1) !== usageIdentity(event)) stream.rolloutAccepted.push(usageIdentity(event));
      return this.accept(event);
    });
    stream.rolloutPending = [];
    return result;
  }
  private pending(stream: UsageStream, signature: string): void {
    if (stream.overflow) return;
    stream.appPending.push(signature);
    if (stream.appPending.length > this.limit) this.overflow(stream);
  }
  private overflow(stream: UsageStream): void {
    this.statistics.dropped += stream.rolloutPending.length;
    stream.overflow = true; stream.appPending = []; stream.rolloutPending = [];
    this.issue(t("Token 镜像队列超过安全上限，无法安全交接；保留当前来源，回退用量未确认"));
  }
  private accept(event: HudEvent): HudEvent {
    this.statistics.accepted++;
    return { ...event, ordinal: ++this.ordinal, eventId: eventIdentity("accepted", event.threadId, this.ordinal, event.eventId) } as HudEvent;
  }
  private duplicate(): HudEvent[] { this.duplicates++; this.statistics.deduplicated++; return []; }
  private remember(id: string, threadId: string): void { this.seen.set(id, threadId); if (this.seen.size > this.limit) this.seen.delete(this.seen.keys().next().value!); }
  private trim<T>(map: Map<string, T>): void { if (map.size > this.limit) map.delete(map.keys().next().value!); }
  private issue(message: string): void { if (this.issues.size < 20) this.issues.add(message); }
}
