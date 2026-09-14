import { t } from "../../i18n/Messages.js";
import type { HudState } from "../../core/HudState.js";
import type { HudEvent } from "../../core/HudEvent.js";
import type { HudConfig } from "../../config/Config.js";
import { SourceDeduplicator } from "../../core/source/SourceDeduplicator.js";
import { SourceAuthorityPolicy } from "../../core/source/SourceAuthorityPolicy.js";
import type { SourceStatus } from "../../core/source/DataSource.js";
import { HudStateReducer } from "../../core/HudStateReducer.js";
import { StateStore } from "../../core/StateStore.js";
import { redactText } from "../../core/Redaction.js";
import { CodexDiscoveryProvider, type CodexRuntime } from "./CodexDiscoveryProvider.js";
import { RolloutReader, type RolloutReadResult, type RolloutWatchStatus } from "./RolloutReader.js";
import type { RolloutDetections } from "./RolloutEventParser.js";
import { RolloutSource } from "./RolloutSource.js";
import { AppServerSource, createAppServerSource } from "./app-server/AppServerSource.js";
import { AppServerError } from "./app-server/AppServerProtocol.js";
import { sourceChecks } from "./SourceDiagnostics.js";
import { errorCode, type CodexCheck, type CodexDiagnostic } from "./Diagnostics.js";
import { RolloutAgentProvider, type AgentRead } from "./RolloutAgentProvider.js";
import { CapabilityDiscovery } from "./CapabilityDiscovery.js";
import type { DiscoveryIO } from "./DiscoveryFiles.js";
import { discoverRolloutPlan, planChecks } from "./PlanDiscovery.js";
import { flattenAgentTree } from "../../core/AgentTree.js";
import { usageChecks } from "./UsageDiagnostics.js";
import type { RuntimePolicy } from "./runtime/RuntimePolicy.js";
import { HudDiagnosticsTracker, type HudDiagnostics } from "../../core/HudDiagnostics.js";

export interface CodexSessionSnapshot {
  runtime: CodexRuntime;
  state: HudState;
  sampledAt: number;
  read: RolloutReadResult;
  detections: RolloutDetections;
  checks: CodexCheck[];
  diagnostics: CodexDiagnostic[];
  watcher?: RolloutWatchStatus;
  agentReads?: AgentRead[];
  discoveryIO?: DiscoveryIO;
  hudDiagnostics?: HudDiagnostics;
}

export function hasUsableAppServer(snapshot: CodexSessionSnapshot): boolean {
  const source = snapshot.state.dataSources?.appServer;
  return !!snapshot.state.session?.id && source?.available === true && (source.live || source.history === "ready" || source.history === "partial");
}

export interface CodexSessionHandlers {
  onSnapshot: (snapshot: CodexSessionSnapshot) => void;
  onDiagnostic: (diagnostic: CodexDiagnostic) => void;
}

interface LiveSession extends CodexSessionHandlers {
  ready: Promise<void>;
  resolveReady: () => void;
  active: boolean;
  dirty: boolean;
  rediscover: boolean;
  running?: Promise<void>;
  timer?: ReturnType<typeof setInterval>;
  watchedPath?: string;
  stopWatch?: () => void;
}

export class CodexSessionProvider {
  readonly store: StateStore;
  readonly telemetry: HudDiagnosticsTracker;
  private readonly discovery: Pick<CodexDiscoveryProvider, "discover">;
  private readonly reader: RolloutReader;
  private readonly rollout: RolloutSource;
  private readonly reducer = new HudStateReducer();
  private readonly agents: RolloutAgentProvider;
  private readonly sources: SourceDeduplicator;
  private readonly createAppSource: (runtime: CodexRuntime, policy?: Partial<RuntimePolicy>) => Promise<AppServerSource>;
  private readonly runtimePolicy?: Partial<RuntimePolicy>;
  private appSource?: AppServerSource;
  private appStatus?: SourceStatus;
  private appAttempted = false;
  private appUnsubscribe: Array<() => void> = [];
  private factoryFailures = 0;
  private factoryRetryAt = 0;
  private sourceFailure?: string;
  private lastSnapshot?: CodexSessionSnapshot;
  private reading = false;
  private publishQueued = false;
  private needsPublish = false;
  private readonly capabilities = new CapabilityDiscovery();
  private readonly now: () => number;
  private detections: RolloutDetections = { tokenCount: false, contextWindow: false, rateLimits: false, tools: false, activity: false, agents: false };
  private diagnostics: CodexDiagnostic[] = [];
  private omittedDiagnostics = { error: 0, warning: 0 };
  private queue: Promise<void> = Promise.resolve();
  private runtime?: CodexRuntime;
  private selectedThread?: string;
  private live?: LiveSession;
  private stopping?: Promise<void>;
  private stopped = false;
  private cleanupFailed = false;
  private rolloutIdentityUnconfirmed = false;

  constructor(options: { discovery?: Pick<CodexDiscoveryProvider, "discover">; reader?: RolloutReader; store?: StateStore; now?: () => number;
    providers?: HudConfig["providers"]; runtime?: Partial<RuntimePolicy>; appServerSource?: AppServerSource;
    createAppServerSource?: (runtime: CodexRuntime, policy?: Partial<RuntimePolicy>) => Promise<AppServerSource> } = {}) {
    this.discovery = options.discovery ?? new CodexDiscoveryProvider();
    this.reader = options.reader ?? new RolloutReader();
    this.rollout = new RolloutSource(this.reader);
    // 生产入口显式传入配置；直接使用 provider 的离线调用方保持原来的 Rollout 行为。
    this.sources = new SourceDeduplicator(new SourceAuthorityPolicy(options.providers?.prefer_app_server ?? !!options.appServerSource,
      options.providers?.use_rollout_fallback ?? true));
    this.now = options.now ?? Date.now;
    this.telemetry = new HudDiagnosticsTracker(this.now);
    this.agents = new RolloutAgentProvider(event => this.normalizeSource(event), id => this.sources.forgetThread(id),
      (reducer, event) => this.applyEvent(reducer, event), (kind, count) => this.telemetry.raw(kind, count));
    this.createAppSource = options.createAppServerSource ?? (options.appServerSource ? async () => options.appServerSource! : createAppServerSource);
    this.runtimePolicy = options.runtime;
    this.store = options.store ?? new StateStore();
  }

  getHudDiagnostics(): HudDiagnostics {
    this.updateDiagnostics(this.lastSnapshot?.state ?? this.store.get());
    return this.telemetry.snapshot();
  }

  refresh(): Promise<CodexSessionSnapshot> {
    this.stopped = false;
    return this.enqueueRead(true);
  }

  async probeWatcher(): Promise<RolloutWatchStatus> {
    if (this.live?.active || !this.runtime?.currentRolloutPath) return this.reader.getWatchStatus();
    const stop = this.reader.watch(this.runtime.currentRolloutPath, () => {}, () => {});
    try {
      // fs.watch 的异步错误可能晚于一次 setImmediate，保留短暂观察窗口后再释放。
      await new Promise<void>(resolve => setTimeout(resolve, 100));
      return this.reader.getWatchStatus();
    } finally { stop(); }
  }

  start(handlers: CodexSessionHandlers): Promise<void> {
    if (this.stopping) return this.stopping.then(() => this.start(handlers));
    if (this.live?.active) return this.live.ready;
    this.stopped = false;
    let resolveReady!: () => void;
    const ready = new Promise<void>(resolve => { resolveReady = resolve; });
    const live: LiveSession = { ...handlers, ready, resolveReady, active: true, dirty: false, rediscover: false };
    this.live = live;
    // 新文件可能出现在其他日期目录，不能只依赖当前 rollout 的目录通知。
    live.timer = setInterval(() => { void this.requestRead(live, true); }, 3000);
    void this.requestRead(live, true);
    return ready;
  }

  stop(): Promise<void> {
    if (this.stopping) return this.stopping;
    const live = this.live;
    if (live) {
      live.active = false; live.dirty = false;
      if (live.timer) clearInterval(live.timer);
      live.stopWatch?.();
    }
    const started = performance.now();
    this.stopping = (async () => {
      const pending = await Promise.allSettled([Promise.resolve().then(() => this.appSource?.stop()), live?.running, this.queue]);
      const cleanup = await Promise.allSettled([Promise.resolve().then(() => this.appSource?.stop()), Promise.resolve().then(() => this.rollout.stop())]);
      if (this.live === live) this.live = undefined;
      const errors = [...pending, ...cleanup].flatMap(result => result.status === "rejected" ? [result.reason] : []);
      if (!errors.length) {
        const remaining: Array<() => void> = [];
        for (const unsubscribe of this.appUnsubscribe) {
          try { unsubscribe(); } catch (error) { errors.push(error); remaining.push(unsubscribe); }
        }
        this.appUnsubscribe = remaining;
      }
      if (!errors.length) { this.appSource = undefined; this.appAttempted = false; this.appStatus = undefined; this.factoryFailures = 0; }
      this.needsPublish = false;
      this.stopped = true; this.cleanupFailed = errors.length > 0;
      this.telemetry.measure("shutdown", performance.now() - started);
      this.updateDiagnostics(this.lastSnapshot?.state ?? this.store.get());
      if (errors.length) throw new AggregateError(errors, t("会话来源资源清理失败"));
    })().finally(() => { this.stopping = undefined; });
    return this.stopping;
  }

  private requestRead(live: LiveSession, rediscover: boolean): Promise<void> {
    if (!live.active) return Promise.resolve();
    live.dirty = true;
    live.rediscover ||= rediscover;
    if (live.running) return live.running;
    live.running = (async () => {
      while (live.active && live.dirty) {
        const discover = live.rediscover;
        live.dirty = false;
        live.rediscover = false;
        try {
          const snapshot = await this.enqueueRead(discover, () => live.active);
          if (!live.active) break;
          const filePath = snapshot.runtime.currentRolloutPath;
          if (filePath !== live.watchedPath) {
            live.stopWatch?.();
            live.watchedPath = filePath;
            live.stopWatch = filePath && this.sources.policy.accepts("rollout") ? this.rollout.watch(filePath,
              () => this.requestRead(live, false),
              diagnostic => { if (live.active) this.report(live, diagnostic); }) : undefined;
            // 回放与建立监听之间的追加由一次增量补读覆盖。
            if (filePath) live.dirty = true;
          }
          snapshot.watcher = this.reader.getWatchStatus();
          live.onSnapshot(snapshot);
        } catch (error) {
          if (live.active) this.report(live, { code: "live-refresh", severity: "error",
            message: t("刷新 Codex 会话失败（{0}），将重试", errorCode(error)) });
        } finally { live.resolveReady(); }
      }
    })().finally(() => { live.running = undefined; });
    return live.running;
  }

  private enqueueRead(rediscover: boolean, publish: () => boolean = () => true): Promise<CodexSessionSnapshot> {
    const run = this.queue.then(async () => {
      this.reading = true;
      try { return await this.readSnapshot(rediscover, publish); }
      finally { this.reading = false; if (this.needsPublish) this.schedulePublish(); }
    });
    this.queue = run.then(() => undefined, () => undefined);
    return run;
  }

  private async readSnapshot(rediscover: boolean, publish: () => boolean, identityRetry = false): Promise<CodexSessionSnapshot> {
    const discoveryStarted = performance.now();
    const runtime = rediscover || !this.runtime ? await this.discovery.discover() : this.runtime;
    if (rediscover || !this.runtime) this.telemetry.measure("discovery", performance.now() - discoveryStarted);
    if (this.runtime && runtime.currentSessionId !== this.selectedThread) this.resetState();
    this.selectedThread = runtime.currentSessionId;
    this.runtime = runtime;
    this.telemetry.select(runtime.currentSessionId);
    let rediscoverIdentity = false;
    const read = await this.rollout.read(this.sources.policy.accepts("rollout") ? runtime.currentRolloutPath : undefined, {
      onReset: reason => {
        if (reason === "truncated" || reason === "replaced") this.rolloutIdentityUnconfirmed = true;
        else if (reason === "switch" || reason === "initial") this.rolloutIdentityUnconfirmed = false;
        if (!this.appSource) this.resetState();
      },
      onParsed: parsed => {
        this.telemetry.raw("received");
        if (parsed.diagnostics.some(diagnostic => diagnostic.severity === "error")) this.telemetry.raw("invalid");
        if (parsed.unknown) this.telemetry.raw("unknown");
        for (const raw of parsed.events) {
          if (runtime.currentSessionId && raw.threadId !== runtime.currentSessionId) {
            if (this.rolloutIdentityUnconfirmed && !runtime.activeThreadId && !identityRetry) { rediscoverIdentity = true; continue; }
            this.sources.rejectEvent("dropped");
            this.rememberDiagnostic({ code: "session-identity-conflict", severity: "error", message: t("主 rollout 的线程身份与所选会话不一致，已拒绝该事件") });
            continue;
          }
          if (raw.type === "session") this.rolloutIdentityUnconfirmed = false;
          for (const event of this.normalizeSource(raw)) this.applyEvent(this.reducer, event);
        }
        for (const key of Object.keys(parsed.detections) as Array<keyof RolloutDetections>) this.detections[key] ||= !!parsed.detections[key];
        for (const diagnostic of parsed.diagnostics) {
          this.rememberDiagnostic({ ...diagnostic, path: runtime.currentRolloutPath });
        }
      },
    });
    if (rediscoverIdentity) {
      this.reader.invalidate();
      return this.readSnapshot(true, publish, true);
    }
    this.telemetry.raw("invalid", read.invalidLines ?? 0);
    const contentDiagnostic = (diagnostic: CodexDiagnostic) => ["invalid-utf8", "line-too-large"].includes(diagnostic.code);
    for (const diagnostic of read.diagnostics.filter(contentDiagnostic)) this.rememberDiagnostic(diagnostic);
    const sampledAt = this.now();
    const agentData = this.sources.policy.accepts("rollout") ? await this.agents.read(runtime.agentRollouts ?? [], this.reducer, sampledAt) : { reads: [], diagnostics: [] };
    const capabilities = await this.capabilities.refresh(runtime, this.reducer.skills.getCatalog(), rediscover);
    this.reducer.mcp.replaceConfiguration(capabilities.mcp);
    this.reducer.skills.replaceDirectory(capabilities.skills);
    if (!this.stopping) await this.ensureAppSource(runtime);
    const state = this.sourceState(this.reducer.getState(sampledAt));
    const plan = state.planSummary!;
    plan.capability = discoverRolloutPlan(plan, this.readable(read, state) ? "ready" : read.status, this.detections.planUnverified);
    if (read.status === "ready" && state.agentSummary && flattenAgentTree([...state.agentSummary.tree, ...state.agentSummary.orphans])
      .some(({ agent }) => agent.isSubagent && agent.parentId && agent.plan?.threadId === agent.id)) plan.capability.agentAssociation = "available";
    if (state.agentSummary) state.agentSummary.capability.enabled = runtime.agentFeatureEnabled ?? null;
    this.updateDiagnostics(state);
    if (publish()) this.store.replace(state);
    const diagnostics = [...runtime.diagnostics, ...this.diagnostics, ...read.diagnostics.filter(diagnostic => !contentDiagnostic(diagnostic)), ...agentData.diagnostics, ...capabilities.diagnostics,
      ...this.sourceDiagnostics()];
    for (const issue of plan.issues) diagnostics.push({ code: "plan-tracking", severity: "warning", message: issue });
    for (const issue of state.usage?.issues ?? []) diagnostics.push({ code: "usage-tracking", severity: "warning", message: redactText(issue) });
    for (const issue of [...(state.mcpSummary?.issues ?? []), ...(state.skillSummary?.issues ?? [])]) diagnostics.push({ code: "capability-tracking-limit", severity: "warning", message: issue });
    for (const issue of state.agentSummary?.issues ?? []) diagnostics.push({ code: "agent-correlation", severity: "warning", message: redactText(issue) });
    if (this.reducer.getToolOverflowCount()) diagnostics.push({ code: "tool-tracking-limit", severity: "warning",
      message: t("{0} 个工具因超过跟踪上限被归档为未知终态；最多同时跟踪 64 个活动工具", this.reducer.getToolOverflowCount()) });
    if (this.reducer.getUncertainToolStartCount()) diagnostics.push({ code: "tool-history-window", severity: "warning",
      message: t("{0} 条工具开始事件已超出有界跟踪窗口，运行状态未确认", this.reducer.getUncertainToolStartCount()) });
    const notifications = this.store.getNotificationErrors();
    if (notifications.count) diagnostics.push({ code: "state-subscriber", severity: "error",
      message: redactText(t("StateStore 订阅通知失败 {0} 次：{1}", notifications.count, notifications.lastMessage)) });
    for (const severity of ["error", "warning"] as const) {
      if (this.omittedDiagnostics[severity]) diagnostics.push({ code: "diagnostics-limited", severity,
        message: t("另有 {0} 条{1}；仅保留前 50 条定位信息", this.omittedDiagnostics[severity], severity === "error" ? t("解析错误") : t("解析提示")) });
    }
    const checks: CodexCheck[] = [...runtime.checks, ...planChecks(plan, this.appStatus), ...usageChecks(state, this.readable(read, state)), ...sourceChecks(state.dataSources),
      { id: "mcp-configuration", label: t("MCP 配置"), ok: capabilities.mcp.status === "ready" && !!state.mcpSummary?.configuredCount,
        warning: capabilities.mcp.status !== "error", detail: capabilities.mcp.status === "error" ? t("配置读取或解析失败")
          : t("已配置 {0}；已禁用 {1}{2}", state.mcpSummary?.configuredCount ?? 0, state.mcpSummary?.disabledCount ?? 0, state.mcpSummary?.configuredCount ? t("；配置不表示已连接") : t("；未配置 MCP 服务")) },
      { id: "mcp-runtime", label: t("MCP 运行状态"), ok: state.mcpSummary?.capability.serverStatus === true, warning: !state.mcpSummary?.capability.serverStatus,
        detail: state.mcpSummary?.capability.serverStatus ? t("就绪 {0}；失败 {1}", state.mcpSummary.readyCount, state.mcpSummary.failedCount)
          : t("调用中发现 {0} 个服务；连接状态未观测", state.mcpSummary?.runtimeCount ?? 0) },
      { id: "mcp-tools", label: t("MCP 工具发现"), ok: state.mcpSummary?.capability.toolDiscovery === true, warning: !state.mcpSummary?.capability.toolDiscovery,
        detail: t("已观测 {0} 项工具；{1}；资源与提示词未观测", state.mcpSummary?.tools.length ?? 0, state.mcpSummary?.capability.toolDiscovery ? t("取得运行目录") : t("完整工具目录未取得")) },
      { id: "skills-discovery", label: t("Skills 发现"), ok: !!state.skillSummary?.count && capabilities.skills.status === "ready", warning: capabilities.skills.status !== "error",
        detail: t("发现 {0}；当前任务目录确认可用 {1}；不可用或失败 {2}；已禁用 {3}", state.skillSummary?.count ?? 0, state.skillSummary?.availableCount ?? 0, state.skillSummary?.failedCount ?? 0, state.skillSummary?.disabledCount ?? 0) },
      { id: "skills-runtime", label: t("Skills 运行状态"), ok: state.skillSummary?.capability.activeState === true, warning: !state.skillSummary?.capability.activeState,
        detail: state.skillSummary?.capability.activeState ? t("活动 {0}", state.skillSummary.activeCount) : t("未观测逐技能 loaded/active；目录列出不代表正在使用") },
      { id: "agent-feature", label: t("多代理配置"), ok: runtime.agentFeatureEnabled === true, warning: runtime.agentFeatureEnabled !== true,
        detail: `${runtime.agentFeatureEnabled === true ? t("CLI 已启用") : runtime.agentFeatureEnabled === false ? t("CLI 已关闭") : t("未确认")}；${runtime.agentFeatureDetail ?? t("未取得配置来源")}` },
      { id: "agent-events", label: t("代理事件"), ok: !!state.agentSummary?.capability.eventSupport, warning: !state.agentSummary?.capability.eventSupport,
        detail: state.agentSummary?.capability.eventSupport ? t("已检测到；活动 {0}，已完成 {1}，失败 {2}", state.agentSummary.activeCount, state.agentSummary.completedCount, state.agentSummary.failedCount) : t("尚未检测到代理事件；不代表功能不受支持") },
      { id: "agent-correlation", label: t("代理父子关联"), ok: state.agentSummary?.capability.correlation === "strong", warning: state.agentSummary?.capability.correlation !== "strong",
        detail: state.agentSummary?.capability.correlation === "strong" ? t("强关联：明确的线程 ID 与父线程 metadata") : t("关联尚未完整确认；不根据时间或路径补造父边") },
      { id: "rollout-readable", label: t("rollout 可读"), ok: read.status === "ready", detail: read.status === "ready" ? t("本次新增读取 {0} 字节；offset={1}", read.bytesRead, read.offset) : t("当前无可读的 rollout") },
      { id: "event-parser", label: t("事件解析器"), ok: this.readable(read, state) && !diagnostics.some(item => item.severity === "error"), detail: t("坏行和未知工具字段会保留定位诊断") },
      { id: "tool-events", label: t("工具事件"), ok: this.detections.tools, warning: !this.detections.tools,
        detail: this.detections.tools ? t("已检测到实际调用或执行结果") : t("尚未观察到工具事件；当前会话可能尚未调用工具") },
      { id: "activity-tracker", label: t("当前活动"), ok: this.detections.activity, warning: !this.detections.activity,
        detail: this.detections.activity ? t("已接入工具与轮次生命周期") : t("尚未观察到可跟踪的活动") },
      { id: "token-count", label: "token_count", ok: this.detections.tokenCount, detail: this.detections.tokenCount ? t("已检测到真实事件") : t("尚未检测到；Token 模块在缺数据时隐藏") },
      { id: "context-window", label: t("上下文窗口"), ok: this.detections.contextWindow, detail: this.detections.contextWindow ? t("已检测到数值容量") : t("尚未检测到有效容量") },
    ];
    const snapshot = { runtime, state, read, agentReads: agentData.reads, discoveryIO: capabilities.io, sampledAt, hudDiagnostics: this.telemetry.snapshot(),
      detections: { ...this.detections, agents: state.agentSummary?.capability.eventSupport }, checks, diagnostics, watcher: this.reader.getWatchStatus() };
    this.lastSnapshot = snapshot;
    return snapshot;
  }

  private resetState(): void {
    this.reducer.reset(); this.agents.reset(); this.sources.reset();
    this.detections = { tokenCount: false, contextWindow: false, rateLimits: false, tools: false, activity: false, agents: false };
    this.diagnostics = []; this.omittedDiagnostics = { error: 0, warning: 0 };
  }

  private normalizeSource(event: HudEvent): HudEvent[] {
    const started = performance.now();
    const accepted = this.sources.consume(event);
    if (accepted.length) this.telemetry.received(event.source ?? "rollout", event.phase, event.at);
    this.telemetry.measure("eventToReducer", performance.now() - started);
    return accepted;
  }

  private applyEvent(reducer: HudStateReducer, event: HudEvent): void {
    const started = performance.now();
    try { reducer.apply(event); this.telemetry.processed(started); }
    catch {
      this.telemetry.error("event", "event-reducer", t("事件归约失败，已跳过该事件；状态可能不完整"));
      this.rememberDiagnostic({ code: "event-reducer", severity: "error", message: t("事件归约失败，已跳过该事件；状态可能不完整") });
    }
  }

  private async ensureAppSource(runtime: CodexRuntime): Promise<void> {
    if (!this.sources.policy.preferAppServer) return;
    if (!this.appAttempted) {
      if (this.factoryFailures >= 8 || this.now() < this.factoryRetryAt) return;
      this.appAttempted = true;
      try {
        const source = await this.createAppSource(runtime, this.runtimePolicy);
        this.appSource = source;
        this.sourceFailure = undefined;
        this.appUnsubscribe = [source.onEvent(event => {
          const root = this.runtime?.currentSessionId;
          if (this.stopping || this.appSource !== source || !root || !event.threadId || !source.tracksThread(event.threadId, root)) {
            this.sources.rejectEvent("dropped"); return;
          }
          for (const accepted of this.normalizeSource(event)) this.applyAppEvent(accepted);
          this.schedulePublish();
        }), source.onStatus(status => {
          if (this.stopping || this.appSource !== source) return;
          this.appStatus = status;
          for (const event of this.sources.setAppServerLive(status.live, status.unloadedThreadIds)) this.applyAppEvent(event);
          this.schedulePublish();
        }), source.onDiagnostic(diagnostic => { if (this.appSource === source) { this.rememberDiagnostic(diagnostic); this.schedulePublish(); } })];
      } catch (error) {
        this.appAttempted = false; this.factoryFailures++;
        this.factoryRetryAt = this.now() + Math.min(30_000, 1000 * 2 ** (this.factoryFailures - 1));
        this.sourceFailure = error instanceof AppServerError ? error.message : t("无法探测 App Server transport");
      }
    }
    if (!this.appSource) return;
    const attachStarted = performance.now(), attaching = this.appSource.getStatus().state !== "connected";
    const boundaries = this.agents.getBoundaries();
    if (runtime.currentSessionId && this.rollout.getTurnId()) boundaries.set(runtime.currentSessionId, this.rollout.getTurnId()!);
    await this.appSource.selectThread(this.appSource.requiresExplicitThread ? runtime.activeThreadId : runtime.currentSessionId,
      runtime.agentRollouts ?? [], boundaries, runtime.attachmentSource);
    if (!this.stopping) await this.appSource.start();
    if (!this.stopping) await this.appSource.checkHealth();
    if (attaching && this.appSource.isAvailable()) this.telemetry.measure("attach", performance.now() - attachStarted);
    this.appStatus = this.appSource.getStatus();
  }

  private applyAppEvent(event: HudEvent): void {
    const root = this.runtime?.currentSessionId;
    if (!root) return;
    if (event.threadId === root) this.applyEvent(this.reducer, event);
    else if (event.threadId && (this.reducer.agents.has(event.threadId)
      || this.appSource?.tracksThread(event.threadId, root)
      || (event.type === "agent-discovered" && event.parentId && this.reducer.agents.has(event.parentId))
      || this.runtime?.agentRollouts?.some(agent => agent.id === event.threadId))) {
      this.agents.apply(event.type === "tokens" ? { ...event, agentId: event.threadId } : event, this.reducer, this.now());
    }
    if (event.type === "tokens") { this.detections.tokenCount = true; this.detections.contextWindow ||= event.contextWindow !== undefined; }
    if (event.type.startsWith("tool-")) this.detections.tools = true;
    if (event.type.startsWith("turn-") || event.type.startsWith("tool-")) this.detections.activity = true;
    if (event.type.startsWith("plan-")) this.detections.plan = true;
    if (event.type === "quota") this.detections.rateLimits = true;
  }

  private readable(read: RolloutReadResult, state: HudState): boolean {
    return read.status === "ready" || !!state.session?.id && this.appStatus?.available === true && ["ready", "partial"].includes(this.appStatus.history);
  }

  private sourceState(state: HudState): HudState {
    this.agents.prune(this.reducer);
    if (!this.sources.policy.preferAppServer) return state;
    const app = this.appSource?.getStatus() ?? this.appStatus;
    state.dataSources = { preferred: this.sources.policy.preferred, active: app?.live ? "app-server"
      : this.rollout.isAvailable() ? "rollout" : state.session?.id && app?.available && ["ready", "partial"].includes(app.history) ? "app-server" : "none",
      degraded: !app?.live || app.history === "partial" || this.sources.getIssues().length > 0, rolloutAvailable: this.rollout.isAvailable(), appServer: app,
      fallbackEnabled: this.sources.policy.useRolloutFallback,
      tokenSource: this.sources.getTokenSource(state.session?.id),
      deduplicated: this.sources.getDeduplicatedCount(), issues: [...(this.sourceFailure ? [this.sourceFailure] : []), ...this.sources.getIssues()] };
    if (app?.runtime) app.runtime.source = state.dataSources.active;
    return state;
  }

  private sourceDiagnostics(): CodexDiagnostic[] {
    return [...(this.sourceFailure ? [this.sourceFailure] : []), ...this.sources.getIssues()]
      .map(message => ({ code: "data-source", severity: "warning", message }));
  }

  private schedulePublish(): void {
    this.needsPublish = true;
    if (this.publishQueued) return;
    this.publishQueued = true;
    queueMicrotask(() => {
      this.publishQueued = false;
      const live = this.live, previous = this.lastSnapshot;
      if (!live?.active || !previous || this.reading) return;
      this.needsPublish = false;
      try {
        const state = this.sourceState(this.reducer.getState(this.now()));
        this.updateDiagnostics(state);
        state.planSummary!.capability = discoverRolloutPlan(state.planSummary, this.readable(previous.read, state) ? "ready" : previous.read.status, this.detections.planUnverified);
        const updates = [...planChecks(state.planSummary!, this.appStatus), ...usageChecks(state, this.readable(previous.read, state)), ...sourceChecks(state.dataSources)];
        const ids = new Set(updates.map(check => check.id));
        const snapshot: CodexSessionSnapshot = { ...previous, state, sampledAt: this.now(), hudDiagnostics: this.telemetry.snapshot(), detections: { ...this.detections },
          checks: [...previous.checks.filter(check => !ids.has(check.id)), ...updates],
          diagnostics: [...previous.diagnostics.filter(diagnostic => diagnostic.code !== "data-source" && !diagnostic.code.startsWith("app-server")),
            ...this.diagnostics.filter(diagnostic => diagnostic.code.startsWith("app-server")), ...this.sourceDiagnostics()] };
        this.lastSnapshot = snapshot; this.store.replace(state);
        live.onSnapshot(snapshot);
      } catch {
        this.telemetry.error("event", "source-publish", t("实时来源快照发布失败，等待下次更新"));
        this.report(live, { code: "source-publish", severity: "error", message: t("实时来源快照发布失败，等待下次更新") });
      }
    });
  }

  private updateDiagnostics(state: HudState): void {
    const observed = this.stopped && state.dataSources ? { ...state, dataSources: { ...state.dataSources, active: "none" as const } } : state;
    this.telemetry.observe(observed, !this.stopped && this.rollout.isAvailable(), this.sources.getStatistics(), {
      appConnections: 0, appEventListeners: 0, appStatusListeners: 0, appDiagnosticListeners: 0, appThreads: 0,
      appBufferedEvents: 0, appBufferedBytes: 0, reconnectTimers: 0, pendingRequests: 0, pendingWrites: 0,
      runtimeClients: 0, runtimePendingClients: 0, failedCleanupClients: 0, pendingApprovals: 0,
      ...this.sources.getResourceCounts(), ...this.reducer.getResourceCounts(), ...this.agents.getResourceCounts(), ...this.store.getResourceCounts(),
      ...this.appSource?.getResourceCounts(), activeWatchers: this.reader.getWatchStatus().activeWatchers,
      providerTimers: this.live?.active ? 1 : 0, rolloutPollTimers: this.reader.getWatchStatus().mode !== "inactive" ? 1 : 0,
    }, this.appSource?.getStatus() ?? this.appStatus);
    if (this.stopped) this.telemetry.stopped(this.cleanupFailed);
  }

  private report(live: LiveSession, diagnostic: CodexDiagnostic): void {
    this.telemetry.warn(diagnostic.code, diagnostic.message);
    try { live.onDiagnostic(diagnostic); }
    catch { this.telemetry.warn("diagnostic-consumer", t("诊断消费者失败，错误保留在内部诊断中")); }
  }

  private rememberDiagnostic(diagnostic: CodexDiagnostic): void {
    this.telemetry.warn(diagnostic.code, diagnostic.message);
    if (this.diagnostics.length < 50) this.diagnostics.push(diagnostic);
    else this.omittedDiagnostics[diagnostic.severity]++;
  }
}
