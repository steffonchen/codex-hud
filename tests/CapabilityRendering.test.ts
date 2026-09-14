import { describe, expect, it } from "vitest";
import stringWidth from "string-width";
import { HudRenderer } from "../src/renderer/HudRenderer.js";
import { ModuleRegistry } from "../src/renderer/modules/ModuleRegistry.js";
import { createDefaultConfig } from "../src/config/Config.js";
import { McpTracker } from "../src/core/McpTracker.js";
import { SkillTracker } from "../src/core/SkillTracker.js";
import { HudStateReducer } from "../src/core/HudStateReducer.js";
import { CapabilityDetector } from "../src/capabilities/CapabilityDetector.js";
import { debugState, formatDebug } from "../src/cli/Diagnostics.js";
import { mcpState, skill } from "./capabilities.js";
import { testSessionSnapshot } from "./fixtures.js";

const config = () => { const value = createDefaultConfig(); value.display.enabled = ["mcp", "skills"]; return value; };
async function state() {
  const result = await mcpState(), skills = new SkillTracker();
  skills.replaceDirectory({ status: "ready", skills: [skill("代码审查", "available"), skill("测试", "unknown")] });
  result.skillSummary = skills.getSummary(); return result;
}

describe("MCP 与 Skills 展示和隐私", () => {
  it.each([[140, 24], [80, 16], [50, 10], [30, 6], [10, 4], [8, 1]])("%i×%i 遵守宽高预算且没有 ANSI", async (width, height) => {
    const output = new HudRenderer().render(await state(), { width, height }, config());
    expect(output).not.toMatch(/\x1b|undefined|NaN/u);
    expect(output.split("\n").length).toBeLessThanOrEqual(height);
    expect(output.split("\n").every(line => stringWidth(line) <= width)).toBe(true);
  });
  it("配置使用未连接标记，观测数量不冒充工具总数", async () => {
    const output = new HudRenderer().render(await state(), { width: 140, height: 24 }, config());
    expect(output).toContain("○ node_repl Configured"); expect(output).toContain("? codex_app Unknown status Observed 1");
    expect(output).not.toContain("1 tools"); expect(output).not.toContain("●");
  });
  it("未知技能不显示 active，可用技能也使用空心符号", async () => {
    const output = new HudRenderer().render(await state(), { width: 140, height: 24 }, config());
    expect(output).toContain("○ 代码审查 Available"); expect(output).toContain("Discovered in directory"); expect(output).not.toContain("Activity");
  });
  it("明确零数量仍可显示", () => {
    const mcp = new McpTracker(), skills = new SkillTracker(); mcp.replaceConfiguration({ status: "ready", servers: [] });
    skills.replaceDirectory({ status: "ready", skills: [] });
    expect(new HudRenderer().render({ mcpSummary: mcp.getSummary(), skillSummary: skills.getSummary() }, { width: 80, height: 24 }, config())).toContain("MCP 0");
  });
  it("归一化失败在极窄布局保留警示", () => {
    const mcp = new McpTracker(), skills = new SkillTracker();
    mcp.updateServer({ id: "a", name: "a", configured: false, status: "failed" }); skills.update(skill("review", "unavailable"));
    const output = new HudRenderer().render({ mcpSummary: mcp.getSummary(), skillSummary: skills.getSummary() }, { width: 10, height: 4 }, config());
    expect(output).toContain("M:1 !"); expect(output).toContain("S:1 !");
  });
  it("完整工具目录的明确零值不隐藏", () => {
    const mcp = new McpTracker(); mcp.updateServer({ id: "a", name: "a", configured: false, status: "ready", toolCount: 0 });
    expect(new HudRenderer().render({ mcpSummary: mcp.getSummary() }, { width: 140, height: 24 }, config())).toContain("0 tools");
  });
  it("大清单有省略提示，失败项优先", () => {
    const skills = new SkillTracker(); for (let i = 0; i < 50; i++) skills.update(skill(`item-${i}`)); skills.update(skill("error", "failed"));
    const output = new HudRenderer().render({ skillSummary: skills.getSummary() }, { width: 140, height: 24 }, config());
    expect(output).toContain("✗ error Failed"); expect(output).toContain("46 more items"); expect(output.split("\n").length).toBeLessThanOrEqual(7);
  });
  it("两个同名技能使用身份摘要消歧，路径不进入 HUD", () => {
    const skills = new SkillTracker(); skills.update({ ...skill("first-id"), name: "review" }); skills.update({ ...skill("other-id"), name: "review" });
    const output = new HudRenderer().render({ skillSummary: skills.getSummary() }, { width: 140, height: 24 }, config());
    expect(output).toContain("review#t-id"); expect(output).toContain("review#r-id"); expect(output).not.toContain("/fixture");
  });
  it("MCP 与 Skills 继续默认关闭", () => {
    expect(createDefaultConfig().display.enabled).not.toEqual(expect.arrayContaining(["mcp", "skills"]));
    expect(new ModuleRegistry().get("mcp")?.defaultEnabled).toBe(false); expect(new ModuleRegistry().get("skills")?.defaultEnabled).toBe(false);
  });
  it("独立发现不依赖 rollout 可读性", async () => {
    const snapshot = await testSessionSnapshot(); snapshot.read.status = "missing"; snapshot.state = await state();
    const report = new CapabilityDetector(() => { throw new Error("不得启动协议探测"); }).detectRollout(snapshot);
    expect(report.source).toBe("discovery");
    expect(report.modules.filter(module => ["mcp", "skills"].includes(module.id)).every(module => module.available)).toBe(true);
  });
  it("Current Activity 与 Tools 同时选择时，同一 MCP 调用只展示一次", () => {
    const reducer = new HudStateReducer(); reducer.apply({ type: "tool-started", toolId: "call", toolType: "mcp", at: 0,
      mcp: { serverId: "a", serverName: "github", toolName: "get_issue" } });
    const value = config(); value.display.enabled = ["tools", "current-activity"];
    const output = new HudRenderer().render(reducer.getState(0), { width: 140, height: 24 }, value, 0);
    expect(output).toContain("Current activity"); expect(output.match(/github\.get_issue/gu)).toHaveLength(1);
    value.display.enabled = ["tools"];
    expect(new HudRenderer().render(reducer.getState(0), { width: 140, height: 24 }, value, 0)).toContain("github.get_issue");
  });
  it("MCP 当前调用去重仍保留其他工具", () => {
    const reducer = new HudStateReducer(); reducer.apply({ type: "tool-started", toolId: "mcp", toolType: "mcp", mcp: { serverId: "a", serverName: "github", toolName: "read" } });
    reducer.apply({ type: "tool-started", toolId: "shell", name: "shell", toolType: "shell", inputSummary: "npm test" });
    const value = config(); value.display.enabled = ["tools", "current-activity"];
    const output = new HudRenderer().render(reducer.getState(0), { width: 140, height: 24 }, value, 0);
    expect(output).toContain("npm test"); expect(output.match(/github\.read/gu)).toHaveLength(1);
  });
  it("默认 debug 只有能力摘要，verbose 才有清单与路径摘要", async () => {
    const snapshot = await testSessionSnapshot(); snapshot.state = await state();
    snapshot.state.skillSummary!.skills[0].path = "/Users/private-user/secret-folder/review/SKILL.md";
    const display = { config: config(), terminal: { width: 140, height: 24 }, isTTY: false };
    const terse = formatDebug(snapshot, display), verbose = formatDebug(snapshot, { ...display, verbose: true });
    expect(terse).toContain("\"MCP discovery\""); expect(terse).not.toContain('"skillSummary"'); expect(terse).not.toContain("SKILL.md");
    expect(verbose).toContain('"skillSummary"'); expect(verbose).toContain("…/review/SKILL.md"); expect(verbose).not.toMatch(/private-user|secret-folder/u);
    expect(debugState(snapshot.state).skillSummary?.skills[0].path).toBeUndefined();
  });
  it.each([false, true])("debug verbose=%s 仍按白名单脱敏", async verbose => {
    const snapshot = await testSessionSnapshot(); snapshot.state = await state();
    Object.assign(snapshot.state.mcpSummary!.servers[0], { env: { key: "private-env" }, command: "private-command", error: "Authorization: Bearer private-error" });
    Object.assign(snapshot.state.skillSummary!.skills[0], { body: "private-body", description: "API_KEY=private-description" });
    Object.assign(snapshot.state.mcpSummary!.tools[0], { arguments: "private-input", result: "private-result" });
    const output = formatDebug(snapshot, { config: config(), terminal: { width: 140, height: 24 }, isTTY: false, verbose });
    expect(output).not.toMatch(/private-env|private-command|private-error|private-body|private-description|private-input|private-result/u);
  });
});
