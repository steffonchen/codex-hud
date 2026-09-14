import { t } from "../../i18n/Messages.js";
import { flattenAgentTree, type AgentTreeNode } from "../../core/AgentTree.js";
import { isActiveAgent, type AgentState, type AgentSummary } from "../../core/AgentState.js";
import { redactSummary } from "../../core/Redaction.js";
import { formatDuration, formatPercent } from "../Formatter.js";
import { WidthPolicy } from "../WidthPolicy.js";
import type { ModuleRenderContext } from "./HudModule.js";
import { planHeading } from "./PlanModule.js";

const symbols: Record<AgentState["status"], string> = { starting: "◷", running: "●", waiting: "○", completed: "✓", failed: "✗", cancelled: "⊘", unknown: "?" };

export function renderAgentTree(summary: AgentSummary, { width, height = 24, maxRows = height, density, now = Date.now() }: ModuleRenderContext): string {
  const policy = new WidthPolicy();
  const fit = (text: string) => policy.fitLine(text, width);
  const status = `●${summary.activeCount}${summary.failedCount ? ` ✗${summary.failedCount}` : ""}`;
  const heading = t("代理 {0} {1}{2}", summary.count, status, summary.cancelledCount ? ` ⊘${summary.cancelledCount}` : "");
  const compact = `A:${summary.count} ${status}`;
  const title = policy.measure(heading) <= width ? heading : policy.measure(compact) <= width ? compact : status.replace(/ /gu, "");
  if (height < 5 || maxRows < 3 || width < 24) return fit(title);

  const roots = [...summary.tree, ...summary.orphans];
  const all = flattenAgentTree(roots);
  const names = new Map<string, string>();
  const duplicates = new Map<string, number>();
  for (const { agent } of all) if (agent.name) duplicates.set(agent.name, (duplicates.get(agent.name) ?? 0) + 1);
  const used = new Set<string>();
  for (const { agent } of all) {
    const base = agent.id === summary.rootId ? t("主代理") : redactSummary(agent.name ?? agent.agentType ?? t("代理"), 80);
    let label = base;
    let suffix = 4;
    if ((!agent.name && agent.id !== summary.rootId) || (agent.name && duplicates.get(agent.name)! > 1) || used.has(label)) label = `${base}-${agent.id.slice(-suffix)}`;
    while (used.has(label) && suffix < agent.id.length) label = `${base}-${agent.id.slice(-++suffix)}`;
    used.add(label); names.set(agent.id, label);
  }

  const recent = all.filter(({ agent }) => agent.id !== summary.rootId && ["completed", "cancelled"].includes(agent.status))
    .sort((a, b) => (b.agent.completedAt ?? 0) - (a.agent.completedAt ?? 0)).slice(0, height >= 8 ? 5 : 0);
  const visible = new Set([...recent.map(({ agent }) => agent.id), ...all.filter(({ agent }) => agent.id === summary.rootId
    || isActiveAgent(agent) || agent.status === "failed" || agent.status === "unknown").map(({ agent }) => agent.id)]);
  const byId = new Map(all.map(({ agent }) => [agent.id, agent]));
  for (const id of visible) { const parent = byId.get(id)?.parentId; if (parent && byId.has(parent)) visible.add(parent); }
  const important = new Set(all.filter(({ agent }) => isActiveAgent(agent) || agent.status === "failed").map(({ agent }) => agent.id));
  for (const id of important) { const parent = byId.get(id)?.parentId; if (parent && byId.has(parent)) important.add(parent); }
  const order = (nodes: readonly AgentTreeNode[]) => [...nodes.filter(node => important.has(node.agent.id)), ...nodes.filter(node => !important.has(node.agent.id))].filter(node => visible.has(node.agent.id));
  const maxDepth = height >= 12 ? 4 : height >= 8 ? 2 : 1;
  const rows = [fit(title)];
  const orderedRoots = order(roots);
  const pending = orderedRoots.map((node, index) => ({ node, depth: 0, prefix: "", last: index === orderedRoots.length - 1 })).reverse();
  let displayed = 0;
  while (pending.length && rows.length < maxRows) {
    const { node, depth, prefix: ancestors, last } = pending.pop()!;
    const agent = node.agent;
    const prefix = `${ancestors}${depth ? last ? "└─ " : "├─ " : ""}${symbols[agent.status]} `;
    const childPrefix = depth ? `${ancestors}${last ? "   " : "│  "}` : "";
    const context = density === "minimal" ? "" : `${density === "full" ? t("上下文 ") : ""}${formatPercent(agent.context?.usedPercent)}`;
    const duration = agent.startedAt === undefined ? "" : formatDuration(Math.max(0, (isActiveAgent(agent) ? now : agent.completedAt ?? agent.startedAt) - agent.startedAt));
    const mcp = agent.activity?.mcp;
    const activity = agent.status === "waiting" ? t("等待代理") : agent.activity?.status === "idle" ? ""
      : mcp ? `${agent.activity?.label ?? ""} MCP ${mcp.serverName}.${mcp.toolName}`.trim() : agent.activity?.label;
    const plan = agent.plan && agent.plan.threadId === agent.id && agent.plan.status !== "idle" ? agent.plan : undefined;
    const detail = [density !== "full" && plan ? planHeading(plan, Math.min(width, 30)) : "",
      context, density === "full" ? duration : "", density === "compact" ? activity : ""].filter(Boolean).join("  ");
    const nameWidth = Math.max(4, width - policy.measure(prefix) - policy.measure(detail) - 2);
    rows.push(fit(`${prefix}${policy.fitLine(names.get(agent.id)!, nameWidth)}${detail ? `  ${detail}` : ""}`));
    displayed++;
    if (density === "full" && plan && rows.length + pending.length + node.children.length < maxRows) rows.push(fit(`${childPrefix}  └─ ${planHeading(plan, width - policy.measure(childPrefix) - 5)}`));
    if (density === "full" && activity && rows.length + pending.length + node.children.length + 1 < maxRows) rows.push(fit(`${childPrefix}  └─ ${redactSummary(activity, 80)}`));
    if (depth + 1 < maxDepth) {
      const children = order(node.children);
      for (let index = children.length - 1; index >= 0; index--) pending.push({ node: children[index], depth: depth + 1, prefix: childPrefix, last: index === children.length - 1 });
    } else if (node.children.length && rows.length < maxRows) rows.push(fit(t("{0}└─ … 更深层代理", childPrefix)));
  }
  const omitted = all.length - displayed;
  if (omitted > 0 && rows.length < maxRows) rows.push(fit(t("… 另有 {0} 个代理", omitted)));
  return rows.join("\n");
}
