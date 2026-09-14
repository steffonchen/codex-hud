import { t } from "../../i18n/Messages.js";
import type { HudModule } from "./HudModule.js";

export const runtimeStatusModule: HudModule = {
  id: "runtime-status", get label() { return t("运行时状态"); }, get category() { return t("诊断"); }, defaultEnabled: false, priority: 20,
  isAvailable: state => !!state.dataSources || !!state.session,
  render(state, { density }) {
    const sources = state.dataSources, runtime = sources?.appServer?.runtime;
    const active = sources?.active ?? (state.session ? "rollout" : "none");
    if (density === "minimal") return t("源 {0}", active === "app-server" ? "AS" : active === "rollout" ? "RL" : "—");
    if (active !== "app-server") return t("运行时 · {0}{1}", active === "rollout" ? "Rollout" : t("等待数据"), sources?.degraded ? t(" · 回退") : "");
    const owner = runtime?.ownership === "external" ? t("外部") : runtime?.ownership === "owned" ? t("HUD 自有") : t("归属未确认");
    const health = sources?.degraded ? t("降级") : runtime?.health === "healthy" ? t("健康") : t("已连接");
    return t("运行时 · App Server · {0}{1}", owner, density === "full" ? ` · ${health}` : "");
  },
};
