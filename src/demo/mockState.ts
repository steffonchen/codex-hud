import { t } from "../i18n/Messages.js";
import type { HudState } from "../core/HudState.js";

export function mockState(now = Date.now()): HudState {
  return {
    model: "GPT-5.6 Sol",
    reasoningEffort: "xhigh",
    codexVersion: t("演示数据"),
    fastMode: true,
    activity: { status: "running", description: t("验证模块布局（演示）") },
    context: {
      usedTokens: 191000,
      contextWindow: 258400,
      remainingTokens: 67400,
      usedPercent: 73.9,
      inputTokens: 119000,
      outputTokens: 18000,
      cachedInputTokens: 101000,
    },
    quota: {
      fiveHour: { usedPercent: 91, resetsAt: Math.floor(now / 1000) + 5400 },
      weekly: { usedPercent: 72, resetsAt: Math.floor(now / 1000) + 86400 },
    },
    session: {
      id: "mock-session",
      startedAt: now - 12 * 60 * 1000 - 38 * 1000,
      durationMs: 12 * 60 * 1000 + 38 * 1000,
      turnCount: 3,
    },
    tools: {
      counts: { Read: 24, Write: 8, Shell: 17, Search: 6, MCP: 3 },
      active: [],
    },
    agents: [
      { id: "explorer", role: "explorer", status: "running", tokens: { totalTokens: 32000 }, context: { usedPercent: 32 } },
      { id: "implementer", role: "implementer", status: "running", tokens: { totalTokens: 61000 }, context: { usedPercent: 61 } },
      { id: "reviewer", role: "reviewer", status: "completed", tokens: { totalTokens: 18000 } },
    ],
    plan: { completed: 8, total: 10 },
    git: { cwd: "~/project", branch: "main", dirty: true },
  };
}
