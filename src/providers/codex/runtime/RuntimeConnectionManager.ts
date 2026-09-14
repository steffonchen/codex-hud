import { t } from "../../../i18n/Messages.js";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { CodexRuntime } from "../CodexDiscoveryProvider.js";
import { AppServerError, AppServerProtocol, type AppServerClient, type RpcServerRequest } from "../app-server/AppServerProtocol.js";
import { RuntimeDiscoveryProvider, inspectRuntimeSocket, verifyRuntimeProcess } from "./RuntimeDiscoveryProvider.js";
import { RuntimeAuthorityResolver } from "./RuntimeAuthorityResolver.js";
import { RuntimeProbe, runtimeDeadline, type RuntimeProbeResult } from "./RuntimeProbe.js";
import { defaultRuntimePolicy, type RuntimePolicy } from "./RuntimePolicy.js";
import { initialRuntimeState, runtimeIdentity, type RuntimeCandidate, type RuntimeDiscoveryResult, type RuntimeSessionState, type RuntimeThreadAttachment } from "./RuntimeCandidate.js";

const execute = promisify(execFile);
export interface RuntimeConnection { client: AppServerClient; probe: RuntimeProbeResult }
export interface RuntimeManagerOptions {
  runtime: CodexRuntime;
  policy?: Partial<RuntimePolicy>;
  discovery?: Pick<RuntimeDiscoveryProvider, "discover">;
  probe?: RuntimeProbe;
  createClient?: (candidate: RuntimeCandidate) => AppServerClient;
  startManaged?: () => Promise<void>;
  verifyProcess?: (candidate: RuntimeCandidate) => Promise<boolean>;
  now?: () => number;
}

export class RuntimeConnectionManager {
  readonly policy: RuntimePolicy;
  private readonly discovery: Pick<RuntimeDiscoveryProvider, "discover">;
  private readonly probe: RuntimeProbe;
  private readonly resolver = new RuntimeAuthorityResolver();
  private readonly now: () => number;
  private state = initialRuntimeState();
  private current?: RuntimeConnection;
  private pending = new Set<AppServerClient>();
  private failedCleanup = new Set<AppServerClient>();
  private epoch = 0;
  private selection?: { threadId: string; source: NonNullable<RuntimeThreadAttachment["attachmentSource"]> };
  private approvals = new Map<string, { threadId: string; method: string }>();
  private managedStartAttempted = false;

  constructor(private readonly options: RuntimeManagerOptions) {
    this.policy = { ...defaultRuntimePolicy, ...options.policy };
    this.discovery = options.discovery ?? new RuntimeDiscoveryProvider({ runtime: options.runtime });
    this.probe = options.probe ?? new RuntimeProbe({ codexHome: options.runtime.codexHome, cliVersion: options.runtime.version });
    this.now = options.now ?? Date.now;
  }

  getState(): RuntimeSessionState { return structuredClone(this.state); }
  getResourceCounts(): Record<string, number> {
    return { runtimeClients: new Set([...this.pending, ...this.failedCleanup, ...(this.current ? [this.current.client] : [])]).size,
      runtimePendingClients: this.pending.size, failedCleanupClients: this.failedCleanup.size, pendingApprovals: this.approvals.size };
  }
  getCandidate(): RuntimeCandidate | undefined { return this.current && structuredClone(this.current.probe.candidate); }
  setSelection(threadId?: string, source: NonNullable<RuntimeThreadAttachment["attachmentSource"]> = "explicit"): void {
    if (threadId === this.selection?.threadId) {
      if (this.selection) { this.selection.source = source; this.state.thread.attachmentSource = source; }
      return;
    }
    ++this.epoch;
    this.selection = threadId ? { threadId, source } : undefined;
    this.approvals.clear(); this.state.pendingApprovals = 0; this.state.approvalRequestsObserved = 0;
    this.state.thread = { state: "detached", threadId, attachmentSource: threadId ? source : undefined, runtimeId: this.state.runtimeId };
  }

  async discover(force = false): Promise<RuntimeDiscoveryResult> {
    const epoch = this.epoch;
    const result = await this.discovery.discover(force);
    if (epoch === this.epoch) {
      this.state.discovery = result.status; this.state.candidateCount = result.candidates.length;
      this.state.socket = result.socket; this.state.managed = result.managed;
    }
    return result;
  }

  async connectExternal(candidate: RuntimeCandidate): Promise<AppServerClient> {
    if (!this.policy.allow_external_attach || candidate.ownership !== "external" || candidate.transport !== "unix-socket"
      || !candidate.endpoint || !candidate.endpointVerified || candidate.owner !== "verified" || candidate.permissions !== "verified"
      || candidate.process !== "verified") throw new AppServerError("transport", "unsafe-external-attach");
    if (!await runtimeDeadline((this.options.verifyProcess ?? verifyRuntimeProcess)(candidate), 10_000, "process-check")) {
      throw new AppServerError("transport", "process-changed");
    }
    const evidence = await inspectRuntimeSocket(candidate.endpoint);
    if (evidence.identity !== candidate.socketIdentity || evidence.owner !== "verified" || evidence.permissions !== "verified") {
      throw new AppServerError("transport", "socket-changed");
    }
    return this.createClient(candidate);
  }

  spawnOwned(): AppServerClient {
    if (!this.policy.allow_spawn) throw new AppServerError("transport", "spawn-disabled");
    return this.createClient(this.ownedCandidate());
  }

  private ownedCandidate(): RuntimeCandidate {
    return { id: runtimeIdentity(["owned", this.epoch, this.now()]), kind: "standalone", transport: "stdio", ownership: "owned",
      executable: this.options.runtime.codexBinary,
      state: "starting", source: "probe", owner: "verified", permissions: "verified", process: "verified", endpointVerified: true,
      compatibility: "unknown", health: "unknown" };
  }

  private createClient(candidate: RuntimeCandidate): AppServerClient {
    if (this.options.createClient) return this.options.createClient(candidate);
    const executable = this.options.runtime.codexBinary;
    if (!executable) throw new AppServerError("transport", "codex-unavailable");
    // proxy 本身是 HUD 的子进程；candidate.pid 始终只用于核验，绝不传给 kill。
    return new AppServerProtocol({ executable, args: candidate.ownership === "external"
      ? ["app-server", "proxy", "--sock", candidate.endpoint!] : ["app-server", "--stdio"],
    cwd: this.options.runtime.workingDirectory, env: { ...process.env, CODEX_HOME: this.options.runtime.codexHome } });
  }

  private async stopClient(client: AppServerClient): Promise<void> {
    try { await runtimeDeadline(Promise.resolve().then(() => client.stop()), 4000, "client-stop"); this.failedCleanup.delete(client); }
    catch { this.failedCleanup.add(client); throw new AppServerError("transport", "cleanup-failed"); }
  }

  async open(): Promise<RuntimeConnection | undefined> {
    // 未确认退出的自有连接不能被新连接取代；保留引用供显式 stop 重试清理。
    if (this.failedCleanup.size) throw new AppServerError("transport", "cleanup-pending");
    const epoch = ++this.epoch;
    const selection = this.selection;
    const check = () => { if (epoch !== this.epoch) throw new AppServerError("transport", "connection-superseded"); };
    const previous = this.current;
    this.current = undefined;
    const pending = new Set<AppServerClient>();
    const track = (client: AppServerClient) => { pending.add(client); this.pending.add(client); };
    const release = (client: AppServerClient) => { pending.delete(client); this.pending.delete(client); };
    this.state.runtimeStatus = "connecting"; this.state.reason = undefined;
    this.state.thread = { ...this.state.thread, state: this.state.reconnectAttempts ? "reconnecting" : "attaching" };
    const connections: RuntimeConnection[] = [];
    try {
      if (previous) { await this.stopClient(previous.client); check(); }
      let discovery = await runtimeDeadline(this.discover(true), 20_000, "discovery"); check();
      if (this.policy.auto_start_managed && this.policy.allow_external_attach && !this.managedStartAttempted
        && selection && discovery.status === "not-found" && discovery.managed === "not-running" && discovery.commands.daemonStart) {
        this.managedStartAttempted = true;
        if (this.options.startManaged) await runtimeDeadline(this.options.startManaged(), 10_000, "daemon-start");
        else await execute(this.options.runtime.codexBinary!, ["app-server", "daemon", "start"], {
          env: { ...process.env, CODEX_HOME: this.options.runtime.codexHome }, timeout: 10_000, maxBuffer: 64 * 1024, encoding: "utf8" });
        check(); discovery = await runtimeDeadline(this.discover(true), 20_000, "discovery"); check();
      }
      const startedAt = this.now();
      if (selection && this.policy.allow_external_attach && discovery.commands.proxy && discovery.status !== "error") {
        for (const candidate of discovery.candidates) {
          check();
          if (this.now() - startedAt > 30_000) { this.state.reason = t("候选探测达到总时间上限"); break; }
          if (candidate.transport !== "unix-socket" || !candidate.endpointVerified || candidate.owner !== "verified"
            || candidate.permissions !== "verified" || candidate.process !== "verified") continue;
          let client: AppServerClient | undefined;
          try {
            client = await this.connectExternal(candidate); track(client); check();
            const probe = await this.probe.probe(candidate, client, selection.threadId); check();
            Object.assign(candidate, probe.candidate);
            if (probe.initialized && probe.candidate.state === "running") connections.push({ client, probe });
            else { await this.stopClient(client); release(client); }
          } catch (error) {
            if (client) { await this.stopClient(client); release(client); }
            candidate.state = "unavailable"; candidate.health = "unhealthy";
            candidate.reason = error instanceof AppServerError ? error.message : t("外部连接未通过核验");
            check();
          }
        }
      }
      let authority = this.resolver.resolve(discovery, selection?.threadId, this.policy);
      if (authority.maySpawn && discovery.commands.stdio) {
        check(); const candidate = this.ownedCandidate(), client = this.createClient(candidate);
        track(client);
        const probe = await this.probe.probe(candidate, client, selection?.threadId); check();
        if (probe.initialized && probe.candidate.state === "running") connections.push({ client, probe });
        discovery.candidates.push(probe.candidate);
        authority = this.resolver.resolve(discovery, selection?.threadId, this.policy);
      }
      check();
      const selected = connections.find(connection => connection.probe.candidate.id === authority.candidate?.id);
      for (const connection of connections) if (connection !== selected) { await this.stopClient(connection.client); release(connection.client); }
      check(); this.current = selected;
      if (selected) {
        release(selected.client);
        const candidate = selected.probe.candidate;
        Object.assign(this.state, { runtimeId: candidate.id, runtimeStatus: "connected", kind: candidate.kind, transport: candidate.transport,
          ownership: candidate.ownership, compatibility: candidate.compatibility, health: candidate.health, authority: authority.reason,
          discovery: "found", candidateCount: discovery.candidates.length, probe: "success", capabilities: selected.probe.capabilities,
          serverVersion: candidate.codexVersion, authenticated: undefined, reconnectAttempts: 0, reconnectExhausted: false });
        this.state.thread = { ...this.state.thread, runtimeId: candidate.id };
      } else {
        Object.assign(this.state, { runtimeId: undefined, kind: undefined, transport: undefined, serverVersion: undefined, authenticated: undefined,
          runtimeStatus: "degraded", ownership: "unknown", health: "degraded", source: "rollout",
          compatibility: "unknown", authority: authority.reason, discovery: authority.status === "ambiguous" ? "ambiguous" : discovery.status,
          probe: discovery.candidates.some(candidate => candidate.state === "unavailable") ? "failure" : "not-observed",
          reason: this.state.reason ?? (authority.status === "ambiguous" ? t("多个 runtime 无法安全消歧") : discovery.issues[0]
            ?? discovery.candidates.find(candidate => candidate.reason)?.reason ?? t("没有可确认的当前线程 runtime，使用 Rollout")) });
        this.state.thread = { ...this.state.thread, state: "detached", runtimeId: undefined };
      }
      return selected;
    } catch (error) {
      if (epoch === this.epoch) { this.state.runtimeStatus = "degraded"; this.state.health = "degraded"; this.state.probe = "failure";
        this.state.reason = error instanceof AppServerError ? error.message : t("Runtime 连接失败"); }
      throw error;
    } finally {
      const results = await Promise.allSettled([...pending].map(client => this.stopClient(client)));
      for (const client of pending) this.pending.delete(client);
      if (results.some(result => result.status === "rejected")) {
        if (epoch === this.epoch) this.state.reason = t("Runtime 探测连接清理失败");
        throw new AppServerError("transport", "cleanup-failed");
      }
    }
  }

  attachment(state: RuntimeThreadAttachment["state"], live = false): void {
    this.state.thread = { ...this.state.thread, state };
    this.state.source = live ? "app-server" : "rollout";
    this.state.health = live ? "healthy" : this.state.runtimeStatus === "connected" ? "degraded" : this.state.health;
  }
  event(method: string): void {
    this.state.lastEventAt = this.now(); this.state.eventCount++;
  }
  serverRequest(request: RpcServerRequest, knownThread: boolean): void {
    if (!knownThread || !request.threadId) return;
    if (!/Approval|requestUserInput|elicitation/u.test(request.method)) { this.state.reason = t("收到 HUD 无法处理的服务端请求"); return; }
    if (this.approvals.size >= 64) { this.state.reason = t("待处理审批超过观察上限"); return; }
    const key = JSON.stringify([request.threadId, request.id]);
    if (!this.approvals.has(key)) this.state.approvalRequestsObserved++;
    this.approvals.set(key, { threadId: request.threadId, method: request.method });
    this.state.pendingApprovals = this.approvals.size;
  }
  resolveRequest(threadId: string, requestId: unknown): void {
    this.approvals.delete(JSON.stringify([threadId, requestId])); this.state.pendingApprovals = this.approvals.size;
  }
  reconnect(attempts: number, exhausted: boolean, reason: string): void {
    this.state.reconnectAttempts = attempts; this.state.reconnectExhausted = exhausted;
    this.state.runtimeStatus = "degraded"; this.state.health = "degraded"; this.state.source = "rollout"; this.state.reason = reason;
    this.attachment(exhausted ? "lost" : "reconnecting"); this.approvals.clear(); this.state.pendingApprovals = 0;
  }
  updateCapabilities(update: Partial<RuntimeSessionState["capabilities"]>): void { Object.assign(this.state.capabilities, update); }
  account(authenticated: boolean): void { this.state.authenticated = authenticated; }
  async disconnect(): Promise<void> {
    ++this.epoch;
    const clients = new Set([...this.pending, ...this.failedCleanup, ...(this.current ? [this.current.client] : [])]);
    this.current = undefined; this.pending.clear();
    this.state.runtimeStatus = "disconnected"; this.state.source = "rollout"; this.state.health = "unknown";
    this.attachment("detached"); this.approvals.clear(); this.state.pendingApprovals = 0;
    const results = await Promise.allSettled([...clients].map(client => this.stopClient(client)));
    if (results.some(result => result.status === "rejected")) throw new AppServerError("transport", "cleanup-failed");
  }
}
