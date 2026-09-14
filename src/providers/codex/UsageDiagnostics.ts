import { t } from "../../i18n/Messages.js";
import type { HudState } from "../../core/HudState.js";
import { ModelPricingRegistry } from "../../core/usage/ModelPricingRegistry.js";
import type { CodexCheck } from "./Diagnostics.js";
import { redactText } from "../../core/Redaction.js";

const pricing = new ModelPricingRegistry();

export function usageChecks(state: HudState, readable: boolean): CodexCheck[] {
  const usage = state.usage, quota = state.quota;
  const source = state.dataSources?.tokenSource ?? (usage ? "rollout" : "unknown");
  const measured = readable && usage?.tokens.totalSource === "measured";
  const cacheAvailable = readable && usage?.cache.source === "measured" && usage.cache.latestInputTokens !== undefined;
  const price = state.model ? pricing.getPricing(state.model) : undefined;
  const quotaAvailable = readable && quota?.availability !== "unreliable"
    && [quota?.primary, quota?.secondary, quota?.fiveHour, quota?.weekly].some(window => window?.usedPercent !== undefined);
  const costAvailable = readable && !!usage && [usage.cost.latestCost, usage.cost.sessionEstimatedCost]
    .some(cost => cost.confidence === "estimated" && cost.value !== undefined);
  const checks: CodexCheck[] = [
    { id: "token-source", label: t("Token 来源"), ok: measured, warning: !measured,
      detail: t("source={0}；status={1}；累计={2}；最近={3}；账本={4}", source, !readable || !usage ? "unavailable" : measured ? "available" : "partial", usage?.tokens.totalSource ?? "unknown", usage?.tokens.lastSource ?? "unknown", usage?.coverage ?? "unknown") },
    { id: "cache-source", label: t("Cache 来源"), ok: cacheAvailable, warning: !cacheAvailable,
      detail: t("source={0}；status={1}；数据={2}；会话统计={3}{4}", source, cacheAvailable ? "available" : "unavailable", usage?.cache.source ?? "unknown", usage?.cache.coverage ?? "unknown", cacheAvailable && usage?.cache.hitRate === undefined ? t("；零输入，命中率未定义") : "") },
    { id: "rate-limit", label: t("额度窗口"), ok: quotaAvailable, warning: !quotaAvailable,
      detail: t("source={0}；status={1}；全局额度，独立于 Token{2}", quota?.source ?? "unknown", readable ? quota?.availability ?? "unavailable" : "unavailable", quota?.rateLimitReachedType || quota?.spendControlReached ? t("；存在触限记录") : "") },
    { id: "pricing-source", label: t("Pricing 来源"), ok: !!price, warning: !price,
      detail: price ? t("source=registry/{0}；status=available；版本={1}；仅标准 API 等价定价", price.source, price.sourceVersion ?? "unknown")
        : t("source=registry；status=unavailable；当前模型没有可用定价条目") },
    { id: "estimated-cost", label: t("估算费用"), ok: costAvailable, warning: !costAvailable,
      detail: t("status={0}；最近={1}；会话={2}；不代表订阅账单", costAvailable ? "estimated" : "unavailable", usage?.cost.latestCost.reason ?? (usage?.cost.latestCost.value !== undefined ? t("可计算") : t("尚无请求")), usage?.cost.sessionEstimatedCost.reason ?? (usage?.cost.sessionEstimatedCost.value !== undefined ? t("可计算") : t("尚无请求"))) },
  ];
  return checks.map(check => ({ ...check, detail: check.detail && redactText(check.detail) }));
}
