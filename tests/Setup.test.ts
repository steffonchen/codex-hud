import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createDefaultConfig, loadConfig, saveConfig, serializeConfig } from "../src/config/Config.js";
import { recommendedConfig, runSetup, type ModuleChoice, type SetupAction, type SetupPrompter } from "../src/cli/Setup.js";
import { supportedCapabilities, testSessionSnapshot } from "./fixtures.js";
import { CapabilityDetector } from "../src/capabilities/CapabilityDetector.js";

let directory: string;
let filePath: string;
let text: string;

beforeEach(async () => {
  directory = await mkdtemp(path.join(os.tmpdir(), "codex-hud-setup-test-"));
  filePath = path.join(directory, "config.toml");
  text = "";
});
afterEach(async () => { await rm(directory, { recursive: true, force: true }); });

const write = (value: string) => { text += value; };
function prompt(action: SetupAction, selected: string[] = []): SetupPrompter {
  return { choose: vi.fn(async () => action), modules: vi.fn(async () => selected) };
}

describe("setup", () => {
  it("首次推荐只保存有来源的默认模块，演示计划保持不可用", async () => {
    const ui = prompt("recommended");
    const report = await supportedCapabilities();
    const saved = await runSetup({ filePath, capabilities: report, prompt: ui, write });
    expect(saved).toEqual(recommendedConfig(report));
    expect(saved.display.enabled).not.toContain("plan");
    expect(await loadConfig(filePath)).toEqual(saved);
    expect(ui.modules).not.toHaveBeenCalled();
    expect(text).toContain("Welcome to Codex HUD");
    expect(text).toContain("demo data");
    expect(text).toContain("reliable source");
  });

  it("多选默认勾选推荐项，并禁用无可靠来源的模块", async () => {
    let choices: ModuleChoice[] = [];
    const ui = prompt("customize");
    ui.modules = async value => { choices = value; return ["model", "context"]; };
    await runSetup({ filePath, capabilities: await supportedCapabilities(), prompt: ui, write });
    expect(choices.filter(choice => choice.checked).map(choice => choice.id)).toEqual(createDefaultConfig().display.enabled.filter(id => id !== "plan"));
    expect(choices.find(choice => choice.id === "plan")?.disabled).toContain("reliable");
    expect(choices.find(choice => choice.id === "cost")?.disabled).not.toBe(false);
    expect((await loadConfig(filePath))?.display.enabled).toEqual(["model", "context"]);
  });

  it("自定义从当前选项开始，保留行为、来源偏好和显示顺序", async () => {
    const current = createDefaultConfig();
    current.display = { language: "zh-CN", enabled: ["git", "session"], order: ["session", "git"] };
    current.behavior.refresh_ms = 500;
    current.behavior.auto_compact = false;
    current.providers.prefer_app_server = false;
    await saveConfig(current, filePath);
    const ui = prompt("customize");
    ui.modules = async choices => {
      expect(choices.filter(choice => choice.checked).map(choice => choice.id)).toEqual(["session", "git"]);
      return ["git", "context"];
    };
    const saved = await runSetup({ filePath, capabilities: await supportedCapabilities(), prompt: ui, write });
    expect(saved.display).toEqual({ language: "zh-CN", enabled: ["git", "context"], order: ["session", "git"] });
    expect(saved.behavior).toEqual(current.behavior);
    expect(saved.providers).toEqual(current.providers);
  });

  it("保留当前配置不会重写注释或文件内容", async () => {
    const original = "# 手动备注\n" + serializeConfig(createDefaultConfig());
    await writeFile(filePath, original);
    const ui = prompt("keep");
    await runSetup({ filePath, capabilities: await supportedCapabilities(), prompt: ui, write });
    expect(await readFile(filePath, "utf8")).toBe(original);
    expect(ui.modules).not.toHaveBeenCalled();
  });

  it("真实工具接入后可选择两个模块，推荐策略和已有选择保持不变", async () => {
    const snapshot = await testSessionSnapshot();
    snapshot.state.tools = { active: [{ id: "a", name: "exec", type: "wrapper", status: "running" }] };
    const report = new CapabilityDetector().detectRollout(snapshot);
    expect(recommendedConfig(report).display.enabled).toContain("tools");
    expect(recommendedConfig(report).display.enabled).not.toContain("current-activity");
    const current = createDefaultConfig();
    current.display.enabled = ["model"];
    await saveConfig(current, filePath);
    const original = await readFile(filePath, "utf8");
    await runSetup({ filePath, capabilities: report, prompt: prompt("keep"), write });
    expect(await readFile(filePath, "utf8")).toBe(original);
    const ui = prompt("customize", ["tools", "current-activity"]);
    const saved = await runSetup({ filePath, capabilities: report, prompt: ui, write });
    expect(saved.display.enabled).toEqual(["tools", "current-activity"]);
  });

  it("恢复推荐会使用本次检测结果并恢复默认行为", async () => {
    const current = createDefaultConfig();
    current.display = { language: "zh-CN", enabled: ["session"], order: ["session"] };
    current.behavior.refresh_ms = 500;
    await saveConfig(current, filePath);
    const report = await supportedCapabilities();
    report.modules.find(module => module.id === "weekly-usage")!.available = false;
    const saved = await runSetup({ filePath, capabilities: report, prompt: prompt("reset"), write });
    const expected = recommendedConfig(report);
    expected.display.language = "zh-CN";
    expect(saved).toEqual(expected);
    expect(text).toContain("配置已保存");
    expect(saved.display.enabled).not.toContain("weekly-usage");
    expect(saved.display.order).toBeUndefined();
    expect(saved.behavior.refresh_ms).toBe(150);
  });

  it.each(["choose", "modules"] as const)("在 %s 阶段取消时原文件字节不变", async stage => {
    const original = serializeConfig(createDefaultConfig());
    await writeFile(filePath, original);
    const ui = prompt("customize");
    const cancelled = Object.assign(new Error("用户取消"), { name: "ExitPromptError" });
    if (stage === "choose") ui.choose = async () => { throw cancelled; };
    else ui.modules = async () => { throw cancelled; };
    await expect(runSetup({ filePath, capabilities: await supportedCapabilities(), prompt: ui, write })).rejects.toBe(cancelled);
    expect(await readFile(filePath, "utf8")).toBe(original);
  });

  it("首次取消不创建配置文件", async () => {
    const ui = prompt("recommended");
    ui.choose = async () => { throw new Error("取消"); };
    await expect(runSetup({ filePath, capabilities: await supportedCapabilities(), prompt: ui, write })).rejects.toThrow("取消");
    expect(await loadConfig(filePath)).toBeNull();
  });

  it("不可用模块不能绕过多选校验保存", async () => {
    await expect(runSetup({ filePath, capabilities: await supportedCapabilities(), prompt: prompt("customize", ["plan"]), write }))
      .rejects.toThrow("Cannot select an unavailable module");
    expect(await loadConfig(filePath)).toBeNull();
  });

  it("用户可以主动保存空选择", async () => {
    await runSetup({ filePath, capabilities: await supportedCapabilities(), prompt: prompt("customize", []), write });
    expect((await loadConfig(filePath))?.display.enabled).toEqual([]);
  });

  it("损坏的旧配置只有在明确恢复推荐后才会替换", async () => {
    const original = 'version = 1\nmode = "normal"\n';
    await writeFile(filePath, original);
    const report = await supportedCapabilities();
    await expect(runSetup({ filePath, capabilities: report, prompt: prompt("keep"), write })).rejects.toThrow("mode setting was removed");
    expect(await readFile(filePath, "utf8")).toBe(original);
    await runSetup({ filePath, capabilities: report, prompt: prompt("reset"), write });
    expect(await loadConfig(filePath)).toEqual(recommendedConfig(report));
  });
});
