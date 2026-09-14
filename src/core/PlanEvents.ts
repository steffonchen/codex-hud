import type { PlanSource, PlanStatus, PlanStepStatus } from "./PlanState.js";

export interface PlanEventMetadata {
  eventId: string;
  threadId: string;
  turnId?: string;
  source: PlanSource;
  // rollout 使用物理调用行号；成功返回只确认该调用，不改变更新的原始顺序。
  ordinal: number;
  at?: number;
}

export interface PlanStepInput {
  title: string;
  status: PlanStepStatus;
}

export type PlanDeltaEvent = PlanEventMetadata & { type: "plan-delta"; itemId: string; turnId: string; delta: string };

export type NormalizedPlanEvent = PlanDeltaEvent | (PlanEventMetadata & (
  | { type: "plan-updated"; steps: PlanStepInput[]; explanation?: string }
  | { type: "plan-mode"; active: boolean }
  | { type: "plan-proposed"; itemId: string; turnId: string; text: string; complete: boolean }
  | { type: "plan-status"; status: Extract<PlanStatus, "approved" | "executing" | "completed" | "failed" | "cancelled"> }
  | { type: "plan-cleared" }
));
