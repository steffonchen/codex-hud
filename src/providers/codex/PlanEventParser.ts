import { t } from "../../i18n/Messages.js";
import { createHash } from "node:crypto";
import type { NormalizedPlanEvent, PlanStepInput } from "../../core/PlanEvents.js";
import type { ToolEvent } from "../../core/HudEvent.js";
import { MAX_PLAN_STEPS, MAX_PLAN_TEXT } from "../../core/PlanState.js";
import { redactSummary, redactText } from "../../core/Redaction.js";
import { record, type CodexDiagnostic } from "./Diagnostics.js";

interface PlanParseResult {
  events: NormalizedPlanEvent[];
  diagnostics: CodexDiagnostic[];
  toolResults: ToolEvent[];
  unverified: boolean;
}

interface PlanCall {
  threadId: string;
  turnId?: string;
  ordinal: number;
  at?: number;
  steps?: PlanStepInput[];
  explanation?: string;
}

interface PlanReturn { status: "success" | "failed" | "unknown"; at?: number; }
const id = (value: unknown): string | undefined => typeof value === "string" && !!value.trim() && value.length <= 512 ? value : undefined;
const identity = (value: string): string => `plan-event-${createHash("sha256").update(value).digest("hex").slice(0, 24)}`;
const empty = (): PlanParseResult => ({ events: [], diagnostics: [], toolResults: [], unverified: false });

function steps(value: unknown, camelCase: boolean): PlanStepInput[] | undefined {
  if (!Array.isArray(value) || value.length > MAX_PLAN_STEPS) return undefined;
  const result: PlanStepInput[] = [];
  for (const raw of value) {
    const item = record(raw);
    if (!item || typeof item.step !== "string" || !item.step.trim() || item.step.length > 4096) return undefined;
    const status = item.status === "pending" || item.status === "completed" ? item.status
      : item.status === (camelCase ? "inProgress" : "in_progress") ? "in_progress" : undefined;
    if (!status) return undefined;
    result.push({ title: redactSummary(item.step), status });
  }
  return result;
}

function output(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  if (!Array.isArray(value) || value.length !== 1) return undefined;
  const item = record(value[0]);
  return item?.type === "input_text" && typeof item.text === "string" ? item.text : undefined;
}

export class PlanEventParser {
  private threadId?: string;
  private turnId?: string;
  private calls = new Map<string, PlanCall>();
  private returns = new Map<string, PlanReturn>();
  private settled = new Map<string, ToolEvent | undefined>();

  reset(): void { this.threadId = undefined; this.turnId = undefined; this.calls.clear(); this.returns.clear(); this.settled.clear(); }

  parse(root: Record<string, unknown>, at: number | undefined, ordinal: number): PlanParseResult {
    const result = empty();
    const payload = record(root.payload);
    if (!payload) return result;
    const warn = (code: string, message: string) => result.diagnostics.push({ code, message, severity: "warning", line: ordinal });
    if (root.type === "session_meta") {
      const thread = id(payload.id);
      if (thread !== this.threadId) this.reset();
      this.threadId = thread;
      return result;
    }
    const explicitThread = payload.thread_id ?? record(payload.internal_chat_message_metadata_passthrough)?.thread_id;
    if (this.threadId && explicitThread !== undefined && explicitThread !== this.threadId) return result;
    if (root.type === "turn_context" || (root.type === "event_msg" && payload.type === "task_started")) {
      this.turnId = id(payload.turn_id) ?? (root.type === "turn_context" ? this.turnId : undefined);
      const mode = root.type === "turn_context" ? record(payload.collaboration_mode)?.mode : undefined;
      if (mode !== undefined && mode !== "plan" && mode !== "default") warn("plan-mode-schema", t("计划模式字段无法识别，模式保持未确认"));
      if (this.threadId && (mode === "plan" || mode === "default")) result.events.push({ type: "plan-mode", active: mode === "plan",
        eventId: identity(`${this.threadId}:mode:${ordinal}`), threadId: this.threadId, turnId: this.turnId, source: "rollout", at, ordinal });
      return result;
    }
    if (root.type === "event_msg" && (["plan_update", "plan_delta", "PlanUpdate", "PlanDelta"].includes(String(payload.type))
      || ["Plan", "plan"].includes(String(record(payload.item)?.type)))) {
      warn("plan-source-unverified", t("检测到尚未核验的 rollout 计划事件结构，未据此更新状态"));
      result.unverified = true;
      return result;
    }
    if (root.type !== "response_item") return result;
    const callId = id(payload.call_id);
    if (payload.type === "function_call" && payload.name === "update_plan" && payload.namespace == null) {
      if (!this.threadId || !callId) { warn("plan-call-identity", t("计划更新缺少线程或调用身份，无法确认归属")); return result; }
      if (this.settled.has(callId) || this.calls.has(callId)) return result;
      let args: Record<string, unknown> | undefined;
      if (typeof payload.arguments === "string" && payload.arguments.length <= 128 * 1024) {
        try { args = record(JSON.parse(payload.arguments)); }
        catch { /* 下方统一报告固定字段诊断，避免泄露参数原文。 */ }
      }
      const parsed = steps(args?.plan, false);
      const validExplanation = args?.explanation == null || typeof args.explanation === "string";
      if (!parsed || !validExplanation) warn("plan-call-schema", t("计划更新参数无效或超过安全上限，保留上次确认的清单"));
      const call: PlanCall = { threadId: this.threadId, turnId: this.turnId, at, ordinal,
        steps: validExplanation ? parsed : undefined,
        explanation: typeof args?.explanation === "string" ? redactSummary(args.explanation, 1000) : undefined };
      this.calls.set(callId, call);
      if (this.calls.size > 128) {
        this.calls.delete(this.calls.keys().next().value!);
        warn("plan-correlation-limit", t("计划更新超过 128 项待确认上限，较早调用不再关联"));
      }
      const returned = this.returns.get(callId);
      if (returned) this.confirm(callId, call, returned, result, ordinal);
    } else if (payload.type === "function_call_output" && callId) {
      if (this.settled.has(callId)) {
        const failed = this.settled.get(callId);
        if (failed) result.toolResults.push({ ...failed });
        return result;
      }
      const text = output(payload.output);
      const returned: PlanReturn = { status: text === "Plan updated" ? "success"
        : text?.startsWith("failed to parse function arguments:") ? "failed" : "unknown", at };
      const call = this.calls.get(callId);
      if (call) this.confirm(callId, call, returned, result, ordinal);
      else if (returned.status !== "unknown") {
        // 只保存分类与身份，不保存任意工具输出；支持带原始行顺序的先返回后调用记录。
        this.returns.set(callId, returned);
        if (this.returns.size > 256) this.returns.delete(this.returns.keys().next().value!);
      }
    }
    return result;
  }

  // 当前 CLI 离线 schema 的纯适配器；不创建连接、监听器或 App Server Provider。
  parseNotification(value: unknown, ordinal: number, at?: number): PlanParseResult {
    const result = empty();
    const notification = record(value);
    const method = notification?.method;
    if (!["turn/plan/updated", "item/plan/delta", "item/started", "item/completed"].includes(String(method))) return result;
    const params = record(notification?.params);
    const item = record(params?.item);
    if ((method === "item/started" || method === "item/completed") && item?.type !== "plan") return result;
    const invalid = () => { result.unverified = true; result.diagnostics.push({ code: "plan-notification-schema", severity: "error",
      message: t("计划通知缺少有效的身份、步骤或文本字段，未采用该通知") }); return result; };
    const threadId = id(params?.threadId);
    const turnId = id(params?.turnId);
    if (!threadId || !turnId || !Number.isSafeInteger(ordinal) || ordinal < 1) return invalid();
    const common = { threadId, turnId, ordinal, at, source: "app-server" as const,
      eventId: identity(`${threadId}:${turnId}:${method}:${ordinal}`) };
    if (method === "turn/plan/updated") {
      const parsed = steps(params?.plan, true);
      if (!parsed || (params?.explanation != null && typeof params.explanation !== "string")) return invalid();
      result.events.push({ ...common, type: "plan-updated", steps: parsed,
        explanation: typeof params?.explanation === "string" ? redactSummary(params.explanation, 1000) : undefined });
    } else if (method === "item/plan/delta") {
      const itemId = id(params?.itemId);
      if (!itemId || typeof params?.delta !== "string" || params.delta.length > MAX_PLAN_TEXT) return invalid();
      result.events.push({ ...common, type: "plan-delta", itemId, delta: params.delta });
    } else {
      const itemId = id(item?.id);
      if (!itemId || typeof item?.text !== "string" || item.text.length > MAX_PLAN_TEXT) return invalid();
      result.events.push({ ...common, type: "plan-proposed", itemId, text: method === "item/completed" ? redactText(item.text) : item.text,
        complete: method === "item/completed" });
    }
    return result;
  }

  private confirm(callId: string, call: PlanCall, returned: PlanReturn, result: PlanParseResult, line: number): void {
    const failed: ToolEvent | undefined = returned.status === "failed" ? { type: "tool-failed", toolId: callId, at: returned.at,
      resultSource: "call", turnId: call.turnId, error: t("计划更新参数校验失败"), outputSummary: t("计划未更新") } : undefined;
    this.calls.delete(callId); this.returns.delete(callId); this.settled.set(callId, failed);
    if (this.settled.size > 256) this.settled.delete(this.settled.keys().next().value!);
    if (returned.status === "success" && call.steps) {
      result.events.push({ type: "plan-updated", eventId: identity(`${call.threadId}:call:${callId}`), threadId: call.threadId,
        turnId: call.turnId, source: "rollout", at: returned.at ?? call.at, ordinal: call.ordinal, steps: call.steps, explanation: call.explanation });
    } else {
      result.diagnostics.push({ code: returned.status === "failed" ? "plan-update-rejected" : "plan-update-unconfirmed", severity: "warning", line,
        message: returned.status === "failed" ? t("计划更新参数被 Codex 拒绝，保留上次确认的清单") : t("计划更新未取得可识别的成功结果，保留上次确认的清单") });
      if (failed) result.toolResults.push({ ...failed });
    }
  }
}
