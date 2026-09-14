import { describe, expect, it } from "vitest";
import stringWidth from "string-width";
import { LayoutEngine } from "../src/renderer/LayoutEngine.js";
import { ModuleRegistry } from "../src/renderer/modules/ModuleRegistry.js";
import type { HudModule } from "../src/renderer/modules/HudModule.js";
import { mockState } from "../src/demo/mockState.js";

const engine = new LayoutEngine();
const registry = new ModuleRegistry();
const state = mockState(0);
// 固定原有模块组合，避免新增默认模块改变这组布局基线。
const modules = registry.resolve(["model", "reasoning", "context", "five-hour-usage", "weekly-usage", "agents", "tools", "plan", "git"]);

describe("LayoutEngine", () => {
  it.each([140, 80, 50, 30])("在 %i 列内保持宽高约束和关键用量", width => {
    const layout = engine.layout(state, { width, height: 24 }, modules);
    expect(layout.lines.length).toBeLessThanOrEqual(24);
    expect(layout.lines.every(line => stringWidth(line) <= width)).toBe(true);
    expect(layout.lines.join("\n")).toContain("74%");
    expect(layout.lines.join("\n")).toContain("91%");
    expect(layout.lines.join("\n")).toContain("72%");
    expect(layout.moduleIds).toContain("model");
  });

  it("140 列保留完整细节，80 列聚合统计，50 和 30 列优先隐藏次要模块", () => {
    const wide = engine.layout(state, { width: 140, height: 40 }, modules);
    expect(wide.density).toBe("full");
    expect(wide.hiddenModuleIds).toEqual([]);
    expect(wide.lines.join("\n")).toContain("explorer  32K · 32%");
    expect(wide.lines.join("\n")).toContain("Read×24");
    const medium = engine.layout(state, { width: 80, height: 24 }, modules);
    expect(medium.density).toBe("compact");
    expect(medium.lines.join("\n")).toContain("Tools 58");
    expect(medium.lines).toContain("5h 91% · 7d 72%");
    const narrow = engine.layout(state, { width: 50, height: 24 }, modules);
    expect(narrow.lines).toHaveLength(4);
    expect(narrow.moduleIds).toContain("agents");
    expect(narrow.hiddenModuleIds).toEqual(["tools", "plan", "git"]);
    const smallest = engine.layout(state, { width: 30, height: 24 }, modules);
    expect(smallest.lines).toHaveLength(4);
    expect(smallest.lines).toContain("5h 91%");
    expect(smallest.lines).toContain("7d 72%");
    expect(smallest.hiddenModuleIds).toEqual(["agents", "tools", "plan", "git"]);
  });

  it("高度不足时先压缩，再从最低优先级开始隐藏", () => {
    const layout = engine.layout(state, { width: 140, height: 1 }, modules);
    expect(layout.moduleIds).toEqual(["context"]);
    expect(layout.lines).toHaveLength(1);
    expect(layout.density).toBe("minimal");
  });

  it("显示顺序不改变模块的重要性，未选择的高优先级模块不会被补入", () => {
    const selected = registry.resolve(["git", "model", "context"], ["git", "model", "context"]);
    expect(engine.layout(state, { width: 140, height: 24 }, selected).moduleIds).toEqual(["git", "model", "context"]);
    expect(engine.layout(state, { width: 140, height: 2 }, selected).moduleIds).toEqual(["model", "context"]);
    expect(engine.layout(state, { width: 140, height: 1 }, registry.resolve(["git"])).moduleIds).toEqual(["git"]);
  });

  it("同优先级时稳定保留显示顺序靠前的模块", () => {
    const custom = (id: string): HudModule => ({ id, label: id, category: "测试", defaultEnabled: true, priority: 1, isAvailable: () => true, render: () => id });
    expect(engine.layout({}, { width: 140, height: 1 }, [custom("first"), custom("second")]).moduleIds).toEqual(["first"]);
  });

  it("关闭自动压缩后保持完整密度，同时遵守终端边界", () => {
    const layout = engine.layout(state, { width: 30, height: 40 }, modules, false);
    expect(layout.density).toBe("full");
    expect(layout.hiddenModuleIds).toEqual([]);
    expect(layout.lines.every(line => stringWidth(line) <= 30)).toBe(true);
  });

  it.each([{ width: 140, height: 0 }, { width: 0, height: 30 }, { width: 1, height: 30 }, { width: 7, height: 30 }])("不可读或没有空间时不输出省略号占位：%o", terminal => {
    const layout = engine.layout(state, terminal, modules);
    expect(layout.lines).toEqual([]);
    expect(layout.moduleIds).toEqual([]);
  });
});
