import { t } from "../../i18n/Messages.js";
import type { HudModule } from "./HudModule.js";
import { contextPercent, contextTokens, knownNumber } from "./helpers.js";
import { formatPercent, formatTokens } from "../Formatter.js";
import { progressBar } from "../ProgressBar.js";

export const contextModule: HudModule = {
  id: "context", get label() { return t("上下文"); }, get category() { return t("用量"); }, defaultEnabled: true, priority: 100,
  isAvailable: state => knownNumber(state.context?.usedTokens) && knownNumber(state.context?.contextWindow) && state.context.contextWindow > 0,
  render(state, { density, width }) {
    const percent = contextPercent(state);
    const tokens = contextTokens(state);
    const parts: string[] = [];
    if (knownNumber(percent)) {
      if (density !== "minimal") parts.push(progressBar(percent, density === "full" ? 15 : 9));
      parts.push(formatPercent(percent));
    }
    if (density === "full" && tokens && knownNumber(state.context?.remainingTokens)) {
      return t("上下文 {0}\n{1} · 剩余 {2}", parts.join(" "), tokens, formatTokens(state.context.remainingTokens));
    }
    if (tokens && (width >= 40 || !parts.length)) parts.push(`${parts.length ? "· " : ""}${tokens}`);
    return `${width < 12 ? "Ctx" : t("上下文")} ${parts.join(" ")}`;
  },
};
