import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Writable } from "node:stream";
import { select } from "@inquirer/prompts";
import { createProgram } from "../src/cli/Program.js";
import { promptLanguage, type LanguagePrompter } from "../src/cli/Language.js";
import type { HudOutput } from "../src/cli/RunHud.js";
import { createDefaultConfig, loadConfig, parseConfig, saveConfig, serializeConfig, validateConfig } from "../src/config/Config.js";
import { withLanguage, type Language } from "../src/i18n/Language.js";

vi.mock("@inquirer/prompts", () => ({ select: vi.fn(), checkbox: vi.fn() }));
vi.mock("node:fs/promises", async importOriginal => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return { ...actual, rename: vi.fn(actual.rename) };
});

let directory: string, configFile: string;
beforeEach(async () => {
  directory = await fs.mkdtemp(path.join(os.tmpdir(), "codex-hud-language-"));
  configFile = path.join(directory, "config.toml");
  vi.mocked(select).mockReset();
});
afterEach(async () => { vi.restoreAllMocks(); await fs.rm(directory, { recursive: true, force: true }); });

function capture() {
  let text = "";
  const stream: HudOutput = new Writable({ write(chunk, _encoding, callback) { text += String(chunk); callback(); } });
  stream.isTTY = false;
  return { stream, text: () => text };
}

function cli(languagePrompt?: LanguagePrompter) {
  const output = capture(), errors = capture();
  const provider = { refresh: vi.fn(async () => { throw new Error("此命令不应读取 Provider"); }) };
  const program = createProgram({ configFile, output: output.stream, errorOutput: errors.stream, languagePrompt, provider });
  return { output, errors, provider, program, run: (args = ["language"]) => program.parseAsync(args, { from: "user" }) };
}

describe("语言配置与交互菜单", () => {
  it("新配置与省略语言的旧配置均默认英文，旧模块选择保持不变", () => {
    expect(createDefaultConfig().display.language).toBe("en");
    expect(parseConfig('version = 1\n[display]\nenabled = ["tools"]\n').display).toEqual({ language: "en", enabled: ["tools"] });
  });

  it.each(["en", "zh-CN"] as const)("%s 可以保存并重新读取", language => {
    const config = createDefaultConfig(); config.display.language = language;
    expect(parseConfig(serializeConfig(config))).toEqual(config);
  });

  it.each(["zh", "EN", "fr", "", null, true, 1])("拒绝无效语言 %s", language => {
    expect(() => validateConfig({ version: 1, display: { language } })).toThrow("display.language must be en or zh-CN");
  });

  it.each(["en", "zh-CN"] as const)("%s 菜单显示两项并预选当前语言", async language => {
    vi.mocked(select).mockResolvedValueOnce("en");
    const output = capture();
    await expect(withLanguage(language, () => promptLanguage(language, output.stream))).resolves.toBe("en");
    const [options, context] = vi.mocked(select).mock.calls[0];
    expect(options.default).toBe(language);
    expect(options.choices).toEqual([
      { value: "en", name: language === "en" ? "English" : "英文" },
      { value: "zh-CN", name: language === "en" ? "Simplified Chinese" : "简体中文" },
    ]);
    expect(context?.output).toBe(output.stream);
    if (language === "en") expect(JSON.stringify(options)).not.toMatch(/\p{Script=Han}/u);
    else expect(options.message).toBe("请选择显示语言");
  });

  it("首次按默认英文保存配置，不读取真实来源", async () => {
    const prompt = vi.fn(async () => "en" as const), command = cli(prompt);
    await command.run();
    expect(prompt).toHaveBeenCalledWith("en");
    expect(await loadConfig(configFile)).toEqual(createDefaultConfig());
    expect(command.output.text()).toContain("Language set to English");
    expect(command.output.text()).not.toMatch(/\p{Script=Han}/u);
    expect(command.provider.refresh).not.toHaveBeenCalled();
  });

  it("切换只改变语言，后续命令读取保存结果，确认文案使用新语言", async () => {
    const config = createDefaultConfig();
    config.display.enabled = ["context", "tools"];
    config.display.order = ["tools", "context"];
    config.behavior = { refresh_ms: 450, auto_compact: false, hide_when_idle: true };
    config.providers = { prefer_app_server: false, use_rollout_fallback: false };
    config.runtime = { prefer_managed: false, prefer_shared: false, allow_spawn: false,
      allow_external_attach: false, auto_reconnect: false, auto_start_managed: true };
    await saveConfig(config, configFile);
    const command = cli(async current => { expect(current).toBe("en"); return "zh-CN"; });
    await command.run();
    expect(await loadConfig(configFile)).toEqual({ ...config, display: { ...config.display, language: "zh-CN" } });
    expect(command.output.text()).toContain("语言已设置为 简体中文");
    const next = cli(async current => { expect(current).toBe("zh-CN"); return "en"; });
    await next.run(["config"]);
    expect(next.output.text()).toContain("当前语言：简体中文");
    await next.run();
    expect((await loadConfig(configFile))?.display.language).toBe("en");
    expect(next.output.text()).toContain("Language set to English");
    expect(next.provider.refresh).not.toHaveBeenCalled();
  });

  it.each([false, true])("取消选择保留原文件（已有配置=%s）", async existing => {
    const original = "# 保留注释\n" + serializeConfig(createDefaultConfig());
    if (existing) await fs.writeFile(configFile, original);
    const cancelled = Object.assign(new Error("cancelled"), { name: "ExitPromptError" });
    const command = cli(async () => { throw cancelled; });
    await expect(command.run()).rejects.toBe(cancelled);
    if (existing) expect(await fs.readFile(configFile, "utf8")).toBe(original);
    else await expect(fs.stat(configFile)).rejects.toMatchObject({ code: "ENOENT" });
    expect(command.output.text()).toBe("");
  });

  it.each(["en", "zh-CN"] as const)("选择当前 %s 不重写文件或删除注释", async language => {
    const config = createDefaultConfig(); config.display.language = language;
    const original = "# 保留注释\n" + serializeConfig(config);
    await fs.writeFile(configFile, original);
    const command = cli(async () => language);
    await command.run();
    expect(await fs.readFile(configFile, "utf8")).toBe(original);
    expect(command.output.text()).toContain(language === "en" ? "configuration unchanged" : "配置未更改");
  });

  it("旧配置缺少语言且继续使用英文时不改写原文件", async () => {
    const original = "version = 1\n# 旧配置\n";
    await fs.writeFile(configFile, original);
    await cli(async () => "en").run();
    expect(await fs.readFile(configFile, "utf8")).toBe(original);
  });

  it("非交互终端明确报错，不打开菜单或写配置", async () => {
    const command = cli();
    await expect(command.run()).rejects.toThrow("Language selection requires an interactive terminal");
    expect(select).not.toHaveBeenCalled();
    expect(await loadConfig(configFile)).toBeNull();
  });

  it("不接受位置参数，非法菜单结果不保存", async () => {
    const prompt = vi.fn(async () => "en" as const);
    await expect(cli(prompt).run(["language", "en"])).rejects.toMatchObject({ exitCode: 1 });
    expect(prompt).not.toHaveBeenCalled();
    await expect(cli(async () => "fr" as Language).run()).rejects.toThrow("Invalid language selection");
    expect(await loadConfig(configFile)).toBeNull();
  });

  it("损坏配置阻止修改；帮助和版本仍然可用", async () => {
    const original = "version = 1\n[display]\nlanguage = 7\n";
    await fs.writeFile(configFile, original);
    const prompt = vi.fn(async () => "en" as const), command = cli(prompt);
    await expect(command.run()).rejects.toThrow("display.language");
    expect(prompt).not.toHaveBeenCalled();
    await expect(command.run(["--help"])).rejects.toMatchObject({ exitCode: 0 });
    expect(command.output.text()).toContain("Usage:");
    await command.run(["version"]);
    expect(await fs.readFile(configFile, "utf8")).toBe(original);
  });

  it("读取失败时不显示菜单", async () => {
    configFile = directory;
    const prompt = vi.fn(async () => "en" as const);
    await expect(cli(prompt).run()).rejects.toThrow("Cannot read configuration");
    expect(prompt).not.toHaveBeenCalled();
  });

  it("保存失败保留原文件、语言和错误，不输出成功提示", async () => {
    const original = serializeConfig(createDefaultConfig());
    await fs.writeFile(configFile, original);
    const failure = Object.assign(new Error("rename failed"), { code: "EACCES" });
    vi.mocked(fs.rename).mockRejectedValueOnce(failure);
    const command = cli(async () => "zh-CN");
    await expect(command.run()).rejects.toMatchObject({ message: `Cannot save configuration: ${configFile}`, cause: failure });
    expect(command.program.language).toBe("en");
    expect(command.output.text()).toBe("");
    expect(await fs.readFile(configFile, "utf8")).toBe(original);
    expect(await fs.readdir(directory)).toEqual(["config.toml"]);
  });
});
