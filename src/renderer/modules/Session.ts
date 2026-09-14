import { t } from "../../i18n/Messages.js";
import type { HudModule } from "./HudModule.js";
import { knownNumber, knownText } from "./helpers.js";
import { formatDuration, formatReset } from "../Formatter.js";
import { plainText } from "../WidthPolicy.js";

export const sessionModule: HudModule = {
  id: "session", get label() { return t("会话"); }, get category() { return t("活动"); }, defaultEnabled: false, priority: 60,
  isAvailable: state => knownNumber(state.session?.durationMs) || knownNumber(state.session?.turnCount)
    || knownText(state.session?.id) || (knownNumber(state.session?.startedAt) && state.session.startedAt > 0)
    || (knownNumber(state.session?.lastActivityAt) && state.session.lastActivityAt > 0),
  render(state, { density }) {
    const session = state.session;
    const parts = [
      knownNumber(session?.durationMs) ? formatDuration(session.durationMs) : "",
      knownNumber(session?.turnCount) ? t("{0} 轮", session.turnCount) : "",
    ].filter(Boolean);
    if (!parts.length && knownNumber(session?.startedAt) && session.startedAt > 0) parts.push(t("{0} 开始", formatReset(session.startedAt / 1000)));
    if ((!parts.length || density === "full") && knownText(session?.id)) parts.push(plainText(session.id));
    if ((!parts.length || density === "full") && knownNumber(session?.lastActivityAt) && session.lastActivityAt > 0) {
      parts.push(t("最近活动 {0}", formatReset(session.lastActivityAt / 1000)));
    }
    return t("会话 {0}", parts.join(" · "));
  },
};
