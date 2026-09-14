import type { HudState } from "./HudState.js";
import { redactSummary } from "./Redaction.js";
import type { SourceStatus } from "./source/DataSource.js";

export type SourceHealth = "healthy" | "starting" | "connecting" | "stale" | "reconnecting" | "fallback" | "disconnected" | "failed" | "unknown";
export type RecoveryState = "connected" | "starting" | "stale" | "reconnecting" | "reconnect-failed" | "fallback" | "degraded" | "disconnected";
export const STALE_THRESHOLD_MS = 60_000;
export const MAX_DIAGNOSTIC_WARNINGS = 20;
export const PERFORMANCE_STAGES = ["startup", "discovery", "attach", "firstEvent", "firstRender", "eventToReducer", "reducer", "reducerToRender", "render", "reconnect", "shutdown"] as const;
export type PerformanceStage = typeof PERFORMANCE_STAGES[number];
export interface TimingSample { count: number; totalMs: number; lastMs: number; maxMs: number }
export interface EventStatistics { received: number; accepted: number; deduplicated: number; outOfOrder: number; dropped: number; invalid: number; unknown: number }
export const emptyEventStatistics = (): EventStatistics => ({ received: 0, accepted: 0, deduplicated: 0, outOfOrder: 0, dropped: 0, invalid: 0, unknown: 0 });

export interface HudDiagnostics {
  runtime: { authority?: string; kind?: string; connection?: string; ownership?: string };
  source: { kind: "rollout" | "app-server" | "none"; state: SourceHealth; lastEventAt?: number; ageMs?: number; lastCheckedAt?: number; staleThresholdMs: number };
  session: { sessionId?: string; threadId?: string; switches: number };
  events: EventStatistics & { processed: number; errors: number; rawReceived: number; rawInvalid: number; rawUnknown: number };
  render: { count: number; errors: number; lastRenderAt?: number };
  recovery: { state: RecoveryState; reconnectCount: number; fallbackCount: number; recoveryCount: number; lastReconnectDurationMs?: number };
  performance: Partial<Record<PerformanceStage, TimingSample>>;
  memory: { heapUsed: number; rss: number; toolCount: number; agentCount: number; historySize: number; [key: string]: number };
  warnings: Array<{ code: string; message: string; count: number; lastAt: number }>;
  lastReducerAt?: number;
}

// 数据新鲜度与连接存活分开：闲置可以 stale，只有有界协议探测失败才重连。
export function appServerHealth(status: SourceStatus, now: number, threshold = STALE_THRESHOLD_MS): SourceHealth {
  if (status.state === "starting") return "connecting";
  if (status.state === "reconnecting") return "reconnecting";
  if (status.state === "failed") return "failed";
  if (status.state !== "connected") return "disconnected";
  if (!status.live) return "fallback";
  return now - (status.lastEventAt ?? status.connectedAt ?? now) > threshold ? "stale" : "healthy";
}

export class HudDiagnosticsTracker {
  private readonly started = performance.now();
  private firstEvent = false;
  private firstRender = false;
  private lastReducerClock?: number;
  private selected = false;
  private sourceObserved = false;
  private appRaw = { received: 0, invalid: 0, unknown: 0 };
  private appReconnects = 0;
  private reconnectSample?: string;
  private readonly warnings = new Map<string, HudDiagnostics["warnings"][number]>();
  private readonly value: HudDiagnostics = {
    runtime: {}, source: { kind: "none", state: "starting", staleThresholdMs: STALE_THRESHOLD_MS },
    session: { switches: 0 }, events: { ...emptyEventStatistics(), processed: 0, errors: 0, rawReceived: 0, rawInvalid: 0, rawUnknown: 0 },
    render: { count: 0, errors: 0 }, recovery: { state: "starting", reconnectCount: 0, fallbackCount: 0, recoveryCount: 0 },
    performance: {}, memory: { heapUsed: 0, rss: 0, toolCount: 0, agentCount: 0, historySize: 0 }, warnings: [],
  };

  constructor(private readonly now: () => number = Date.now) {}

  measure(stage: PerformanceStage, milliseconds: number): void {
    if (!Number.isFinite(milliseconds) || milliseconds < 0) return;
    const previous = this.value.performance[stage];
    this.value.performance[stage] = { count: (previous?.count ?? 0) + 1, totalMs: (previous?.totalMs ?? 0) + milliseconds,
      lastMs: milliseconds, maxMs: Math.max(previous?.maxMs ?? 0, milliseconds) };
  }

  select(sessionId?: string): void {
    if (this.selected && this.value.session.sessionId !== sessionId) this.value.session.switches++;
    if (this.value.session.sessionId !== sessionId) {
      this.value.source.lastEventAt = undefined;
      this.value.source.ageMs = undefined;
    }
    this.selected = true;
    this.value.session.sessionId = sessionId;
    this.value.session.threadId = sessionId;
  }

  received(source: "rollout" | "app-server", phase?: "history" | "live", at?: number): void {
    if (!this.firstEvent) { this.firstEvent = true; this.measure("firstEvent", performance.now() - this.started); }
    // 历史回放不能把旧数据伪装成刚产生的实时数据。
    const time = phase === "history" ? at : this.now();
    if (source === this.value.source.kind || this.value.source.kind === "none") {
      if (time !== undefined && Number.isFinite(time) && time >= 0) this.value.source.lastEventAt = Math.max(this.value.source.lastEventAt ?? 0, Math.min(time, this.now()));
    }
  }

  processed(startedAt: number): void {
    this.value.events.processed++;
    this.value.lastReducerAt = this.now();
    this.lastReducerClock = performance.now();
    this.measure("reducer", this.lastReducerClock - startedAt);
  }

  raw(kind: "received" | "invalid" | "unknown", count = 1): void {
    const field = kind === "received" ? "rawReceived" : kind === "invalid" ? "rawInvalid" : "rawUnknown";
    this.value.events[field] += count;
  }

  error(stage: "event" | "render", code: string, message: string): void {
    if (stage === "event") this.value.events.errors++;
    else this.value.render.errors++;
    this.warn(code, message);
  }

  warn(code: string, message: string): void {
    code = redactSummary(code, 80);
    const previous = this.warnings.get(code);
    if (!previous && this.warnings.size >= MAX_DIAGNOSTIC_WARNINGS) this.warnings.delete(this.warnings.keys().next().value!);
    this.warnings.set(code, { code: redactSummary(code, 80), message: redactSummary(message), count: (previous?.count ?? 0) + 1, lastAt: this.now() });
  }

  rendered(startedAt: number): void {
    const finished = performance.now();
    this.value.render.count++;
    this.value.render.lastRenderAt = this.now();
    this.measure("render", finished - startedAt);
    if (!this.firstRender) { this.firstRender = true; this.measure("firstRender", finished - this.started); }
    if (this.lastReducerClock !== undefined) { this.measure("reducerToRender", finished - this.lastReducerClock); this.lastReducerClock = undefined; }
  }

  observe(state: HudState, rolloutReady: boolean, stats: EventStatistics, resources: Record<string, number> = {}, app?: SourceStatus): void {
    const now = this.now(), sources = state.dataSources;
    const kind = sources?.active ?? (rolloutReady ? "rollout" : "none");
    const previous = this.value.source.kind;
    if (this.sourceObserved && previous !== kind) {
      if (kind === "rollout" && sources?.preferred === "app-server") this.value.recovery.fallbackCount++;
      if (kind !== "none") this.value.recovery.recoveryCount++;
    }
    if (!this.sourceObserved && kind === "rollout" && sources?.preferred === "app-server") this.value.recovery.fallbackCount++;
    this.sourceObserved = true;
    const runtime = app?.runtime;
    this.value.runtime = { authority: runtime?.authority, kind: runtime?.kind, connection: app?.state, ownership: runtime?.ownership };
    Object.assign(this.value.events, stats);
    this.value.source.kind = kind;
    if (kind === "app-server") this.value.source.lastEventAt = app?.lastEventAt;
    else if (kind === "rollout" && state.session?.lastActivityAt !== undefined) {
      this.value.source.lastEventAt = Math.min(now, state.session.lastActivityAt);
    }
    this.value.source.lastCheckedAt = kind === "app-server" ? app?.lastCheckedAt : rolloutReady ? now : undefined;
    const age = this.value.source.lastEventAt === undefined ? undefined : Math.max(0, now - this.value.source.lastEventAt);
    this.value.source.ageMs = age;
    this.value.source.state = kind === "app-server" && app ? appServerHealth(app, now)
      : kind === "rollout" ? sources?.preferred === "app-server" ? "fallback" : age !== undefined && age > STALE_THRESHOLD_MS ? "stale" : "healthy"
      : app?.state === "starting" ? "connecting" : app?.state === "reconnecting" ? "reconnecting" : app?.state === "failed" ? "failed" : "disconnected";
    this.value.recovery.state = kind === "rollout" && sources?.preferred === "app-server" ? "fallback"
      : this.value.source.state === "healthy" ? "connected" : this.value.source.state === "stale" ? "stale"
      : app?.state === "reconnecting" ? "reconnecting" : runtime?.reconnectExhausted ? "reconnect-failed" : kind === "none" ? "degraded" : "disconnected";
    if (app) {
      this.value.recovery.reconnectCount += app.reconnectCount >= this.appReconnects ? app.reconnectCount - this.appReconnects : app.reconnectCount;
      this.appReconnects = app.reconnectCount;
      const counts = { received: app.eventCount + app.unknownCount, invalid: app.invalidCount ?? 0, unknown: app.unknownCount };
      for (const key of ["received", "invalid", "unknown"] as const) {
        this.raw(key, counts[key] >= this.appRaw[key] ? counts[key] - this.appRaw[key] : counts[key]);
      }
      this.appRaw = counts;
    } else { this.appRaw = { received: 0, invalid: 0, unknown: 0 }; this.appReconnects = 0; }
    if (app?.lastReconnectDurationMs !== undefined) {
      this.value.recovery.lastReconnectDurationMs = app.lastReconnectDurationMs;
      const key = `${app.reconnectCount}:${app.lastReconnectDurationMs}`;
      if (key !== this.reconnectSample) { this.measure("reconnect", app.lastReconnectDurationMs); this.reconnectSample = key; }
    }
    const memory = process.memoryUsage();
    this.value.memory = { heapUsed: memory.heapUsed, rss: memory.rss, toolCount: (state.tools?.active?.length ?? 0) + (state.tools?.recent?.length ?? 0),
      agentCount: state.agentSummary?.count ?? 0, historySize: state.usage?.retainedRecords ?? 0, ...resources };
    if (!this.value.performance.startup && kind !== "none") this.measure("startup", performance.now() - this.started);
  }

  stopped(failed = false): void {
    this.value.runtime.connection = failed ? "failed" : "stopped";
    this.value.source.kind = "none";
    this.value.source.state = failed ? "failed" : "disconnected";
    this.value.recovery.state = failed ? "degraded" : "disconnected";
  }

  snapshot(): HudDiagnostics {
    const snapshot = structuredClone(this.value);
    snapshot.warnings = [...this.warnings.values()].map(warning => ({ ...warning }));
    if (snapshot.source.lastEventAt !== undefined) snapshot.source.ageMs = Math.max(0, this.now() - snapshot.source.lastEventAt);
    return snapshot;
  }
}
