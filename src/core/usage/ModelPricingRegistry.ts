import { t } from "../../i18n/Messages.js";
import type { ModelPricing, PricingProvider } from "./PricingProvider.js";

// 2026-09-12 核对官方页面；仅作 Standard API 等价估算，未声明历史生效日期。
const officialPricing: ModelPricing[] = [
  { model: "gpt-6-astra", inputPerMillion: 10, cachedInputPerMillion: 1, cacheWriteInputPerMillion: 12.5, outputPerMillion: 50,
    currency: "USD", source: "official-openai", sourceVersion: "2026-09-12", sourceUrl: "https://developers.openai.com/api/docs/models/gpt-6-astra",
    inputContract: "separate-cache-categories", longContext: { inputTokensAbove: 272_000, inputMultiplier: 2, outputMultiplier: 1.5 } },
  { model: "gpt-5.6-sol", inputPerMillion: 4, cachedInputPerMillion: 0.4, cacheWriteInputPerMillion: 5, outputPerMillion: 20,
    currency: "USD", source: "official-openai", sourceVersion: "2026-09-12", sourceUrl: "https://developers.openai.com/api/docs/models/gpt-5.6-sol",
    inputContract: "separate-cache-categories", longContext: { inputTokensAbove: 272_000, inputMultiplier: 2, outputMultiplier: 1.5 } },
];

export class ModelPricingRegistry implements PricingProvider {
  private readonly entries = new Map<string, ModelPricing>();

  constructor(entries: readonly ModelPricing[] = officialPricing) {
    for (const entry of entries) {
      const rates = [entry.inputPerMillion, entry.cachedInputPerMillion, entry.outputPerMillion,
        ...(entry.cacheWriteInputPerMillion === undefined ? [] : [entry.cacheWriteInputPerMillion])];
      const long = entry.longContext;
      if (!entry.model.trim() || !/^[A-Z]{3}$/u.test(entry.currency) || !entry.source.trim()
        || entry.inputContract !== "separate-cache-categories" || this.entries.has(entry.model)
        || rates.some(rate => !Number.isFinite(rate) || rate < 0)
        || (long && (!Number.isSafeInteger(long.inputTokensAbove) || long.inputTokensAbove < 0
          || !Number.isFinite(long.inputMultiplier) || long.inputMultiplier <= 0
          || !Number.isFinite(long.outputMultiplier) || long.outputMultiplier <= 0))) throw new Error(t("模型定价条目无效"));
      this.entries.set(entry.model, structuredClone(entry));
    }
  }

  getPricing(model: string): ModelPricing | undefined {
    const entry = this.entries.get(model);
    return entry && structuredClone(entry);
  }
}
