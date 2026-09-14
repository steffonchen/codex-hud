import { CapabilityDetector, type ProtocolSchemas } from "../src/capabilities/CapabilityDetector.js";
import { mockState } from "../src/demo/mockState.js";
import { readFile } from "node:fs/promises";
import { HudStateReducer } from "../src/core/HudStateReducer.js";
import { RolloutEventParser } from "../src/providers/codex/RolloutEventParser.js";
import type { CodexSessionSnapshot } from "../src/providers/codex/CodexSessionProvider.js";

const fields = (...names: string[]) => ({ properties: Object.fromEntries(names.map(name => [name, {}])) });
const methods = (...names: string[]) => names.map(name => ({ properties: { method: { enum: [name] } } }));

export function protocolSchemas(): ProtocolSchemas {
  return {
    "ClientRequest.json": { oneOf: methods("thread/read", "model/list", "account/rateLimits/read", "mcpServerStatus/list", "skills/list", "account/usage/read") },
    "ServerNotification.json": {
      oneOf: methods("thread/tokenUsage/updated", "thread/status/changed", "item/started", "item/completed", "turn/plan/updated"),
      definitions: {
        ThreadTokenUsage: fields("last", "total", "modelContextWindow"),
        TokenUsageBreakdown: fields("inputTokens", "outputTokens", "totalTokens", "cachedInputTokens"),
        ThreadStatusChangedNotification: fields("status"),
        TurnPlanUpdatedNotification: fields("plan"),
        TurnPlanStep: fields("step", "status"),
        ThreadItem: { oneOf: ["commandExecution", "collabAgentToolCall"].map(name => ({ properties: { type: { enum: [name] } } })) },
      },
    },
    "v2/ThreadReadResponse.json": { definitions: { Thread: fields("id", "createdAt", "model", "reasoningEffort") } },
    "v2/ModelListResponse.json": { definitions: { Model: fields("model", "defaultReasoningEffort") } },
    "v2/GetAccountRateLimitsResponse.json": { definitions: { RateLimitWindow: fields("usedPercent", "windowDurationMins") } },
    "v2/ListMcpServerStatusResponse.json": { definitions: { McpServerStatus: fields("name", "tools") } },
    "v2/SkillsListResponse.json": { definitions: { SkillMetadata: fields("name", "enabled") } },
    "v2/GetAccountTokenUsageResponse.json": { definitions: { ThreadUsage: fields("estimatedUsageUsdMicros") } },
  };
}

export function testDetector(): CapabilityDetector {
  return new CapabilityDetector(async () => ({ version: "codex-cli 测试版本", schemas: protocolSchemas(), diagnostics: [] }));
}

export async function supportedCapabilities() {
  return testDetector().detect(mockState(0));
}

export async function testSessionSnapshot(): Promise<CodexSessionSnapshot> {
  const parser = new RolloutEventParser();
  const reducer = new HudStateReducer();
  let source = "";
  for (const name of ["rollout-session.jsonl", "rollout-token-count.jsonl", "rollout-rate-limit.jsonl"]) {
    source += await readFile(new URL(`./fixtures/codex/${name}`, import.meta.url), "utf8");
  }
  for (const line of source.split("\n")) for (const event of parser.parse(line).events) reducer.apply(event);
  const sampledAt = Date.parse("2026-09-11T09:00:00Z");
  const checks = [
    { id: "binary", label: "Codex binary", ok: true, detail: "/fixture/bin/codex" },
    { id: "version", label: "Codex 版本", ok: true, detail: "codex-cli 0.154.0" },
    { id: "home", label: "Codex home", ok: true },
    { id: "sessions", label: "sessions 目录", ok: true },
    { id: "active-rollout", label: "主会话 rollout", ok: true },
    { id: "rollout-readable", label: "rollout 可读", ok: true },
    { id: "token-count", label: "token_count", ok: true },
    { id: "context-window", label: "上下文窗口", ok: true },
    { id: "rate-limit", label: "额度窗口", ok: false, detail: "rate_limits 的窗口为空" },
  ];
  return {
    runtime: { codexHome: "/fixture/.codex", sessionsPath: "/fixture/.codex/sessions", codexBinary: "/fixture/bin/codex",
      version: "codex-cli 0.154.0", rolloutVersion: "0.153.4", currentSessionId: "session-a",
      currentRolloutPath: "/fixture/.codex/sessions/rollout-a.jsonl", selection: "working-directory", checks: checks.slice(0, 5), diagnostics: [] },
    state: reducer.getState(sampledAt), sampledAt, checks, diagnostics: [],
    detections: { tokenCount: true, contextWindow: true, rateLimits: true, tools: false, activity: true },
    read: { status: "ready", bytesRead: Buffer.byteLength(source), offset: Buffer.byteLength(source), linesRead: source.trim().split("\n").length, pendingBytes: 0, diagnostics: [] },
  };
}
