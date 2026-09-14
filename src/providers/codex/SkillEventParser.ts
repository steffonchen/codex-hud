import { t } from "../../i18n/Messages.js";
import path from "node:path";
import type { HudEvent } from "../../core/HudEvent.js";
import { MAX_SKILLS, type SkillCatalogEntry } from "../../core/SkillState.js";
import { redactSummary } from "../../core/Redaction.js";
import { record, type CodexDiagnostic } from "./Diagnostics.js";

export class SkillEventParser {
  parse(root: Record<string, unknown>, line?: number): { events: HudEvent[]; diagnostics: CodexDiagnostic[] } {
    const result: { events: HudEvent[]; diagnostics: CodexDiagnostic[] } = { events: [], diagnostics: [] };
    const payload = record(root.payload);
    // 仅接受 Codex developer message 中的明确目录，不扫描用户正文、工具输出或任意技能提及。
    if (root.type !== "response_item" || payload?.type !== "message" || payload.role !== "developer" || !Array.isArray(payload.content)) return result;
    for (const raw of payload.content.slice(0, 64)) {
      const block = record(raw);
      if (block?.type !== "input_text" || typeof block.text !== "string") continue;
      const section = /<skills_instructions>([\s\S]*?)<\/skills_instructions>/u.exec(block.text)?.[1];
      if (!section || !/^### Available skills\s*$/mu.test(section)) continue;
      const roots = new Map<string, string>();
      const rootSection = /### Skill roots\s*\n([\s\S]*?)(?=\n### |$)/u.exec(section)?.[1] ?? "";
      for (const match of rootSection.matchAll(/^- `(r\d+)` = `([^`\n]+)`\s*$/gmu)) {
        if (path.isAbsolute(match[2]) && match[2].length <= 4096) roots.set(match[1], match[2]);
      }
      const listed = /### Available skills\s*\n([\s\S]*?)(?=\n### |$)/u.exec(section)?.[1] ?? "";
      const entries: SkillCatalogEntry[] = [];
      let invalid = false;
      for (const value of listed.split("\n").filter(value => value.startsWith("- "))) {
        const match = /^- (.+?): (.*?) \(file: ([^)]+)\)\s*$/u.exec(value);
        if (!match || match[1].length > 512 || match[3].length > 4096) { invalid = true; continue; }
        const alias = /^(r\d+)\/(.+)$/u.exec(match[3]);
        const file = alias && roots.has(alias[1]) ? path.resolve(roots.get(alias[1])!, alias[2]) : match[3];
        if (!path.isAbsolute(file) || path.basename(file) !== "SKILL.md" || /[\u0000-\u001f]/u.test(file)) { invalid = true; continue; }
        if (entries.length >= MAX_SKILLS) { invalid = true; break; }
        entries.push({ name: redactSummary(match[1], 100), description: redactSummary(match[2]), path: path.resolve(file) });
      }
      if (invalid) result.diagnostics.push({ code: "skill-catalog-format", severity: "warning", line,
        message: t("技能目录存在无法识别的条目或超过安全上限，仅保留已确认的文件引用") });
      result.events.push({ type: "skills-listed", skills: entries });
    }
    return result;
  }
}
