import type { AgentStatus } from "./AgentState.js";

export interface NormalizedAgentEvent {
  type: "agent-discovered" | "agent-status" | "agent-call";
  agentId: string;
  parentId?: string;
  isSubagent?: boolean;
  name?: string;
  agentPath?: string;
  agentType?: string;
  status?: AgentStatus;
  turnId?: string;
  at?: number;
  callId?: string;
  operation?: "spawn" | "wait";
  source: "rollout" | "app-server";
}
