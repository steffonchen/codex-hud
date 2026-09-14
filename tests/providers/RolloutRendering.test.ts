import { describe, expect, it } from "vitest";
import { readFile } from "node:fs/promises";
import stringWidth from "string-width";
import { HudStateReducer } from "../../src/core/HudStateReducer.js";
import { RolloutEventParser } from "../../src/providers/codex/RolloutEventParser.js";
import { createDefaultConfig } from "../../src/config/Config.js";
import { HudRenderer } from "../../src/renderer/HudRenderer.js";
import { ModuleRegistry } from "../../src/renderer/modules/ModuleRegistry.js";

async function state() {
  const parser = new RolloutEventParser();
  const reducer = new HudStateReducer();
  for (const name of ["rollout-session.jsonl", "rollout-token-count.jsonl"]) {
    const source = await readFile(new URL(`../fixtures/codex/${name}`, import.meta.url), "utf8");
    for (const line of source.split("\n")) for (const event of parser.parse(line).events) reducer.apply(event);
  }
  return reducer.getState(Date.parse("2026-09-11T09:00:00Z"));
}

describe("真实 rollout 状态渲染", () => {
  it("Context 与累计 Token 分别显示，保留最近活动和剩余容量", async () => {
    const config = createDefaultConfig();
    config.display.enabled = ["model", "reasoning", "context", "session", "token-details", "cache", "agents", "tools"];
    const current = await state();
    const output = new HudRenderer().render(current, { width: 140, height: 30 }, config);
    for (const value of ["gpt-6-astra", "high", "7%", "19K/258K", "Remaining 239K", "1 turns", "Last activity", "Input 6.4M", "Total 6.5M"]) expect(output).toContain(value);
    for (const id of ["cache", "agents", "tools", "plan", "cost", "mcp", "skills"]) {
      expect(new ModuleRegistry().get(id)!.isAvailable(current)).toBe(false);
    }
    config.display.enabled = ["model", "context"];
    expect(new HudRenderer().render(current, { width: 140, height: 30 }, config)).not.toContain("Token");
  });

  it.each([140, 80, 50, 30])("真实字段在 %i 列仍由现有布局适配", async width => {
    const config = createDefaultConfig();
    config.display.enabled = ["model", "reasoning", "context", "session", "token-details"];
    const output = new HudRenderer().render(await state(), { width, height: 24 }, config);
    expect(output).toContain("7%");
    expect(output.split("\n").every(line => stringWidth(line) <= width)).toBe(true);
  });

  it("独立 tokenUsage 优先于旧字段，并保留 Phase 1 接口", () => {
    const module = new ModuleRegistry().get("token-details")!;
    expect(module.render({ tokenUsage: { totalTokens: 100 }, context: { totalTokens: 10 } }, { width: 80, density: "compact" })).toContain("Total 100");
    expect(module.render({ context: { totalTokens: 10 } }, { width: 80, density: "compact" })).toContain("Total 10");
  });
});
