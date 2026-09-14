import { t } from "../../i18n/Messages.js";
import type { HudState } from "../../core/HudState.js";
import { record, type CodexDiagnostic } from "./Diagnostics.js";
import { redactSummary } from "../../core/Redaction.js";
import type { QuotaState, QuotaWindow } from "../../core/usage/QuotaTracker.js";

export interface RateLimitParseResult {
  detected: boolean;
  quota?: HudState["quota"];
  diagnostics: CodexDiagnostic[];
}

export class RateLimitParser {
  parse(value: unknown, line?: number): RateLimitParseResult {
    return this.parseSnapshot(value, "rollout", line);
  }

  // 当前 CLI 的独立协议入口，不建立连接，也不把它当成 rollout 实机证据。
  parseNotification(value: unknown): RateLimitParseResult {
    const message = record(value);
    return this.parseSnapshot(message?.rateLimits, "protocol");
  }

  private parseSnapshot(value: unknown, source: "rollout" | "protocol", line?: number): RateLimitParseResult {
    const result: RateLimitParseResult = { detected: value != null, diagnostics: [] };
    if (value === undefined) return result;
    if (value === null) { result.quota = { scope: "global", source: "unknown", availability: "unavailable" }; return result; }
    const limits = record(value);
    if (!limits) {
      result.diagnostics.push({ code: "invalid-rate-limits", severity: "error", message: t("rate_limits 不是有效的对象"), line });
      result.quota = { scope: "global", source: "unknown", availability: "unreliable" };
      return result;
    }
    const field = (raw: string, protocol: string): string => source === "rollout" ? raw : protocol;
    const invalid = (name: string): void => { result.diagnostics.push({ code: "invalid-rate-window", severity: "error", message: t("额度字段 {0} 无效", name), line }); };
    const text = (value: unknown, name: string): string | undefined => {
      if (value == null) return undefined;
      if (typeof value === "string" && value.length > 0 && value.length <= 512) return redactSummary(value, 160);
      invalid(name); return undefined;
    };
    const flag = (value: unknown, name: string): boolean | undefined => {
      if (value == null) return undefined;
      if (typeof value === "boolean") return value;
      invalid(name); return undefined;
    };
    const integer = (value: unknown, name: string, positive = false): number | undefined => {
      if (value == null) return undefined;
      if (typeof value === "number" && Number.isSafeInteger(value) && value >= (positive ? 1 : 0) && value <= 8_640_000_000_000) return value;
      invalid(name); return undefined;
    };
    const window = (key: "primary" | "secondary"): QuotaWindow | undefined => {
      if (limits[key] == null) return undefined;
      const raw = record(limits[key]);
      if (!raw) { invalid(key); return undefined; }
      if (![field("used_percent", "usedPercent"), field("window_minutes", "windowDurationMins"), field("resets_at", "resetsAt")]
        .some(name => Object.hasOwn(raw, name))) result.diagnostics.push({ code: "unsupported-rate-window", severity: "warning",
          message: t("额度窗口 {0} 未提供可识别的字段，用量保持未知", key), line });
      const used = raw[field("used_percent", "usedPercent")];
      if (used != null && (typeof used !== "number" || !Number.isFinite(used) || used < 0)) { invalid(`${key}.used_percent`); return undefined; }
      const usedPercent = typeof used === "number" ? used : undefined;
      const windowDurationMins = integer(raw[field("window_minutes", "windowDurationMins")], `${key}.window_minutes`, true);
      const resetsAt = integer(raw[field("resets_at", "resetsAt")], `${key}.resets_at`);
      return { usedPercent, remainingPercent: usedPercent === undefined ? undefined : Math.max(0, 100 - usedPercent),
        windowDurationMins, resetsAt, source: usedPercent === undefined ? "unknown" : "measured" };
    };
    const primary = window("primary"), secondary = window("secondary");
    const quota: QuotaState = { primary, secondary, source, scope: "global",
      limitId: text(limits[field("limit_id", "limitId")], "limit_id"), limitName: text(limits[field("limit_name", "limitName")], "limit_name"),
      planType: text(limits[field("plan_type", "planType")], "plan_type") };
    const reachedKey = field("rate_limit_reached_type", "rateLimitReachedType");
    if (Object.hasOwn(limits, reachedKey)) quota.rateLimitReachedType = limits[reachedKey] === null ? null : text(limits[reachedKey], reachedKey);
    const spendKey = field("spend_control_reached", "spendControlReached");
    if (Object.hasOwn(limits, spendKey)) quota.spendControlReached = limits[spendKey] === null ? null : flag(limits[spendKey], spendKey);
    if (limits.credits != null) {
      const credits = record(limits.credits);
      if (!credits) invalid("credits");
      else quota.credits = { hasCredits: flag(credits[field("has_credits", "hasCredits")], "credits.has_credits"),
        unlimited: flag(credits.unlimited, "credits.unlimited"), balance: credits.balance === null ? null : text(credits.balance, "credits.balance") };
    }
    quota.fiveHour = [primary, secondary].find(item => item?.windowDurationMins === 300);
    quota.weekly = [primary, secondary].find(item => item?.windowDurationMins === 10080);
    if (!["primary", "secondary"].some(key => Object.hasOwn(limits, key))) {
      result.diagnostics.push({ code: "unsupported-rate-limits", severity: "warning", message: t("rate_limits 缺少窗口字段，窗口用量未确认"), line });
    }
    const windows = [primary, secondary].filter((item): item is QuotaWindow => item !== undefined);
    quota.availability = result.diagnostics.some(item => item.severity === "error") ? "unreliable"
      : windows.some(item => item.usedPercent !== undefined) ? windows.every(item => item.usedPercent !== undefined && item.windowDurationMins !== undefined) ? "available" : "partial"
      : windows.length || quota.rateLimitReachedType || quota.spendControlReached ? "partial" : "empty";
    result.quota = quota;
    return result;
  }
}
