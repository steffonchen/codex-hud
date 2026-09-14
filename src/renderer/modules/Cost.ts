import { t } from "../../i18n/Messages.js";
import type { HudModule } from "./HudModule.js";
import { knownNumber, knownText } from "./helpers.js";
import { plainText } from "../WidthPolicy.js";

export const costModule: HudModule = {
  id: "cost", get label() { return t("估算费用"); }, get category() { return t("高级"); }, defaultEnabled: false, priority: 20,
  isAvailable: state => state.usage ? [state.usage.cost.latestCost, state.usage.cost.sessionEstimatedCost]
    .some(cost => cost.confidence === "estimated" && knownNumber(cost.value) && knownText(cost.currency))
    : knownNumber(state.cost?.amount) && knownText(state.cost?.currency),
  render(state, { density }) {
    if (!state.usage) return `${state.cost?.estimated ? t("估算费用") : t("费用")} ${plainText(state.cost?.currency ?? "")} ${state.cost?.amount.toFixed(2)}`;
    const { latestCost, sessionEstimatedCost } = state.usage.cost;
    const session = sessionEstimatedCost.value === undefined ? t("会话估算不可用") : t("会话估算 {0} {1}", plainText(sessionEstimatedCost.currency ?? ""), sessionEstimatedCost.value.toFixed(2));
    const latest = latestCost.value === undefined ? t("最近估算不可用") : t("最近估算 {0} {1}", plainText(latestCost.currency ?? ""), latestCost.value.toFixed(2));
    return density === "full" ? t("{0}\n{1} · 标准 API 等价", session, latest) : sessionEstimatedCost.value === undefined ? latest : session;
  },
};
