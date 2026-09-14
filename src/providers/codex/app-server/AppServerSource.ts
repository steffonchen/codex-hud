import { t } from "../../../i18n/Messages.js";
import type { HudEvent } from "../../../core/HudEvent.js";
import { APP_SERVER_CAPABILITIES, type DataSource, type SourceStatus } from "../../../core/source/DataSource.js";
import { record, type CodexDiagnostic } from "../Diagnostics.js";
import type { CodexRuntime } from "../CodexDiscoveryProvider.js";
import { AppServerError, type AppServerClient, type RpcNotification } from "./AppServerProtocol.js";
import { AppServerEventNormalizer, APP_SERVER_NOTIFICATIONS, protocolId, threadParent, type NormalizationResult } from "./AppServerEventNormalizer.js";
import { RuntimeConnectionManager } from "../runtime/RuntimeConnectionManager.js";
import { runtimeDeadline, unsupportedMethod } from "../runtime/RuntimeProbe.js";
import type { RuntimePolicy } from "../runtime/RuntimePolicy.js";
import type { RuntimeThreadAttachment } from "../runtime/RuntimeCandidate.js";
import { STALE_THRESHOLD_MS } from "../../../core/HudDiagnostics.js";

export interface AppServerSourceOptions {
  createClient?: () => AppServerClient;
  connectionManager?: RuntimeConnectionManager;
  transport?: SourceStatus["transport"];
  reconnectDelayMs?: number;
  maxBufferedEvents?: number;
  maxHistoryPages?: number;
  historyTimeoutMs?: number;
  maxReconnectAttempts?: number;
  staleThresholdMs?: number;
  healthTimeoutMs?: number;
  now?: () => number;
}
class Superseded extends Error {}

export class AppServerSource implements DataSource {
  readonly kind = "app-server" as const;
  readonly capabilities = APP_SERVER_CAPABILITIES;
  private readonly normalizer = new AppServerEventNormalizer();
  private listeners = new Set<(event: HudEvent) => void>();
  private statuses = new Set<(status: SourceStatus) => void>();
  private diagnostics = new Set<(diagnostic: CodexDiagnostic) => void>();
  private status: SourceStatus;
  private client?: AppServerClient;
  private unsubscribe: Array<() => void> = [];
  private started = false;
  private connecting?: Promise<void>;
  private syncing?: Promise<void>;
  private stopping?: Promise<void>;
  private cleanup?: Promise<void>;
  private reconnectTimer?: ReturnType<typeof setTimeout>;
  private retry = 0;
  private generation = 0;
  private selection = 0;
  private ordinal = 0;
  private root?: string;
  private threads = new Map<string, string | undefined>();
  private latestTurns = new Map<string, string>();
  private observedTurns = new Map<string, Set<string>>();
  private hydrated = new Set<string>();
  private subscribed = new Set<string>();
  private unloaded = new Set<string>();
  private unloadedSinceQuery = new Set<string>();
  private partialThreads = new Set<string>();
  private historyBoundaries = new Map<string, string | undefined>();
  private buffer: HudEvent[] = [];
  private bufferedBytes = 0;
  private buffering = false;
  private dirty = false;
  private checkingHealth?: Promise<void>;
  private cleanupFailed = false;
  private readonly now: () => number;

  constructor(private readonly options: AppServerSourceOptions) {
    this.now = options.now ?? Date.now;
    this.status = { state: "stopped", available: false, live: false, transport: options.transport ?? "stdio", protocol: "unknown",
      schema: "v2", history: "pending", eventCount: 0, unknownCount: 0, reconnectCount: 0, capabilities: { ...this.capabilities } };
  }
  getStatus(): SourceStatus { return structuredClone({ ...this.status, runtime: this.options.connectionManager?.getState(), unloadedThreadIds: [...this.unloaded] }); }
  getResourceCounts(): Record<string, number> {
    const protocol = this.client?.getDiagnostics?.();
    return { ...this.options.connectionManager?.getResourceCounts(), appConnections: this.client ? 1 : 0, appEventListeners: this.listeners.size, appStatusListeners: this.statuses.size,
      appDiagnosticListeners: this.diagnostics.size, appThreads: this.threads.size, appBufferedEvents: this.buffer.length,
      appBufferedBytes: this.bufferedBytes, reconnectTimers: this.reconnectTimer ? 1 : 0,
      pendingRequests: protocol?.pending ?? 0, pendingWrites: protocol?.pendingWrites ?? 0 };
  }

  checkHealth(): Promise<void> {
    if (this.checkingHealth) return this.checkingHealth;
    if (!this.started || this.status.state !== "connected" || !this.root || this.syncing || this.connecting
      || this.now() - Math.max(this.status.lastEventAt ?? 0, this.status.lastCheckedAt ?? this.status.connectedAt ?? 0) < (this.options.staleThresholdMs ?? STALE_THRESHOLD_MS)) return Promise.resolve();
    const generation = this.generation, selection = this.selection, root = this.root;
    // 复用 Provider 的低频时钟。正常闲置只核验协议响应，不因事件少而重连。
    this.checkingHealth = (async () => {
      try {
        const response = record(await runtimeDeadline(this.client!.request("thread/read", { threadId: root, includeTurns: false }), this.options.healthTimeoutMs ?? 5000, "health"));
        this.check(generation, selection);
        if (record(response?.thread)?.id !== root) throw new AppServerError("protocol", "health-identity");
        this.update({ lastCheckedAt: this.now() });
      } catch (error) {
        if (this.valid(generation) && selection === this.selection) this.failed(generation,
          error instanceof AppServerError ? t("来源存活检查失败：{0}", error.message) : t("来源存活检查失败"));
      }
    })().finally(() => { this.checkingHealth = undefined; });
    return this.checkingHealth;
  }
  get requiresExplicitThread(): boolean { return !!this.options.connectionManager; }
  tracksThread(id: string, root: string): boolean { return this.root === root && this.threads.has(id); }
  discover() { return this.options.connectionManager?.discover(true); }
  detach(): Promise<void> { return this.selectThread(undefined); }
  isAvailable(): boolean { return this.status.available; }
  onEvent(listener: (event: HudEvent) => void): () => void { this.listeners.add(listener); return () => this.listeners.delete(listener); }
  onStatus(listener: (status: SourceStatus) => void): () => void { this.statuses.add(listener); return () => this.statuses.delete(listener); }
  onDiagnostic(listener: (diagnostic: CodexDiagnostic) => void): () => void { this.diagnostics.add(listener); return () => this.diagnostics.delete(listener); }

  async selectThread(threadId: string | undefined, children: readonly { id: string; parentId?: string }[] = [], boundaries: ReadonlyMap<string, string> = new Map(),
    attachmentSource: NonNullable<RuntimeThreadAttachment["attachmentSource"]> = "explicit"): Promise<void> {
    const id = protocolId(threadId);
    const changed = id !== this.root;
    if (id !== this.root) {
      this.selection++; this.root = id; this.threads.clear(); this.latestTurns.clear(); this.observedTurns.clear(); this.hydrated.clear(); this.subscribed.clear();
      this.unloaded.clear(); this.unloadedSinceQuery.clear(); this.partialThreads.clear(); this.historyBoundaries.clear();
      this.buffer = []; this.bufferedBytes = 0; this.normalizer.reset();
      if (id) this.threads.set(id, undefined);
      this.update({ threadId: id, live: false, history: "pending", lastEventAt: undefined, lastCheckedAt: this.now() });
    }
    this.options.connectionManager?.setSelection(id, attachmentSource);
    // children 来自 discovery 的明确父边；允许任意枚举顺序，不能靠时间或 cwd 关联。
    for (let pass = 0; pass < children.length; pass++) {
      let changed = false;
      for (const child of children) if (protocolId(child.id) && child.parentId && this.threads.has(child.parentId) && !this.threads.has(child.id)) {
        if (this.threads.size >= 256) { this.issue("app-server-thread-limit", t("App Server 线程跟踪达到 256 项安全上限")); break; }
        this.threads.set(child.id, child.parentId); changed = true;
      }
      if (!changed) break;
    }
    for (const [thread, turn] of boundaries) if (this.threads.has(thread) && protocolId(turn) && !this.latestTurns.has(thread)) {
      this.latestTurns.set(thread, turn); this.observedTurns.set(thread, new Set([turn]));
    }
    if (changed && this.started && this.options.connectionManager) {
      const generation = ++this.generation, selection = this.selection;
      if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
      this.reconnectTimer = undefined;
      this.unsubscribe.forEach(unsubscribe => unsubscribe()); this.unsubscribe = [];
      this.client = undefined;
      const cleanup = await Promise.allSettled([this.options.connectionManager.disconnect(), this.cleanup, this.connecting, this.syncing, this.checkingHealth]);
      if (cleanup.some(result => result.status === "rejected")) this.issue("app-server-detach", t("旧线程连接清理出现错误"));
      if (this.valid(generation) && selection === this.selection) { this.retry = 0; await this.beginConnect(); }
      return;
    }
    if (this.started && this.status.state === "connected" && (!this.root || [...this.threads.keys()].some(thread => !this.hydrated.has(thread) || !this.subscribed.has(thread)))) {
      const generation = this.generation;
      try { await this.synchronize(); }
      catch (error) { if (!(error instanceof Superseded)) this.failed(generation, error instanceof AppServerError ? error.message : t("目标线程同步失败")); }
    }
  }

  start(): Promise<void> {
    if (this.stopping) return this.stopping.then(() => this.start());
    if (this.connecting) return this.connecting;
    if (this.started) return this.syncing ?? Promise.resolve();
    this.started = true;
    this.retry = 0;
    return this.beginConnect();
  }

  stop(): Promise<void> {
    if (this.stopping) return this.stopping;
    this.started = false; this.generation++; this.selection++;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = undefined;
    this.unsubscribe.forEach(unsubscribe => unsubscribe()); this.unsubscribe = [];
    this.stopping = (async () => {
      // 先等上一轮失败清理交回引用，再重试；不能丢失尚未确认退出的 transport。
      const cleanup = await Promise.allSettled([this.cleanup]);
      const client = this.client;
      const results = await Promise.allSettled([Promise.resolve().then(() => this.options.connectionManager ? this.options.connectionManager.disconnect() : client?.stop()), this.connecting, this.syncing, this.checkingHealth]);
      if (results[0].status === "fulfilled") this.client = undefined;
      this.cleanupFailed = [...cleanup, ...results].some(result => result.status === "rejected");
      this.buffer = []; this.bufferedBytes = 0; this.buffering = false;
      this.hydrated.clear(); this.subscribed.clear();
      this.update({ state: this.cleanupFailed ? "failed" : "stopped", available: false, live: false });
      if (this.cleanupFailed) throw new AppServerError("transport", "cleanup-failed");
    })().finally(() => { this.stopping = undefined; });
    return this.stopping;
  }

  private beginConnect(): Promise<void> {
    if (this.connecting) return this.connecting;
    const connecting = this.connect().finally(() => { if (this.connecting === connecting) this.connecting = undefined; });
    this.connecting = connecting;
    return connecting;
  }

  private async connect(): Promise<void> {
    if (this.cleanupFailed) return;
    const startedAt = performance.now(), reconnect = this.retry > 0;
    const generation = ++this.generation;
    this.update({ state: this.retry ? "reconnecting" : "starting", available: false, live: false, reason: undefined });
    try {
      const manager = this.options.connectionManager;
      const connection = manager ? await manager.open() : undefined;
      this.check(generation);
      if (manager && !connection) {
        this.update({ state: "disconnected", available: false, live: false, history: "unavailable", reason: manager.getState().reason });
        if (this.root) this.failed(generation, manager.getState().reason ?? t("没有可附着的 runtime"));
        return;
      }
      const client = connection?.client ?? this.options.createClient?.();
      if (!client) throw new AppServerError("transport", "client-unavailable");
      this.client = client;
      this.unsubscribe = [client.onNotification(notification => { if (this.valid(generation)) {
        try { this.notification(notification); }
        catch { this.issue("app-server-normalization", t("App Server 消息归一化失败，已跳过该消息")); }
      } }),
        client.onIssue(error => { if (this.valid(generation)) this.issue("app-server-protocol", error.message); }),
        client.onClose(() => { if (this.valid(generation)) this.failed(generation, t("App Server 连接已断开")); })];
      if (manager && client.onRequest) this.unsubscribe.push(client.onRequest(request => {
        if (!this.valid(generation)) return;
        manager.serverRequest(request, !!request.threadId && this.threads.has(request.threadId)); this.update({});
      }));
      if (!connection) {
        await runtimeDeadline(client.start(), 5000, "connect"); this.check(generation);
        const initialized = record(await client.request("initialize", { clientInfo: { name: "codex-hud", version: "0.1.0" }, capabilities: { experimentalApi: true } }));
        this.check(generation);
        if (!initialized || typeof initialized.userAgent !== "string") throw new AppServerError("protocol", "initialize");
        await runtimeDeadline(client.notify("initialized"), 8000, "initialized"); this.check(generation);
      } else this.status.transport = connection.probe.candidate.transport === "unix-socket" ? "stdio-proxy" : "stdio";
      this.hydrated.clear(); this.subscribed.clear();
      this.update({ state: "connected", available: true, protocol: "detected", history: "pending", reason: undefined, connectedAt: this.now(), lastCheckedAt: this.now() });
      await this.synchronize(); this.check(generation);
      if (manager) await this.readAccount(generation);
      this.check(generation);
      if (reconnect) this.update({ lastReconnectDurationMs: performance.now() - startedAt });
      this.retry = 0;
    } catch (error) {
      if (!(error instanceof Superseded) && this.valid(generation)) this.failed(generation,
        error instanceof AppServerError ? error.message : t("App Server 初始化或历史读取失败"));
    }
  }

  private synchronize(): Promise<void> {
    this.dirty = true;
    if (this.syncing) return this.syncing;
    const generation = this.generation;
    this.syncing = runtimeDeadline((async () => {
      while (this.dirty && this.valid(generation)) {
        this.dirty = false;
        const selection = this.selection;
        this.buffering = true; this.unloadedSinceQuery.clear();
        try {
          if (!this.root) {
            this.update({ live: false, history: "unavailable", reason: t("没有明确的当前线程身份，未订阅其他线程") });
            continue;
          }
          const loaded = await this.loadedThreads(generation, selection);
          for (const thread of this.threads.keys()) {
            const canSubscribe = loaded.has(thread) && !this.unloadedSinceQuery.has(thread);
            if (!canSubscribe) { this.subscribed.delete(thread); this.unloaded.add(thread); }
            if (this.hydrated.has(thread) && (!canSubscribe || this.subscribed.has(thread))) continue;
            try {
              await this.bootstrap(thread, canSubscribe, generation, selection);
              this.check(generation, selection); this.hydrated.add(thread);
            } catch (error) {
              this.check(generation, selection);
              if (error instanceof Superseded) throw error;
              this.partialThreads.add(thread);
              this.issue("app-server-history", error instanceof AppServerError ? t("线程历史未完整取得：{0}", error.message) : t("线程历史未完整取得，继续保留已有状态"));
            }
          }
          this.check(generation, selection);
          const live = this.subscribed.has(this.root);
          this.options.connectionManager?.attachment(live ? "attached" : this.unloadedSinceQuery.has(this.root) ? "lost" : "detached", live);
          this.update({ live, history: this.partialThreads.size ? "partial" : "ready",
            reason: live ? this.partialThreads.size ? t("部分历史未完整取得，实时事件继续接收") : undefined
              : t("目标线程未由当前 App Server 实例承载，仅可补充历史；实时数据使用 Rollout") });
          const buffered = this.buffer; this.buffer = []; this.bufferedBytes = 0;
          this.buffering = false;
          for (const event of buffered) this.emit(event);
        } catch (error) {
          if (!(error instanceof Superseded)) throw error;
        } finally { this.buffering = false; }
      }
    })(), this.options.historyTimeoutMs ?? 30_000, "history").finally(() => { this.syncing = undefined; });
    return this.syncing;
  }

  private async loadedThreads(generation: number, selection: number): Promise<Set<string>> {
    const loaded = new Set<string>();
    try {
      await this.pages("thread/loaded/list", { limit: 100 }, generation, selection, async data => {
        for (const id of data) { if (!protocolId(id)) throw new AppServerError("protocol", "loaded-thread-id"); loaded.add(id as string); }
      });
    } catch (error) { if (!unsupportedMethod(error)) throw error;
      this.options.connectionManager?.updateCapabilities({ loadedThreads: "unsupported" });
      this.issue("app-server-capability", t("当前 runtime 未提供 loaded/list，只补读历史")); }
    return loaded;
  }

  private async bootstrap(threadId: string, loaded: boolean, generation: number, selection: number): Promise<void> {
    // 未补齐的边界必须一直保留，不能由后到的新轮次掩盖历史缺口。
    const anchor = this.historyBoundaries.has(threadId) ? this.historyBoundaries.get(threadId) : this.latestTurns.get(threadId);
    this.historyBoundaries.set(threadId, anchor); this.partialThreads.delete(threadId);
    const result = record(await this.client!.request("thread/read", { threadId, includeTurns: false })); this.check(generation, selection);
    const thread = record(result?.thread);
    if (protocolId(thread?.id) !== threadId) throw new AppServerError("protocol", "thread-identity");
    if (threadId !== this.root && threadParent(thread!) !== this.threads.get(threadId)) throw new AppServerError("protocol", "parent-identity");
    this.deliver(this.normalizer.thread(thread, this.context("history")), threadId);
    const runtimeStatus = record(thread?.status)?.type;
    if (loaded && !this.unloadedSinceQuery.has(threadId) && (!this.options.connectionManager || ["active", "idle"].includes(String(runtimeStatus)))) {
      // read 不订阅。只对当前实例已经承载的线程 rejoin，绝不为历史线程发 turn/start。
      const resumed = record(await this.client!.request("thread/resume", { threadId, excludeTurns: true })); this.check(generation, selection);
      if (protocolId(record(resumed?.thread)?.id) !== threadId) throw new AppServerError("protocol", "resume-identity");
      if (!this.unloadedSinceQuery.has(threadId)) { this.subscribed.add(threadId); this.unloaded.delete(threadId); }
    }
    const turns: Record<string, unknown>[] = [];
    const turnIds = new Set<string>();
    let bytes = 0, found = false;
    try { await this.pages("thread/turns/list", { threadId, limit: 100, sortDirection: anchor ? "desc" : "asc", itemsView: "full" }, generation, selection, async data => {
      for (const value of data) {
        const turn = record(value), id = protocolId(turn?.id);
        if (!turn || !id) throw new AppServerError("protocol", "turn-identity");
        if (turnIds.has(id)) continue;
        turnIds.add(id);
        if (turn.itemsView !== "full") {
          const items: unknown[] = [];
          await this.pages("thread/items/list", { threadId, turnId: id, limit: 100, sortDirection: "asc" }, generation, selection, async entries => {
            for (const value of entries) {
              const entry = record(value);
              if (entry?.turnId !== id || !record(entry.item)) throw new AppServerError("protocol", "item-identity");
              items.push(entry.item);
              if (items.length > 8192) throw new AppServerError("protocol", "history-item-limit");
            }
          }).catch(error => {
            if (unsupportedMethod(error)) this.options.connectionManager?.updateCapabilities({ itemsList: "unsupported" });
            throw error;
          });
          turn.items = items;
          this.options.connectionManager?.updateCapabilities({ itemsList: "supported" });
        }
        if (!Array.isArray(turn.items) || turn.items.length > 8192) throw new AppServerError("protocol", "turn-items");
        bytes += Buffer.byteLength(JSON.stringify(turn));
        if (bytes > 16 * 1024 * 1024 || turns.length >= 8192) throw new AppServerError("protocol", "history-limit");
        if (anchor) turns.push(turn);
        else this.deliver(this.normalizer.turn(threadId, turn, this.context("history")), threadId);
        if (id === anchor) { found = true; return false; }
      }
    });
      this.options.connectionManager?.updateCapabilities({ turnsList: "supported" });
    } catch (error) {
      if (!unsupportedMethod(error)) throw error;
      if (this.options.connectionManager?.getState().capabilities.itemsList !== "unsupported") {
        this.options.connectionManager?.updateCapabilities({ turnsList: "unsupported" });
      }
      const response = record(await this.client!.request("thread/read", { threadId, includeTurns: true })); this.check(generation, selection);
      const history = record(response?.thread);
      if (history?.id !== threadId || !Array.isArray(history.turns) || history.turns.length > 8192
        || Buffer.byteLength(JSON.stringify(history.turns)) > 16 * 1024 * 1024) throw new AppServerError("protocol", "legacy-history");
      const start = anchor ? history.turns.findIndex(value => record(value)?.id === anchor) : 0;
      if (start < 0) { this.partialThreads.add(threadId); this.issue("app-server-history-boundary", t("旧协议历史未包含已确认边界")); return; }
      for (const value of history.turns.slice(start)) this.deliver(this.normalizer.turn(threadId, value, this.context("history")), threadId);
      this.historyBoundaries.delete(threadId);
      this.issue("app-server-capability", t("分页协议不可用，已通过 thread/read 补读历史"));
      return;
    }
    if (anchor) {
      if (!found) {
        this.partialThreads.add(threadId);
        this.issue("app-server-history-boundary", t("历史分页未找到已确认轮次边界，未将不确定的旧轮次重新播放"));
      } else for (const turn of turns.reverse()) {
        this.deliver(this.normalizer.turn(threadId, turn, this.context("history")), threadId);
      }
    }
    if (!this.partialThreads.has(threadId)) this.historyBoundaries.delete(threadId);
  }

  private async pages(method: string, params: Record<string, unknown>, generation: number, selection: number,
    consume: (data: unknown[]) => Promise<void | false>): Promise<void> {
    let cursor: string | undefined;
    const cursors = new Set<string>();
    for (let page = 0; page < (this.options.maxHistoryPages ?? 100); page++) {
      const response = record(await this.client!.request(method, { ...params, ...(cursor ? { cursor } : {}) })); this.check(generation, selection);
      if (!response || !Array.isArray(response.data) || response.data.length > 8192
        || (response.nextCursor !== null && (typeof response.nextCursor !== "string" || !response.nextCursor || response.nextCursor.length > 8192))) {
        throw new AppServerError("protocol", "page");
      }
      if (method === "thread/turns/list") this.options.connectionManager?.updateCapabilities({ turnsList: "supported" });
      if (method === "thread/items/list") this.options.connectionManager?.updateCapabilities({ itemsList: "supported" });
      if (await consume(response.data) === false || response.nextCursor === null) return;
      cursor = response.nextCursor as string;
      if (cursors.has(cursor)) throw new AppServerError("protocol", "cursor-cycle");
      cursors.add(cursor);
    }
    throw new AppServerError("protocol", "page-limit");
  }

  private notification(notification: RpcNotification): void {
    const manager = this.options.connectionManager;
    if (manager && notification.method === "serverRequest/resolved") {
      const params = record(notification.params), threadId = protocolId(params?.threadId);
      if (threadId && this.threads.has(threadId)) { manager.resolveRequest(threadId, params?.requestId); this.update({}); }
      return;
    }
    if (manager && ["thread/closed", "thread/archived", "thread/deleted"].includes(notification.method)) {
      const threadId = protocolId(record(notification.params)?.threadId);
      if (threadId && this.threads.has(threadId)) {
        this.unloaded.add(threadId); this.unloadedSinceQuery.add(threadId); this.subscribed.delete(threadId); this.hydrated.delete(threadId);
        manager.event(notification.method);
        if (threadId === this.root) manager.attachment("lost");
        this.update({ live: !!this.root && this.subscribed.has(this.root), reason: t("线程已关闭或移除，使用 Rollout") });
      }
      return;
    }
    if (!APP_SERVER_NOTIFICATIONS.has(notification.method)) { this.status.unknownCount++; return; }
    const params = record(notification.params);
    if (!params) { this.issue("app-server-notification-schema", t("App Server 通知缺少有效参数")); return; }
    let threadId: string | undefined;
    if (notification.method !== "account/rateLimits/updated") {
      const thread = record(params.thread);
      const id = protocolId(params.threadId) ?? protocolId(thread?.id);
      if (!id) { this.issue("app-server-notification-schema", t("App Server 通知缺少明确线程身份")); return; }
      threadId = id;
      if (!this.threads.has(id)) {
        const parent = thread && threadParent(thread);
        if (notification.method !== "thread/started" || !parent || !this.threads.has(parent)) return;
        if (this.threads.size >= 256) { this.issue("app-server-thread-limit", t("App Server 线程跟踪达到安全上限")); return; }
      }
    }
    const result = this.normalizer.normalize(notification, this.context("live"));
    this.status.eventCount++; this.status.lastEvent = notification.method; this.status.lastEventAt = this.now();
    manager?.event(notification.method);
    if (notification.method === "thread/status/changed" && record(params.status)?.type === "notLoaded" && threadId) {
      this.unloaded.add(threadId); this.unloadedSinceQuery.add(threadId); this.subscribed.delete(threadId);
      if (threadId === this.root) manager?.attachment("lost");
      this.update({ live: !!this.root && this.subscribed.has(this.root), reason: threadId === this.root
        ? t("目标线程已卸载，实时数据使用 Rollout，等待当前实例再次承载线程") : this.status.reason });
    }
    this.deliver(result, threadId ?? this.root);
  }

  private deliver(result: NormalizationResult, threadId?: string): void {
    const scope = threadId && this.threads.has(threadId) ? threadId : this.root;
    if (this.buffering && scope && result.diagnostics.some(issue => /schema|limit|identity/.test(issue.code))) this.partialThreads.add(scope);
    for (const diagnostic of result.diagnostics) this.issue(diagnostic.code, diagnostic.message);
    for (const event of result.events) {
      if (event.type === "agent-discovered" && event.parentId && this.threads.has(event.parentId) && !this.threads.has(event.agentId)) {
        if (this.threads.size >= 256) { this.issue("app-server-thread-limit", t("App Server 线程跟踪达到安全上限")); continue; }
        this.threads.set(event.agentId, event.parentId);
      }
      if (event.phase === "live" && this.buffering) {
        this.bufferedBytes += Buffer.byteLength(JSON.stringify(event));
        if (this.buffer.length >= (this.options.maxBufferedEvents ?? 2048) || this.bufferedBytes > 2 * 1024 * 1024) {
          this.failed(this.generation, t("历史同步期间通知超过有界缓冲，连接将恢复并补读历史")); return;
        }
        this.buffer.push(event);
      } else this.emit(event);
    }
  }

  private emit(event: HudEvent): void {
    if (event.type === "turn-started" && event.id && event.threadId) {
      const seen = this.observedTurns.get(event.threadId) ?? new Set<string>();
      if (!seen.has(event.id)) { this.latestTurns.set(event.threadId, event.id); seen.add(event.id); }
      if (seen.size > 2048) seen.delete(seen.values().next().value!);
      this.observedTurns.set(event.threadId, seen);
    }
    // thread/status/changed 不含 turnId；在历史与 live 合并后关联已确认的当前轮次。
    if (event.type === "agent-status" && !event.turnId && event.threadId) event = { ...event, turnId: this.latestTurns.get(event.threadId) };
    for (const listener of this.listeners) {
      try { listener(event); }
      catch { this.issue("app-server-listener", t("App Server 事件消费者失败，部分状态未更新")); }
    }
  }
  private context(phase: "history" | "live") { return { ordinal: ++this.ordinal, generation: this.generation, phase, rootThreadId: this.root }; }
  private valid(generation: number): boolean { return this.started && generation === this.generation; }
  private check(generation: number, selection?: number): void { if (!this.valid(generation) || (selection !== undefined && selection !== this.selection)) throw new Superseded(); }

  private failed(generation: number, reason: string): void {
    if (!this.valid(generation)) return;
    const failedGeneration = ++this.generation;
    this.subscribed.clear(); this.hydrated.clear(); this.buffer = []; this.bufferedBytes = 0;
    this.unsubscribe.forEach(unsubscribe => unsubscribe()); this.unsubscribe = [];
    const client = this.client; this.client = undefined;
    this.retry++;
    const exhausted = this.retry >= (this.options.maxReconnectAttempts ?? 8) || this.options.connectionManager?.policy.auto_reconnect === false;
    this.options.connectionManager?.reconnect(this.retry, exhausted, reason);
    this.update({ state: this.retry === 1 && this.status.protocol === "unknown" ? "failed" : "disconnected", live: false, available: false, reason });
    const delay = Math.min(30000, (this.options.reconnectDelayMs ?? 1000) * 2 ** Math.min(this.retry - 1, 5));
    this.cleanup = (async () => {
      try {
        const results = await Promise.allSettled([this.options.connectionManager ? this.options.connectionManager.disconnect() : client?.stop()]);
        if (results.some(result => result.status === "rejected")) throw new Error("cleanup");
        if (this.valid(failedGeneration)) { this.options.connectionManager?.reconnect(this.retry, exhausted, reason); this.update({}); }
      }
      catch {
        this.cleanupFailed = true;
        if (!this.options.connectionManager) this.client = client;
        this.update({ state: "failed", reason: t("App Server transport 清理失败，已停止自动重连") });
        this.issue("app-server-stop", t("App Server transport 清理失败，已停止自动重连"));
      }
      if (!this.valid(failedGeneration) || this.reconnectTimer || exhausted || this.cleanupFailed) return;
      this.reconnectTimer = setTimeout(() => {
        this.reconnectTimer = undefined;
        if (!this.valid(failedGeneration)) return;
        this.status.reconnectCount++;
        void this.beginConnect();
      }, delay);
    })().finally(() => { this.cleanup = undefined; });
  }

  private async readAccount(generation: number): Promise<void> {
    const manager = this.options.connectionManager;
    if (!manager || !this.client) return;
    try {
      const response = record(await this.client.request("account/read", { refreshToken: false })); this.check(generation);
      if (!response || typeof response.requiresOpenaiAuth !== "boolean" || response.account !== null && !record(response.account)) throw new AppServerError("protocol", "account");
      if (response.account !== null && !["apiKey", "chatgpt", "amazonBedrock"].includes(String(record(response.account)?.type))) throw new AppServerError("protocol", "account-type");
      manager.account(!!response.account); manager.updateCapabilities({ accountRead: "supported" });
    } catch (error) { this.check(generation); if (error instanceof Superseded) throw error;
      manager.updateCapabilities({ accountRead: unsupportedMethod(error) ? "unsupported" : "unknown" });
      if (!unsupportedMethod(error)) this.issue("app-server-account", t("账户状态未取得；不输出账户身份信息")); }
    try {
      const response = record(await this.client.request("account/rateLimits/read", { excludeResetCreditDetails: true })); this.check(generation);
      if (!response || !record(response.rateLimits)) throw new AppServerError("protocol", "rate-limits");
      manager.updateCapabilities({ rateLimits: "supported" });
      this.deliver(this.normalizer.quota({ rateLimits: response.rateLimits }, this.context("history")), this.root);
    } catch (error) { this.check(generation); if (error instanceof Superseded) throw error;
      manager.updateCapabilities({ rateLimits: unsupportedMethod(error) ? "unsupported" : "unknown" });
      if (!unsupportedMethod(error)) this.issue("app-server-quota", t("结构化额度读取不可用，保留 Rollout 额度")); }
    this.update({});
  }

  private update(update: Partial<SourceStatus>): void {
    Object.assign(this.status, update);
    for (const listener of this.statuses) {
      try { listener(this.getStatus()); }
      catch { this.issue("app-server-status-listener", t("App Server 状态消费者失败")); }
    }
  }
  private issue(code: string, message: string): void {
    if (/schema|normalization|identity/.test(code)) this.status.invalidCount = (this.status.invalidCount ?? 0) + 1;
    for (const listener of this.diagnostics) {
      try { listener({ code, message, severity: "warning" }); }
      catch { this.status.reason = t("App Server 诊断消费者失败"); }
    }
  }
}

export async function createAppServerSource(runtime: CodexRuntime, policy?: Partial<RuntimePolicy>): Promise<AppServerSource> {
  return new AppServerSource({ connectionManager: new RuntimeConnectionManager({ runtime, policy }) });
}
