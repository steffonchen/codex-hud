import { t } from "../../i18n/Messages.js";
import type { PricingProvider } from "./PricingProvider.js";
import { ModelPricingRegistry } from "./ModelPricingRegistry.js";
import { completeUsage, usageSource, type CostEstimate, type UsageRecord } from "./UsageState.js";

export const unknownCost = (reason: string): CostEstimate => ({ basis: "standard-api-equivalent", confidence: "unknown", reason });

export class CostCalculator {
  constructor(private readonly pricing: PricingProvider = new ModelPricingRegistry()) {}

  estimate(record: UsageRecord): CostEstimate {
    if (!record.model) return unknownCost(t("请求模型未确认"));
    const price = this.pricing.getPricing(record.model);
    if (!price) return unknownCost(t("没有经过核实的模型价格"));
    const usage = completeUsage(record.usage);
    if (record.source !== "measured" || usageSource(usage) !== "measured" || !usage) return unknownCost(t("没有完整可信的实测用量分项"));
    if (price.inputContract !== "separate-cache-categories") return unknownCost(t("输入计费契约未确认"));
    if (price.cacheWriteInputPerMillion !== undefined && usage.cacheWriteInputTokens === undefined) return unknownCost(t("缺少缓存写入用量"));
    const write = usage.cacheWriteInputTokens ?? 0;
    if (write > 0 && (record.cacheWriteSemantics !== "input-subset" || price.cacheWriteInputPerMillion === undefined)) {
      return unknownCost(t("rollout 缓存写入到 API 计费字段的映射未确认"));
    }
    const ordinary = usage.inputTokens - usage.cachedInputTokens - write;
    if (ordinary < 0) return unknownCost(t("输入分类互相冲突"));
    const long = price.longContext && usage.inputTokens > price.longContext.inputTokensAbove ? price.longContext : undefined;
    const inputMultiplier = long?.inputMultiplier ?? 1;
    const inputCost = ordinary * price.inputPerMillion * inputMultiplier / 1_000_000;
    const cachedInputCost = usage.cachedInputTokens * price.cachedInputPerMillion * inputMultiplier / 1_000_000;
    const cacheWriteCost = write * (price.cacheWriteInputPerMillion ?? 0) * inputMultiplier / 1_000_000;
    const outputCost = usage.outputTokens * price.outputPerMillion * (long?.outputMultiplier ?? 1) / 1_000_000;
    const value = inputCost + cachedInputCost + cacheWriteCost + outputCost;
    if (![value, inputCost, cachedInputCost, cacheWriteCost, outputCost].every(amount => Number.isFinite(amount) && amount >= 0)) return unknownCost(t("费用超出可计算范围"));
    return { value, currency: price.currency, inputCost, cachedInputCost, cacheWriteCost, outputCost,
      source: price.source, sourceVersion: price.sourceVersion, basis: "standard-api-equivalent", confidence: "estimated" };
  }
}
