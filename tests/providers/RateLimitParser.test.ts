import { describe, expect, it } from "vitest";
import { readFile } from "node:fs/promises";
import { RateLimitParser } from "../../src/providers/codex/RateLimitParser.js";
import { RolloutEventParser } from "../../src/providers/codex/RolloutEventParser.js";
import { HudStateReducer } from "../../src/core/HudStateReducer.js";
import { ModuleRegistry } from "../../src/renderer/modules/ModuleRegistry.js";

describe("RateLimitParser", () => {
  it("实际空窗口 fixture 识别为缺数据，并清除旧额度、隐藏模块", async () => {
    const source = await readFile(new URL("../fixtures/codex/rollout-rate-limit.jsonl", import.meta.url), "utf8");
    const parsed = new RolloutEventParser().parse(source.trim());
    expect(parsed.diagnostics).toEqual([]);
    expect(parsed.detections).toMatchObject({ tokenCount: true, rateLimits: true });
    const reducer = new HudStateReducer();
    reducer.apply({ type: "quota", quota: { fiveHour: { usedPercent: 30 }, weekly: { usedPercent: 10 } } });
    for (const event of parsed.events) reducer.apply(event);
    const state = reducer.getState(Date.now());
    expect(state.quota).toMatchObject({ availability: "empty", source: "rollout", scope: "global" });
    expect(state.quota?.primary).toBeUndefined(); expect(state.quota?.secondary).toBeUndefined();
    const registry = new ModuleRegistry();
    expect(registry.get("five-hour-usage")!.isAvailable(state)).toBe(false);
    expect(registry.get("weekly-usage")!.isAvailable(state)).toBe(false);
  });

  it("rate_limits=undefined 没有新快照，null 明确记录不可用而不伪造百分比", () => {
    expect(new RateLimitParser().parse(undefined)).toEqual({ detected: false, diagnostics: [] });
    expect(new RateLimitParser().parse(null)).toEqual({ detected: false, diagnostics: [], quota: { source: "unknown", scope: "global", availability: "unavailable" } });
  });

  it("遇到尚未验证的非空窗口时诊断可见，不套用其他协议字段", () => {
    const parsed = new RateLimitParser().parse({ primary: { unknown: "秘密内容" }, secondary: null }, 12);
    expect(parsed.quota).toMatchObject({ availability: "partial", primary: { source: "unknown" } });
    expect(parsed.quota?.primary?.usedPercent).toBeUndefined();
    expect(parsed.quota?.fiveHour).toBeUndefined(); expect(parsed.quota?.weekly).toBeUndefined();
    expect(parsed.diagnostics).toEqual([expect.objectContaining({ code: "unsupported-rate-window", line: 12, severity: "warning" })]);
    expect(JSON.stringify(parsed)).not.toContain("秘密内容");
  });

  it("窗口和容器的错误类型保持可见", () => {
    expect(new RateLimitParser().parse("invalid").diagnostics[0].code).toBe("invalid-rate-limits");
    expect(new RateLimitParser().parse({ primary: 1 }).diagnostics[0].code).toBe("invalid-rate-window");
    expect(new RateLimitParser().parse({ unknown: true }).diagnostics[0].code).toBe("unsupported-rate-limits");
  });
});
