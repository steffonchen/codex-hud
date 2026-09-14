import { t } from "../../i18n/Messages.js";
import type { HudModule } from "./HudModule.js";
import { knownNumber, knownText } from "./helpers.js";
import { plainText } from "../WidthPolicy.js";

export const gitModule: HudModule = {
  id: "git", label: "Git", get category() { return t("项目"); }, defaultEnabled: true, priority: 50,
  isAvailable: state => knownText(state.git?.branch) || knownText(state.git?.cwd),
  render(state, { density }) {
    const git = state.git;
    const parts: string[] = [];
    if (knownText(git?.cwd) && (density === "full" || !knownText(git?.branch))) parts.push(plainText(git.cwd));
    if (knownText(git?.branch)) parts.push(plainText(git.branch));
    const sync = density === "full"
      ? `${knownNumber(git?.ahead) && git.ahead > 0 ? ` ↑${git.ahead}` : ""}${knownNumber(git?.behind) && git.behind > 0 ? ` ↓${git.behind}` : ""}` : "";
    return `${parts.join(" · ")}${git?.dirty ? " *" : ""}${sync}`;
  },
};
