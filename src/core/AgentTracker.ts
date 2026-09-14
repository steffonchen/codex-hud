import { t } from "../i18n/Messages.js";
import type { NormalizedAgentEvent } from "./AgentEvents.js";
import { isActiveAgent, type AgentCapability, type AgentState, type AgentSummary } from "./AgentState.js";
import { buildAgentTree, flattenAgentTree } from "./AgentTree.js";
import type { HudState } from "./HudState.js";
import { redactSummary } from "./Redaction.js";

export const MAX_TRACKED_AGENTS = 256;
export const MAX_RECENT_AGENTS = 20;
type RetiredAgent = Pick<AgentState, "id" | "parentId" | "isSubagent" | "name" | "agentPath" | "agentType" | "turnId" | "lastUpdatedAt">;

export class AgentTracker {
  private agents = new Map<string, AgentState>();
  private retired = new Map<string, RetiredAgent>();
  private observed = false;
  private rootId?: string;
  private omitted = 0;
  private issues = new Set<string>();
  private retiredTurns = new Map<string, Set<string>>();

  constructor(private readonly limit = MAX_TRACKED_AGENTS, private readonly recentLimit = MAX_RECENT_AGENTS) {
    if (!Number.isSafeInteger(limit) || limit < 1 || !Number.isSafeInteger(recentLimit) || recentLimit < 0) throw new Error(t("代理跟踪上限无效"));
  }

  reset(): void {
    this.agents.clear(); this.retired.clear(); this.issues.clear(); this.retiredTurns.clear();
    this.observed = false; this.rootId = undefined; this.omitted = 0;
  }

  setRoot(id: string): void { this.rootId = id; }

  apply(event: NormalizedAgentEvent): void {
    if (event.isSubagent || event.parentId || event.type === "agent-call") this.observed = true;
    const previous = this.agents.get(event.agentId);
    if (!previous && this.retired.has(event.agentId)) return;
    if (!previous && this.agents.size >= this.limit) {
      this.omitted++;
      this.issue(t("代理跟踪达到 {0} 项安全上限，部分状态未采集", this.limit));
      return;
    }
    const agent: AgentState = previous ?? { id: event.agentId, status: "unknown" };
    if (event.type === "agent-discovered") {
      if (event.isSubagent !== undefined) agent.isSubagent = event.isSubagent;
      if (agent.parentId && event.parentId && agent.parentId !== event.parentId) {
        this.issue(t("代理父线程记录冲突：{0}", agent.id));
      } else if (event.parentId) agent.parentId = event.parentId;
      if (event.name) agent.name = redactSummary(event.name, 80);
      if (event.agentPath) agent.agentPath = redactSummary(event.agentPath, 240);
      if (event.agentType) agent.agentType = redactSummary(event.agentType, 80);
    }
    if (event.type === "agent-status" && event.status) {
      if (event.turnId && this.retiredTurns.get(agent.id)?.has(event.turnId)) return;
      const stale = event.at !== undefined && agent.lastUpdatedAt !== undefined && event.at < agent.lastUpdatedAt;
      const sameTurn = !event.turnId || !agent.turnId || event.turnId === agent.turnId;
      const settled = ["completed", "failed", "cancelled"].includes(agent.status);
      if (!stale && !(settled && sameTurn && isActiveAgent({ status: event.status }))) {
        if (event.turnId && event.turnId !== agent.turnId) {
          if (agent.turnId) {
            const turns = this.retiredTurns.get(agent.id) ?? new Set<string>();
            turns.add(agent.turnId);
            if (turns.size > 64) turns.delete(turns.values().next().value!);
            this.retiredTurns.set(agent.id, turns);
          }
          agent.startedAt = undefined; agent.completedAt = undefined; agent.activity = undefined; agent.error = undefined;
        }
        agent.status = event.status;
        agent.turnId = event.turnId ?? agent.turnId;
        if (isActiveAgent(agent)) agent.startedAt ??= event.at;
        else if (event.status !== "unknown") agent.completedAt = event.at;
      }
      // 终态先到时仍可补上同一轮的开始时间，但绝不重新变成运行中。
      if (sameTurn && event.status === "running" && event.at !== undefined && (agent.completedAt === undefined || event.at <= agent.completedAt)) {
        agent.startedAt = Math.min(agent.startedAt ?? event.at, event.at);
      }
    }
    if (event.at !== undefined) agent.lastUpdatedAt = Math.max(agent.lastUpdatedAt ?? 0, event.at);
    this.agents.set(agent.id, agent);
  }

  updateThread(id: string, snapshot: HudState): void {
    const agent = this.agents.get(id);
    if (!agent) return;
    agent.model = snapshot.model;
    agent.reasoningEffort = snapshot.reasoningEffort;
    agent.tokens = snapshot.tokenUsage && { ...snapshot.tokenUsage };
    if (snapshot.usage && snapshot.session?.id === id) {
      const { recentRecords, ...usage } = snapshot.usage;
      agent.usage = structuredClone(usage);
    } else agent.usage = undefined;
    agent.context = snapshot.context && { ...snapshot.context };
    agent.activity = snapshot.activity && { ...snapshot.activity };
    const plan = snapshot.planSummary?.execution;
    agent.plan = agent.isSubagent && plan?.threadId === id ? structuredClone(plan) : undefined;
  }

  resetThread(id: string): void { this.agents.delete(id); this.retired.delete(id); this.retiredTurns.delete(id); }

  markUnavailable(id: string): void {
    const agent = this.agents.get(id);
    if (!agent) return;
    agent.status = "unknown";
    agent.activity = undefined; agent.tokens = undefined; agent.context = undefined;
    agent.usage = undefined;
    agent.plan = undefined;
    agent.error = t("子线程 rollout 暂不可读，状态未确认");
  }

  getSummary(enabled: boolean | null = null): AgentSummary {
    this.trimHistory();
    const values = [...this.agents.values()];
    const graph = buildAgentTree(values);
    const children = values.filter(agent => agent.id !== this.rootId);
    const capability: AgentCapability = { enabled, eventSupport: this.observed,
      correlation: children.length ? children.every(agent => !!agent.parentId) && !graph.issues.length && !this.issues.size ? "strong" : "partial" : "none",
      nestedSupport: flattenAgentTree(graph.tree).some(entry => entry.depth >= 2),
      contextSupport: children.some(agent => agent.context?.usedPercent !== undefined),
      tokenSupport: children.some(agent => agent.tokens?.totalTokens !== undefined) };
    return { rootId: this.rootId, count: values.length, activeCount: values.filter(isActiveAgent).length, activeSubagentCount: children.filter(isActiveAgent).length,
      completedCount: values.filter(agent => agent.status === "completed").length,
      failedCount: values.filter(agent => agent.status === "failed").length,
      cancelledCount: values.filter(agent => agent.status === "cancelled").length,
      omittedCount: this.omitted, ...graph, issues: [...this.issues, ...graph.issues].slice(0, 50), capability,
      lastUpdatedAt: values.reduce<number | undefined>((at, agent) => agent.lastUpdatedAt === undefined ? at : Math.max(at ?? 0, agent.lastUpdatedAt), undefined) };
  }

  has(id: string): boolean { return this.agents.has(id); }
  getResourceCounts(): Record<string, number> { return { trackedAgents: this.agents.size, retiredAgents: this.retired.size,
    retiredAgentTurns: [...this.retiredTurns.values()].reduce((sum, turns) => sum + turns.size, 0) }; }
  isRetired(id: string): boolean { return this.retired.has(id); }
  restoreThread(id: string, turnId?: string, at?: number): boolean {
    const previous = this.retired.get(id);
    if (!previous || !turnId || !previous.turnId || turnId === previous.turnId || !previous.parentId || !this.agents.has(previous.parentId)
      || this.agents.size >= this.limit || at !== undefined && previous.lastUpdatedAt !== undefined && at < previous.lastUpdatedAt) return false;
    this.retired.delete(id);
    this.agents.set(id, { ...previous, status: "unknown" });
    this.retiredTurns.set(id, new Set([previous.turnId]));
    return true;
  }

  trimHistory(): string[] {
    const terminal = [...this.agents.values()].filter(agent => agent.id !== this.rootId && !isActiveAgent(agent) && (agent.status !== "unknown" || agent.error))
      .sort((a, b) => (b.completedAt ?? b.lastUpdatedAt ?? 0) - (a.completedAt ?? a.lastUpdatedAt ?? 0));
    const keep = new Set([...this.agents.values()].filter(agent => agent.id === this.rootId || isActiveAgent(agent) || (agent.status === "unknown" && !agent.error)).map(agent => agent.id));
    for (const agent of terminal.slice(0, this.recentLimit)) keep.add(agent.id);
    // 活动后代的祖先仍用于连接树；它们受总安全上限约束。
    for (const id of keep) {
      const parent = this.agents.get(id)?.parentId;
      if (parent && this.agents.has(parent)) keep.add(parent);
    }
    const removed: string[] = [];
    for (const agent of terminal) if (!keep.has(agent.id)) {
      this.agents.delete(agent.id);
      this.retiredTurns.delete(agent.id);
      removed.push(agent.id);
      this.retired.set(agent.id, { id: agent.id, parentId: agent.parentId, isSubagent: agent.isSubagent, name: agent.name,
        agentPath: agent.agentPath, agentType: agent.agentType, turnId: agent.turnId, lastUpdatedAt: agent.lastUpdatedAt });
      if (this.retired.size > this.limit * 4) this.retired.delete(this.retired.keys().next().value!);
    }
    return removed;
  }

  private issue(message: string): void {
    if (this.issues.size < 49 || this.issues.has(message)) this.issues.add(message);
    else this.issues.add(t("更多代理关系诊断已省略；请检查原始来源"));
  }
}
