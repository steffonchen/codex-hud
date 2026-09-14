import { createHash } from "node:crypto";
import type { HudEvent, ToolEvent } from "../HudEvent.js";

// 数组边界参与散列，避免分隔符出现在线程或条目 ID 中时发生拼接碰撞。
export function eventIdentity(...parts: unknown[]): string {
  return `event-${createHash("sha256").update(JSON.stringify(parts)).digest("hex")}`;
}

export function usageIdentity(event: Extract<HudEvent, { type: "tokens" }>): string {
  const values = (usage: typeof event.total) => usage && [usage.inputTokens, usage.cachedInputTokens,
    usage.cacheWriteInputTokens ?? 0, usage.outputTokens, usage.reasoningOutputTokens, usage.totalTokens];
  return eventIdentity("usage-snapshot", event.threadId, event.turnId, values(event.total), values(event.last));
}

export function canonicalIdentity(event: HudEvent): string {
  if (event.type.startsWith("tool-")) {
    const tool = event as HudEvent & ToolEvent;
    return eventIdentity("tool", event.threadId, event.turnId, tool.toolId, tool.type, tool.status, tool.resultSource);
  }
  if (event.type === "turn-started" || event.type === "turn-completed" || event.type === "turn-aborted") {
    return eventIdentity("turn", event.threadId, event.id, event.type);
  }
  if (event.type === "session") return eventIdentity("session", event.id);
  if (event.type === "plan-proposed") return eventIdentity("proposal", event.threadId, event.turnId, event.itemId, event.complete, event.text);
  return event.eventId ?? eventIdentity(event.source, event.threadId, event.turnId, event.generation, event.sourceOrdinal, event.type);
}
