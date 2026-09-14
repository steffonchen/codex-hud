import { describe, expect, it } from "vitest";
import { debugState, formatDebug, formatRuntimeChecks } from "../src/cli/Diagnostics.js";
import { initialRuntimeState } from "../src/providers/codex/runtime/RuntimeCandidate.js";
import { AppServerSource } from "../src/providers/codex/app-server/AppServerSource.js";
import { sourceChecks } from "../src/providers/codex/SourceDiagnostics.js";
import { ModuleRegistry } from "../src/renderer/modules/ModuleRegistry.js";
import { testSessionSnapshot } from "./fixtures.js";
import { FakeAppServer } from "./app-server/helpers.js";

describe("Runtime 诊断与可选显示", () => {
  it("debug 使用显式白名单，不输出 endpoint、PID、凭据或原始 payload", async () => {
    const snapshot = await testSessionSnapshot(), runtime = initialRuntimeState();
    Object.assign(runtime, { endpoint: "/private/SECRET.sock", executable: "/Users/SECRET/codex", pid: 12345, credentials: "SECRET",
      raw: { prompt: "SECRET" }, authenticated: true, runtimeId: "abcdef0123456789" });
    Object.assign(runtime.capabilities, { injected: "SECRET" }); Object.assign(runtime.thread, { raw: "SECRET" });
    const app = new AppServerSource({ createClient: () => new FakeAppServer() }).getStatus(); app.runtime = runtime;
    snapshot.state.dataSources = { preferred: "app-server", active: "rollout", degraded: true, rolloutAvailable: true, fallbackEnabled: true,
      appServer: app, deduplicated: 0, issues: [] };
    const safe = debugState(snapshot.state), text = JSON.stringify(safe);
    expect(text).not.toMatch(/SECRET|12345/u); expect(safe.dataSources?.appServer?.runtime).toMatchObject({ runtimeId: "abcdef01", authenticated: true });
    expect(formatDebug(snapshot)).not.toContain(snapshot.runtime.codexHome);
  });
  it("doctor 显示发现、权限归属、线程、回退和未观测审批，同时省略 home 全路径", async () => {
    const snapshot = await testSessionSnapshot(), runtime = initialRuntimeState(), app = new AppServerSource({ createClient: () => new FakeAppServer() }).getStatus();
    app.runtime = runtime;
    const checks = sourceChecks({ preferred: "app-server", active: "rollout", degraded: true, rolloutAvailable: true, appServer: app,
      fallbackEnabled: false, deduplicated: 0, issues: [] });
    expect(checks.map(check => check.id)).toEqual(expect.arrayContaining(["runtime-discovery", "runtime-managed", "runtime-socket", "runtime-probe",
      "runtime-protocol", "runtime-ownership", "runtime-authority", "runtime-thread", "runtime-fallback", "runtime-health", "runtime-account", "runtime-approval"]));
    expect(checks.find(check => check.id === "runtime-approval")?.detail).toContain("NOT OBSERVED");
    snapshot.checks = [...checks, { id: "home", label: "Codex home", ok: true, detail: snapshot.runtime.codexHome }];
    const text = formatRuntimeChecks(snapshot); expect(text).toContain("<CODEX_HOME>"); expect(text).not.toContain(snapshot.runtime.codexHome);
    expect(checks.find(check => check.id === "runtime-fallback")?.detail).toBe("Disabled");
  });
  it("运行时模块默认关闭，缺少 App Server 时也能展示回退", () => {
    const registry = new ModuleRegistry(), module = registry.get("runtime-status")!;
    expect(module.defaultEnabled).toBe(false); expect(registry.defaultEnabled()).toHaveLength(11);
    const state = { dataSources: { preferred: "app-server" as const, active: "rollout" as const, degraded: true, rolloutAvailable: true, deduplicated: 0, issues: [] } };
    expect(module.isAvailable(state)).toBe(true); expect(module.render(state, { width: 80, density: "full" })).toBe("Runtime · Rollout · Fallback");
    expect(module.render(state, { width: 10, density: "minimal" })).toBe("Source RL");
  });
});
