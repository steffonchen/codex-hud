import { t } from "../../i18n/Messages.js";
import type { HudState } from "../../core/HudState.js";
import type { QuotaWindow } from "../../core/usage/QuotaTracker.js";
import type { ModuleRenderContext } from "./HudModule.js";
import { knownNumber } from "./helpers.js";
import { formatPercent, formatQuotaReset, formatReset } from "../Formatter.js";
import { progressBar } from "../ProgressBar.js";

type Slot = "fiveHour" | "weekly";
const duration = (slot: Slot): number => slot === "fiveHour" ? 300 : 10080;
const reached = (state: HudState): boolean => state.quota?.spendControlReached === true || ["rate_limit_reached", "workspace_owner_credits_depleted",
  "workspace_member_credits_depleted", "workspace_owner_usage_limit_reached", "workspace_member_usage_limit_reached"].includes(state.quota?.rateLimitReachedType ?? "");

function select(state: HudState, slot: Slot): QuotaWindow | undefined {
  const quota = state.quota;
  if (!quota || quota.availability === "unreliable") return undefined;
  if (!quota.source) return quota[slot];
  const windows = [quota.primary, quota.secondary].filter((window): window is QuotaWindow => window !== undefined);
  const selected: Partial<Record<Slot, QuotaWindow>> = {};
  for (const key of ["fiveHour", "weekly"] as const) {
    selected[key] = windows.find(window => window.windowDurationMins === duration(key));
  }
  const remaining = windows.filter(window => !Object.values(selected).includes(window));
  for (const key of ["fiveHour", "weekly"] as const) {
    if (!selected[key]) selected[key] = remaining.shift();
  }
  return selected[slot];
}

export function quotaAvailable(state: HudState, slot: Slot): boolean {
  return state.quota?.availability !== "unreliable" && (knownNumber(select(state, slot)?.usedPercent) || (slot === "fiveHour" && reached(state)));
}

export function renderQuota(state: HudState, slot: Slot, { density, now = Date.now() }: ModuleRenderContext): string {
  const quota = state.quota, window = select(state, slot);
  const legacy = !quota?.source;
  const mins = legacy ? duration(slot) : window?.windowDurationMins;
  const label = mins === 300 ? "5h" : mins === 10080 ? "7d" : slot === "fiveHour" ? t("额度") : t("额度2");
  const notice = slot === "fiveHour" && reached(state) ? t(" · 已触限") : "";
  if (!knownNumber(window?.usedPercent)) return reached(state) ? t("全局额度：已触限") : "";
  const percent = formatPercent(window.usedPercent);
  if (!legacy && density === "minimal") return t("{0} {1}用{2}", label, percent, notice);
  const reset = density === "full" && knownNumber(window.resetsAt)
    ? ` · ${legacy ? t("{0} 重置", formatReset(window.resetsAt)) : formatQuotaReset(window.resetsAt, now)}` : "";
  return `${!legacy && density === "full" ? t("全局额度 ") : ""}${label} ${density === "full" ? `${progressBar(window.usedPercent, 9)} ` : ""}${percent}${legacy ? "" : t(" 已用")}${notice}${reset}`;
}
