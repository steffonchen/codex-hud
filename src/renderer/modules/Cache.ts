import { t } from "../../i18n/Messages.js";
import type { HudModule } from "./HudModule.js";
import { knownNumber } from "./helpers.js";
import { formatTokens, formatDetailedTokens } from "../Formatter.js";

export const cacheModule: HudModule = {
  id: "cache", get label() { return t("缓存"); }, get category() { return t("高级"); }, defaultEnabled: true, priority: 5,
  isAvailable: state => state.usage ? state.usage.cache.source === "measured" && knownNumber(state.usage.cache.latestInputTokens)
    : knownNumber(state.context?.cachedInputTokens),
  render(state, { density }) {
    const cache = state.usage?.cache;
    if (!cache) return t("缓存输入 {0}", formatTokens(state.context?.cachedInputTokens));
    const rate = cache.hitRate === undefined ? "—" : `${(cache.hitRate * 100).toFixed(1)}%`;
    if (density === "minimal") return t("缓存 {0}", rate);
    if (density === "compact") return t("缓存命中 {0}", rate);
    const cumulative = cache.coverage === "complete" && cache.cumulativeHitRate !== undefined ? t(" · 会话 {0}%", (cache.cumulativeHitRate * 100).toFixed(1))
      : cache.coverage === "partial" ? t(" · 会话统计不完整") : "";
    return t("缓存命中 {0}{1}\n已缓存 {2} / 输入 {3}", rate, cumulative, formatDetailedTokens(cache.latestCachedInputTokens), formatDetailedTokens(cache.latestInputTokens));
  },
};
