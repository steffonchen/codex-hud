import { describe, expect, it } from "vitest";
import { ModuleRegistry } from "../src/renderer/modules/ModuleRegistry.js";
import { emptyHudState, type HudState } from "../src/core/HudState.js";
import { mockState } from "../src/demo/mockState.js";

const registry = new ModuleRegistry();

describe("ModuleRegistry", () => {
  it("注册全部 17 个模块，默认开启包含计划、Token 和 Cache 的十一个推荐模块", () => {
    expect(registry.all().map(module => module.id)).toEqual([
      "model", "reasoning", "context", "five-hour-usage", "weekly-usage", "agents", "tools", "current-activity",
      "plan", "session", "git", "mcp", "skills", "token-details", "cost", "cache", "runtime-status",
    ]);
    expect(registry.defaultEnabled()).toEqual(["model", "reasoning", "context", "five-hour-usage", "weekly-usage", "agents", "tools", "plan", "git", "token-details", "cache"]);
    expect(registry.get("context")?.priority).toBe(100);
    expect(registry.get("cost")?.defaultEnabled).toBe(false);
    expect(registry.get("runtime-status")?.defaultEnabled).toBe(false);
  });

  it("只解析所选模块，并按可选 order 调整顺序", () => {
    expect(registry.resolve(["model", "git"], ["git", "context"]).map(module => module.id)).toEqual(["git", "model"]);
    expect(registry.resolve([])).toEqual([]);
    expect(registry.resolve(["model", "model"]).map(module => module.id)).toEqual(["model"]);
  });

  it("拒绝重复注册和未知模块", () => {
    const model = registry.get("model")!;
    expect(() => new ModuleRegistry([model, model])).toThrow("Duplicate module registration");
    expect(() => registry.resolve(["不存在"])).toThrow("Unknown display module");
    expect(() => registry.resolve(["model"], ["不存在"])).toThrow("Unknown display module");
  });

  it("空状态不被当成真实的零用量或空代理统计", () => {
    expect(registry.all().filter(module => module.isAvailable(emptyHudState()))).toEqual([]);
  });

  it("显式零值保持可用，缺失值及非有限数字不可用", () => {
    const zero: HudState = {
      context: { usedTokens: 0, contextWindow: 100, usedPercent: 0, inputTokens: 0, cachedInputTokens: 0 },
      quota: { fiveHour: { usedPercent: 0 }, weekly: { usedPercent: 0 } },
      tools: { counts: { Read: 0 } }, plan: { completed: 0, total: 0 },
      session: { durationMs: 0, turnCount: 0 }, cost: { amount: 0, currency: "USD" },
    };
    for (const id of ["context", "five-hour-usage", "weekly-usage", "plan", "session", "token-details", "cost", "cache"]) {
      expect(registry.get(id)?.isAvailable(zero), id).toBe(true);
    }
    expect(registry.get("tools")?.isAvailable(zero)).toBe(false);
    expect(registry.get("context")?.isAvailable({ context: { usedPercent: Number.NaN } })).toBe(false);
    expect(registry.get("five-hour-usage")?.isAvailable({ quota: { fiveHour: { usedPercent: Infinity } } })).toBe(false);
  });

  it("Context 同时需要用量与正数窗口，缺少任一项隐藏", () => {
    for (const context of [{ usedTokens: 100 }, { contextWindow: 1000 }, { usedTokens: 100, contextWindow: 0 }, { usedPercent: 10 }]) {
      expect(registry.get("context")?.isAvailable({ context })).toBe(false);
    }
    expect(registry.get("context")?.isAvailable({ context: { usedTokens: 0, contextWindow: 1000 } })).toBe(true);
  });

  it("当前活动过滤已结束工具，工具模块显示真实活动数量与摘要", () => {
    const state: HudState = { tools: { counts: { Shell: 1 }, active: [
      { id: "read", name: "Read", status: "running", description: "读取配置" },
      { id: "done", name: "Shell", status: "completed", description: "已完成命令" },
    ] } };
    const context = { width: 140, density: "full" as const };
    const activity = registry.get("current-activity")!.render(state, context);
    expect(activity).toContain("读取配置");
    expect(activity).not.toContain("已完成命令");
    const tools = registry.get("tools")!.render(state, context);
    expect(tools).toContain("Tools 1 active");
    expect(tools).toContain("读取配置");
    expect(registry.get("current-activity")!.isAvailable({ tools: { active: [{ id: "done", name: "Shell", status: "completed" }] } })).toBe(false);
  });

  it("模块渲染不会修改状态", () => {
    const state = mockState(0);
    const before = structuredClone(state);
    for (const module of registry.all().filter(module => module.isAvailable(state))) {
      module.render(state, { width: 140, density: "full" });
    }
    expect(state).toEqual(before);
  });
});
