import type { HudEvent, ToolEvent } from "./HudEvent.js";
import { emptyHudState, type HudState } from "./HudState.js";
import { TokenTracker } from "./TokenTracker.js";
import { ToolTracker } from "./ToolTracker.js";
import { ActivityTracker } from "./ActivityTracker.js";
import { AgentTracker } from "./AgentTracker.js";
import { legacyAgentTree } from "./AgentTree.js";
import type { NormalizedAgentEvent } from "./AgentEvents.js";
import { McpTracker } from "./McpTracker.js";
import { SkillTracker } from "./SkillTracker.js";
import { PlanTracker } from "./PlanTracker.js";
import type { NormalizedPlanEvent } from "./PlanEvents.js";
import { TokenUsageTracker } from "./usage/TokenUsageTracker.js";
import { QuotaTracker } from "./usage/QuotaTracker.js";
import type { PricingProvider } from "./usage/PricingProvider.js";

export const MAX_RETAINED_TURNS = 2048;

export class HudStateReducer {
  readonly agents = new AgentTracker();
  readonly mcp = new McpTracker();
  readonly skills = new SkillTracker();
  readonly plans = new PlanTracker();
  private state: HudState = emptyHudState();
  private readonly tokens = new TokenTracker();
  private readonly usage: TokenUsageTracker;
  private readonly quota = new QuotaTracker();
  private usageObserved = false;
  private modelOrdinal?: number;
  private readonly turns = new Set<string>();
  private turnCount = 0;
  private turnHistoryLimited = false;
  private uncertainTurns = 0;
  private readonly tools = new ToolTracker();
  private readonly activity = new ActivityTracker();
  private currentTurn?: { id?: string; at?: number };

  constructor(private readonly trackAgents = true, pricing?: PricingProvider) { this.usage = new TokenUsageTracker({ pricing }); }

  reset(): void {
    this.state = emptyHudState();
    this.tokens.reset();
    this.usage.reset(); this.quota.reset(); this.usageObserved = false; this.modelOrdinal = undefined;
    this.turns.clear();
    this.turnCount = 0; this.turnHistoryLimited = false; this.uncertainTurns = 0;
    this.tools.reset();
    this.activity.reset();
    this.currentTurn = undefined;
    this.agents.reset();
    this.mcp.reset();
    this.skills.reset();
    this.plans.reset();
  }

  apply(event: HudEvent): void {
    if (event.type === "skills-listed") { this.skills.replaceCatalog(event.skills); return; }
    if (event.type.startsWith("plan-")) { this.plans.apply(event as NormalizedPlanEvent); return; }
    if (event.type.startsWith("agent-")) {
      if (this.trackAgents) this.agents.apply(event as NormalizedAgentEvent);
      return;
    }
    if (event.type === "session") {
      if (this.state.session?.id && this.state.session.id !== event.id) this.reset();
      this.state.session = { ...this.state.session, id: event.id,
        startedAt: this.state.session?.startedAt ?? event.startedAt };
      this.state.codexVersion = event.version;
      this.agents.setRoot(event.id);
      this.plans.setThread(event.id);
      this.usage.setThread(event.id);
    } else if (event.type === "model") {
      if (event.ordinal !== undefined && this.modelOrdinal !== undefined && event.ordinal < this.modelOrdinal) return;
      this.modelOrdinal = event.ordinal ?? this.modelOrdinal;
      if (this.state.model !== undefined && this.state.model !== event.model) this.state.context = undefined;
      this.state.model = event.model;
      this.state.reasoningEffort = event.reasoningEffort;
    } else if (event.type === "turn-started") {
      const seen = this.turns.has(event.id ?? "");
      const late = event.at !== undefined && this.currentTurn?.at !== undefined && event.at < this.currentTurn.at;
      if (seen && event.id !== this.currentTurn?.id) return;
      if (!seen && this.turnHistoryLimited && (event.at === undefined || this.currentTurn?.at === undefined)) { this.uncertainTurns++; return; }
      if (!seen && this.turnHistoryLimited && late) return;
      if (!seen && !late) {
        if (this.currentTurn) this.tools.endTurn(this.currentTurn.id, event.at);
        this.currentTurn = { id: event.id, at: event.at };
        this.plans.startTurn(event.id);
      }
      if (event.id && !seen) {
        this.turns.add(event.id);
        this.turnCount++;
        if (this.turns.size > MAX_RETAINED_TURNS) { this.turns.delete(this.turns.values().next().value!); this.turnHistoryLimited = true; }
        this.state.session = { ...this.state.session, turnCount: this.turnCount };
      }
      if (late) return;
      if (event.contextWindow !== undefined) this.updateContext(this.state.context?.usedTokens, event.contextWindow);
    } else if (event.type === "tokens") {
      this.usageObserved = true;
      if (this.usage.consume(event)) {
        if (event.total) this.tokens.update(event.total);
        else this.tokens.reset();
        this.state.tokenUsage = this.tokens.getCurrent();
        this.updateContext(event.last?.totalTokens, event.contextWindow);
      }
    } else if (event.type === "context-compacted") {
      if (this.usage.compact(event.ordinal, event.at)) this.updateContext(undefined, this.state.context?.contextWindow);
    } else if (event.type === "quota") {
      this.quota.apply(event.quota, event.ordinal, event.at);
    } else if (event.type === "turn-completed" || event.type === "turn-aborted") {
      this.tools.endTurn(event.id, event.at);
    } else if (event.type.startsWith("tool-")) {
      const tool = event as ToolEvent;
      if (tool.mcp) this.mcp.observeTool(tool.mcp, tool.at);
      this.tools.apply({ ...tool, turnId: tool.turnId ?? (tool.type === "tool-started" ? this.currentTurn?.id : undefined) });
    }
    this.activity.apply(event);
    if (event.at !== undefined) {
      this.state.session = { ...this.state.session, lastActivityAt: Math.max(this.state.session?.lastActivityAt ?? 0, event.at) };
    }
  }

  getState(now: number): HudState {
    const snapshot = structuredClone(this.state);
    snapshot.quota = this.quota.snapshot();
    if (this.usageObserved) {
      snapshot.usage = this.usage.snapshot();
      const cost = snapshot.usage.cost.sessionEstimatedCost;
      if (cost.value !== undefined && cost.currency) snapshot.cost = { amount: cost.value, currency: cost.currency, estimated: true };
    }
    const tools = this.tools.getState();
    snapshot.tools = { ...snapshot.tools, ...tools };
    snapshot.activity = this.activity.getState(tools);
    snapshot.mcpSummary = this.mcp.getSummary();
    snapshot.skillSummary = this.skills.getSummary();
    snapshot.planSummary = this.plans.getSummary();
    const execution = snapshot.planSummary.execution;
    if (execution) snapshot.plan = { completed: execution.completedCount, total: execution.totalCount };
    if (snapshot.session?.startedAt !== undefined) {
      snapshot.session.durationMs = Math.max(0, now - snapshot.session.startedAt);
    }
    if (this.trackAgents && snapshot.session?.id) {
      this.agents.updateThread(snapshot.session.id, snapshot);
      snapshot.agentSummary = this.agents.getSummary();
      if (snapshot.agentSummary.capability.eventSupport) snapshot.agents = legacyAgentTree([...snapshot.agentSummary.tree, ...snapshot.agentSummary.orphans]);
    }
    return snapshot;
  }

  getToolOverflowCount(): number { return this.tools.getOverflowCount(); }
  getUncertainToolStartCount(): number { return this.tools.getUncertainStartCount(); }
  getResourceCounts(): Record<string, number> { return { retainedTurns: this.turns.size, turnHistoryLimited: Number(this.turnHistoryLimited), uncertainTurns: this.uncertainTurns, ...this.agents.getResourceCounts() }; }

  private updateContext(usedTokens: number | undefined, contextWindow: number | undefined): void {
    if (usedTokens === undefined && contextWindow === undefined) { this.state.context = undefined; return; }
    // 最近快照可能是压缩后的估算值；累计 Token 只进入 tokenUsage。
    this.state.context = {
      usedTokens, contextWindow,
      remainingTokens: usedTokens !== undefined && contextWindow !== undefined ? Math.max(0, contextWindow - usedTokens) : undefined,
      usedPercent: usedTokens !== undefined && contextWindow !== undefined && contextWindow > 0 ? usedTokens / contextWindow * 100 : undefined,
    };
  }
}
