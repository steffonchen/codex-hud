import { select } from "@inquirer/prompts";
import type { Language } from "../i18n/Language.js";
import { t } from "../i18n/Messages.js";

export type LanguagePrompter = (current: Language) => Promise<Language>;

export function languageName(language: Language): string {
  return language === "en" ? t("英文") : t("简体中文");
}

export function promptLanguage(current: Language, output: NodeJS.WritableStream = process.stdout): Promise<Language> {
  return select<Language>({
    message: t("请选择显示语言"),
    default: current,
    choices: ["en", "zh-CN"].map(value => ({ value: value as Language, name: languageName(value as Language) })),
    instructions: { navigation: t("↑↓ 选择，Enter 继续"), pager: t("↑↓ 查看更多选项") },
    theme: { style: { keysHelpTip: () => t("↑↓ 选择，Enter 继续") } },
  }, { output });
}
