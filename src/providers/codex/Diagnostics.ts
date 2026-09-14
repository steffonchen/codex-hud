import { t } from "../../i18n/Messages.js";
export interface CodexDiagnostic {
  code: string;
  message: string;
  severity: "warning" | "error";
  path?: string;
  line?: number;
}

export interface CodexCheck {
  id: string;
  label: string;
  ok: boolean;
  warning?: boolean;
  detail?: string;
}

export function errorCode(error: unknown): string {
  const code = (error as NodeJS.ErrnoException | null)?.code;
  return typeof code === "string" && /^[A-Z_0-9]+$/u.test(code) ? code : t("未知错误");
}

export function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown> : undefined;
}
