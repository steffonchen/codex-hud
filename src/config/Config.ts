import { t } from "../i18n/Messages.js";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename, unlink } from "node:fs/promises";
import { parse, stringify, TomlError } from "smol-toml";
import { ModuleRegistry } from "../renderer/modules/ModuleRegistry.js";
import { defaultRuntimePolicy, type RuntimePolicy } from "../providers/codex/runtime/RuntimePolicy.js";
import { defaultLanguage, isLanguage, type Language } from "../i18n/Language.js";

export interface HudConfig {
  version: 1;
  display: {
    language: Language;
    enabled: string[];
    order?: string[];
  };
  behavior: {
    refresh_ms: number;
    auto_compact: boolean;
    hide_when_idle: boolean;
  };
  providers: {
    prefer_app_server: boolean;
    use_rollout_fallback: boolean;
  };
  runtime: RuntimePolicy;
}

const registry = new ModuleRegistry();

export const defaultConfig: HudConfig = {
  version: 1,
  display: { language: defaultLanguage, enabled: registry.defaultEnabled() },
  behavior: { refresh_ms: 150, auto_compact: true, hide_when_idle: false },
  providers: { prefer_app_server: true, use_rollout_fallback: true },
  runtime: { ...defaultRuntimePolicy },
};

export function createDefaultConfig(): HudConfig {
  return structuredClone(defaultConfig);
}

function table(value: unknown, label: string, allowed: readonly string[]): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error(t("{0} 必须是配置表", label));
  const result = value as Record<string, unknown>;
  for (const key of Object.keys(result)) {
    if (key === "mode") throw new Error(t("已移除 mode 配置，请运行 codex-hud setup 选择显示模块"));
    if (!allowed.includes(key)) throw new Error(t("{0} 包含未知配置项：{1}", label, key));
  }
  return result;
}

function modules(value: unknown, label: string): string[] {
  if (!Array.isArray(value) || value.some(id => typeof id !== "string")) throw new Error(t("{0} 必须是模块 ID 数组", label));
  const ids = value as string[];
  if (new Set(ids).size !== ids.length) throw new Error(t("{0} 包含重复模块", label));
  for (const id of ids) {
    if (!registry.get(id)) throw new Error(t("{0} 包含未知模块：{1}", label, id));
  }
  return [...ids];
}

function booleanValue(value: unknown, fallback: boolean, label: string): boolean {
  if (value === undefined) return fallback;
  if (typeof value !== "boolean") throw new Error(t("{0} 必须是布尔值", label));
  return value;
}

export function validateConfig(value: unknown): HudConfig {
  const root = table(value, t("配置"), ["version", "display", "behavior", "providers", "runtime"]);
  if (root.version !== 1) throw new Error(t("不支持的配置版本，version 必须为 1"));
  const display = table(root.display === undefined ? {} : root.display, "display", ["language", "enabled", "order"]);
  const language = display.language === undefined ? defaultLanguage : display.language;
  if (!isLanguage(language)) throw new Error(t("display.language 必须是 en 或 zh-CN"));
  const behavior = table(root.behavior === undefined ? {} : root.behavior, "behavior", ["refresh_ms", "auto_compact", "hide_when_idle"]);
  const providers = table(root.providers === undefined ? {} : root.providers, "providers", ["prefer_app_server", "use_rollout_fallback"]);
  const runtime = table(root.runtime === undefined ? {} : root.runtime, "runtime", Object.keys(defaultRuntimePolicy));
  const runtimePolicy = { ...defaultRuntimePolicy };
  for (const key of Object.keys(runtimePolicy) as Array<keyof RuntimePolicy>) {
    runtimePolicy[key] = booleanValue(runtime[key], defaultRuntimePolicy[key], `runtime.${key}`);
  }
  const refresh = behavior.refresh_ms === undefined ? defaultConfig.behavior.refresh_ms : behavior.refresh_ms;
  if (typeof refresh !== "number" || !Number.isInteger(refresh) || refresh < 1 || refresh > 60_000) {
    throw new Error(t("behavior.refresh_ms 必须是 1 至 60000 的整数（毫秒）"));
  }

  return {
    version: 1,
    display: {
      language,
      enabled: modules(display.enabled === undefined ? defaultConfig.display.enabled : display.enabled, "display.enabled"),
      ...(display.order === undefined ? {} : { order: modules(display.order, "display.order") }),
    },
    behavior: {
      refresh_ms: refresh,
      auto_compact: booleanValue(behavior.auto_compact, true, "behavior.auto_compact"),
      hide_when_idle: booleanValue(behavior.hide_when_idle, false, "behavior.hide_when_idle"),
    },
    providers: {
      prefer_app_server: booleanValue(providers.prefer_app_server, true, "providers.prefer_app_server"),
      use_rollout_fallback: booleanValue(providers.use_rollout_fallback, true, "providers.use_rollout_fallback"),
    },
    runtime: runtimePolicy,
  };
}

export function parseConfig(source: string): HudConfig {
  let value: unknown;
  try { value = parse(source); }
  catch (error) {
    // TOML 库的错误会附带相邻配置原文，诊断仅保留定位信息。
    if (error instanceof TomlError) throw new Error(t("TOML 语法无效（第 {0} 行，第 {1} 列）", error.line, error.column));
    throw error;
  }
  return validateConfig(value);
}

export function serializeConfig(config: HudConfig): string {
  return `${stringify(validateConfig(config))}\n`;
}

export function codexHome(): string {
  return process.env.CODEX_HOME || path.join(os.homedir(), ".codex");
}

export function configPath(): string {
  return path.join(os.homedir(), ".codex-hud", "config.toml");
}

export async function loadConfig(filePath = configPath()): Promise<HudConfig | null> {
  let source: string;
  try {
    source = await readFile(filePath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw new Error(t("无法读取配置：{0}", filePath), { cause: error });
  }
  try {
    return parseConfig(source);
  } catch (error) {
    throw new Error(t("配置无效：{0}；{1}", filePath, error instanceof Error ? error.message : String(error)), { cause: error });
  }
}

export async function saveConfig(config: HudConfig, filePath = configPath()): Promise<void> {
  const source = serializeConfig(config);
  const directory = path.dirname(filePath);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const temporary = path.join(directory, `.${path.basename(filePath)}.${randomUUID()}.tmp`);
  try {
    const file = await open(temporary, "wx", 0o600);
    try {
      await file.writeFile(source, "utf8");
      await file.sync();
    } finally {
      await file.close();
    }
    await rename(temporary, filePath);
  } catch (error) {
    try {
      await unlink(temporary);
    } catch (cleanupError) {
      if ((cleanupError as NodeJS.ErrnoException).code !== "ENOENT") {
        throw new AggregateError([error, cleanupError], t("配置保存失败，且临时文件清理失败：{0}", temporary));
      }
    }
    throw new Error(t("无法保存配置：{0}", filePath), { cause: error });
  }
}
