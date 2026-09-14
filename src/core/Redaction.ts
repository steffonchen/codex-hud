import { t } from "../i18n/Messages.js";
import { stripVTControlCharacters } from "node:util";

const credentialKey = /(?:apikey|accesstoken|refreshtoken|idtoken|authtoken|token|authorization|cookie|secret|secretaccesskey|accesskeyid|credential|credentials|password|passwd|privatekey)$/iu;
const textCredential = "[a-z0-9_]*(?:api[_ -]?key|(?:access|refresh|id|auth)[_-]?token|token|password|passwd|client[_-]?secret|secret(?:[_-]?access[_-]?key)?|access[_-]?key[_-]?id|credentials?|private[_-]?key|authorization|cookie)";
const credentialAssignment = new RegExp(`\\b(${textCredential})\\b["']?\\s*[:=]\\s*(?:\\[(?:已隐藏|redacted)\\]|"(?:\\\\.|[^"\\\\])*"|'(?:\\\\.|[^'\\\\])*'|[^\\s,;\\]}&]+)`, "giu");
const credentialArgument = new RegExp(`(-{1,2}${textCredential})(?:=|\\s+)(?:"(?:\\\\.|[^"\\\\])*"|'(?:\\\\.|[^'\\\\])*'|[^\\s,;]+)`, "giu");

export function redactText(value: string): string {
  return stripVTControlCharacters(value)
    .replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/gu, " ")
    .replace(/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/gu, t("[已隐藏]"))
    .replace(/\b(?:Bearer|Basic)\s+[^\s"',;]+/giu, t("[已隐藏]"))
    .replace(/\bsk-[a-z0-9_-]+/giu, t("[已隐藏]"))
    .replace(/\beyJ[a-z0-9_-]+\.[a-z0-9_-]+\.[a-z0-9_-]+/giu, t("[已隐藏]"))
    .replace(/([a-z][a-z0-9+.-]*:\/\/)[^\s/:@]+:[^\s/@]+@/giu, t("$1[已隐藏]@"))
    .replace(/\b(?:proxy-authorization|authorization|set-cookie|cookie)\s*:\s*[^\r\n]*/giu, t("[已隐藏]"))
    .replace(credentialArgument, t("$1=[已隐藏]"))
    .replace(credentialAssignment, t("$1=[已隐藏]"));
}

export function redactSummary(value: string, limit = 240): string {
  const clean = redactText(value).replace(/\s+/gu, " ").trim();
  const characters = Array.from(clean);
  return characters.length > limit ? characters.slice(0, limit - 1).join("") + "…" : clean;
}

export function redact(value: unknown): unknown {
  if (typeof value === "string") return redactText(value);
  if (Array.isArray(value)) return value.map(redact);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key,
      credentialKey.test(key.replace(/[_ -]/gu, "")) ? t("[已隐藏]") : redact(item)]));
  }
  return value;
}
