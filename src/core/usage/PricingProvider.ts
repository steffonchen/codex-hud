export interface ModelPricing {
  model: string;
  inputPerMillion: number;
  cachedInputPerMillion: number;
  cacheWriteInputPerMillion?: number;
  outputPerMillion: number;
  currency: string;
  source: string;
  sourceVersion?: string;
  sourceUrl?: string;
  effectiveAt?: number;
  inputContract: "separate-cache-categories";
  longContext?: { inputTokensAbove: number; inputMultiplier: number; outputMultiplier: number };
}

export interface PricingProvider {
  getPricing(model: string): ModelPricing | undefined;
}
