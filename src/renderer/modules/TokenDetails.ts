import { t } from "../../i18n/Messages.js";
import type { HudState } from "../../core/HudState.js";
import type { HudModule } from "./HudModule.js";
import { knownNumber } from "./helpers.js";
import { formatTokens, formatDetailedTokens } from "../Formatter.js";

function details(state: HudState): string[] {
  const usage = state.tokenUsage ?? state.context;
  const values: Array<[string, number | undefined]> = [
    [t("输入"), usage?.inputTokens], [t("输出"), usage?.outputTokens],
    [t("推理"), usage?.reasoningOutputTokens], [t("缓存"), usage?.cachedInputTokens], [t("总计"), usage?.totalTokens],
  ];
  return values.filter(([, value]) => knownNumber(value)).map(([label, value]) => `${label} ${formatTokens(value)}`);
}

export const tokenDetailsModule: HudModule = {
  id: "token-details", get label() { return t("Token 明细"); }, get category() { return t("高级"); }, defaultEnabled: true, priority: 10,
  isAvailable: state => knownNumber(state.usage?.tokens.total?.totalTokens) || details(state).length > 0,
  render(state, { density }) {
    const tokens = state.usage?.tokens;
    const usage = tokens?.total;
    if (!usage) return `Token${state.usage ? t(" 未确认") : ""} ${details(state).join(" · ")}`;
    const source = tokens.totalSource === "estimated" ? t("估算") : tokens.totalSource === "unknown" ? t("未确认") : t("累计");
    const total = t("总计 {0}", formatDetailedTokens(usage.totalTokens));
    if (density === "minimal") return `Tok ${source} ${formatTokens(usage.totalTokens)}`;
    if (tokens.totalSource !== "measured") return `Token ${source} · ${total}`;
    if (density === "compact") return t("Token {0} · 输入 {1} · 输出 {2} · {3}", source, formatTokens(usage.inputTokens), formatTokens(usage.outputTokens), total);
    return t("Token {0} · {1}\n输入 {2} · 缓存 {3}\n输出 {4} · 推理 {5}", source, total, formatDetailedTokens(usage.inputTokens), formatDetailedTokens(usage.cachedInputTokens), formatDetailedTokens(usage.outputTokens), formatDetailedTokens(usage.reasoningOutputTokens));
  },
};
