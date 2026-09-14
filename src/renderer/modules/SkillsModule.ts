import { t } from "../../i18n/Messages.js";
import type { HudModule } from "./HudModule.js";
import type { SkillStatus } from "../../core/SkillState.js";
import { redactSummary } from "../../core/Redaction.js";
import { WidthPolicy } from "../WidthPolicy.js";

const labels: Record<SkillStatus, string> = { get available() { return t("可用"); }, get loaded() { return t("已加载"); }, get active() { return t("活动"); }, get disabled() { return t("已禁用"); }, get failed() { return t("失败"); }, get unavailable() { return t("不可用"); }, get unknown() { return t("目录发现"); } };
const icons: Record<SkillStatus, string> = { available: "○", loaded: "◐", active: "●", disabled: "⊘", failed: "✗", unavailable: "✗", unknown: "○" };
const priority: Record<SkillStatus, number> = { failed: 0, unavailable: 0, active: 1, loaded: 2, available: 3, unknown: 4, disabled: 5 };

export const skillsModule: HudModule = {
  id: "skills", get label() { return t("技能"); }, get category() { return t("高级"); }, defaultEnabled: false, priority: 30,
  isAvailable: state => state.skillSummary ? state.skillSummary.enabled && (state.skillSummary.count > 0 || state.skillSummary.directoryStatus !== "missing") : !!state.skills?.length,
  render(state, { density, width, maxRows }) {
    const summary = state.skillSummary;
    if (!summary) {
      const skills = state.skills ?? [];
      if (density !== "full") return t("技能 {0}/{1}", skills.filter(skill => skill.enabled).length, skills.length);
      return t("技能 {0}", skills.map(skill => `${skill.enabled ? "✓" : "○"} ${redactSummary(skill.name, 100)}`).join(" · "));
    }
    const policy = new WidthPolicy();
    const alert = summary.failedCount ? ` ✗${summary.failedCount}` : "";
    if (!summary.count && summary.directoryStatus === "error") return policy.fitLine(t("技能 来源不可读"), width);
    if (density === "minimal" || (maxRows ?? 2) < 2) return policy.fitLine(width < 20 ? `S:${summary.count}${summary.failedCount ? " !" : ""}`
      : t("技能 {0}{1}{2}", summary.count, summary.activeCount ? t(" ●{0}活动", summary.activeCount) : "", alert), width);
    const skills = [...summary.skills].sort((a, b) => priority[a.status] - priority[b.status] || a.name.localeCompare(b.name));
    const limit = Math.max(0, Math.min(density === "full" ? 5 : 2, (maxRows ?? 7) - 2));
    const names = new Map<string, number>();
    for (const skill of skills) names.set(skill.name, (names.get(skill.name) ?? 0) + 1);
    const rows = skills.slice(0, limit).map(skill => policy.fitLine(`${icons[skill.status]} ${redactSummary(skill.name, 100)}${names.get(skill.name)! > 1 ? `#${skill.id.slice(-4)}` : ""} ${labels[skill.status]}`, width));
    return [t("技能 {0}{1}", summary.count, alert), ...rows, ...(skills.length > limit ? [t("… 另 {0} 项", skills.length - limit)] : [])].join("\n");
  },
};
