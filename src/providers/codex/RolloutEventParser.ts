import { t } from "../../i18n/Messages.js";
import type { HudEvent } from "../../core/HudEvent.js";
import type { TokenUsage } from "../../core/HudState.js";
import { record, type CodexDiagnostic } from "./Diagnostics.js";
import { RateLimitParser } from "./RateLimitParser.js";
import { ToolEventParser } from "./ToolEventParser.js";
import { AgentEventParser } from "./AgentEventParser.js";
import { SkillEventParser } from "./SkillEventParser.js";
import { PlanEventParser } from "./PlanEventParser.js";

export interface RolloutDetections {
  tokenCount: boolean;
  contextWindow: boolean;
  rateLimits: boolean;
  tools: boolean;
  activity: boolean;
  agents?: boolean;
  mcp?: boolean;
  skills?: boolean;
  plan?: boolean;
  planMode?: boolean;
  planUnverified?: boolean;
}

export interface RolloutParseResult {
  events: HudEvent[];
  detections: RolloutDetections;
  diagnostics: CodexDiagnostic[];
  unknown?: boolean;
}

function timestamp(value: unknown): number | undefined {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T/u.test(value)) return undefined;
  const time = Date.parse(value);
  return Number.isFinite(time) && time >= 0 ? time : undefined;
}

export class RolloutEventParser {
  private readonly rateLimits = new RateLimitParser();
  private readonly tools = new ToolEventParser();
  private readonly agents = new AgentEventParser();
  private readonly skills = new SkillEventParser();
  private readonly plans = new PlanEventParser();
  private ordinal = 0;
  private usageModel?: string;
  private usageModelOrdinal = 0;
  private usageAgentId?: string;

  reset(): void { this.agents.reset(); this.plans.reset(); this.ordinal = 0; this.usageModel = undefined; this.usageModelOrdinal = 0; this.usageAgentId = undefined; }

  parse(line: string, lineNumber?: number): RolloutParseResult {
    const result: RolloutParseResult = { events: [], detections: { tokenCount: false, contextWindow: false, rateLimits: false, tools: false, activity: false }, diagnostics: [] };
    if (!line.trim()) return result;
    const ordinal = lineNumber ?? this.ordinal + 1;
    this.ordinal = Math.max(this.ordinal, ordinal);
    const invalid = (field: string) => {
      result.diagnostics.push({ code: "invalid-event-field", severity: "error", message: t("rollout 字段 {0} 无效", field), line: lineNumber });
    };
    const text = (value: unknown, field: string): string | undefined => {
      if (value == null) return undefined;
      if (typeof value === "string" && value.trim().length > 0 && value.length <= 512) return value.trim();
      invalid(field);
      return undefined;
    };
    const number = (value: unknown, field: string, positive = false): number | undefined => {
      if (value == null) return undefined;
      if (typeof value === "number" && Number.isSafeInteger(value) && value >= (positive ? 1 : 0)) return value;
      invalid(field);
      return undefined;
    };
    const usage = (value: unknown, field: string): TokenUsage | undefined => {
      if (value == null) return undefined;
      const source = record(value);
      if (!source) { invalid(field); return undefined; }
      const normalized: TokenUsage = {};
      const fields = {
        input_tokens: "inputTokens", output_tokens: "outputTokens", cached_input_tokens: "cachedInputTokens",
        reasoning_output_tokens: "reasoningOutputTokens", total_tokens: "totalTokens",
        cache_write_input_tokens: "cacheWriteInputTokens",
      } as const;
      for (const [raw, key] of Object.entries(fields)) {
        const value = number(source[raw], `${field}.${raw}`);
        if (value !== undefined) normalized[key] = value;
      }
      return Object.keys(normalized).length ? normalized : undefined;
    };

    let root: Record<string, unknown> | undefined;
    try { root = record(JSON.parse(line)); }
    catch {
      result.diagnostics.push({ code: "invalid-json", severity: "error", message: t("JSONL 行不是有效的 JSON，已跳过该行"), line: lineNumber });
      return result;
    }
    if (!root || typeof root.type !== "string") { invalid("type"); return result; }
    const at = timestamp(root.timestamp);
    if (root.timestamp != null && at === undefined) invalid("timestamp");
    const payload = record(root.payload);
    const owner = this.agents.getThreadId();
    const explicitThread = payload?.thread_id ?? record(payload?.internal_chat_message_metadata_passthrough)?.thread_id;
    if (owner && typeof explicitThread === "string" && explicitThread !== owner) return result;
    if (["session_meta", "turn_context", "event_msg", "compacted"].includes(root.type) && !payload) {
      invalid("payload");
      return result;
    }

    if (root.type === "session_meta" && payload) {
      const id = text(payload.id, "session_meta.id");
      if (!id) { if (payload.id == null) invalid("session_meta.id"); return result; }
      const startedAt = timestamp(payload.timestamp);
      if (payload.timestamp != null && startedAt === undefined) invalid("session_meta.timestamp");
      result.events.push({ type: "session", id, startedAt: startedAt ?? at, version: text(payload.cli_version, "session_meta.cli_version"), at });
    } else if (root.type === "turn_context" && payload) {
      const model = text(payload.model, "turn_context.model");
      if (ordinal >= this.usageModelOrdinal) { this.usageModel = model; this.usageModelOrdinal = ordinal; }
      result.events.push({ type: "model", model, reasoningEffort: text(payload.effort, "turn_context.effort"), at, ordinal });
    } else if (root.type === "compacted") {
      result.events.push({ type: "context-compacted", at, ordinal });
    } else if (root.type === "event_msg" && payload?.type === "task_started") {
      const contextWindow = number(payload.model_context_window, "task_started.model_context_window", true);
      let startedAt = number(payload.started_at, "task_started.started_at");
      if (startedAt !== undefined && startedAt > 8_640_000_000_000) {
        invalid("task_started.started_at");
        startedAt = undefined;
      }
      const activityAt = startedAt === undefined ? at : Math.max(at ?? 0, startedAt * 1000);
      result.detections.contextWindow = contextWindow !== undefined;
      result.detections.activity = true;
      result.events.push({ type: "turn-started", id: text(payload.turn_id, "task_started.turn_id"), contextWindow, at: activityAt });
    } else if (root.type === "event_msg" && (payload?.type === "task_complete" || payload?.type === "turn_aborted")) {
      result.detections.activity = true;
      result.events.push({ type: payload.type === "task_complete" ? "turn-completed" : "turn-aborted",
        id: text(payload.turn_id, `${payload.type}.turn_id`), at });
    } else if (root.type === "event_msg" && payload?.type === "token_count") {
      result.detections.tokenCount = true;
      const info = record(payload.info);
      if (payload.info != null && !info) invalid("token_count.info");
      if (info) {
        const contextWindow = number(info.model_context_window, "token_count.info.model_context_window", true);
        result.detections.contextWindow = contextWindow !== undefined;
        if (ordinal < this.usageModelOrdinal) result.diagnostics.push({ code: "usage-model-order", severity: "warning",
          message: t("用量事件早于当前模型记录，请求模型保持未知"), line: lineNumber });
        result.events.push({ type: "tokens", total: usage(info.total_token_usage, "total_token_usage"),
          last: usage(info.last_token_usage, "last_token_usage"), contextWindow, at, ordinal,
          threadId: owner, agentId: this.usageAgentId, model: ordinal >= this.usageModelOrdinal ? this.usageModel : undefined, cacheWriteSemantics: "unverified" });
      }
      if (Object.hasOwn(payload, "rate_limits")) {
        const limits = this.rateLimits.parse(payload.rate_limits, lineNumber);
        result.detections.rateLimits = limits.detected;
        result.diagnostics.push(...limits.diagnostics);
        result.events.push({ type: "quota", quota: limits.quota, at, ordinal });
      }
    }
    const plans = this.plans.parse(root, at, ordinal);
    result.events.push(...plans.events);
    result.diagnostics.push(...plans.diagnostics);
    if (plans.events.some(event => event.type !== "plan-mode")) result.detections.plan = true;
    if (plans.events.some(event => event.type === "plan-mode")) result.detections.planMode = true;
    if (plans.unverified) result.detections.planUnverified = true;
    const tools = this.tools.parse(root, at, line, lineNumber);
    // 明确的参数失败替换通用成功分类，避免重复回执的时间戳制造虚假的成功终态。
    result.events.push(...tools.events.filter(event => event.type !== "tool-completed"
      || !plans.toolResults.some(result => result.toolId === event.toolId)));
    result.events.push(...plans.toolResults);
    result.diagnostics.push(...tools.diagnostics);
    result.detections.tools = tools.detected;
    result.detections.activity ||= tools.detected;
    if (tools.events.some(event => event.mcp)) result.detections.mcp = true;
    const skills = this.skills.parse(root, lineNumber);
    result.events.push(...skills.events);
    result.diagnostics.push(...skills.diagnostics);
    if (skills.events.length) result.detections.skills = true;
    const agents = this.agents.parse(root, at, lineNumber);
    const discovered = agents.events.find(event => event.type === "agent-discovered");
    if (discovered) this.usageAgentId = discovered.isSubagent ? discovered.agentId : undefined;
    result.events.push(...agents.events);
    result.diagnostics.push(...agents.diagnostics);
    result.detections.agents = agents.detected;
    result.unknown = !result.events.length && !result.diagnostics.length;
    if (!result.events.length && at !== undefined) result.events.push({ type: "activity", at });
    return result;
  }
}
