import { describe, expect, it } from "vitest";
import { createDefaultConfig } from "../src/config/Config.js";
import { TokenUsageTracker } from "../src/core/usage/TokenUsageTracker.js";
import { RateLimitParser } from "../src/providers/codex/RateLimitParser.js";
import { HudRenderer } from "../src/renderer/HudRenderer.js";
import { WidthPolicy } from "../src/renderer/WidthPolicy.js";
import { cacheModule } from "../src/renderer/modules/Cache.js";
import { costModule } from "../src/renderer/modules/Cost.js";
import { tokenDetailsModule } from "../src/renderer/modules/TokenDetails.js";
import { fiveHourUsageModule } from "../src/renderer/modules/FiveHourUsage.js";
import { weeklyUsageModule } from "../src/renderer/modules/WeeklyUsage.js";
import { ModuleRegistry } from "../src/renderer/modules/ModuleRegistry.js";
import { sumUsage, testPricing, usage, usageState } from "./usage.js";

const densities = ["full", "compact", "minimal"] as const;
const context = { density: "full" as const, width: 140, height: 24, now: 1000 };
const renderer = new HudRenderer(), policy = new WidthPolicy();
const config = () => { const value = createDefaultConfig(); value.display.enabled = ["token-details", "cache", "cost", "five-hour-usage", "weekly-usage"]; return value; };
const quota = (primary?: number, secondary?: number) => new RateLimitParser().parse({
  primary: { used_percent: 28, window_minutes: primary, resets_at: 3661 },
  secondary: { used_percent: 42, window_minutes: secondary },
}).quota;

describe("Token、Cache、Cost 的渲染语义", () => {
  it("只有新版 usage 也能显示实测分项，缓存和推理不会另加到总量", () => {
    const state = usageState(); delete state.tokenUsage;
    expect(tokenDetailsModule.isAvailable(state)).toBe(true);
    expect(tokenDetailsModule.render(state, context)).toBe("Token Cumulative · Total 101.0K\nInput 100.0K · Cache 90.0K\nOutput 1.0K · Reasoning 4");
    expect(cacheModule.render(state, context)).toBe("Cache hit 90.0% · Session 90.0%\nCached 90.0K / Input 100.0K");
    expect(costModule.render(state, context)).toBe("Session estimate USD 0.07\nLatest estimate USD 0.07 · Standard API equivalent");
  });
  it.each(densities)("%s 密度明确标记估算，不显示虚构零分项", density => {
    const tracker = new TokenUsageTracker({ pricing: testPricing() });
    const estimate = { ...usage(0, 0, 0), totalTokens: 18994 };
    tracker.consume({ threadId: "a", ordinal: 1, total: estimate, last: estimate });
    const state = { usage: tracker.snapshot() };
    expect(tokenDetailsModule.render(state, { ...context, density })).toContain("Estimated");
    expect(tokenDetailsModule.render(state, { ...context, density })).not.toMatch(/Input|Output|Reasoning|Cache/u);
    expect(cacheModule.isAvailable(state)).toBe(false); expect(costModule.isAvailable(state)).toBe(false);
  });
  it.each(densities)("%s 密度中的有效费用始终标记估算", density => {
    const text = costModule.render(usageState(), { ...context, density });
    expect(text).toContain("estimate"); expect(text).toContain("USD 0.07");
  });
  it("零输入显示未定义命中率；真实零费用可以显示", () => {
    const state = usageState(usage(0, 0, 0));
    expect(cacheModule.isAvailable(state)).toBe(true); expect(costModule.isAvailable(state)).toBe(true);
    expect(cacheModule.render(state, context)).toBe("Cache hit —\nCached 0 / Input 0");
    expect(costModule.render(state, context)).toContain("Session estimate USD 0.00");
  });
  it("数据缺失时隐藏缓存和费用，不用旧接口中的值补成实测数据", () => {
    const state = usageState(); state.usage = new TokenUsageTracker().snapshot();
    state.context = { cachedInputTokens: 123 }; state.cost = { amount: 123, currency: "USD", estimated: true };
    expect(cacheModule.isAvailable(state)).toBe(false); expect(costModule.isAvailable(state)).toBe(false);
    expect(tokenDetailsModule.render(state, context)).toContain("Unconfirmed");
  });
  it("部分账本不能显示会话命中率或完整会话费用，最近确认请求仍可显示", () => {
    const tracker = new TokenUsageTracker({ pricing: testPricing() });
    const baseline = sumUsage(usage(), usage());
    tracker.consume({ ordinal: 1, threadId: "a", total: baseline, last: usage(), model: "priced-a" });
    tracker.consume({ ordinal: 2, threadId: "a", total: sumUsage(baseline, usage()), last: usage(), model: "priced-a" });
    const state = { usage: tracker.snapshot() };
    expect(cacheModule.render(state, context)).toContain("Session coverage incomplete");
    expect(cacheModule.render(state, context)).not.toContain("Session 80.0%");
    expect(costModule.isAvailable(state)).toBe(true);
    expect(costModule.render(state, context)).toContain("Session estimate unavailable\nLatest estimate");
  });
});

describe("额度窗口标签与可用性", () => {
  it.each([
    [300, 10080, "5h", "28%", "7d", "42%"], [10080, 300, "5h", "42%", "7d", "28%"],
    [10080, 60, "Quota", "42%", "7d", "28%"], [60, 10080, "Quota", "28%", "7d", "42%"],
    [300, 60, "5h", "28%", "Quota 2", "42%"], [60, 300, "5h", "42%", "Quota 2", "28%"],
    [60, 120, "Quota", "28%", "Quota 2", "42%"],
  ] as const)("primary=%i、secondary=%i 两个窗口均保留且不猜测周期", (primary, secondary, firstLabel, firstPercent, secondLabel, secondPercent) => {
    const state = { quota: quota(primary, secondary) };
    expect(fiveHourUsageModule.isAvailable(state)).toBe(true); expect(weeklyUsageModule.isAvailable(state)).toBe(true);
    const first = fiveHourUsageModule.render(state, context), second = weeklyUsageModule.render(state, context);
    expect(first).toContain(`Global quota ${firstLabel} `); expect(first).toContain(firstPercent + " used");
    expect(second).toContain(`Global quota ${secondLabel} `); expect(second).toContain(secondPercent + " used");
  });
  it("缺少周期仍展示已知百分比，不标成 5h 或 7d", () => {
    const state = { quota: quota() }; const text = renderer.render(state, { width: 140, height: 20 }, config(), 1000);
    expect(text).toContain("28% used"); expect(text).toContain("42% used"); expect(text).not.toMatch(/5h|7d/u);
  });
  it("重置时间到达后等待来源更新，不自行重置额度", () => {
    const state = { quota: quota(300, 10080) };
    expect(fiveHourUsageModule.render(state, context)).toContain("Resets in 1h1m");
    const text = fiveHourUsageModule.render(state, { ...context, now: 3661000 });
    expect(text).toContain("28% used"); expect(text).toContain("Reset time reached; awaiting update");
  });
  it("空窗口不伪造零额度；明确触限且无比例时只显示触限提示", () => {
    const empty = { quota: new RateLimitParser().parse({ primary: null, secondary: null }).quota };
    expect(renderer.render(empty, { width: 140, height: 20 }, config())).toBe("");
    empty.quota!.spendControlReached = true;
    expect(renderer.render(empty, { width: 140, height: 20 }, config())).toBe("Global quota: limit reached");
    empty.quota!.availability = "unreliable";
    expect(renderer.render(empty, { width: 140, height: 20 }, config())).toBe("");
  });
});

describe("用量模块宽高预算及默认配置", () => {
  it.each([140, 80, 50, 30].flatMap(width => [24, 8, 4].map(height => ({ width, height }))))("$width 列、$height 行保留额度并遵守预算", size => {
    const state = { ...usageState(), quota: quota(300, 10080) }, before = structuredClone(state);
    const text = renderer.render(state, size, config(), 1000);
    expect(text.split("\n").length).toBeLessThanOrEqual(policy.rowBudget(size));
    expect(text.split("\n").every(line => policy.measure(line) <= size.width)).toBe(true);
    expect(text).toContain("28%"); expect(text).toContain("42%"); expect(state).toEqual(before);
  });
  it("默认显示 Token 和 Cache，Cost 仍需选择；低优先级不挤掉已有关键模块", () => {
    const settings = createDefaultConfig(), registry = new ModuleRegistry();
    expect(settings.display.enabled).toEqual(expect.arrayContaining(["token-details", "cache"]));
    expect(settings.display.enabled).not.toContain("cost");
    expect(registry.get("context")!.priority).toBeGreaterThan(registry.get("cost")!.priority);
    const text = renderer.render({ ...usageState(), quota: quota(300, 10080) }, { width: 140, height: 40 }, settings, 1000);
    expect(text).toContain("Token Cumulative"); expect(text).toContain("Cache hit"); expect(text).not.toContain("USD");
  });
});
