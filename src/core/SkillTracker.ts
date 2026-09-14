import { t } from "../i18n/Messages.js";
import { MAX_SKILLS, type SkillCatalogEntry, type SkillDirectorySnapshot, type SkillState, type SkillSummary } from "./SkillState.js";
import { redactSummary } from "./Redaction.js";

export class SkillTracker {
  private catalog?: SkillCatalogEntry[];
  private directory?: SkillDirectorySnapshot;
  private skills = new Map<string, SkillState>();
  private limited = false;

  reset(): void { this.catalog = undefined; this.directory = undefined; this.skills.clear(); this.limited = false; }

  replaceCatalog(entries: readonly SkillCatalogEntry[]): void {
    this.catalog = [...new Map(entries.slice(0, MAX_SKILLS).map(entry => [entry.path, { ...entry,
      name: redactSummary(entry.name, 100), description: entry.description && redactSummary(entry.description) }])).values()];
    if (entries.length > MAX_SKILLS) this.limited = true;
  }

  getCatalog(): SkillCatalogEntry[] | undefined { return this.catalog && structuredClone(this.catalog); }

  replaceDirectory(directory: SkillDirectorySnapshot): void {
    this.directory = { status: directory.status, skills: [] };
    this.skills.clear();
    this.limited = directory.skills.length > MAX_SKILLS;
    for (const skill of directory.skills.slice(0, MAX_SKILLS)) this.update(skill);
  }

  update(skill: SkillState): void {
    if (!this.skills.has(skill.id) && this.skills.size >= MAX_SKILLS) { this.limited = true; return; }
    this.skills.set(skill.id, { id: skill.id, name: redactSummary(skill.name, 100), status: skill.status, source: skill.source,
      path: skill.path, advertised: skill.advertised, description: skill.description && redactSummary(skill.description),
      version: skill.version && redactSummary(skill.version, 80), error: skill.error && redactSummary(skill.error) });
  }

  getSummary(): SkillSummary | undefined {
    if (!this.directory && !this.catalog && !this.skills.size) return undefined;
    const skills = [...this.skills.values()].sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
    return { enabled: true, count: skills.length,
      availableCount: skills.filter(skill => ["available", "loaded", "active"].includes(skill.status)).length,
      activeCount: skills.filter(skill => skill.status === "active").length,
      failedCount: skills.filter(skill => skill.status === "failed" || skill.status === "unavailable").length,
      disabledCount: skills.filter(skill => skill.status === "disabled").length,
      directoryStatus: this.directory?.status ?? "missing", skills: structuredClone(skills),
      capability: { directoryDiscovery: this.directory?.status === "ready", runtimeDiscovery: this.catalog !== undefined,
        activeState: skills.some(skill => skill.status === "active" || skill.status === "loaded"), versionInfo: skills.some(skill => skill.version !== undefined) },
      issues: this.limited ? [t("技能发现达到安全上限，清单不完整")] : [] };
  }
}
