import { AsyncLocalStorage } from "node:async_hooks";

export type Language = "en" | "zh-CN";
export const defaultLanguage: Language = "en";

const languages = new AsyncLocalStorage<Language>();

export function currentLanguage(): Language {
  return languages.getStore() ?? defaultLanguage;
}

export function withLanguage<T>(language: Language, action: () => T): T {
  return languages.run(language, action);
}

export function isLanguage(value: unknown): value is Language {
  return value === "en" || value === "zh-CN";
}
