import { afterEach, describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Writable } from "node:stream";
import stringWidth from "string-width";
import { createProgram } from "../src/cli/Program.js";
import { formatDebug } from "../src/cli/Diagnostics.js";
import type { HudOutput } from "../src/cli/RunHud.js";
import { createDefaultConfig, saveConfig } from "../src/config/Config.js";
import { redactText } from "../src/core/Redaction.js";
import { mockState } from "../src/demo/mockState.js";
import { currentLanguage, withLanguage, type Language } from "../src/i18n/Language.js";
import { messages, t } from "../src/i18n/Messages.js";
import { HudRenderer } from "../src/renderer/HudRenderer.js";
import { ModuleRegistry } from "../src/renderer/modules/ModuleRegistry.js";
import { HudRuntime } from "../src/runtime/HudRuntime.js";
import { SignalHandler } from "../src/runtime/SignalHandler.js";
import { testSessionSnapshot } from "./fixtures.js";
import { FakeCodexProvider, FakeTerminal } from "./runtime/fixtures.js";

const languages = ["en", "zh-CN"] as const;
const han = /\p{Script=Han}/u;
const directories: string[] = [];
afterEach(async () => {
  vi.useRealTimers();
  for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true });
});

describe("语言作用域", () => {
  it("并发异步任务与嵌套异常不串语言，插值保留原文", async () => {
    const results = await Promise.all(languages.map(language => withLanguage(language, async () => {
      await new Promise<void>(resolve => setImmediate(resolve));
      expect(currentLanguage()).toBe(language);
      expect(() => withLanguage(language === "en" ? "zh-CN" : "en", () => { throw new Error("nested"); })).toThrow("nested");
      expect(currentLanguage()).toBe(language);
      return t("未知显示模块：{0}", "中文原文 {1}");
    })));
    expect(results).toEqual(["Unknown display module: 中文原文 {1}", "未知显示模块：中文原文 {1}"]);
    expect(currentLanguage()).toBe("en");
  });

  it("全部英文内置消息没有汉字，中英文插值槽位一致", () => {
    const slots = (value: string) => [...value.matchAll(/\{\d+\}/gu)].map(match => match[0]).sort();
    for (const [chinese, english] of Object.entries(messages)) {
      expect(english, chinese).not.toMatch(han);
      expect(slots(english), chinese).toEqual(slots(chinese));
    }
  });

  it("模块标签随作用域变化，不在导入时固定", () => {
    const registry = new ModuleRegistry();
    expect(registry.get("context")?.label).toBe("Context");
    withLanguage("zh-CN", () => expect(registry.get("context")?.label).toBe("上下文"));
    expect(registry.get("context")?.label).toBe("Context");
  });

  it.each(languages)("%s 脱敏可以重复执行，也能处理另一种语言的标记", language => {
    withLanguage(language, () => {
      const output = redactText("API_KEY=private-value");
      expect(output).toBe(language === "en" ? "API_KEY=[redacted]" : "API_KEY=[已隐藏]");
      expect(redactText(output)).toBe(output);
      const other = language === "en" ? "API_KEY=[已隐藏]" : "API_KEY=[redacted]";
      expect(redactText(other)).toBe(output);
    });
  });
});

describe("中英文 HUD 和诊断", () => {
  it.each(languages)("%s 默认 80 列预览保持各项信息", language => {
    const config = createDefaultConfig(); config.display.language = language;
    const state = withLanguage(language, () => mockState(0));
    const output = new HudRenderer().render(state, { width: 80, height: 24 }, config, 0);
    expect(output).toBe(language === "en"
      ? "GPT-5.6 Sol · xhigh\nContext 74% · 191K/258K\n5h 91% · 7d 72%\nAgents 3\nTools 58\nPlan 8/10\nmain *\nToken Input 119K · Output 18K · Cache 101K"
      : "GPT-5.6 Sol · xhigh\n上下文 74% · 191K/258K\n5h 91% · 7d 72%\n子代理 3\n工具 58\n计划 8/10\nmain *\nToken 输入 119K · 输出 18K · 缓存 101K");
  });

  it.each(languages.flatMap(language => [140, 80, 50, 30, 12, 8].flatMap(width => [24, 6, 2].map(height => ({ language, width, height })))))
    ("$language 的全部模块在 $width × $height 内安全布局", ({ language, width, height }) => {
      const registry = new ModuleRegistry(), config = createDefaultConfig();
      config.display.language = language; config.display.enabled = registry.all().map(module => module.id);
      const state = { ...withLanguage(language, () => mockState(0)),
        mcp: [{ name: "docs", status: "connected" as const, toolCount: 2 }],
        skills: [{ name: "review", enabled: true }], cost: { amount: 1.25, currency: "USD", estimated: true },
        dataSources: { preferred: "app-server" as const, active: "rollout" as const, degraded: false,
          rolloutAvailable: true, deduplicated: 0, issues: [] },
      };
      const renderer = new HudRenderer();
      const output = withLanguage(language === "en" ? "zh-CN" : "en", () => renderer.render(state, { width, height }, config, 0));
      expect(renderer.getIssues()).toEqual([]);
      expect(output.split("\n").length).toBeLessThanOrEqual(height);
      expect(output.split("\n").every(line => stringWidth(line) <= width)).toBe(true);
      if (language === "en") expect(output).not.toMatch(han);
    });

  it("英文模式保留中文任务、文件名与名称，即使内容与标签相同", () => {
    const config = createDefaultConfig(); config.display.enabled = ["model", "plan", "current-activity", "skills"];
    const output = new HudRenderer().render({ model: "上下文工具计划中文模型",
      activity: { status: "running", description: "检查文件/src/中文.ts" },
      plan: { items: [{ text: "工具与输入不能翻译", status: "in_progress" }] },
      skills: [{ name: "中文技能", enabled: true }],
    }, { width: 140, height: 40 }, config);
    for (const text of ["上下文工具计划中文模型", "检查文件/src/中文.ts", "工具与输入不能翻译", "中文技能"]) expect(output).toContain(text);
    expect(output).toContain("Current activity");
  });

  it.each(languages)("%s 诊断直接调用时以传入配置为准", async language => {
    const config = createDefaultConfig(); config.display.language = language;
    const snapshot = await withLanguage(language, testSessionSnapshot);
    const output = withLanguage(language === "en" ? "zh-CN" : "en", () => formatDebug(snapshot,
      { config, terminal: { width: 80, height: 24 }, isTTY: false }));
    expect(output).toContain(language === "en" ? '"Runtime"' : '"运行时"');
    if (language === "en") expect(output).not.toMatch(han);
  });

  it.each(languages)("%s 帮助、demo、config、debug 与 start 使用保存的语言", async language => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "codex-hud-localized-cli-")); directories.push(directory);
    const configFile = path.join(directory, "config.toml"), config = createDefaultConfig(); config.display.language = language;
    await saveConfig(config, configFile);
    for (const name of ["--help", "demo", "config", "debug", "start"]) {
      let text = "";
      const output: HudOutput = new Writable({ write(chunk, _encoding, callback) { text += String(chunk); callback(); } }); output.isTTY = false;
      const snapshot = await withLanguage(language, testSessionSnapshot);
      snapshot.checks = []; snapshot.runtime.checks = [];
      const program = createProgram({ configFile, output, errorOutput: output, provider: { refresh: async () => snapshot } });
      if (name === "--help") await expect(program.parseAsync([name], { from: "user" })).rejects.toMatchObject({ exitCode: 0 });
      else await program.parseAsync([name], { from: "user" });
      expect(text).not.toBe("");
      if (language === "en") expect(text, name).not.toMatch(han);
      else expect(text, name).toMatch(han);
    }
  });

  it.each(languages)("%s 后台更新、计时和 resize 恢复配置语言", async language => {
    vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout", "setInterval", "clearInterval"] });
    vi.setSystemTime(1000);
    const config = createDefaultConfig(); config.display.language = language;
    config.display.enabled = ["session", "tools", "current-activity"];
    const snapshot = await withLanguage(language, testSessionSnapshot); snapshot.state = {}; snapshot.read.status = "missing";
    snapshot.runtime.currentSessionId = undefined; snapshot.runtime.currentRolloutPath = undefined;
    const provider = new FakeCodexProvider(snapshot), terminal = new FakeTerminal();
    const runtime = new HudRuntime(config, { provider, terminal, signals: new SignalHandler(new EventEmitter()) });
    try {
      await runtime.start();
      expect(terminal.frames.at(-1)).toContain(language === "en" ? "Waiting for a Codex session" : "正在等待 Codex 会话");
      withLanguage(language === "en" ? "zh-CN" : "en", () => {
        provider.publish({ ...snapshot, state: { session: { startedAt: 1000 },
          tools: { active: [{ id: "shell", name: "shell", type: "shell", status: "running", startedAt: 1000, inputSummary: "npm test" }] } } });
        terminal.events?.resize();
      });
      await vi.advanceTimersByTimeAsync(1100);
      const frame = terminal.frames.at(-1)!;
      expect(frame).toContain(language === "en" ? "Session 1s" : "会话 1s");
      expect(frame).toContain(language === "en" ? "Executing" : "执行中");
      if (language === "en") expect(frame).not.toMatch(han);
      provider.handlers?.onDiagnostic({ code: "test", severity: "warning", message: "API_KEY=private-secret" });
      expect(runtime.getDiagnostics()[0].message).toBe(language === "en" ? "API_KEY=[redacted]" : "API_KEY=[已隐藏]");
    } finally { await runtime.stop(); }
    expect(vi.getTimerCount()).toBe(0);
  });
});
