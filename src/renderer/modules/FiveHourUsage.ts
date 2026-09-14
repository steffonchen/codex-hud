import { t } from "../../i18n/Messages.js";
import type { HudModule } from "./HudModule.js";
import { quotaAvailable, renderQuota } from "./Quota.js";

export const fiveHourUsageModule: HudModule = {
  id: "five-hour-usage", get label() { return t("5 小时额度"); }, get category() { return t("用量"); }, defaultEnabled: true, priority: 85,
  isAvailable: state => quotaAvailable(state, "fiveHour"),
  render: (state, context) => renderQuota(state, "fiveHour", context),
};
