import { vi } from "vitest";
import type { AppServerClient, AppServerError, RpcNotification } from "../../src/providers/codex/app-server/AppServerProtocol.js";
import type { HudEvent } from "../../src/core/HudEvent.js";

export const thread = (id = "thread-a", parentThreadId: string | null = null) => ({ id, parentThreadId, sessionId: "session-tree",
  environments: null, extra: null, forkedFromId: null, preview: "已脱敏", ephemeral: false, section: null, sectionEnteredAt: null,
  projectId: null, historyMode: "legacy", modelProvider: "openai", model: "gpt-6-astra", reasoningEffort: "medium",
  createdAt: 1789257600, updatedAt: 1789257601, recencyAt: null, status: { type: "idle" }, path: null, cwd: "/example",
  cliVersion: "0.154.0", originator: null, source: "cli", canAcceptDirectInput: null, threadSource: null,
  agentNickname: null, agentRole: null, gitInfo: null, name: null, daybreakEnabled: null, turns: [] as unknown[] });
export const turn = (id = "turn-a", status = "completed", items: unknown[] = []) => ({ id, status, items, itemsView: "full", error: null,
  startedAt: 1789257600, completedAt: status === "inProgress" ? null : 1789257601, durationMs: status === "inProgress" ? null : 1000 });
export const usage = (n: number) => ({ inputTokens: n * 100, cachedInputTokens: n * 20, cacheWriteInputTokens: 0,
  outputTokens: n * 10, reasoningOutputTokens: n * 2, totalTokens: n * 110 });
export const tokenNotification = (n: number, last = 1, threadId = "thread-a", turnId = "turn-a"): RpcNotification => ({ method: "thread/tokenUsage/updated",
  params: { threadId, turnId, tokenUsage: { total: usage(n), last: usage(last), modelContextWindow: 1000 } } });
export const tokenEvent = (source: "rollout" | "app-server", n: number, ordinal: number, last = 1, generation = 1): HudEvent => ({ type: "tokens",
  threadId: "thread-a", turnId: "turn-a", source, sourceOrdinal: ordinal, ordinal, generation, phase: source === "rollout" ? "history" : "live",
  eventId: `${source}-${generation}-${ordinal}`, total: usage(n), last: usage(last), contextWindow: 1000 });
export const command = (id = "command-a", status = "completed", exitCode: number | null = 0) => ({ type: "commandExecution", id,
  pluginId: null, scriptPath: null, command: "printf ok", cwd: "/example", processId: null, source: "agent", status,
  commandActions: [], aggregatedOutput: "已脱敏", exitCode, durationMs: 5 });
export const itemNotification = (item: unknown, stage = "completed", threadId = "thread-a", turnId = "turn-a"): RpcNotification => ({ method: `item/${stage}`,
  params: { threadId, turnId, item, [stage === "started" ? "startedAtMs" : "completedAtMs"]: 1789257601000 } });

export class FakeAppServer implements AppServerClient {
  notifications = new Set<(notification: RpcNotification) => void>();
  closes = new Set<() => void>();
  issues = new Set<(error: AppServerError) => void>();
  threads = new Map<string, ReturnType<typeof thread>>([["thread-a", thread()]]);
  turns = new Map<string, ReturnType<typeof turn>[]>([["thread-a", [turn()]]]);
  loaded = new Set<string>(["thread-a"]);
  override?: (method: string, params: Record<string, unknown>) => unknown | Promise<unknown>;
  start = vi.fn(async () => {});
  stop = vi.fn(async () => {});
  notify = vi.fn(async (_method: string, _params?: unknown) => {});
  request = vi.fn(async (method: string, raw?: unknown): Promise<unknown> => {
    const params = raw as Record<string, unknown> ?? {};
    const override = await this.override?.(method, params);
    if (override !== undefined) return override;
    if (method === "initialize") return { userAgent: "codex-cli/0.154.0", platformFamily: "unix", platformOs: "macos", codexHome: "/example" };
    if (method === "thread/loaded/list") return { data: [...this.loaded], nextCursor: null };
    if (method === "thread/read" || method === "thread/resume") return { thread: this.threads.get(params.threadId as string) };
    if (method === "thread/turns/list") return { data: params.sortDirection === "desc" ? [...(this.turns.get(params.threadId as string) ?? [])].reverse()
      : this.turns.get(params.threadId as string) ?? [], nextCursor: null, backwardsCursor: null };
    if (method === "account/rateLimits/read") return { rateLimits: { limitId: null, primary: null, secondary: null, credits: null, planType: null } };
    throw new Error(`测试未配置的方法：${method}`);
  });
  onNotification(listener: (notification: RpcNotification) => void) { this.notifications.add(listener); return () => { this.notifications.delete(listener); }; }
  onClose(listener: () => void) { this.closes.add(listener); return () => { this.closes.delete(listener); }; }
  onIssue(listener: (error: AppServerError) => void) { this.issues.add(listener); return () => { this.issues.delete(listener); }; }
  emit(notification: RpcNotification) { for (const listener of [...this.notifications]) listener(notification); }
  disconnect() { for (const listener of [...this.closes]) listener(); }
}

export const settle = async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); };
