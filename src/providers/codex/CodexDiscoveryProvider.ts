import { t } from "../../i18n/Messages.js";
import { execFile } from "node:child_process";
import { constants } from "node:fs";
import { access, open, readdir, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { errorCode, record, type CodexCheck, type CodexDiagnostic } from "./Diagnostics.js";
import { parseAgentMetadata, type AgentMetadata } from "./AgentMetadata.js";
import { protocolId } from "./app-server/AppServerEventNormalizer.js";
import type { RuntimeThreadAttachment } from "./runtime/RuntimeCandidate.js";

const execute = promisify(execFile);

export interface CodexRuntime {
  codexHome: string;
  sessionsPath: string;
  codexBinary?: string;
  version?: string;
  currentSessionId?: string;
  activeThreadId?: string;
  attachmentSource?: RuntimeThreadAttachment["attachmentSource"];
  currentRolloutPath?: string;
  rolloutVersion?: string;
  selection?: "working-directory" | "recent" | "environment" | "explicit";
  checks: CodexCheck[];
  diagnostics: CodexDiagnostic[];
  agentRollouts?: AgentRollout[];
  agentFeatureEnabled?: boolean | null;
  agentFeatureDetail?: string;
  userHome?: string;
  workingDirectory?: string;
  sessionCwd?: string;
}

export interface AgentRollout extends AgentMetadata { path: string; modifiedAt: number }

interface DiscoveryOptions {
  threadId?: string;
  codexHome?: string;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  readVersion?: (binary: string) => Promise<string>;
  readFeatures?: (binary: string) => Promise<string>;
  userHome?: string;
}

interface Candidate {
  path: string;
  modifiedAt: number;
}

async function metadata(filePath: string): Promise<AgentMetadata> {
  const file = await open(filePath, "r");
  try {
    const chunks: Buffer[] = [];
    let offset = 0;
    while (offset < 1024 * 1024) {
      const buffer = Buffer.alloc(16 * 1024);
      const { bytesRead } = await file.read(buffer, 0, buffer.length, offset);
      if (!bytesRead) break;
      offset += bytesRead;
      const newline = buffer.subarray(0, bytesRead).indexOf(10);
      chunks.push(buffer.subarray(0, newline < 0 ? bytesRead : newline));
      if (newline < 0) continue;
      const event = record(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks))));
      const payload = record(event?.payload);
      if (event?.type !== "session_meta" || typeof payload?.id !== "string" || !payload.id.trim()) break;
      const result = parseAgentMetadata(payload);
      if (result) return result;
      break;
    }
    throw new Error(t("缺少完整的 session_meta 首行，或首行超过 1 MiB"));
  } finally {
    await file.close();
  }
}

export class CodexDiscoveryProvider {
  private readonly env: NodeJS.ProcessEnv;
  private readonly cwd: string;
  private readonly home: string;
  private readonly userHome: string;
  private readonly explicitThreadId?: string;
  private readonly readVersion: (binary: string) => Promise<string>;
  private readonly readFeatures: (binary: string) => Promise<string>;
  private featureProbe?: Promise<{ enabled: boolean | null; detail: string }>;
  private readonly metadataCache = new Map<string, { modifiedAt: number; session: AgentMetadata }>();

  constructor(options: DiscoveryOptions = {}) {
    this.env = options.env ?? process.env;
    this.cwd = path.resolve(options.cwd ?? process.cwd());
    this.home = path.resolve(options.codexHome ?? (this.env.CODEX_HOME || path.join(os.homedir(), ".codex")));
    this.userHome = path.resolve(options.userHome ?? (options.codexHome ? path.dirname(this.home) : os.homedir()));
    if (options.threadId !== undefined && !protocolId(options.threadId)) throw new Error(t("明确线程 ID 格式无效"));
    this.explicitThreadId = options.threadId;
    this.readVersion = options.readVersion ?? (async binary => {
      const result = await execute(binary, ["--version"], { encoding: "utf8", timeout: 5000, maxBuffer: 64 * 1024 });
      return result.stdout;
    });
    this.readFeatures = options.readFeatures ?? (async binary => (await execute(binary, ["features", "list"], {
      encoding: "utf8", timeout: 5000, maxBuffer: 64 * 1024, env: { ...this.env, CODEX_HOME: this.home },
    })).stdout);
  }

  async discover(): Promise<CodexRuntime> {
    const runtime: CodexRuntime = {
      codexHome: this.home, sessionsPath: path.join(this.home, "sessions"), checks: [], diagnostics: [],
      userHome: this.userHome, workingDirectory: this.cwd,
    };
    const environmentHome = path.resolve(this.env.CODEX_HOME || path.join(os.homedir(), ".codex"));
    if (this.explicitThreadId) {
      runtime.activeThreadId = this.explicitThreadId;
      runtime.attachmentSource = "explicit";
    } else if (environmentHome === this.home && this.env.CODEX_THREAD_ID) {
      const threadId = protocolId(this.env.CODEX_THREAD_ID);
      if (threadId && (!this.env.CODEX_SESSION_ID || this.env.CODEX_SESSION_ID === threadId)) {
        runtime.activeThreadId = threadId;
        runtime.attachmentSource = "environment";
      } else runtime.diagnostics.push({ code: "thread-context", severity: "warning", message: t("环境线程身份无效或相互冲突，未选择实时线程") });
    }
    const binaryNames = process.platform === "win32" ? ["codex.exe", "codex.cmd", "codex.bat"] : ["codex"];
    for (const directory of (this.env.PATH ?? "").split(path.delimiter).filter(Boolean)) {
      for (const name of binaryNames) {
        const binary = path.resolve(directory, name);
        try {
          await access(binary, constants.X_OK);
          if ((await stat(binary)).isFile()) { runtime.codexBinary = binary; break; }
        } catch (error) {
          if (!["ENOENT", "ENOTDIR", "EACCES"].includes(errorCode(error))) {
            runtime.diagnostics.push({ code: "binary-access", severity: "warning", message: t("检查 Codex binary 失败（{0}）", errorCode(error)), path: binary });
          }
        }
      }
      if (runtime.codexBinary) break;
    }
    runtime.checks.push({ id: "binary", label: "Codex binary", ok: !!runtime.codexBinary, detail: runtime.codexBinary ?? t("PATH 中未找到可执行的 codex") });
    if (runtime.codexBinary) {
      try {
        const version = (await this.readVersion(runtime.codexBinary)).trim();
        if (!/^codex-cli \d+\.\d+\.\d+(?:[-+][a-zA-Z0-9.-]+)?$/u.test(version)) {
          runtime.diagnostics.push({ code: "version-format", severity: "error", message: t("Codex 返回了无法识别的版本格式") });
        } else runtime.version = version;
      } catch (error) {
        const timedOut = (error as { killed?: boolean } | null)?.killed;
        runtime.diagnostics.push({ code: "version-read", severity: "error", message: timedOut ? t("读取 Codex 版本超时") : t("读取 Codex 版本失败（{0}）", errorCode(error)) });
      }
    }
    runtime.checks.push({ id: "version", label: t("Codex 版本"), ok: !!runtime.version, detail: runtime.version ?? t("未取得版本；仍可读取已有 rollout") });
    if (runtime.codexBinary) {
      this.featureProbe ??= this.readFeatures(runtime.codexBinary).then(output => {
        const value = /^multi_agent\s+.+?\s+(true|false)\s*$/mu.exec(output)?.[1];
        return { enabled: value ? value === "true" : null, detail: value ? t("当前 CLI 启动时的 feature 快照；Desktop 可使用不同配置") : t("CLI 未报告 multi_agent 标志，能力尚未检测到") };
      }, error => ({ enabled: null, detail: t("无法查询 CLI 多代理配置（{0}）", errorCode(error)) }));
      const feature = await this.featureProbe;
      runtime.agentFeatureEnabled = feature.enabled;
      runtime.agentFeatureDetail = feature.detail;
    }

    for (const [id, label, directory] of [["home", "Codex home", this.home], ["sessions", t("sessions 目录"), runtime.sessionsPath]]) {
      try {
        const isDirectory = (await stat(directory)).isDirectory();
        runtime.checks.push({ id, label, ok: isDirectory, detail: isDirectory ? directory : t("路径不是目录") });
      } catch (error) {
        runtime.checks.push({ id, label, ok: false, detail: t("无法访问（{0}）", errorCode(error)) });
        if (errorCode(error) !== "ENOENT") runtime.diagnostics.push({ code: "directory-access", severity: "error", message: t("{0}无法访问（{1}）", label, errorCode(error)), path: directory });
      }
    }

    const candidates: Candidate[] = [];
    const pending = runtime.checks.find(check => check.id === "sessions")?.ok ? [runtime.sessionsPath] : [];
    while (pending.length) {
      const directory = pending.pop()!;
      try {
        for (const entry of await readdir(directory, { withFileTypes: true })) {
          const entryPath = path.join(directory, entry.name);
          if (entry.isDirectory()) pending.push(entryPath);
          else if (entry.isFile() && entry.name.startsWith("rollout-") && entry.name.endsWith(".jsonl")) {
            try {
              candidates.push({ path: entryPath, modifiedAt: (await stat(entryPath)).mtimeMs });
            } catch (error) {
              runtime.diagnostics.push({ code: "rollout-stat", severity: "warning", message: t("rollout 元数据不可读（{0}）", errorCode(error)), path: entryPath });
            }
          }
        }
      } catch (error) {
        runtime.diagnostics.push({ code: "sessions-read", severity: "error", message: t("读取 sessions 子目录失败（{0}）", errorCode(error)), path: directory });
      }
    }
    candidates.sort((a, b) => b.modifiedAt - a.modifiedAt || a.path.localeCompare(b.path));
    let recent: { candidate: Candidate; session: AgentMetadata } | undefined;
    let selected: typeof recent;
    const agents: AgentRollout[] = [];
    const present = new Set(candidates.map(candidate => candidate.path));
    for (const key of this.metadataCache.keys()) if (!present.has(key)) this.metadataCache.delete(key);
    for (const candidate of candidates) {
      try {
        const cached = this.metadataCache.get(candidate.path);
        const session = cached?.modifiedAt === candidate.modifiedAt ? cached.session : await metadata(candidate.path);
        this.metadataCache.set(candidate.path, { modifiedAt: candidate.modifiedAt, session });
        if (this.metadataCache.size > 4096) this.metadataCache.delete(this.metadataCache.keys().next().value!);
        if (session.taskAgent) agents.push({ ...session, path: candidate.path, modifiedAt: candidate.modifiedAt });
        if (session.subagent) continue;
        recent ??= { candidate, session };
        if (runtime.activeThreadId ? session.id === runtime.activeThreadId : !selected && session.cwd && path.resolve(session.cwd) === this.cwd) {
          selected = { candidate, session };
        }
      } catch (error) {
        // JSON 错误可能带有日志正文；只报告固定描述与错误码。
        runtime.diagnostics.push({ code: "session-metadata", severity: "warning", message: t("无法读取有效的 session_meta 首行（{0}）", errorCode(error)), path: candidate.path });
      }
    }
    runtime.selection = runtime.activeThreadId ? runtime.attachmentSource as "environment" | "explicit"
      : selected ? "working-directory" : recent ? "recent" : undefined;
    if (!runtime.activeThreadId) selected ??= recent;
    runtime.currentSessionId = runtime.activeThreadId;
    if (selected) {
      runtime.currentSessionId = selected.session.id;
      runtime.currentRolloutPath = selected.candidate.path;
      runtime.rolloutVersion = selected.session.version;
      runtime.sessionCwd = selected.session.cwd;
      const byParent = new Map<string, AgentRollout[]>();
      for (const agent of agents) if (agent.parentId) {
        const siblings = byParent.get(agent.parentId) ?? [];
        siblings.push(agent); byParent.set(agent.parentId, siblings);
      }
      const members = new Set([selected.session.id]);
      for (const id of members) for (const child of byParent.get(id) ?? []) members.add(child.id);
      // session_id 只限定所属会话；缺失的父边仍然作为 orphan，不据此补造 parent。
      runtime.agentRollouts = agents.filter(agent => members.has(agent.id) || agent.sessionId === selected.session.id);
    }
    runtime.checks.push({ id: "active-rollout", label: t("主会话 rollout"), ok: !!selected,
      detail: selected ? runtime.activeThreadId ? t("与明确线程 ID 匹配的主会话") : runtime.selection === "working-directory"
        ? t("当前工作目录的历史主会话；不作为实时线程依据") : t("最近历史主会话；不作为实时线程依据")
        : runtime.activeThreadId ? t("明确线程尚无可读 rollout，未回放其他会话") : t("未找到可读取的主会话 rollout") });
    runtime.checks.push({ id: "thread-context", label: t("当前线程依据"), ok: !!runtime.activeThreadId, warning: !runtime.activeThreadId,
      detail: runtime.activeThreadId ? runtime.attachmentSource === "environment" ? t("同一 CODEX_HOME 的环境线程 ID") : t("调用方明确指定的线程 ID")
        : t("无明确实时线程；仅显示可用历史，不自动选择最近线程附着") });
    return runtime;
  }
}
