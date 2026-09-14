import { t } from "../../i18n/Messages.js";
import { opendir, realpath, stat } from "node:fs/promises";
import path from "node:path";
import { MAX_SKILLS, skillId, type SkillCatalogEntry, type SkillDirectorySnapshot, type SkillSource, type SkillState } from "../../core/SkillState.js";
import { redactSummary } from "../../core/Redaction.js";
import { DiscoveryFiles, DiscoveryFormatError } from "./DiscoveryFiles.js";
import { errorCode, type CodexDiagnostic } from "./Diagnostics.js";

export interface SkillMetadata { name: string; description: string; version?: string }

function scalar(raw: string): string {
  const value = raw.trim();
  if (value.startsWith('"')) {
    const match = /^("(?:\\.|[^"\\])*")(?:\s+#.*)?$/u.exec(value);
    if (!match) throw new DiscoveryFormatError(t("技能 frontmatter 的引号字符串无法识别"));
    try { return JSON.parse(match[1]) as string; }
    catch { throw new DiscoveryFormatError(t("技能 frontmatter 的转义形式尚未支持")); }
  }
  if (value.startsWith("'")) {
    const match = /^'((?:[^']|'')*)'(?:\s+#.*)?$/u.exec(value);
    if (!match) throw new DiscoveryFormatError(t("技能 frontmatter 的引号字符串无法识别"));
    return match[1].replace(/''/gu, "'");
  }
  const plain = value.replace(/\s+#.*$/u, "");
  if (!plain || /^[\[\]{},&*!|>@`%"']/u.test(plain) || /:\s/u.test(plain)
    || /^(?:true|false|null|~|[-+]?\d+(?:\.\d+)?)$/iu.test(plain)) {
    throw new DiscoveryFormatError(t("技能 frontmatter 需要可识别的字符串标量"));
  }
  return plain;
}

export function parseSkillMetadata(text: string): SkillMetadata {
  const header = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/u.exec(text)?.[1];
  if (header === undefined) throw new DiscoveryFormatError(t("未发现完整的技能 frontmatter，或头部超过 64 KiB"));
  const lines = header.split(/\r?\n/u);
  const values = new Map<string, string>();
  const scopes = [{ indent: 0, path: "", keys: new Set<string>() }];
  let childOf: string | undefined;
  for (let i = 0; i < lines.length; i++) {
    const row = lines[i];
    if (!row.trim() || row.trimStart().startsWith("#")) continue;
    // 只接受已支持的标量映射；未使用字段也要检查，避免损坏 YAML 被误报可用。
    const field = /^( *)([A-Za-z0-9_-]+):(?:[ \t]+(.*))?$/u.exec(row);
    if (!field) throw new DiscoveryFormatError(t("技能 frontmatter 包含未支持的映射或缩进形式"));
    const indent = field[1].length;
    if (indent > scopes.at(-1)!.indent) {
      if (!childOf) throw new DiscoveryFormatError(t("技能 frontmatter 的缩进无法识别"));
      scopes.push({ indent, path: childOf, keys: new Set<string>() });
    } else while (indent < scopes.at(-1)!.indent) scopes.pop();
    const scope = scopes.at(-1)!;
    if (indent !== scope.indent) throw new DiscoveryFormatError(t("技能 frontmatter 的映射缩进不一致"));
    childOf = undefined;
    if (scope.keys.has(field[2])) throw new DiscoveryFormatError(t("技能 frontmatter 包含重复字段"));
    scope.keys.add(field[2]);
    const fieldPath = scope.path ? `${scope.path}.${field[2]}` : field[2];
    const key = fieldPath === "metadata.version" ? "version" : ["name", "description"].includes(fieldPath) ? fieldPath : undefined;
    let value = field[3]?.trim() ?? "";
    if (!value || value.startsWith("#")) {
      if (key) throw new DiscoveryFormatError(t("技能 frontmatter 的必要字段为空"));
      childOf = fieldPath; continue;
    }
    if (/^[>|][-+]?(?:\s+#.*)?$/u.test(value)) {
      const body: string[] = [];
      while (i + 1 < lines.length && (!lines[i + 1].trim() || /^ */u.exec(lines[i + 1])![0].length > indent)) body.push(lines[++i].trim());
      value = body.join(" ");
    } else if (key || !/^(?:true|false|null|~|[-+]?\d+(?:\.\d+)?)(?:\s+#.*)?$/iu.test(value)) value = scalar(value);
    if (!key) continue;
    if (!value.trim()) throw new DiscoveryFormatError(t("技能 frontmatter 的必要字段为空"));
    values.set(key, redactSummary(value, key === "description" ? 240 : 100));
  }
  if (!values.has("name") || !values.has("description")) throw new DiscoveryFormatError(t("技能 frontmatter 缺少 name 或 description"));
  return { name: values.get("name")!, description: values.get("description")!, version: values.get("version") };
}

export async function discoverSkills(files: DiscoveryFiles, options: {
  codexHome: string; userHome: string; cwd?: string; catalog?: readonly SkillCatalogEntry[];
}): Promise<{ snapshot: SkillDirectorySnapshot; diagnostics: CodexDiagnostic[] }> {
  const diagnostics: CodexDiagnostic[] = [];
  const skills = new Map<string, SkillState>();
  const visited = new Set<string>();
  let anyDirectory = false;
  let limited = false;
  const roots: Array<{ directory: string; source: SkillSource; depth: number }> = [
    { directory: path.join(options.codexHome, "skills"), source: "user", depth: 0 },
    { directory: path.join(options.userHome, ".agents", "skills"), source: "user", depth: 0 },
  ];
  if (options.cwd) {
    let directory = path.resolve(options.cwd);
    for (let depth = 0; depth < 32; depth++) {
      if (directory !== options.userHome) for (const folder of [".agents", ".codex"]) roots.push({ directory: path.join(directory, folder, "skills"), source: "project", depth: 0 });
      let repository = false;
      try { await stat(path.join(directory, ".git")); repository = true; }
      catch (error) { if (!["ENOENT", "ENOTDIR"].includes(errorCode(error))) diagnostics.push({ code: "skill-project-scope", severity: "warning", message: t("项目边界不可读，技能目录按有界父路径检查") }); }
      const parent = path.dirname(directory);
      if (repository || parent === directory || directory === options.userHome) break;
      directory = parent;
    }
  }
  const load = async (file: string, source: SkillSource, advertised?: SkillCatalogEntry): Promise<boolean> => {
    const result = await files.read(file, 64 * 1024, parseSkillMetadata, true);
    if (result.status === "missing" && !advertised) return false;
    const canonical = result.canonicalPath ?? path.resolve(file);
    const id = skillId(canonical);
    if (!skills.has(id) && skills.size >= MAX_SKILLS) { limited = true; return true; }
    const previous = skills.get(id);
    const info = result.value;
    skills.set(id, { id, path: canonical, name: advertised?.name ?? previous?.name ?? info?.name ?? redactSummary(path.basename(path.dirname(file)), 100),
      description: info?.description, version: info?.version, source: previous?.source ?? source,
      advertised: !!advertised || previous?.advertised,
      status: result.status === "ready" ? advertised || previous?.advertised ? "available" : "unknown"
        : result.status === "missing" ? "unavailable" : "failed", error: result.status === "ready" ? undefined : result.reason });
    if (result.status !== "ready") diagnostics.push({ code: "skill-definition", severity: result.status === "missing" ? "warning" : "error", path: file,
      message: result.status === "missing" ? t("当前任务列出的技能文件已不可用") : result.reason ?? t("技能定义读取失败") });
    return true;
  };
  for (let index = 0; index < roots.length; index++) {
    if (visited.size >= 256) { limited = true; break; }
    const root = roots[index];
    let canonical: string;
    try { canonical = await realpath(root.directory); }
    catch (error) {
      if (!["ENOENT", "ENOTDIR"].includes(errorCode(error))) diagnostics.push({ code: "skill-directory", severity: "error", path: root.directory, message: t("技能目录不可读（{0}）", errorCode(error)) });
      continue;
    }
    if (visited.has(canonical)) continue;
    visited.add(canonical);
    try {
      const directory = await opendir(canonical);
      files.io.directories++; anyDirectory = true;
      const found = await load(path.join(canonical, "SKILL.md"), root.source);
      if (found || root.depth >= 4 || skills.size >= MAX_SKILLS) { await directory.close(); if (!found) limited = true; continue; }
      let entries = 0;
      for await (const entry of directory) {
        if (++entries > 1024) { limited = true; break; }
        if ((entry.isDirectory() || entry.isSymbolicLink()) && (!entry.name.startsWith(".") || entry.name === ".system")) {
          roots.push({ directory: path.join(canonical, entry.name), source: entry.name === ".system" ? "system" : root.source, depth: root.depth + 1 });
        }
      }
    } catch (error) {
      diagnostics.push({ code: "skill-directory", severity: "error", path: root.directory, message: t("技能目录读取失败（{0}）", errorCode(error)) });
    }
  }
  for (const entry of options.catalog?.slice(0, MAX_SKILLS) ?? []) {
    const source: SkillSource = entry.path.startsWith(path.join(options.codexHome, "plugins") + path.sep) ? "plugin" : "runtime";
    await load(entry.path, source, entry);
  }
  if (limited) diagnostics.push({ code: "skill-discovery-limit", severity: "warning", message: t("技能目录超过深度、数量或文件安全上限，清单不完整") });
  return { snapshot: { status: diagnostics.some(item => item.severity === "error") ? "error" : anyDirectory || skills.size ? "ready" : "missing", skills: [...skills.values()] }, diagnostics };
}
