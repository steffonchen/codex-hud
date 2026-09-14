import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createDefaultConfig, loadConfig, parseConfig, saveConfig, serializeConfig, validateConfig } from "../src/config/Config.js";

vi.mock("node:fs/promises", async importOriginal => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return { ...actual, open: vi.fn(actual.open), rename: vi.fn(actual.rename) };
});

let directory: string;
let filePath: string;

beforeEach(async () => {
  directory = await fs.mkdtemp(path.join(os.tmpdir(), "codex-hud-config-test-"));
  filePath = path.join(directory, "config.toml");
});

afterEach(async () => {
  vi.restoreAllMocks();
  await fs.rm(directory, { recursive: true, force: true });
});

describe("Config", () => {
  it("默认配置使用模块列表、行为和来源偏好，无 mode", () => {
    const config = createDefaultConfig();
    expect(config.version).toBe(1);
    expect(config.display.language).toBe("en");
    expect(config.display.enabled).toEqual(["model", "reasoning", "context", "five-hour-usage", "weekly-usage", "agents", "tools", "plan", "git", "token-details", "cache"]);
    expect(config.behavior).toEqual({ refresh_ms: 150, auto_compact: true, hide_when_idle: false });
    expect(config.providers).toEqual({ prefer_app_server: true, use_rollout_fallback: true });
    expect(config.runtime).toEqual({ prefer_managed: true, prefer_shared: true, allow_spawn: true,
      allow_external_attach: true, auto_reconnect: true, auto_start_managed: false });
    expect(serializeConfig(config)).not.toMatch(/^mode\s*=/mu);
    config.display.enabled.length = 0;
    expect(createDefaultConfig().display.enabled).toHaveLength(11);
  });

  it("支持 TOML 注释、多行数组、单引号、可选排序及显式 false", () => {
    const config = parseConfig(`version = 1
[display]
enabled = [
  'context', # 首选上下文
  "model",
]
order = ["context", "model"]
[behavior]
refresh_ms = 250
auto_compact = false
hide_when_idle = true
[providers]
prefer_app_server = false
use_rollout_fallback = false
`);
    expect(config.display).toEqual({ language: "en", enabled: ["context", "model"], order: ["context", "model"] });
    expect(config.behavior).toEqual({ refresh_ms: 250, auto_compact: false, hide_when_idle: true });
    expect(config.providers).toEqual({ prefer_app_server: false, use_rollout_fallback: false });
    expect(parseConfig(serializeConfig(config))).toEqual(config);
  });

  it("允许空选择，省略的可选设置使用默认值", () => {
    const config = parseConfig("version = 1\n[display]\nenabled = []\n");
    expect(config.display.enabled).toEqual([]);
    expect(config.behavior.refresh_ms).toBe(150);
    expect(config.runtime.auto_start_managed).toBe(false);
  });

  it("runtime 策略完整校验，保存显示选项时不丢失显式许可", () => {
    const config = parseConfig('version = 1\n[runtime]\nallow_spawn = false\nauto_reconnect = false\nauto_start_managed = true\n');
    config.display.enabled = ["runtime-status"];
    expect(parseConfig(serializeConfig(config))).toEqual(config);
    expect(config.runtime).toMatchObject({ allow_spawn: false, auto_reconnect: false, auto_start_managed: true, allow_external_attach: true });
    expect(() => parseConfig('version = 1\n[runtime]\nallow_spawn = "yes"')).toThrow("boolean");
    expect(() => parseConfig('version = 1\n[runtime]\nspawn = true')).toThrow("unknown setting");
  });

  it.each([
    ['version = 2', "version"],
    ['version = 1\nmode = "normal"', "mode setting was removed"],
    ['version = 1\n[display]\nmode = "compact"', "mode setting was removed"],
    ['version = 1\n[display]\nenabled = ["不存在"]', "unknown module"],
    ['version = 1\n[display]\nenabled = ["model", "model"]', "duplicate modules"],
    ['version = 1\n[display]\norder = ["expanded"]', "unknown module"],
    ['version = 1\n[behavior]\nrefresh_ms = 0', "refresh_ms"],
    ['version = 1\n[behavior]\nauto_compact = "yes"', "boolean"],
    ['version = 1\n[behavior]\nrefesh_ms = 100', "unknown setting"],
  ])("拒绝无效或已废弃的配置：%s", (source, message) => {
    expect(() => parseConfig(source)).toThrow(message);
  });

  it("拒绝无效的配置结构和损坏 TOML", () => {
    expect(() => validateConfig({ version: 1, display: null })).toThrow("configuration table");
    expect(() => parseConfig("version = 1\n[display]\nenabled = [")).toThrow();
  });

  it("首次加载不存在的文件返回 null，保存后可完整读取，文件为 UTF-8 无 BOM", async () => {
    expect(await loadConfig(filePath)).toBeNull();
    const config = createDefaultConfig();
    config.display.enabled = ["model", "context"];
    config.display.order = ["context", "model"];
    await saveConfig(config, filePath);
    expect(await loadConfig(filePath)).toEqual(config);
    const bytes = await fs.readFile(filePath);
    expect(bytes.subarray(0, 3).equals(Buffer.from([0xef, 0xbb, 0xbf]))).toBe(false);
    expect((await fs.stat(filePath)).mode & 0o777).toBe(0o600);
    expect(await fs.readdir(directory)).toEqual(["config.toml"]);
  });

  it("读取失败或配置损坏时不会返回默认配置伪装成功", async () => {
    await fs.writeFile(filePath, "不是合法的 TOML");
    await expect(loadConfig(filePath)).rejects.toThrow("Invalid configuration");
    await expect(loadConfig(directory)).rejects.toThrow("Cannot read configuration");
  });

  it("无效配置在创建目录之前就被拒绝", async () => {
    const config = createDefaultConfig();
    config.display.enabled = ["未知模块"];
    const target = path.join(directory, "new", "config.toml");
    await expect(saveConfig(config, target)).rejects.toThrow("unknown module");
    await expect(fs.stat(path.dirname(target))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it.each(["writeFile", "sync", "rename"] as const)("%s 失败时保留原文件并清理临时文件", async stage => {
    const original = "# 保留原注释\n" + serializeConfig(createDefaultConfig());
    await fs.writeFile(filePath, original);
    const failure = new Error(`模拟 ${stage} 失败`);
    if (stage === "rename") {
      vi.mocked(fs.rename).mockRejectedValueOnce(failure);
    } else {
      const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
      vi.mocked(fs.open).mockImplementationOnce(async (...args) => {
        const handle = await actual.open(...args);
        vi.spyOn(handle, stage).mockRejectedValueOnce(failure);
        return handle;
      });
    }
    const next = createDefaultConfig();
    next.display.enabled = ["git"];
    await expect(saveConfig(next, filePath)).rejects.toThrow("Cannot save configuration");
    expect(await fs.readFile(filePath, "utf8")).toBe(original);
    expect(await fs.readdir(directory)).toEqual(["config.toml"]);
  });
});
