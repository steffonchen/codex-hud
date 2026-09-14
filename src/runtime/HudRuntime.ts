import { t } from "../i18n/Messages.js";
import { withLanguage } from "../i18n/Language.js";
import type { HudConfig } from "../config/Config.js";
import type { HudState } from "../core/HudState.js";
import { redactText } from "../core/Redaction.js";
import { CodexSessionProvider, hasUsableAppServer, type CodexSessionSnapshot } from "../providers/codex/CodexSessionProvider.js";
import type { CodexDiagnostic } from "../providers/codex/Diagnostics.js";
import { HudRenderer } from "../renderer/HudRenderer.js";
import { WidthPolicy } from "../renderer/WidthPolicy.js";
import { TerminalController, type HudTerminal } from "../terminal/TerminalController.js";
import { RenderScheduler } from "./RenderScheduler.js";
import { SignalHandler } from "./SignalHandler.js";
import { HudDiagnosticsTracker, type HudDiagnostics } from "../core/HudDiagnostics.js";

export type HudRuntimeStatus = "created" | "starting" | "running" | "recovering" | "stopping" | "stopped";
export type LiveCodexProvider = Pick<CodexSessionProvider, "store" | "start" | "stop"> & Partial<Pick<CodexSessionProvider, "telemetry" | "getHudDiagnostics">>;

export class HudRuntime {
  private status: HudRuntimeStatus = "created";
  private readonly provider: LiveCodexProvider;
  private readonly terminal: HudTerminal;
  private readonly renderer: Pick<HudRenderer, "render"> & Partial<Pick<HudRenderer, "getIssues">>;
  private readonly telemetry: HudDiagnosticsTracker;
  private readonly signals: SignalHandler;
  private readonly scheduler: RenderScheduler;
  private readonly now: () => number;
  private readonly widthPolicy = new WidthPolicy();
  private state: HudState = {};
  private snapshot?: CodexSessionSnapshot;
  private readonly transientDiagnostics = new Map<string, CodexDiagnostic>();
  private hadSession = false;
  private clock?: ReturnType<typeof setInterval>;
  private unsubscribeState?: () => void;
  private unsubscribeTerminal?: () => void;
  private starting?: Promise<void>;
  private stopping?: Promise<void>;
  private stopped = Promise.resolve();
  private resolveStopped?: () => void;
  private failure?: Error;
  private generation = 0;

  constructor(private readonly config: HudConfig, options: {
    provider?: LiveCodexProvider;
    terminal?: HudTerminal;
    renderer?: Pick<HudRenderer, "render"> & Partial<Pick<HudRenderer, "getIssues">>;
    signals?: SignalHandler;
    now?: () => number;
  } = {}) {
    this.provider = options.provider ?? withLanguage(config.display.language,
      () => new CodexSessionProvider({ providers: config.providers, runtime: config.runtime }));
    this.terminal = options.terminal ?? new TerminalController();
    this.renderer = options.renderer ?? new HudRenderer();
    this.signals = options.signals ?? new SignalHandler();
    this.now = options.now ?? Date.now;
    this.telemetry = this.provider.telemetry ?? new HudDiagnosticsTracker(this.now);
    this.scheduler = withLanguage(config.display.language, () => new RenderScheduler(
      () => withLanguage(config.display.language, () => this.render()), config.behavior.refresh_ms, error => this.fail(error), this.now));
  }

  getStatus(): HudRuntimeStatus { return this.status; }
  getHudDiagnostics(): HudDiagnostics { return this.provider.getHudDiagnostics?.() ?? this.telemetry.snapshot(); }

  getDiagnostics(): CodexDiagnostic[] {
    return withLanguage(this.config.display.language, () =>
      [...(this.snapshot?.diagnostics ?? []), ...this.transientDiagnostics.values()].map(item => ({ ...item, message: redactText(item.message) })));
  }

  start(): Promise<void> {
    return withLanguage(this.config.display.language, () => this.startLocalized());
  }

  private startLocalized(): Promise<void> {
    if (this.status === "stopping") return this.stopping!.then(() => this.start());
    if (this.isActive()) return this.starting ?? Promise.resolve();
    this.status = "starting";
    this.failure = undefined;
    this.stopping = undefined;
    this.snapshot = undefined;
    this.state = {};
    this.hadSession = false;
    this.transientDiagnostics.clear();
    this.stopped = new Promise(resolve => { this.resolveStopped = resolve; });
    this.starting = this.begin(++this.generation);
    return this.starting;
  }

  async waitForStop(): Promise<void> {
    await this.stopped;
    if (this.failure) throw this.failure;
  }

  stop(): Promise<void> {
    return withLanguage(this.config.display.language, () => this.stopLocalized());
  }

  private stopLocalized(): Promise<void> {
    if (this.stopping) return this.stopping;
    if (this.status === "created" || this.status === "stopped") return Promise.resolve();
    this.status = "stopping";
    const started = performance.now();
    const earlyErrors: unknown[] = [];
    if (this.clock) clearInterval(this.clock);
    this.clock = undefined;
    try { this.unsubscribeState?.(); } catch (error) { earlyErrors.push(error); }
    this.unsubscribeState = undefined;
    this.stopping = Promise.resolve().then(async () => {
      const results = await Promise.allSettled([
        Promise.resolve().then(() => this.provider.stop()),
        Promise.resolve().then(() => this.scheduler.stop()),
      ]);
      const errors = [...earlyErrors, ...results.flatMap(result => result.status === "rejected" ? [result.reason] : [])];
      try { await this.terminal.dispose(); }
      catch (error) { errors.push(error); }
      finally {
        try { this.unsubscribeTerminal?.(); } catch (error) { errors.push(error); }
        this.unsubscribeTerminal = undefined;
        // 在资源释放完成前保留信号处理，连续 Ctrl+C 不会打断清理。
        try { this.signals.stop(); } catch (error) { errors.push(error); }
        this.status = "stopped";
        this.starting = undefined;
        if (errors.length) {
          this.failure = new AggregateError([...(this.failure ? [this.failure] : []), ...errors], t("HUD 资源清理失败"));
          this.telemetry.warn("runtime-cleanup", t("HUD 资源清理失败，退出结果包含全部错误"));
        }
        this.telemetry.measure("shutdown", performance.now() - started);
        this.resolveStopped?.();
      }
      if (errors.length) throw this.failure;
    });
    return this.stopping;
  }

  private isActive(): boolean {
    return ["starting", "running", "recovering"].includes(this.status);
  }

  private async begin(generation: number): Promise<void> {
    const active = () => generation === this.generation && this.isActive();
    try {
      this.unsubscribeTerminal = this.terminal.subscribe({
        resize: () => { if (active()) { this.scheduler.invalidate(); void this.scheduler.flush(); } },
        error: error => { if (active()) this.fail(error); },
        close: () => { if (active()) void this.stop().catch(error => { this.failure ??= error; }); },
      });
      this.signals.start(() => { void this.stop().catch(error => { this.failure ??= error; }); }, () => this.terminal.restoreSync());
      this.unsubscribeState = this.provider.store.subscribe(state => {
        if (!active()) return;
        this.state = state;
        this.scheduler.invalidate();
      });
      await this.terminal.start();
      if (!active()) return;
      this.scheduler.start();
      this.scheduler.invalidate();
      await this.scheduler.flush();
      if (!active()) return;
      await this.provider.start({
        onSnapshot: snapshot => {
          if (!active()) return;
          this.snapshot = snapshot;
          this.state = snapshot.state;
          this.hadSession ||= !!snapshot.runtime.currentSessionId;
          this.status = snapshot.read.status === "error" && !hasUsableAppServer(snapshot) ? "recovering" : "running";
          this.transientDiagnostics.delete("live-refresh");
          for (const [code, diagnostic] of this.transientDiagnostics) {
            if (diagnostic.path && diagnostic.path !== snapshot.runtime.currentRolloutPath) this.transientDiagnostics.delete(code);
          }
          this.scheduler.invalidate();
        },
        onDiagnostic: diagnostic => {
          if (!active()) return;
          if (diagnostic.severity === "error") this.status = "recovering";
          if (this.transientDiagnostics.size >= 20) this.transientDiagnostics.delete(this.transientDiagnostics.keys().next().value!);
          this.transientDiagnostics.set(diagnostic.code, diagnostic);
          this.scheduler.invalidate();
        },
      });
      if (!active()) return;
      if (this.config.display.enabled.some(id => ["session", "tools", "current-activity", "agents"].includes(id))) {
        this.clock = setInterval(() => {
          const session = this.config.display.enabled.includes("session") && this.state.session?.startedAt !== undefined;
          const tools = this.config.display.enabled.includes("tools") && this.state.tools?.active?.some(tool => tool.startedAt !== undefined);
          const activity = this.config.display.enabled.includes("current-activity") && this.state.activity?.status === "running" && this.state.activity.startedAt !== undefined;
          const agents = this.config.display.enabled.includes("agents") && (this.state.agentSummary?.activeCount ?? 0) > 0;
          if (session || tools || activity || agents) this.scheduler.invalidate();
        }, 1000);
      }
      await this.scheduler.flush();
    } catch (error) {
      if (generation !== this.generation) throw error;
      this.failure ??= error instanceof Error ? error : new Error(String(error));
      await this.stop();
      throw this.failure;
    }
  }

  private fail(error: unknown): void {
    this.failure ??= error instanceof Error ? error : new Error(String(error));
    void this.stop().catch(cleanupError => { this.failure ??= cleanupError; });
  }

  private async render(): Promise<void> {
    if (!this.isActive()) return;
    const renderStarted = performance.now();
    const size = this.terminal.getSize();
    if (this.config.behavior.hide_when_idle && this.state.activity?.status === "idle" && !this.state.agentSummary?.activeSubagentCount
      && !this.state.dataSources?.degraded) {
      await this.terminal.render("");
      this.telemetry.rendered(renderStarted);
      return;
    }
    const now = this.now();
    const state = this.state.session?.startedAt === undefined ? this.state : {
      ...this.state, session: { ...this.state.session, durationMs: Math.max(0, now - this.state.session.startedAt) },
    };
    const header = size.height >= 6 ? [t("Codex HUD · Ctrl+C 退出"), ""] : [];
    const diagnostics = this.getDiagnostics().filter(item => item.code !== "watch-unavailable" && item.code !== "renderer");
    const diagnostic = diagnostics.find(item => item.severity === "error") ?? diagnostics[0];
    const sources = state.dataSources;
    const footer = sources?.degraded && size.height >= 1 ? [size.width < 20 ? t("源降级 {0}", sources.active === "rollout" ? "RL" : sources.active === "app-server" ? "AS" : "—")
      : t("数据源降级：{0}；{1}", sources.active, sources.issues[0] ?? sources.appServer?.reason ?? t("实时连接不可用"))]
      : diagnostic && size.height >= 3 ? [`${diagnostic.severity === "error" ? t("错误") : t("提示")}：${diagnostic.message}`] : [];
    const bodyHeight = Math.max(0, size.height - header.length - footer.length);
    let body = "";
    try {
      body = this.renderer.render(state, { width: size.width, height: bodyHeight }, this.config, now);
      if (this.renderer.getIssues?.().length) throw new Error("module-render");
      const recovered = this.transientDiagnostics.delete("renderer");
      if (recovered && this.status === "recovering" && this.snapshot && !diagnostics.some(item => item.severity === "error")
        && (this.snapshot.read.status !== "error" || hasUsableAppServer(this.snapshot))) this.status = "running";
    } catch {
      this.status = "recovering";
      const message = t("部分模块渲染失败，等待下一次更新");
      this.telemetry.error("render", "renderer", message);
      this.transientDiagnostics.set("renderer", { code: "renderer", severity: "error", message });
      body ||= message;
      footer.splice(0, footer.length, t("错误：{0}", message));
    }
    const empty = !this.config.display.enabled.length ? t("未启用显示模块，请运行 codex-hud setup")
      : this.snapshot?.read.status === "ready" ? t("等待已启用模块的真实数据…")
      : this.hadSession ? t("会话暂不可用，正在等待新会话…") : t("正在等待 Codex 会话…");
    const lines = [...header, ...(body ? body.split("\n") : bodyHeight ? [empty] : []).slice(0, Math.max(0, size.height - header.length - footer.length)), ...footer];
    await this.terminal.render(redactText(lines.slice(0, size.height).map(line => this.widthPolicy.fitLine(line, size.width)).join("\n")));
    this.telemetry.rendered(renderStarted);
  }
}
