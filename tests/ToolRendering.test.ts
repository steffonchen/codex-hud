import { describe, expect, it } from "vitest";
import stringWidth from "string-width";
import { createDefaultConfig } from "../src/config/Config.js";
import { HudRenderer } from "../src/renderer/HudRenderer.js";
import { ModuleRegistry } from "../src/renderer/modules/ModuleRegistry.js";
import { formatToolSummary, toolDuration } from "../src/renderer/Formatter.js";
import type { HudState, ToolActivity } from "../src/core/HudState.js";
import { toolActivity } from "../src/core/ActivityTracker.js";

const tool: ToolActivity = { id: "shell", name: "shell", type: "shell", status: "running", startedAt: 1000,
  inputSummary: "npm run test -- 中文👩‍💻é".repeat(20) };
const registry = new ModuleRegistry();

describe("工具与当前活动展示", () => {
  it.each([140, 100, 80, 60, 50, 40])("%i 列不会溢出、损坏字素或输出 ANSI", width => {
    const config = createDefaultConfig();
    config.display.enabled = ["tools", "current-activity"];
    const state: HudState = { tools: { active: [tool] }, activity: toolActivity(tool) };
    const output = new HudRenderer().render(state, { width, height: 20 }, config, 6000);
    expect(output.split("\n").every(line => stringWidth(line) <= width)).toBe(true);
    expect(output).not.toMatch(/\x1b|NaN|undefined|\uFFFD/u);
    expect(output).toContain("npm run test");
    expect(state.tools?.active?.[0].durationMs).toBeUndefined();
  });

  it("宽屏只选一个当前活动，命令摘要截断后仍保留耗时", () => {
    const state: HudState = { tools: { active: [tool, { ...tool, id: "search", type: "search", inputSummary: "src/" }] } };
    const output = registry.get("current-activity")!.render(state, { width: 100, density: "full", now: 6000 });
    expect(output).toContain("Executing");
    expect(output).toContain("5s");
    expect(output).not.toContain("src/");
    expect(output).toContain("…");
  });

  it("空工具、明确 idle 和没有证据的 unknown 都不产生占位", () => {
    expect(registry.get("tools")!.isAvailable({ tools: { active: [], recent: [], counts: {} } })).toBe(false);
    expect(registry.get("current-activity")!.isAvailable({ activity: { status: "idle" } })).toBe(false);
    expect(registry.get("current-activity")!.isAvailable({ activity: { status: "unknown" } })).toBe(false);
  });

  it.each([["completed", "✓"], ["failed", "✗"], ["cancelled", "⊘"], ["unknown", "?"]] as const)("%s 使用真实终态标记", (status, icon) => {
    const complete = { ...tool, status, completedAt: 4000, durationMs: 3000, inputSummary: "npm test" };
    expect(formatToolSummary(complete, 40, { now: 50_000 })).toBe(`${icon} npm test · 3s`);
    const activity = registry.get("current-activity")!.render({ activity: toolActivity(complete) }, { width: 80, density: "full" });
    expect(activity).not.toContain("Executing");
  });

  it("展示时动态计算运行时长，不回写状态，非法时间不显示 NaN", () => {
    expect(toolDuration(tool, 6000)).toBe(5000);
    expect(toolDuration({ ...tool, startedAt: undefined }, 6000)).toBeUndefined();
    expect(formatToolSummary({ ...tool, startedAt: Infinity }, 40)).not.toContain("NaN");
    expect(tool.durationMs).toBeUndefined();
  });

  it("格式化入口统一脱敏，终端控制字符不能破坏 HUD", () => {
    const output = formatToolSummary({ ...tool, inputSummary: 'curl --token private-token \x1b[2J' }, 80, { now: 6000 });
    expect(output).not.toContain("private-token");
    expect(output).not.toContain("\x1b");
  });

  it("空间不足时当前活动比普通 Tools 优先，旧配置不会自动加入活动模块", () => {
    const config = createDefaultConfig();
    config.display.enabled = ["tools", "current-activity"];
    const state = { tools: { active: [{ ...tool, inputSummary: "npm test" }] } };
    expect(new HudRenderer().render(state, { width: 40, height: 1 }, config, 6000)).toContain("npm test");
    config.display.enabled = ["model"];
    expect(new HudRenderer().render({ ...state, model: "模型" }, { width: 100, height: 20 }, config)).toBe("模型");
  });
});
