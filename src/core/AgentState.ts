import type { ActivityState, ContextUsage, TokenUsage } from "./HudState.js";
import type { AgentTreeNode } from "./AgentTree.js";
import type { PlanState } from "./PlanState.js";
import type { UsageEconomicsState } from "./usage/UsageState.js";

export type AgentStatus = "starting" | "running" | "waiting" | "completed" | "failed" | "cancelled" | "unknown";

export interface AgentState {
  id: string;
  parentId?: string;
  isSubagent?: boolean;
  name?: string;
  agentPath?: string;
  agentType?: string;
  model?: string;
  reasoningEffort?: string;
  status: AgentStatus;
  turnId?: string;
  startedAt?: number;
  completedAt?: number;
  lastUpdatedAt?: number;
  tokens?: TokenUsage;
  usage?: Omit<UsageEconomicsState, "recentRecords">;
  context?: ContextUsage;
  activity?: ActivityState;
  plan?: PlanState;
  error?: string;
}

export interface AgentCapability {
  enabled: boolean | null;
  eventSupport: boolean;
  correlation: "strong" | "partial" | "none";
  nestedSupport: boolean;
  contextSupport: boolean;
  tokenSupport: boolean;
}

export interface AgentSummary {
  rootId?: string;
  count: number;
  activeCount: number;
  activeSubagentCount: number;
  completedCount: number;
  failedCount: number;
  cancelledCount: number;
  omittedCount: number;
  tree: AgentTreeNode[];
  orphans: AgentTreeNode[];
  issues: string[];
  capability: AgentCapability;
  lastUpdatedAt?: number;
}

export const isActiveAgent = (agent: Pick<AgentState, "status">): boolean =>
  ["starting", "running", "waiting"].includes(agent.status);
