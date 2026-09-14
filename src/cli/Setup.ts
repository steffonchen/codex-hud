import { t } from "../i18n/Messages.js";
import { currentLanguage, withLanguage } from "../i18n/Language.js";
import { checkbox, select } from "@inquirer/prompts";
import type { CapabilityReport } from "../capabilities/CapabilityDetector.js";
import { createDefaultConfig, loadConfig, saveConfig, type HudConfig } from "../config/Config.js";
import { ModuleRegistry } from "../renderer/modules/ModuleRegistry.js";

const usageModules = new Set(["token-details", "cache", "cost", "five-hour-usage", "weekly-usage"]);

export type SetupAction = "recommended" | "customize" | "keep" | "reset";

export interface ModuleChoice {
  id: string;
  label: string;
  checked: boolean;
  disabled: false | string;
}

export interface SetupPrompter {
  choose(message: string, choices: Array<{ value: SetupAction; label: string }>): Promise<SetupAction>;
  modules(choices: ModuleChoice[]): Promise<string[]>;
}

export function terminalPrompter(): SetupPrompter {
  return {
    choose: (message, choices) => select<SetupAction>({
      message,
      choices: choices.map(choice => ({ name: choice.label, value: choice.value })),
      instructions: { navigation: t("↑↓ 选择，Enter 继续"), pager: t("↑↓ 查看更多选项") },
      theme: { style: { keysHelpTip: () => t("↑↓ 选择，Enter 继续") } },
    }),
    modules: choices => checkbox<string>({
      message: t("你希望显示哪些信息？"),
      choices: choices.map(choice => ({ name: choice.label, value: choice.id, checked: choice.checked, disabled: choice.disabled })),
      pageSize: Math.min(16, Math.max(4, (process.stdout.rows ?? 24) - 8)),
      instructions: t("↑↓ 移动，空格选择，Enter 保存"),
      shortcuts: { all: null, invert: null },
      theme: {
        icon: { checked: "☑", unchecked: "☐", cursor: "❯" },
        style: {
          keysHelpTip: () => t("↑↓ 移动，空格选择，Enter 保存"),
          renderSelectedChoices: (choices: ReadonlyArray<{ name: string }>) => choices.length ? choices.map(choice => choice.name).join("、") : t("不显示任何模块"),
        },
      },
    }),
  };
}

export function recommendedConfig(report: CapabilityReport, registry = new ModuleRegistry()): HudConfig {
  const config = createDefaultConfig();
  const available = new Set(report.modules.filter(module => module.available).map(module => module.id));
  config.display.enabled = registry.all().filter(module => (module.defaultEnabled || module.id === "plan") && available.has(module.id))
    .map(module => module.id);
  return config;
}

export function formatCapabilities(report: CapabilityReport, registry = new ModuleRegistry()): string {
  const lines = [
    `Codex：${report.codexVersion ?? t("未检测到可用版本")}`,
    report.source === "mock" ? t("当前数据源：演示数据；实时数据尚未接入。")
      : report.source === "rollout" ? t("当前数据源：Codex rollout（本次读取的真实快照）。")
      : report.source === "app-server" ? t("当前数据源：Codex App Server（本次读取的历史与实时快照）。")
      : report.source === "discovery" ? t("当前数据源：本地配置与技能定义；尚无可读的主会话。") : t("当前数据源：尚未发现可读的 Codex rollout。"),
    "",
    t("检测到的显示能力："),
  ];
  for (const module of registry.all()) {
    const capability = report.modules.find(item => item.id === module.id);
    const detail = capability?.available ? usageModules.has(module.id) ? capability.evidence.join("；") : ""
      : capability?.reason ?? t("能力尚未确认");
    lines.push(`${capability?.available ? "✓" : "⚠"} ${module.label}${detail ? `：${detail}` : ""}`);
  }
  for (const diagnostic of report.diagnostics) lines.push(t("诊断：{0}", diagnostic));
  return `${lines.join("\n")}\n`;
}

export async function runSetup(options: {
  filePath: string;
  capabilities: CapabilityReport;
  prompt: SetupPrompter;
  write: (text: string) => void | Promise<void>;
  registry?: ModuleRegistry;
}): Promise<HudConfig> {
  const registry = options.registry ?? new ModuleRegistry();
  let current: HudConfig | null = null;
  let loadError: unknown;
  try {
    current = await loadConfig(options.filePath);
  } catch (error) {
    loadError = error;
  }

  return withLanguage(current?.display.language ?? currentLanguage(), async () => {
    await options.write(current || loadError ? t("检测到现有配置。\n\n") : t("欢迎使用 Codex HUD\n\n"));
    await options.write(formatCapabilities(options.capabilities, registry));
    if (loadError) await options.write(t("\n{0}\n选择自定义或恢复推荐后才会替换此文件。\n", loadError instanceof Error ? loadError.message : String(loadError)));

    const existing = current !== null || loadError !== undefined;
    const action = await options.prompt.choose(existing ? t("如何处理当前配置？") : t("已生成推荐配置，是否使用？"), existing ? [
      { value: "keep", label: loadError ? t("保留文件并退出") : t("保留当前配置") },
      { value: "customize", label: t("自定义") },
      { value: "reset", label: t("恢复推荐配置") },
    ] : [
      { value: "recommended", label: t("使用推荐配置") },
      { value: "customize", label: t("自定义") },
    ]);

    if (action === "keep") {
      if (loadError) throw loadError;
      if (!current) throw new Error(t("没有可以保留的现有配置"));
      await options.write(t("已保留当前配置。\n"));
      return current;
    }

    let config = recommendedConfig(options.capabilities, registry);
    config.display.language = current?.display.language ?? config.display.language;
    if (action === "customize") {
      config = current ? structuredClone(current) : config;
      const available = new Map(options.capabilities.modules.map(module => [module.id, module]));
      const selectable = (id: string): boolean => available.get(id)?.available === true || (!!current && usageModules.has(id) && current.display.enabled.includes(id));
      if (!registry.all().some(module => selectable(module.id))) throw new Error(t("当前没有可用模块，请运行 codex-hud doctor 查看原因"));
      if (config.display.enabled.some(id => !selectable(id))) {
        await options.write(t("当前已选模块中有暂不可用项；自定义保存时会移除这些项，也可取消以保留原文件。\n"));
      }
      const choices = registry.all().map((module): ModuleChoice => {
        const capability = available.get(module.id);
        return {
          id: module.id,
          label: module.label,
          checked: config.display.enabled.includes(module.id) && selectable(module.id),
          disabled: selectable(module.id) ? false : capability?.reason ?? t("能力尚未确认"),
        };
      });
      const selected = await options.prompt.modules(choices);
      for (const id of selected) {
        if (!registry.get(id) || !selectable(id)) throw new Error(t("不能选择当前不可用的模块：{0}", id));
      }
      config.display.enabled = selected;
    } else if (action !== "recommended" && action !== "reset") {
      throw new Error(t("无效的配置操作"));
    }

    await saveConfig(config, options.filePath);
    await options.write(t("配置已保存：{0}\n", options.filePath));
    return config;
  });
}
