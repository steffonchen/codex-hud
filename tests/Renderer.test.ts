import { describe, expect, it } from "vitest";
import stringWidth from "string-width";
import { HudRenderer } from "../src/renderer/index.js";
import { ModuleRegistry } from "../src/renderer/modules/ModuleRegistry.js";
import { createDefaultConfig } from "../src/config/Config.js";
import { emptyHudState, type HudState } from "../src/core/HudState.js";
import { mockState } from "../src/demo/mockState.js";

const renderer = new HudRenderer();
const wide = { width: 140, height: 50 };

describe("HudRenderer", () => {
  it("默认模块保留模型、上下文、额度、工具统计和 Git dirty 标记", () => {
    const output = renderer.render(mockState(0), wide, createDefaultConfig());
    for (const value of ["GPT-5.6 Sol", "xhigh", "74%", "191K/258K", "91%", "72%", "Read×24", "main *"]) {
      expect(output).toContain(value);
    }
    expect(output).toContain("Plan");
    expect(output).toContain("8/10");
    expect(output).not.toContain("Session");
  });

  it("不会输出未选择或没有可用数据的模块", () => {
    const config = createDefaultConfig();
    config.display.enabled = ["model", "plan", "cost", "skills", "mcp"];
    expect(renderer.render({ model: "测试模型" }, wide, config)).toBe("测试模型");
    expect(renderer.render(emptyHudState(), wide, config)).toBe("");
    config.display.enabled = [];
    expect(renderer.render(mockState(0), wide, config)).toBe("");
  });

  it("有真实字段时高级模块能渲染，费用不会由 Token 数量推算", () => {
    const config = createDefaultConfig();
    config.display.enabled = ["mcp", "skills", "token-details", "cost", "cache", "plan", "session", "current-activity"];
    const state: HudState = {
      ...mockState(0),
      mcp: [{ name: "文档服务", status: "connected", toolCount: 3 }],
      skills: [{ name: "代码检查", enabled: true }],
      cost: { amount: 1.25, currency: "USD", estimated: true },
    };
    const output = renderer.render(state, wide, config);
    for (const value of ["文档服务", "代码检查", "Input 119K", "Cached input 101K", "Estimated cost USD 1.25", "8/10", "12m 38s", "Checking module layout"]) {
      expect(output).toContain(value);
    }
    delete state.cost;
    expect(renderer.render(state, wide, config)).not.toMatch(/cost/iu);
  });

  it("子代理树保留层级，重复 ID 不重复计数", () => {
    const child = { id: "child", status: "running" as const };
    const state: HudState = { agents: [{ id: "parent", status: "running", children: [child] }, { ...child }] };
    const config = createDefaultConfig();
    config.display.enabled = ["agents"];
    const output = renderer.render(state, wide, config);
    expect(output).toContain("  ● child");
    expect(output.match(/child/gu)).toHaveLength(1);
    expect(renderer.render(state, { width: 50, height: 24 }, config)).toBe("Agents 2");
  });

  it("计划条目优先于旧计数，零任务计划不会产生 NaN", () => {
    const config = createDefaultConfig();
    config.display.enabled = ["plan"];
    const output = renderer.render({ plan: { completed: 8, total: 10, items: [
      { text: "已完成", status: "completed" }, { text: "正在验证", status: "in_progress" },
    ] } }, wide, config);
    expect(output).toContain("1/2");
    expect(output).toContain("正在验证");
    const zero = renderer.render({ plan: { completed: 0, total: 0 } }, wide, config);
    expect(zero).toContain("0/0");
    expect(zero).not.toMatch(/NaN|—/u);
  });

  it("只有明确的空闲状态才触发 hide_when_idle", () => {
    const config = createDefaultConfig();
    config.behavior.hide_when_idle = true;
    expect(renderer.render({ model: "模型", activity: { status: "idle" } }, wide, config)).toBe("");
    expect(renderer.render({ model: "模型" }, wide, config)).toBe("模型");
    expect(renderer.render({ model: "模型", activity: { status: "waiting" } }, wide, config)).toBe("模型");
  });

  it("超长中文及 emoji 内容在所有指定宽度内保持安全", () => {
    const state = mockState(0);
    state.model = "中文模型👩‍💻".repeat(20);
    state.git = { branch: "分支\x1b[2J名称".repeat(20), dirty: true };
    const config = createDefaultConfig();
    config.display.enabled = new ModuleRegistry().all().map(module => module.id);
    for (const width of [140, 80, 50, 30, 8]) {
      const output = renderer.render(state, { width, height: 24 }, config);
      expect(output).not.toContain("\x1b");
      expect(output.split("\n").every(line => stringWidth(line) <= width)).toBe(true);
    }
  });
});
