export const MAX_PLAN_STEPS = 256;
export const MAX_PLAN_TEXT = 64 * 1024;
export const MAX_PLAN_EVENTS = 20;

export type PlanSource = "rollout" | "app-server";
export type PlanStepStatus = "pending" | "in_progress" | "completed" | "failed" | "cancelled" | "unknown";
export type PlanStatus = "idle" | "draft" | "approved" | "executing" | "completed" | "failed" | "cancelled" | "unknown";
export type PlanEvidence = "available" | "unsupported" | "not-observed" | "disabled" | "unavailable" | "partial";

export interface PlanStep {
  id: string;
  title: string;
  status: PlanStepStatus;
  position: number;
}

export interface PlanState {
  planId: string;
  threadId: string;
  turnId?: string;
  source: PlanSource;
  status: PlanStatus;
  steps: PlanStep[];
  counts: Record<PlanStepStatus, number>;
  currentStepId?: string;
  currentStepPosition?: number;
  completedCount: number;
  totalCount: number;
  progressPercent?: number;
  explanation?: string;
  createdAt?: number;
  updatedAt?: number;
  ordinal: number;
}

export interface PlanModeState {
  active: boolean;
  threadId: string;
  turnId?: string;
  updatedAt?: number;
}

export interface PlanProposalState {
  itemId: string;
  threadId: string;
  turnId: string;
  source: PlanSource;
  status: "streaming" | "ready";
  // 流式片段可能把凭据拆开；只在收到权威完成文本后向快照暴露脱敏正文。
  text?: string;
  streamedCharacters: number;
  truncated: boolean;
  updatedAt?: number;
  ordinal: number;
}

export interface PlanCapability {
  available: boolean;
  planEvents: PlanEvidence;
  stepStatuses: PlanEvidence;
  planMode: PlanEvidence;
  planDelta: PlanEvidence;
  approvalState: PlanEvidence;
  completionState: PlanEvidence;
  agentAssociation: PlanEvidence;
}

export interface PlanEventRecord {
  eventId: string;
  type: string;
  source: PlanSource;
  ordinal: number;
  at?: number;
  stepCount?: number;
}

export interface PlanSummary {
  execution?: PlanState;
  proposal?: PlanProposalState;
  mode?: PlanModeState;
  capability: PlanCapability;
  eventCount: number;
  events: PlanEventRecord[];
  issues: string[];
}

export function emptyPlanCapability(): PlanCapability {
  return { available: false, planEvents: "not-observed", stepStatuses: "not-observed", planMode: "not-observed",
    planDelta: "not-observed", approvalState: "not-observed", completionState: "not-observed", agentAssociation: "not-observed" };
}

export function visibleProposal(summary: PlanSummary): PlanProposalState | undefined {
  return summary.proposal && (!summary.execution || summary.proposal.ordinal > summary.execution.ordinal)
    ? summary.proposal : undefined;
}
