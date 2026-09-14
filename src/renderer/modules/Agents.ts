import { t } from "../../i18n/Messages.js";
import type { HudModule } from "./HudModule.js";
import { agentEntries, knownNumber, knownText } from "./helpers.js";
import { formatPercent, formatTokens } from "../Formatter.js";
import { plainText } from "../WidthPolicy.js";
import { renderAgentTree } from "./AgentModule.js";

export const agentsModule: HudModule = {
  id: "agents", get label() { return t("子代理"); }, get category() { return t("活动"); }, defaultEnabled: true, priority: 80,
  isAvailable: state => Boolean(state.agents?.length),
  render(state, context) {
    if (state.agentSummary?.capability.eventSupport) return renderAgentTree(state.agentSummary, context);
    const { density } = context;
    const entries = agentEntries(state.agents);
    if (density === "minimal") return t("子代理 {0}", entries.length);
    if (density === "compact") {
      const running = entries.filter(({ agent }) => agent.status === "running").length;
      const completed = entries.filter(({ agent }) => agent.status === "completed").length;
      const failed = entries.filter(({ agent }) => agent.status === "failed").length;
      return t("子代理 {0} · {1}● {2}✓{3}", entries.length, running, completed, failed ? ` ${failed}✗` : "");
    }
    return [t("子代理"), ...entries.map(({ agent, depth }) => {
      const marker = agent.status === "running" ? "●" : agent.status === "completed" ? "✓" : agent.status === "failed" ? "✗" : "○";
      const details = [
        knownNumber(agent.tokens?.totalTokens) ? formatTokens(agent.tokens.totalTokens) : "",
        knownNumber(agent.context?.usedPercent) ? formatPercent(agent.context.usedPercent) : "",
      ].filter(Boolean).join(" · ");
      return `${"  ".repeat(Math.min(depth, 20))}${marker} ${plainText(knownText(agent.role) ? agent.role : agent.id)}${details ? `  ${details}` : ""}`;
    })].join("\n");
  },
};
