import { t } from "../../i18n/Messages.js";
import path from "node:path";
import type { McpConfiguration } from "../../core/McpState.js";
import type { SkillCatalogEntry, SkillDirectorySnapshot } from "../../core/SkillState.js";
import type { CodexRuntime } from "./CodexDiscoveryProvider.js";
import type { CodexDiagnostic } from "./Diagnostics.js";
import { DiscoveryFiles, type DiscoveryIO } from "./DiscoveryFiles.js";
import { parseMcpConfiguration } from "./McpDiscovery.js";
import { discoverSkills } from "./SkillDiscovery.js";

export interface CapabilityDiscoverySnapshot {
  mcp: McpConfiguration;
  skills: SkillDirectorySnapshot;
  diagnostics: CodexDiagnostic[];
  io: DiscoveryIO;
}

export class CapabilityDiscovery {
  private readonly files = new DiscoveryFiles();
  private snapshot?: CapabilityDiscoverySnapshot;
  private key?: string;

  async refresh(runtime: CodexRuntime, catalog: SkillCatalogEntry[] | undefined, checkChanges: boolean): Promise<CapabilityDiscoverySnapshot> {
    const key = JSON.stringify([runtime.codexHome, runtime.userHome, runtime.sessionCwd ?? runtime.workingDirectory, catalog]);
    if (!checkChanges && key === this.key && this.snapshot) return { ...structuredClone(this.snapshot), io: { stats: 0, filesRead: 0, bytesRead: 0, directories: 0 } };
    this.files.begin();
    const configPath = path.join(runtime.codexHome, "config.toml");
    const configuration = await this.files.read(configPath, 1024 * 1024, parseMcpConfiguration);
    const skills = await discoverSkills(this.files, { codexHome: runtime.codexHome,
      userHome: runtime.userHome ?? path.dirname(runtime.codexHome), cwd: runtime.sessionCwd ?? runtime.workingDirectory, catalog });
    this.files.finish();
    const diagnostics: CodexDiagnostic[] = configuration.status === "error" ? [{ code: "mcp-configuration", severity: "error", path: configPath,
      message: configuration.reason ?? t("MCP 配置读取失败") }] : [];
    diagnostics.push(...skills.diagnostics);
    this.key = key;
    this.snapshot = { mcp: { status: configuration.status, servers: configuration.value ?? [] }, skills: skills.snapshot,
      diagnostics: diagnostics.length > 50 ? [...diagnostics.slice(0, 49), { code: "capability-diagnostics-limit",
        severity: diagnostics.some(item => item.severity === "error") ? "error" : "warning", message: t("另有 {0} 条能力发现诊断，详情已限量", diagnostics.length - 49) }] : diagnostics,
      io: { ...this.files.io } };
    return structuredClone(this.snapshot);
  }
}
