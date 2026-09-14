import { createHash } from "node:crypto";

export type SkillStatus = "available" | "loaded" | "active" | "disabled" | "failed" | "unavailable" | "unknown";
export type SkillSource = "system" | "user" | "project" | "plugin" | "runtime";

export interface SkillState {
  id: string;
  name: string;
  description?: string;
  status: SkillStatus;
  source: SkillSource;
  path?: string;
  version?: string;
  advertised?: boolean;
  error?: string;
}

export interface SkillCatalogEntry { name: string; path: string; description?: string }

export interface SkillCapability {
  directoryDiscovery: boolean;
  runtimeDiscovery: boolean;
  activeState: boolean;
  versionInfo: boolean;
}

export interface SkillDirectorySnapshot {
  status: "ready" | "missing" | "error";
  skills: SkillState[];
}

export interface SkillSummary {
  enabled: boolean;
  count: number;
  availableCount: number;
  activeCount: number;
  failedCount: number;
  disabledCount: number;
  directoryStatus: SkillDirectorySnapshot["status"];
  skills: SkillState[];
  capability: SkillCapability;
  issues: string[];
}

export const skillId = (canonicalPath: string): string => `skill-${createHash("sha256").update(canonicalPath).digest("hex").slice(0, 24)}`;
export const MAX_SKILLS = 512;
