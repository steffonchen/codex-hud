import { readFile } from "node:fs/promises";
import { HudStateReducer } from "../src/core/HudStateReducer.js";
import { RolloutEventParser } from "../src/providers/codex/RolloutEventParser.js";
import { flattenAgentTree } from "../src/core/AgentTree.js";
import type { HudEvent } from "../src/core/HudEvent.js";

export async function agentFixture(name: string): Promise<string[]> {
  return (await readFile(new URL(`./fixtures/agents/${name}.jsonl`, import.meta.url), "utf8")).trimEnd().split("\n");
}

export async function agentEvents(name: string): Promise<HudEvent[]> {
  const parser = new RolloutEventParser();
  return (await agentFixture(name)).flatMap((line, index) => parser.parse(line, index + 1).events);
}

export async function agentState(children = ["parallel-a", "parallel-b"]) {
  const reducer = new HudStateReducer();
  for (const event of await agentEvents("parallel-agents")) reducer.apply(event);
  for (const file of children) {
    const thread = new HudStateReducer(false);
    for (const event of await agentEvents(file)) {
      if (event.type.startsWith("agent-")) reducer.apply(event);
      else thread.apply(event);
    }
    const state = thread.getState(Date.now());
    reducer.agents.updateThread(state.session!.id!, state);
  }
  return reducer.getState(Date.now());
}

export const agentsOf = (state: Awaited<ReturnType<typeof agentState>>) =>
  flattenAgentTree([...(state.agentSummary?.tree ?? []), ...(state.agentSummary?.orphans ?? [])]).map(entry => entry.agent);
