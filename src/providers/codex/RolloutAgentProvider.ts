import { t } from "../../i18n/Messages.js";
import { HudStateReducer } from "../../core/HudStateReducer.js";
import { MAX_TRACKED_AGENTS } from "../../core/AgentTracker.js";
import type { NormalizedAgentEvent } from "../../core/AgentEvents.js";
import type { HudEvent } from "../../core/HudEvent.js";
import type { AgentRollout } from "./CodexDiscoveryProvider.js";
import { RolloutSource } from "./RolloutSource.js";
import { RolloutReader, type RolloutReadResult } from "./RolloutReader.js";
import type { CodexDiagnostic } from "./Diagnostics.js";

export interface AgentRead {
  agentId: string;
  path: string;
  status: RolloutReadResult["status"];
  bytesRead: number;
  offset: number;
}

interface AgentStream {
  path?: string;
  source: RolloutSource;
  reducer: HudStateReducer;
  diagnostics: CodexDiagnostic[];
  valid: boolean;
  external: boolean;
  omittedDiagnostics: { error: number; warning: number };
}

export const MAX_AGENT_ROLLOUTS = 4096;

// 仅保存增量游标和归一化状态。调用方统一调度，子线程从不创建 watcher 或 timer。
export class RolloutAgentProvider {
  private streams = new Map<string, AgentStream>();
  private retiredFiles = new Map<string, number>();

  constructor(private readonly normalize: (event: HudEvent) => HudEvent[] = event => [event], private readonly forgetThread: (id: string) => void = () => {},
    private readonly reduce: (reducer: HudStateReducer, event: HudEvent) => void = (reducer, event) => reducer.apply(event),
    private readonly raw: (kind: "received" | "invalid" | "unknown", count?: number) => void = () => {}) {}

  getResourceCounts(): Record<string, number> { return { agentReaders: this.streams.size, retiredAgentFiles: this.retiredFiles.size,
    agentDiagnosticEntries: [...this.streams.values()].reduce((sum, stream) => sum + stream.diagnostics.length, 0) }; }

  prune(owner: HudStateReducer): void {
    for (const [id, stream] of this.streams) if (stream.external && owner.agents.isRetired(id)) {
      this.streams.delete(id); owner.mcp.replaceThread(id);
    }
  }

  getBoundaries(): Map<string, string> {
    return new Map([...this.streams].flatMap(([id, stream]) => stream.source.getTurnId() ? [[id, stream.source.getTurnId()!] as const] : []));
  }

  apply(event: HudEvent, owner: HudStateReducer, now: number): void {
    const id = event.threadId;
    if (!id) return;
    this.prune(owner);
    if (owner.agents.isRetired(id)) {
      const turn = event.type === "turn-started" ? event.id : event.type === "agent-status" && event.status === "running" ? event.turnId : undefined;
      if (!owner.agents.restoreThread(id, turn, event.at)) return;
    }
    if (event.type.startsWith("agent-")) this.reduce(owner, event);
    let stream = this.streams.get(id);
    if (!stream) {
      if (this.streams.size >= MAX_TRACKED_AGENTS - 1) return;
      stream = this.createStream(); this.streams.set(id, stream);
      stream.reducer.apply({ type: "session", id });
    }
    stream.external = true;
    if (!event.type.startsWith("agent-")) this.reduce(stream.reducer, event);
    this.publish(id, stream, owner, now);
  }

  private createStream(): AgentStream {
    return { source: new RolloutSource(), reducer: new HudStateReducer(false), diagnostics: [], omittedDiagnostics: { error: 0, warning: 0 }, valid: false, external: false };
  }

  private publish(id: string, stream: AgentStream, owner: HudStateReducer, now: number): void {
    const state = stream.reducer.getState(now);
    owner.agents.updateThread(id, state);
    owner.mcp.replaceThread(id, state.mcpSummary);
  }

  reset(): void { this.streams.clear(); this.retiredFiles.clear(); }

  async read(candidates: readonly AgentRollout[], owner: HudStateReducer, now: number): Promise<{ reads: AgentRead[]; diagnostics: CodexDiagnostic[] }> {
    const reads: AgentRead[] = [];
    const diagnostics: CodexDiagnostic[] = [];
    let readerLimitReported = false;
    const current = new Set(candidates.map(candidate => candidate.id));
    for (const [id, stream] of this.streams) if (!current.has(id) && !stream.external) {
      owner.agents.markUnavailable(id);
      owner.mcp.replaceThread(id);
      this.streams.delete(id);
      this.forgetThread(id);
      diagnostics.push({ code: "agent-rollout-missing", severity: "warning", path: stream.path, message: t("子线程 rollout 已消失，代理状态未确认") });
    }
    owner.agents.trimHistory();
    const metadata = new Map(candidates.map(candidate => [candidate.id, candidate]));
    const selected = candidates.filter((candidate, index) => index < MAX_AGENT_ROLLOUTS || this.streams.has(candidate.id));
    const selectedIds = new Set(selected.map(candidate => candidate.id));
    for (const id of this.retiredFiles.keys()) if (!selectedIds.has(id)) this.retiredFiles.delete(id);
    if (selected.length < candidates.length) diagnostics.push({ code: "agent-discovery-limit", severity: "warning", message: t("会话超过 {0} 个 rollout 的安全窗口，较早且未跟踪的数据未采集", MAX_AGENT_ROLLOUTS) });
    for (const candidate of selected) {
      if (this.retiredFiles.get(candidate.id) === candidate.modifiedAt) continue;
      let stream = this.streams.get(candidate.id);
      if (!stream) {
        if (this.streams.size >= MAX_TRACKED_AGENTS - 1) {
          if (!readerLimitReported) diagnostics.push({ code: "agent-reader-limit", severity: "warning", message: t("子线程读取达到安全上限，部分代理数据未采集") });
          readerLimitReported = true;
          continue;
        }
        stream = this.createStream();
        this.streams.set(candidate.id, stream);
      }
      const active = stream;
      const discovered: NormalizedAgentEvent = { type: "agent-discovered", agentId: candidate.id, parentId: candidate.parentId,
        isSubagent: true, name: candidate.name, agentPath: candidate.agentPath, agentType: candidate.agentType, source: "rollout" };
      const read = await active.source.read(candidate.path, {
        onReset: () => {
          if (!active.external) {
            this.forgetThread(candidate.id);
            active.reducer.reset(); owner.agents.resetThread(candidate.id); owner.mcp.replaceThread(candidate.id);
          }
          active.diagnostics = []; active.omittedDiagnostics = { error: 0, warning: 0 }; active.valid = false;
          owner.apply(discovered);
        },
        onParsed: parsed => {
          this.raw("received");
          if (parsed.diagnostics.some(diagnostic => diagnostic.severity === "error")) this.raw("invalid");
          if (parsed.unknown) this.raw("unknown");
          const session = parsed.events.find(event => event.type === "session");
          if (session?.type === "session") {
            active.valid = session.id === candidate.id;
            if (!active.valid) this.remember(active, { code: "agent-identity-conflict", severity: "error", path: candidate.path,
              message: t("子 rollout 的线程身份与发现结果不一致，已停止接收其事件") });
          }
          if (active.valid) for (const raw of parsed.events) for (const event of this.normalize(raw)) {
            if (event.type.startsWith("agent-")) this.reduce(owner, event);
            else this.reduce(active.reducer, event);
          }
          for (const diagnostic of parsed.diagnostics) this.remember(active, { ...diagnostic, path: candidate.path });
        },
      });
      active.path = candidate.path;
      if (read.status === "ready" && active.valid) {
        this.publish(candidate.id, active, owner, now);
      } else if (!active.external) {
        owner.agents.markUnavailable(candidate.id);
        owner.mcp.replaceThread(candidate.id);
      }
      reads.push({ agentId: candidate.id, path: candidate.path, status: read.status, bytesRead: read.bytesRead, offset: read.offset });
      diagnostics.push(...active.diagnostics, ...read.diagnostics);
      this.raw("invalid", read.invalidLines ?? 0);
      for (const severity of ["error", "warning"] as const) if (active.omittedDiagnostics[severity]) diagnostics.push({ code: "agent-diagnostics-limited", severity,
        message: t("子线程另有 {0} 条{1}，详情已限量", active.omittedDiagnostics[severity], severity === "error" ? t("错误") : t("提示")) });
      for (const id of owner.agents.trimHistory()) {
        this.streams.delete(id);
        this.forgetThread(id);
        owner.mcp.replaceThread(id);
        const retired = metadata.get(id);
        if (retired) this.retiredFiles.set(id, retired.modifiedAt);
      }
    }
    if (diagnostics.length > 50) return { reads, diagnostics: [...diagnostics.slice(0, 49), {
      code: "agent-diagnostics-limited", severity: diagnostics.some(item => item.severity === "error") ? "error" : "warning",
      message: t("子线程另有 {0} 条诊断，详情已限量", diagnostics.length - 49),
    }] };
    return { reads, diagnostics };
  }

  private remember(stream: AgentStream, diagnostic: CodexDiagnostic): void {
    if (stream.diagnostics.length < 50) stream.diagnostics.push(diagnostic);
    else stream.omittedDiagnostics[diagnostic.severity]++;
  }
}
