import { t } from "../../i18n/Messages.js";
import type { HudModule } from "./HudModule.js";
import { knownText } from "./helpers.js";
import { plainText } from "../WidthPolicy.js";

export const modelModule: HudModule = {
  id: "model", get label() { return t("模型"); }, get category() { return t("基础"); }, defaultEnabled: true, priority: 95,
  isAvailable: state => knownText(state.model),
  render: (state, context) => `${plainText(state.model ?? "")}${context.density === "full" && state.fastMode ? t(" · ⚡ 快速") : ""}`,
};
