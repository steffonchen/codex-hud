import { t } from "../i18n/Messages.js";
import { createHash } from "node:crypto";
import type { NormalizedPlanEvent, PlanDeltaEvent, PlanEventMetadata, PlanStepInput } from "./PlanEvents.js";
import { MAX_PLAN_EVENTS, MAX_PLAN_STEPS, MAX_PLAN_TEXT, emptyPlanCapability,
  type PlanModeState, type PlanProposalState, type PlanState, type PlanStepStatus, type PlanSummary } from "./PlanState.js";
import { redactSummary, redactText } from "./Redaction.js";

const statuses: PlanStepStatus[] = ["pending", "in_progress", "completed", "failed", "cancelled", "unknown"];
const counts = (): PlanState["counts"] => ({ pending: 0, in_progress: 0, completed: 0, failed: 0, cancelled: 0, unknown: 0 });
const validId = (value: string): boolean => typeof value === "string" && !!value.trim() && value.length <= 512;
const observedTime = (at?: number): number | undefined => at !== undefined && Number.isFinite(at) && at >= 0 ? at : undefined;

export class PlanTracker {
  private threadId?: string;
  private execution?: PlanState;
  private mode?: PlanModeState;
  private proposal?: PlanProposalState;
  private draft = "";
  private last = new Map<string, number>();
  private seen = new Set<string>();
  private events: PlanSummary["events"] = [];
  private issues = new Set<string>();
  private eventCount = 0;
  private planObserved = false;
  private stepsObserved = false;
  private deltaObserved = false;
  private approvalObserved = false;
  private completionObserved = false;

  reset(): void {
    this.threadId = undefined; this.execution = undefined; this.mode = undefined; this.proposal = undefined; this.draft = "";
    this.last.clear(); this.seen.clear(); this.events = []; this.issues.clear(); this.eventCount = 0;
    this.planObserved = false; this.stepsObserved = false; this.deltaObserved = false; this.approvalObserved = false; this.completionObserved = false;
  }

  setThread(id: string): void {
    if (this.threadId && this.threadId !== id) this.reset();
    this.threadId = id;
  }

  startTurn(id?: string): void {
    if (this.mode && this.mode.turnId !== id) this.mode = undefined;
  }

  apply(event: NormalizedPlanEvent): void {
    if (event.type === "plan-delta") { this.applyDelta(event); return; }
    if (event.type === "plan-updated" && !this.validSteps(event.steps)) return;
    if (event.type === "plan-proposed" && !event.complete && this.proposal?.itemId === event.itemId
      && this.proposal.turnId === event.turnId && this.proposal.status === "ready") return;
    const scope = event.type === "plan-mode" ? "mode" : event.type === "plan-proposed" ? "proposal" : "execution";
    if (!this.accept(event, scope)) return;
    const at = observedTime(event.at);
    if (event.type === "plan-mode") {
      this.mode = { active: event.active, threadId: event.threadId, turnId: event.turnId, updatedAt: at };
    } else if (event.type === "plan-updated") {
      const plan = this.base(event);
      plan.steps = event.steps.map((step, position) => ({ id: `${plan.planId}:${position}`, position,
        title: redactSummary(step.title), status: step.status }));
      plan.counts = counts();
      for (const step of plan.steps) plan.counts[step.status]++;
      plan.completedCount = plan.counts.completed;
      plan.totalCount = plan.steps.length;
      plan.progressPercent = plan.totalCount ? plan.completedCount / plan.totalCount * 100 : undefined;
      const current = plan.steps.find(step => step.status === "in_progress");
      plan.currentStepId = current?.id;
      plan.currentStepPosition = current?.position;
      plan.explanation = event.explanation === undefined ? undefined : redactSummary(event.explanation, 1000);
      plan.status = !plan.totalCount ? "idle" : plan.counts.failed ? "failed" : plan.counts.unknown ? "unknown"
        : plan.completedCount === plan.totalCount ? "completed" : plan.counts.in_progress ? "executing"
        : plan.counts.cancelled ? "cancelled" : plan.counts.pending === plan.totalCount ? "draft" : "unknown";
      if (plan.counts.in_progress > 1) this.issue(t("来源包含多个进行中的步骤，按原始位置展示，不推断唯一当前步骤"));
      this.execution = plan;
      this.planObserved = true;
      this.stepsObserved = true;
      this.completionObserved ||= plan.status === "completed";
    } else if (event.type === "plan-proposed") {
      const same = this.proposal?.itemId === event.itemId && this.proposal.turnId === event.turnId;
      const clean = event.complete ? redactText(event.text) : undefined;
      this.draft = event.complete ? "" : event.text.slice(0, MAX_PLAN_TEXT);
      this.proposal = { itemId: event.itemId, threadId: event.threadId, turnId: event.turnId, source: event.source,
        status: event.complete ? "ready" : "streaming", text: clean?.slice(0, MAX_PLAN_TEXT),
        streamedCharacters: same ? this.proposal!.streamedCharacters : 0,
        truncated: event.text.length > MAX_PLAN_TEXT || (!event.complete && same && this.proposal!.truncated), updatedAt: at, ordinal: event.ordinal };
      if (this.proposal.truncated) this.issue(t("提案超过文本安全上限，正文不完整"));
      this.planObserved = true;
    } else if (event.type === "plan-status") {
      this.execution = { ...this.base(event), status: event.status };
      this.planObserved = true;
      this.approvalObserved ||= event.status === "approved";
      this.completionObserved ||= event.status === "completed";
      if (event.status === "completed" && this.execution.completedCount !== this.execution.totalCount) {
        this.issue(t("计划完成事件与步骤状态不一致，保留来源中的步骤和实际完成比例"));
      }
    } else if (event.type === "plan-cleared") {
      this.execution = undefined;
      const key = `${event.source}:proposal`;
      if (event.ordinal >= (this.last.get(key) ?? 0)) { this.proposal = undefined; this.draft = ""; this.last.set(key, event.ordinal); }
      this.planObserved = true;
    }
  }

  applyDelta(event: PlanDeltaEvent): void {
    if (this.proposal?.itemId === event.itemId && this.proposal.turnId === event.turnId && this.proposal.status === "ready") return;
    if (!this.accept(event, "proposal")) return;
    const same = this.proposal?.itemId === event.itemId && this.proposal.turnId === event.turnId;
    if (!same) this.draft = "";
    const length = this.draft.length + event.delta.length;
    this.draft = (this.draft + event.delta).slice(0, MAX_PLAN_TEXT);
    this.proposal = { itemId: event.itemId, threadId: event.threadId, turnId: event.turnId, source: event.source, status: "streaming",
      streamedCharacters: Math.min(Number.MAX_SAFE_INTEGER, (same ? this.proposal!.streamedCharacters : 0) + event.delta.length),
      truncated: length > MAX_PLAN_TEXT || (same && this.proposal!.truncated), updatedAt: observedTime(event.at), ordinal: event.ordinal };
    if (this.proposal.truncated) this.issue(t("提案流超过文本安全上限，片段未全部保留；最终文本单独处理"));
    this.planObserved = true; this.deltaObserved = true;
  }

  getSummary(): PlanSummary {
    const capability = emptyPlanCapability();
    capability.available = this.planObserved;
    if (this.planObserved) capability.planEvents = "available";
    if (this.stepsObserved) capability.stepStatuses = this.execution?.counts.unknown ? "partial" : "available";
    if (this.mode) capability.planMode = "available";
    if (this.deltaObserved) capability.planDelta = "available";
    if (this.approvalObserved) capability.approvalState = "available";
    if (this.completionObserved) capability.completionState = "available";
    return structuredClone({ execution: this.execution, proposal: this.proposal, mode: this.mode, capability,
      eventCount: this.eventCount, events: this.events, issues: [...this.issues] });
  }

  private base(event: PlanEventMetadata): PlanState {
    const at = observedTime(event.at);
    return { planId: `plan-${createHash("sha256").update(event.threadId).digest("hex").slice(0, 24)}`,
      threadId: event.threadId, status: "idle", steps: [], counts: counts(), completedCount: 0, totalCount: 0,
      ...this.execution, source: event.source, turnId: event.turnId, createdAt: this.execution?.createdAt ?? at,
      updatedAt: at, ordinal: event.ordinal };
  }

  private accept(event: NormalizedPlanEvent, scope: string): boolean {
    if (!validId(event.eventId) || !validId(event.threadId) || !Number.isSafeInteger(event.ordinal) || event.ordinal < 1) {
      this.issue(t("计划事件缺少有效身份或来源顺序，未采用该事件")); return false;
    }
    if (this.threadId && this.threadId !== event.threadId) { this.issue(t("计划线程与当前会话不一致，未采用该事件")); return false; }
    this.threadId ??= event.threadId;
    const key = `${event.source}:${scope}`;
    if (event.ordinal <= (this.last.get(key) ?? 0)) return false;
    this.last.set(key, event.ordinal);
    if (this.seen.has(event.eventId)) return false;
    this.seen.add(event.eventId);
    if (this.seen.size > 256) this.seen.delete(this.seen.values().next().value!);
    this.eventCount++;
    this.events.push({ eventId: event.eventId, type: event.type, source: event.source, ordinal: event.ordinal,
      at: observedTime(event.at), stepCount: event.type === "plan-updated" ? event.steps.length : undefined });
    if (this.events.length > MAX_PLAN_EVENTS) this.events.shift();
    return true;
  }

  private validSteps(steps: PlanStepInput[]): boolean {
    if (!Array.isArray(steps) || steps.length > MAX_PLAN_STEPS || steps.some(step => !step || typeof step.title !== "string"
      || !step.title.trim() || step.title.length > 4096 || !statuses.includes(step.status))) {
      this.issue(t("计划步骤无效或超过安全上限，保留上次确认的清单")); return false;
    }
    return true;
  }

  private issue(message: string): void { if (this.issues.size < 20) this.issues.add(message); }
}
