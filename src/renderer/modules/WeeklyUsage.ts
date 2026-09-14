import { t } from "../../i18n/Messages.js";
import type { HudModule } from "./HudModule.js";
import { quotaAvailable, renderQuota } from "./Quota.js";

export const weeklyUsageModule: HudModule = {
  id: "weekly-usage", get label() { return t("每周额度"); }, get category() { return t("用量"); }, defaultEnabled: true, priority: 84,
  isAvailable: state => quotaAvailable(state, "weekly"),
  render: (state, context) => renderQuota(state, "weekly", context),
};
