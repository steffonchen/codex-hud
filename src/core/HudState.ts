import type { AgentStatus, AgentSummary } from "./AgentState.js";
import type { McpSummary } from "./McpState.js";
import type { McpToolReference } from "./McpToolState.js";
import type { SkillSummary } from "./SkillState.js";
import type { PlanSummary } from "./PlanState.js";
import type { UsageEconomicsState } from "./usage/UsageState.js";
import type { QuotaState } from "./usage/QuotaTracker.js";
import type { DataSourceState } from "./source/DataSource.js";
export type { AgentStatus } from "./AgentState.js";

export interface TokenUsage {
  inputTokens?: number;
  outputTokens?: number;
  cachedInputTokens?: number;
  cacheWriteInputTokens?: number;
  reasoningOutputTokens?: number;
  totalTokens?: number;
}

export interface ContextUsage {
  usedTokens?: number;
  contextWindow?: number;
  remainingTokens?: number;
  usedPercent?: number;
}

export interface RateLimitWindow {
  usedPercent?: number;
  windowDurationMins?: number;
  resetsAt?: number;
}

export type ToolStatus = "pending" | "running" | "completed" | "failed" | "cancelled" | "unknown";

export interface ToolActivity {
  id: string;
  name: string;
  type?: string;
  status: ToolStatus;
  startedAt?: number;
  completedAt?: number;
  durationMs?: number;
  description?: string;
  inputSummary?: string;
  outputSummary?: string;
  error?: string;
  turnId?: string;
  mcp?: McpToolReference;
}

export interface ActivityState {
  status: "running" | "waiting" | "completed" | "idle" | "unknown";
  label?: string;
  description?: string;
  startedAt?: number;
  completedAt?: number;
  durationMs?: number;
  toolId?: string;
  toolType?: string;
  toolStatus?: ToolStatus;
  mcp?: McpToolReference;
}

export interface AgentNode {
  id: string;
  parentId?: string;
  status: AgentStatus;
  model?: string;
  reasoningEffort?: string;
  role?: string;
  startedAt?: number;
  endedAt?: number;
  tokens?: TokenUsage;
  context?: ContextUsage;
  children?: AgentNode[];
}

export interface PlanItem {
  text: string;
  status: "pending" | "in_progress" | "completed";
}

export interface HudState {
  dataSources?: DataSourceState;
  model?: string;
  reasoningEffort?: string;
  codexVersion?: string;
  fastMode?: boolean;

  activity?: ActivityState;

  context?: ContextUsage & TokenUsage;
  tokenUsage?: TokenUsage;
  usage?: UsageEconomicsState;

  quota?: QuotaState;

  session?: {
    id?: string;
    startedAt?: number;
    durationMs?: number;
    lastActivityAt?: number;
    turnCount?: number;
  };

  tools?: {
    active?: ToolActivity[];
    recent?: ToolActivity[];
    counts?: Record<string, number>;
  };

  // 归一化后的根节点数组，子节点由 children 承载；parentId 用于来源关联。
  agents?: AgentNode[];
  agentSummary?: AgentSummary;

  plan?: {
    completed?: number;
    total?: number;
    items?: PlanItem[];
  };
  planSummary?: PlanSummary;

  git?: {
    cwd?: string;
    branch?: string;
    dirty?: boolean;
    ahead?: number;
    behind?: number;
  };

  mcp?: Array<{
    name: string;
    status: "connected" | "connecting" | "failed" | "disabled";
    toolCount?: number;
  }>;
  mcpSummary?: McpSummary;

  skills?: Array<{
    name: string;
    enabled: boolean;
  }>;
  skillSummary?: SkillSummary;

  cost?: {
    amount: number;
    currency: string;
    estimated?: boolean;
  };
}

export const emptyHudState = (): HudState => ({
  tools: { active: [], recent: [], counts: {} },
  agents: [],
});
