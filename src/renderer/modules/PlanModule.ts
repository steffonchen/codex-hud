import { t } from "../../i18n/Messages.js";
import type { HudModule, ModuleRenderContext } from "./HudModule.js";
import type { PlanState, PlanStepStatus } from "../../core/PlanState.js";
import { visibleProposal } from "../../core/PlanState.js";
import { redactSummary } from "../../core/Redaction.js";
import { WidthPolicy } from "../WidthPolicy.js";
import { knownText, planProgress } from "./helpers.js";
import { progressBar } from "../ProgressBar.js";

const symbols: Record<PlanStepStatus, string> = { completed: "✓", in_progress: "●", pending: "○", failed: "✗", cancelled: "⊘", unknown: "?" };
const stateLabels: Record<PlanState["status"], string> = { idle: "", get draft() { return t("待执行"); }, get approved() { return t("已批准"); }, executing: "",
  get completed() { return t("✓ 已完成"); }, get failed() { return t("✗ 失败"); }, get cancelled() { return t("⊘ 已取消"); }, get unknown() { return t("? 状态未确认"); } };

export function planHeading(plan: PlanState, width: number): string {
  const policy = new WidthPolicy();
  const ratio = `${plan.completedCount}/${plan.totalCount}`;
  const symbol = plan.status === "failed" ? "✗" : plan.status === "cancelled" ? "⊘" : plan.status === "unknown" ? "?" : plan.status === "completed" ? "✓" : "";
  const label = stateLabels[plan.status];
  const percent = width >= 60 && plan.progressPercent !== undefined ? ` ${Math.round(plan.progressPercent)}%` : "";
  const full = t("计划{0} {1}{2}", label ? ` · ${label}` : "", ratio, percent);
  const compact = `P ${symbol}${ratio}`;
  return policy.measure(full) <= width && width >= 40 ? full : policy.measure(compact) <= width ? compact : policy.fitLine(`${symbol}${ratio}`, width);
}

function renderPlan(plan: PlanState, { width, height = 24, maxRows = height, density }: ModuleRenderContext): string {
  const policy = new WidthPolicy();
  const fit = (value: string) => policy.fitLine(value, width);
  const rows = [planHeading(plan, width)];
  if (height < 5 || maxRows < 2 || width < 40 || !plan.steps.length) return rows[0];
  if (width < 60) {
    rows.push(fit((Object.keys(symbols) as PlanStepStatus[]).filter(status => plan.counts[status])
      .map(status => `${symbols[status]}${plan.counts[status]}`).join(" ")));
    return rows.join("\n");
  }
  const current = plan.currentStepPosition;
  if (height < 7 || density === "minimal") {
    if (current !== undefined && plan.steps[current]) rows.push(fit(`● ${redactSummary(plan.steps[current].title)}`));
    return rows.join("\n");
  }
  const available = Math.min(Math.max(0, maxRows - 1), height < 10 ? 3 : plan.steps.length);
  const limited = available < plan.steps.length;
  const count = Math.max(1, available - (limited && available > 1 ? 1 : 0));
  const anchor = current ?? (plan.status === "completed" ? plan.steps.length - 1 : 0);
  const start = Math.max(0, Math.min(anchor - Math.floor(count / 2), plan.steps.length - count));
  for (const step of plan.steps.slice(start, start + count)) rows.push(fit(`${symbols[step.status]} ${redactSummary(step.title)}`));
  if (limited && rows.length < maxRows) rows.push(fit(t("… 另有 {0} 步", plan.steps.length - count)));
  return rows.join("\n");
}

export const planModule: HudModule = {
  id: "plan", get label() { return t("计划"); }, get category() { return t("活动"); }, defaultEnabled: true, priority: 65,
  isAvailable(state) {
    const summary = state.planSummary;
    return summary ? !!visibleProposal(summary) || (!!summary.execution && summary.execution.status !== "idle") || summary.mode?.active === true
      : planProgress(state) !== undefined;
  },
  render(state, context) {
    const summary = state.planSummary;
    if (summary) {
      const proposal = visibleProposal(summary);
      if (proposal) return new WidthPolicy().fitLine(proposal.status === "streaming" ? t("计划提案 · 生成中") : t("计划提案 · 待确认"), context.width);
      if (summary.execution && summary.execution.status !== "idle") return renderPlan(summary.execution, context);
      return summary.mode?.active ? new WidthPolicy().fitLine(t("计划模式"), context.width) : "";
    }
    const plan = planProgress(state);
    if (!plan) return "";
    const current = state.plan?.items?.find(item => item.status === "in_progress");
    const progress = context.density === "full" ? `${progressBar(plan.total ? plan.completed / plan.total * 100 : 0, 16)} ` : "";
    const detail = context.density === "full" && knownText(current?.text) ? `\n${redactSummary(current.text)}` : "";
    return t("计划 {0}{1}/{2}{3}", progress, plan.completed, plan.total, detail);
  },
};
