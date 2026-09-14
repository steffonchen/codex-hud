import type { HudEvent } from "../HudEvent.js";

const types = new Set(["session", "model", "tokens", "quota", "context-compacted", "activity", "skills-listed",
  "turn-started", "turn-completed", "turn-aborted", "tool-started", "tool-updated", "tool-completed", "tool-failed", "tool-cancelled", "tool-unknown",
  "agent-discovered", "agent-status", "agent-call", "plan-updated", "plan-mode", "plan-proposed", "plan-delta", "plan-status", "plan-cleared"]);
const id = (value: unknown): boolean => typeof value === "string" && value.trim().length > 0 && value.length <= 512;

// 业务字段仍由各 parser/tracker 校验；入口只守住身份、时间和事件信封。
export function eventProblem(value: unknown): "invalid" | "unknown" | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return "invalid";
  const event = value as HudEvent;
  if (typeof event.type !== "string") return "invalid";
  if (!types.has(event.type)) return "unknown";
  for (const key of ["at", "startedAt", "durationMs", "sourceOrdinal", "generation", "ordinal"] as const) {
    const number = (event as unknown as Record<string, unknown>)[key];
    if (number !== undefined && (typeof number !== "number" || !Number.isFinite(number) || number < 0)) return "invalid";
  }
  for (const key of ["threadId", "turnId"] as const) if (event[key] !== undefined && !id(event[key])) return "invalid";
  if (event.source !== undefined && !id(event.threadId) && event.type !== "session") return "invalid";
  for (const key of ["sourceOrdinal", "generation", "ordinal"] as const) {
    const value = (event as unknown as Record<string, unknown>)[key];
    if (value !== undefined && !Number.isSafeInteger(value)) return "invalid";
  }
  if (event.source !== undefined && event.source !== "rollout" && event.source !== "app-server") return "invalid";
  if (event.phase !== undefined && event.phase !== "history" && event.phase !== "live") return "invalid";
  if (event.eventId !== undefined && (typeof event.eventId !== "string" || event.eventId.length > 1024)) return "invalid";
  if (event.type === "session" && (!id(event.id) || event.threadId !== undefined && event.id !== event.threadId)) return "invalid";
  if (event.type.startsWith("tool-") && (!("toolId" in event) || !id(event.toolId))) return "invalid";
  if (event.type.startsWith("agent-") && (!("agentId" in event) || !id(event.agentId))) return "invalid";
  return undefined;
}
