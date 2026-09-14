import { t } from "../../i18n/Messages.js";
import type { NormalizedAgentEvent } from "../../core/AgentEvents.js";
import { agentIdentifier, parseAgentMetadata } from "./AgentMetadata.js";
import { record, type CodexDiagnostic } from "./Diagnostics.js";

export class AgentEventParser {
  private threadId?: string;
  private turnId?: string;
  private ignored = false;
  private waits = new Map<string, string | undefined>();
  private returned = new Set<string>();

  reset(): void { this.threadId = undefined; this.turnId = undefined; this.ignored = false; this.waits.clear(); this.returned.clear(); }
  getThreadId(): string | undefined { return this.threadId; }

  parse(root: Record<string, unknown>, at?: number, line?: number): {
    events: NormalizedAgentEvent[]; detected: boolean; diagnostics: CodexDiagnostic[];
  } {
    const result: { events: NormalizedAgentEvent[]; detected: boolean; diagnostics: CodexDiagnostic[] } = { events: [], detected: false, diagnostics: [] };
    const payload = record(root.payload);
    if (!payload) return result;
    const warn = (field: string) => result.diagnostics.push({ code: "agent-schema", severity: "warning", message: t("代理字段 {0} 缺失或冲突；关系未确认", field), line });
    if (root.type === "session_meta") {
      const meta = parseAgentMetadata(payload);
      if (!meta) { warn("session_meta.id"); return result; }
      this.threadId = meta.id;
      this.ignored = meta.subagent && !meta.taskAgent;
      if (this.ignored) return result;
      if (meta.relationConflict || (meta.taskAgent && !meta.parentId)) warn("parent_thread_id");
      result.detected = meta.taskAgent;
      result.events.push({ type: "agent-discovered", agentId: meta.id, parentId: meta.parentId,
        isSubagent: meta.taskAgent,
        name: meta.name, agentPath: meta.agentPath, agentType: meta.agentType, at, source: "rollout" });
    }
    if (!this.threadId || this.ignored) return result;
    const common = { agentId: this.threadId, at, source: "rollout" as const };
    if (root.type === "event_msg" && payload.type === "task_started") {
      if (agentIdentifier(payload.turn_id) !== this.turnId) this.waits.clear();
      this.turnId = agentIdentifier(payload.turn_id);
      result.events.push({ ...common, type: "agent-status", turnId: this.turnId, status: "running" });
    } else if (root.type === "event_msg" && ["task_complete", "turn_aborted"].includes(String(payload.type))) {
      result.events.push({ ...common, type: "agent-status", turnId: agentIdentifier(payload.turn_id),
        status: payload.type === "task_complete" ? "completed" : payload.reason === "interrupted" ? "cancelled" : "unknown" });
    } else if (root.type === "response_item" && payload.type === "function_call" && payload.namespace === "collaboration" && ["spawn_agent", "wait_agent"].includes(String(payload.name))) {
      result.detected = true;
      const callId = agentIdentifier(payload.call_id);
      if (!callId) { warn("call_id"); return result; }
      result.events.push({ ...common, type: "agent-call", callId, operation: payload.name === "spawn_agent" ? "spawn" : "wait" });
      if (payload.name === "wait_agent" && !this.returned.has(callId)) {
        if (this.waits.size >= 256) { this.waits.delete(this.waits.keys().next().value!); warn(t("wait 关联窗口")); }
        this.waits.set(callId, this.turnId);
        result.events.push({ ...common, type: "agent-status", turnId: this.turnId, status: "waiting" });
      }
    } else if (root.type === "response_item" && payload.type === "function_call_output") {
      const callId = agentIdentifier(payload.call_id);
      if (callId) {
        this.returned.add(callId);
        if (this.returned.size > 256) this.returned.delete(this.returned.values().next().value!);
      }
      if (callId && this.waits.has(callId)) {
        const turnId = this.waits.get(callId);
        this.waits.delete(callId);
        result.events.push({ ...common, type: "agent-status", turnId, status: this.waits.size ? "waiting" : "running" });
      }
    }
    return result;
  }
}
