import { t } from "../../i18n/Messages.js";
import { emptyPlanCapability, type PlanCapability, type PlanEvidence, type PlanSummary } from "../../core/PlanState.js";
import type { RolloutReadResult } from "./RolloutReader.js";
import type { CodexCheck } from "./Diagnostics.js";
import type { SourceStatus } from "../../core/source/DataSource.js";

export const planEvidenceLabel = (value: PlanEvidence): string => ({ available: t("可用"), unsupported: t("未支持"),
  "not-observed": t("未观测"), disabled: t("已关闭"), unavailable: t("来源不可用"), partial: t("部分可用") })[value];

export function discoverRolloutPlan(summary: PlanSummary | undefined, read: RolloutReadResult["status"], unverified = false): PlanCapability {
  const capability = summary ? { ...summary.capability } : emptyPlanCapability();
  if (read !== "ready") {
    capability.available = false;
    for (const key of Object.keys(capability) as Array<keyof PlanCapability>) if (key !== "available") capability[key] = "unavailable";
  } else if (unverified) capability.planEvents = "partial";
  return capability;
}

export function planChecks(summary: PlanSummary, appServer?: SourceStatus): CodexCheck[] {
  const capability = summary.capability;
  const fields: Array<[keyof Omit<PlanCapability, "available">, string, string]> = [
    ["planEvents", t("计划事件"), t("执行清单只采用已确认的来源")],
    ["stepStatuses", t("计划步骤"), t("进度只统计已完成步骤")],
    ["planMode", t("计划模式"), summary.mode ? summary.mode.active ? t("当前为 Plan Mode") : t("当前为普通模式") : t("模式未确认")],
    ["planDelta", t("计划提案增量"), t("文本增量不代表步骤状态变化")],
    ["approvalState", t("计划批准"), t("提案存在或模式切换不证明已经批准")],
    ["completionState", t("计划完成"), t("仅依据明确计划终态或全部步骤完成")],
    ["agentAssociation", t("代理与计划"), t("仅依据明确的子线程身份")],
  ];
  return [{ id: "plan-source", label: t("计划来源"), ok: capability.available, warning: true,
    detail: capability.available ? t("{0}；已确认计划数据", summary.execution?.source ?? summary.proposal?.source ?? "rollout")
      : t("{0}；未观测不表示 Codex 不支持", planEvidenceLabel(capability.planEvents)) },
    ...fields.map(([key, label, detail]): CodexCheck => ({ id: `plan-${key}`, label, ok: capability[key] === "available", warning: true,
      detail: `${planEvidenceLabel(capability[key])}（${capability[key]}）；${detail}` })),
    { id: "plan-app-server", label: t("App Server 计划订阅"), ok: appServer?.live === true, warning: true,
      detail: appServer?.live ? t("已接入实时来源；结构化计划是否出现取决于当前轮次") : appServer ? t("实时订阅不可用；{0}", appServer.reason ?? appServer.state) : t("未启用；使用 Rollout 已确认的计划") }];
}
