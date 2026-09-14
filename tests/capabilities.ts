import { readFile } from "node:fs/promises";
import { HudStateReducer } from "../src/core/HudStateReducer.js";
import { RolloutEventParser } from "../src/providers/codex/RolloutEventParser.js";
import { parseMcpConfiguration } from "../src/providers/codex/McpDiscovery.js";
import type { SkillState, SkillStatus } from "../src/core/SkillState.js";

export const capabilityFixture = (group: "mcp" | "skills", name: string): Promise<string> =>
  readFile(new URL(`./fixtures/${group}/${name}`, import.meta.url), "utf8");

export async function mcpResult(name = "tool-completed"): Promise<Record<string, any>> {
  return JSON.parse((await capabilityFixture("mcp", `${name}.jsonl`)).trim());
}

export async function mcpState() {
  const reducer = new HudStateReducer();
  reducer.mcp.replaceConfiguration({ status: "ready", servers: parseMcpConfiguration(await capabilityFixture("mcp", "multiple-servers.toml")) });
  for (const event of new RolloutEventParser().parse(await capabilityFixture("mcp", "tool-completed.jsonl")).events) reducer.apply(event);
  return reducer.getState(0);
}

export const skill = (id = "review", status: SkillStatus = "unknown"): SkillState =>
  ({ id, name: id, path: `/fixture/${id}/SKILL.md`, source: "user", status });
