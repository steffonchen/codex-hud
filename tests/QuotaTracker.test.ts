import { describe, expect, it } from "vitest";
import { QuotaTracker } from "../src/core/usage/QuotaTracker.js";
import { RateLimitParser } from "../src/providers/codex/RateLimitParser.js";

const quota = () => new RateLimitParser().parse({ primary: { used_percent: 37, window_minutes: 300, resets_at: 2000000000 },
  secondary: { used_percent: 61, window_minutes: 10080 }, credits: { has_credits: true, unlimited: false, balance: "12.34" },
  plan_type: "test", rate_limit_reached_type: null, spend_control_reached: null }).quota!;

describe("Quota 独立快照与语义", () => {
  it("保存 used 与 remaining，窗口按实际分钟投影，credits 不强转数字", () => {
    expect(quota()).toMatchObject({ primary: { usedPercent: 37, remainingPercent: 63, windowDurationMins: 300, resetsAt: 2000000000 },
      secondary: { usedPercent: 61, remainingPercent: 39 }, fiveHour: { usedPercent: 37 }, weekly: { usedPercent: 61 },
      credits: { balance: "12.34", hasCredits: true, unlimited: false }, spendControlReached: null,
      rateLimitReachedType: null, source: "rollout", scope: "global", availability: "available" });
  });
  it("primary 可以是 weekly，secondary 可以是 5h", () => {
    const result = new RateLimitParser().parse({ primary: { used_percent: 61, window_minutes: 10080 }, secondary: { used_percent: 37, window_minutes: 300 } });
    expect(result.quota).toMatchObject({ fiveHour: { usedPercent: 37 }, weekly: { usedPercent: 61 } });
  });
  it("未知窗口和缺失比例保留 partial，不补成 0%", () => {
    const result = new RateLimitParser().parse({ primary: { used_percent: null, window_minutes: 60 }, secondary: null });
    expect(result.quota?.primary?.usedPercent).toBeUndefined(); expect(result.quota?.primary?.remainingPercent).toBeUndefined();
    expect(result.quota?.availability).toBe("partial"); expect(result.quota?.fiveHour).toBeUndefined();
  });
  it("无窗口的明确触限与单纯空窗口不同", () => {
    const parser = new RateLimitParser();
    expect(parser.parse({ primary: null, secondary: null }).quota?.availability).toBe("empty");
    expect(parser.parse({ primary: null, secondary: null, spend_control_reached: true }).quota).toMatchObject({ availability: "partial", spendControlReached: true });
  });
  it("负数、错误类型保留诊断和不可靠状态", () => {
    const result = new RateLimitParser().parse({ primary: { used_percent: -1, window_minutes: 300 } });
    expect(result.quota?.availability).toBe("unreliable"); expect(result.diagnostics[0].severity).toBe("error");
  });
  it("超过100%的原值保留，剩余额度最低为零", () => {
    const result = new RateLimitParser().parse({ primary: { used_percent: 110, window_minutes: 300 } });
    expect(result.quota?.primary).toMatchObject({ usedPercent: 110, remainingPercent: 0 });
  });
  it("协议参数入口独立映射 camelCase，不冒充 rollout 来源", () => {
    const result = new RateLimitParser().parseNotification({ rateLimits: { primary: { usedPercent: 37, windowDurationMins: 300, resetsAt: 2000000000 },
      credits: { hasCredits: true, unlimited: false, balance: null }, spendControlReached: null } });
    expect(result.quota).toMatchObject({ source: "protocol", fiveHour: { usedPercent: 37 }, credits: { balance: null }, spendControlReached: null });
  });
  it("快照乱序和旧 reset 不覆盖新值，时间向后也可以用物理序号接受", () => {
    const tracker = new QuotaTracker(); tracker.apply(quota(), 10, 10000);
    expect(tracker.apply(undefined, 9, 20000)).toBe(false); expect(tracker.apply(undefined, undefined, 9000)).toBe(false);
    expect(tracker.snapshot()?.primary?.usedPercent).toBe(37);
    expect(tracker.apply({ ...quota(), primary: { usedPercent: 0, windowDurationMins: 300 } }, 11, 9000)).toBe(true);
    expect(tracker.snapshot()?.primary?.usedPercent).toBe(0);
  });
  it("新 null 清除旧窗口，reset 与快照复制保持隔离", () => {
    const tracker = new QuotaTracker(), input = quota(); tracker.apply(input, 1);
    input.primary!.usedPercent = 99; tracker.snapshot()!.primary!.usedPercent = 88;
    expect(tracker.snapshot()?.primary?.usedPercent).toBe(37);
    tracker.apply(new RateLimitParser().parse(null).quota, 2); expect(tracker.snapshot()?.primary).toBeUndefined();
    expect(tracker.snapshot()?.availability).toBe("unavailable"); tracker.reset(); expect(tracker.snapshot()).toBeUndefined();
  });
});
