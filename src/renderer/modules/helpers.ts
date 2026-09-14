import type { AgentNode, HudState } from "../../core/HudState.js";
import { formatTokens } from "../Formatter.js";
import { plainText } from "../WidthPolicy.js";

export const knownNumber = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value) && value >= 0;

export const knownText = (value: unknown): value is string =>
  typeof value === "string" && plainText(value).length > 0;

export function contextPercent(state: HudState): number | undefined {
  const context = state.context;
  if (knownNumber(context?.usedPercent)) return context.usedPercent;
  if (knownNumber(context?.usedTokens) && knownNumber(context?.contextWindow) && context.contextWindow > 0) {
    return context.usedTokens / context.contextWindow * 100;
  }
  return undefined;
}

export function contextTokens(state: HudState): string {
  const context = state.context;
  if (!knownNumber(context?.usedTokens)) return "";
  return knownNumber(context?.contextWindow) && context.contextWindow > 0
    ? `${formatTokens(context.usedTokens)}/${formatTokens(context.contextWindow)}`
    : formatTokens(context.usedTokens);
}

export function agentEntries(agents: AgentNode[] = []): Array<{ agent: AgentNode; depth: number }> {
  const result: Array<{ agent: AgentNode; depth: number }> = [];
  const pending = agents.map(agent => ({ agent, depth: 0 })).reverse();
  const visited = new Set<string>();
  while (pending.length) {
    const entry = pending.pop()!;
    if (visited.has(entry.agent.id)) continue;
    visited.add(entry.agent.id);
    result.push(entry);
    for (const child of [...(entry.agent.children ?? [])].reverse()) {
      pending.push({ agent: child, depth: entry.depth + 1 });
    }
  }
  return result;
}

export function toolCounts(state: HudState): Array<[string, number]> {
  return Object.entries(state.tools?.counts ?? {})
    .filter(([name, count]) => knownText(name) && knownNumber(count))
    .sort((a, b) => b[1] - a[1]);
}

export function runningTools(state: HudState) {
  return (state.tools?.active ?? []).filter(tool => tool.status === "running" && knownText(tool.name));
}

export function planProgress(state: HudState): { completed: number; total: number } | undefined {
  const plan = state.plan;
  if (plan?.items?.length) {
    return { completed: plan.items.filter(item => item.status === "completed").length, total: plan.items.length };
  }
  if (knownNumber(plan?.total) && knownNumber(plan.completed) && plan.completed <= plan.total) {
    return { completed: plan.completed, total: plan.total };
  }
  return undefined;
}
