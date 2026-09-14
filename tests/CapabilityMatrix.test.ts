import { describe, expect, it } from "vitest";
import { APP_SERVER_CAPABILITIES, ROLLOUT_CAPABILITIES, type DataSourceState } from "../src/core/source/DataSource.js";
import { sourceChecks } from "../src/providers/codex/SourceDiagnostics.js";
import { debugState } from "../src/cli/Diagnostics.js";
import { planChecks } from "../src/providers/codex/PlanDiscovery.js";
import { emptyPlanCapability } from "../src/core/PlanState.js";
import { usageChecks } from "../src/providers/codex/UsageDiagnostics.js";

const sources: DataSourceState = { preferred: "app-server", active: "rollout", degraded: true, rolloutAvailable: true, tokenSource: "rollout", deduplicated: 7, issues: [],
  appServer: { available: true, state: "connected", live: false, transport: "stdio", protocol: "detected", schema: "v2", threadId: "thread-private-id",
    history: "ready", capabilities: APP_SERVER_CAPABILITIES, eventCount: 10, unknownCount: 2, reconnectCount: 1, lastEvent: "turn/completed", reason: "独立实例只提供历史" } };
describe("Source capability 与脱敏诊断", () => {
  it("两来源明确声明已接入协议能力，历史不意味着含 Token 或步骤", () => {
    for (const source of [APP_SERVER_CAPABILITIES, ROLLOUT_CAPABILITIES]) expect(source).toMatchObject({ liveEvents: true, history: true, tokenUsage: true, plans: true, tools: true, agents: true, quota: true, context: true });
    expect(sourceChecks(sources).find(check => check.id === "app-server-live")?.ok).toBe(false);
    expect(sourceChecks(sources).find(check => check.id === "app-server-capabilities")?.detail).toContain("do not imply observed runtime behavior");
  });
  it("debug 只保留来源白名单和短 thread ID", () => {
    const unsafe = structuredClone(sources) as any; unsafe.appServer.auth = "SECRET"; unsafe.appServer.params = { prompt: "SECRET" };
    const result = debugState({ dataSources: unsafe }).dataSources!;
    expect(result.appServer?.threadId).toBe("thread-p"); expect(JSON.stringify(result)).not.toContain("SECRET"); expect(result.deduplicated).toBe(7);
  });
  it("doctor 区分已连接、仅历史和计划未观测", () => {
    const checks = planChecks({ capability: emptyPlanCapability(), events: [], eventCount: 0, issues: [] }, sources.appServer);
    expect(checks.find(check => check.id === "plan-app-server")?.detail).toContain("Live subscription unavailable");
    expect(checks.find(check => check.id === "planEvents")?.ok).not.toBe(true);
  });
  it("Token 诊断采用实际权威来源，不能把所有业务来源固定为 Rollout", () => {
    const value = usageChecks({ dataSources: { ...sources, tokenSource: "app-server" } }, true);
    expect(value.find(check => check.id === "token-source")?.detail).toContain("source=app-server");
  });
});
