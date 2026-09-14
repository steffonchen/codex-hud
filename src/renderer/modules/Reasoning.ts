import { t } from "../../i18n/Messages.js";
import type { HudModule } from "./HudModule.js";
import { knownText } from "./helpers.js";
import { plainText } from "../WidthPolicy.js";

export const reasoningModule: HudModule = {
  id: "reasoning", get label() { return t("推理强度"); }, get category() { return t("基础"); }, defaultEnabled: true, priority: 90,
  isAvailable: state => knownText(state.reasoningEffort),
  render: state => plainText(state.reasoningEffort ?? ""),
};
