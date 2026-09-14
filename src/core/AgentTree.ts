import { t } from "../i18n/Messages.js";
import type { AgentState } from "./AgentState.js";
import type { AgentNode } from "./HudState.js";

export interface AgentTreeNode {
  agent: AgentState;
  children: AgentTreeNode[];
}

export interface AgentTree {
  tree: AgentTreeNode[];
  orphans: AgentTreeNode[];
  issues: string[];
}

export function buildAgentTree(agents: readonly AgentState[]): AgentTree {
  const nodes = new Map<string, AgentTreeNode>();
  for (const agent of agents) if (!nodes.has(agent.id)) nodes.set(agent.id, { agent: structuredClone(agent), children: [] });
  const result: AgentTree = { tree: [], orphans: [], issues: [] };
  const visited = new Set<string>();
  const cycles = new Set<string>();
  // 每条父边只访问一次；环上的节点独立保留，不生成循环对象。
  for (const id of nodes.keys()) {
    const trail: string[] = [];
    const positions = new Map<string, number>();
    let cursor: string | undefined = id;
    while (cursor && nodes.has(cursor) && !visited.has(cursor)) {
      const repeated = positions.get(cursor);
      if (repeated !== undefined) {
        for (const member of trail.slice(repeated)) cycles.add(member);
        break;
      }
      positions.set(cursor, trail.length);
      trail.push(cursor);
      cursor = nodes.get(cursor)!.agent.parentId;
    }
    for (const member of trail) visited.add(member);
  }
  for (const node of nodes.values()) {
    const parent = node.agent.parentId && nodes.get(node.agent.parentId);
    if (cycles.has(node.agent.id)) {
      result.orphans.push(node);
      result.issues.push(t("代理父子关系存在环：{0}", node.agent.id));
    } else if (parent) parent.children.push(node);
    else if (node.agent.parentId || node.agent.isSubagent) {
      result.orphans.push(node);
      result.issues.push(t("发现孤立代理：{0}", node.agent.id));
    } else result.tree.push(node);
  }
  return result;
}

export function flattenAgentTree(roots: readonly AgentTreeNode[]): Array<{ agent: AgentState; depth: number }> {
  const pending = roots.map(node => ({ node, depth: 0 })).reverse();
  const result: Array<{ agent: AgentState; depth: number }> = [];
  const seen = new Set<string>();
  while (pending.length) {
    const { node, depth } = pending.pop()!;
    if (seen.has(node.agent.id)) continue;
    seen.add(node.agent.id);
    result.push({ agent: node.agent, depth });
    for (let index = node.children.length - 1; index >= 0; index--) pending.push({ node: node.children[index], depth: depth + 1 });
  }
  return result;
}

export function legacyAgentTree(roots: readonly AgentTreeNode[]): AgentNode[] {
  const result: AgentNode[] = [];
  const pending = roots.map(node => ({ node, target: result })).reverse();
  while (pending.length) {
    const { node, target } = pending.pop()!;
    const value = node.agent;
    const children: AgentNode[] = [];
    target.push({ id: value.id, parentId: value.parentId, status: value.status, role: value.name,
      model: value.model, reasoningEffort: value.reasoningEffort, startedAt: value.startedAt,
      endedAt: value.completedAt, tokens: value.tokens, context: value.context, children });
    for (let index = node.children.length - 1; index >= 0; index--) pending.push({ node: node.children[index], target: children });
  }
  return result;
}
