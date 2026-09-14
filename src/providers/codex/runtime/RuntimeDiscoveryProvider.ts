import { t } from "../../../i18n/Messages.js";
import { execFile } from "node:child_process";
import { constants } from "node:fs";
import { lstat, open, readdir, realpath, stat } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import type { CodexRuntime } from "../CodexDiscoveryProvider.js";
import { errorCode } from "../Diagnostics.js";
import { runtimeIdentity, type RuntimeCandidate, type RuntimeCommands, type RuntimeDiscoveryResult } from "./RuntimeCandidate.js";

const execute = promisify(execFile);
const processMetadata = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\w+\s+\w+\s+\d+\s+[\d:]+\s+\d+)\s+(.+)$/u;
export interface RuntimeProcess {
  pid: number;
  parentPid: number;
  uid: number;
  executable: string;
  startedAt?: string;
  commandReadable: boolean;
  appServer: boolean;
  transport: RuntimeCandidate["transport"];
  endpoint?: string;
  socketPaths: string[];
}
export interface SocketEvidence {
  owner: RuntimeCandidate["owner"];
  permissions: RuntimeCandidate["permissions"];
  identity?: string;
  reason?: string;
}
export interface RuntimeDiscoveryOptions {
  runtime: CodexRuntime;
  env?: NodeJS.ProcessEnv;
  now?: () => number;
  cacheMs?: number;
  processes?: () => Promise<RuntimeProcess[]>;
  commands?: () => Promise<RuntimeCommands>;
  processVersion?: (process: RuntimeProcess) => Promise<string | undefined>;
  managedStatus?: () => Promise<boolean>;
}

function argumentsOf(command: string): string[] | undefined {
  const tokens: string[] = [];
  let token = "", quote = "", escaped = false;
  for (const char of command) {
    if (escaped) { token += char; escaped = false; }
    else if (char === "\\" && quote !== "'") escaped = true;
    else if (quote) { if (char === quote) quote = ""; else token += char; }
    else if (char === "'" || char === '"') quote = char;
    else if (/\s/u.test(char)) { if (token) { tokens.push(token); token = ""; } }
    else token += char;
  }
  if (quote || escaped) return undefined;
  if (token) tokens.push(token);
  return tokens;
}

// 只保留可执行文件和已识别的传输参数；进程参数中的 prompt、凭据不进入结果。
export function parseRuntimeProcesses(metadata: string, commands: string): RuntimeProcess[] {
  const argumentsByPid = new Map(commands.split("\n").flatMap(line => {
    const match = /^\s*(\d+)\s+(.*)$/u.exec(line);
    return match ? [[Number(match[1]), match[2]] as const] : [];
  }));
  const processes: RuntimeProcess[] = [];
  for (const line of metadata.split("\n")) {
    const match = processMetadata.exec(line);
    if (!match || !/^codex(?:\.exe)?$/iu.test(path.basename(match[5]))) continue;
    const pid = Number(match[1]), executable = match[5];
    const command = argumentsByPid.get(pid);
    const argv = command === undefined ? undefined : argumentsOf(command.startsWith(`${executable} `) ? command.slice(executable.length) : command);
    if (argv?.[0] === executable || argv?.[0] === path.basename(executable)) argv.shift();
    let index = 0;
    while (argv && index < argv.length && argv[index].startsWith("-")) {
      if (["-c", "--config", "--enable", "--disable", "-p", "--profile", "-C", "--cd"].includes(argv[index])) index += 2;
      else if (/^--(?:config|enable|disable|profile|cd)=/u.test(argv[index])) index++;
      else break;
    }
    if (argv && argv[index] !== "app-server" && !argv[index]?.startsWith("-")) continue;
    if (argv?.[index] !== "app-server") index = -1;
    const appServer = index >= 0 && !["proxy", "daemon", "generate-ts", "generate-json-schema"].includes(argv?.[index + 1] ?? "");
    if (index >= 0 && !appServer) continue;
    const listenAt = argv?.indexOf("--listen", index + 1) ?? -1;
    const listen = listenAt < 0 ? argv?.find(arg => arg.startsWith("--listen="))?.slice(9) : argv?.[listenAt + 1];
    const endpoint = listen?.startsWith("unix:///") ? listen.slice(7) : listen?.startsWith("ws://") || listen?.startsWith("wss://") ? listen : undefined;
    const transport = listen?.startsWith("unix://") ? "unix-socket" : listen?.startsWith("ws") ? "websocket"
      : appServer && (!listen || listen === "stdio://") ? "stdio" : "unknown";
    processes.push({ pid, parentPid: Number(match[2]), uid: Number(match[3]), executable, startedAt: match[4],
      commandReadable: !!argv && index >= 0, appServer, transport, endpoint, socketPaths: [] });
  }
  return processes;
}

async function readRuntimeProcesses(pid?: number): Promise<RuntimeProcess[]> {
  if (process.platform !== "darwin" && process.platform !== "linux") throw new Error(t("进程身份检查尚不支持当前平台"));
  const options = { timeout: 3000, maxBuffer: 2 * 1024 * 1024, encoding: "utf8" as const, env: { ...process.env, LC_ALL: "C" } };
  const args = pid === undefined ? ["-axo"] : ["-p", String(pid), "-o"];
  const results = await Promise.all([execute("ps", [...args, "pid=,ppid=,uid=,lstart=,comm="], options),
    execute("ps", [...args, "pid=,args="], options)]);
  const rows = results[0].stdout.split("\n").filter(line => line.trim());
  if (!rows.length || rows.some(line => !processMetadata.test(line))) throw new Error(t("进程表格式未确认"));
  const processes = parseRuntimeProcesses(results[0].stdout, results[1].stdout);
  if (processes.length > 32) throw new Error(t("候选进程超过安全上限"));
  if (processes.length) {
    try {
      const sockets = (await execute("lsof", ["-nP", "-a", "-U", "-p", processes.map(item => item.pid).join(","), "-Fpn"], options)).stdout;
      let processId: number | undefined;
      for (const line of sockets.split("\n")) {
        if (/^p\d+$/u.test(line)) processId = Number(line.slice(1));
        else if (line.startsWith("n/") && !line.includes(" -> ")) processes.find(item => item.pid === processId)?.socketPaths.push(line.slice(1));
      }
    } catch (error) {
      if ((error as { code?: unknown }).code !== 1) throw error;
    }
  }
  return processes;
}

export async function verifyRuntimeProcess(candidate: RuntimeCandidate): Promise<boolean> {
  if (!candidate.pid || !candidate.executable || !candidate.processStartedAt || !candidate.endpoint) return false;
  const binary = await stat(candidate.executable), startedAt = Date.parse(candidate.processStartedAt);
  if (!binary.isFile() || !Number.isFinite(startedAt) || binary.ctimeMs > startedAt || binary.mtimeMs > startedAt || binary.mode & 0o022) return false;
  const matches = (item: RuntimeProcess | undefined) => !!item && item.appServer && item.commandReadable
    && item.uid === process.getuid?.() && item.executable === candidate.executable && item.startedAt === candidate.processStartedAt;
  const runningProcess = (await readRuntimeProcesses(candidate.pid)).find(item => item.pid === candidate.pid);
  if (!matches(runningProcess) || !runningProcess!.socketPaths.includes(candidate.endpoint)) return false;
  // lsof 完成后再核对进程出生信息，避免把复用的 PID 拼接成旧身份。
  const [metadata, command] = await Promise.all(["pid=,ppid=,uid=,lstart=,comm=", "pid=,args="].map(fields =>
    execute("ps", ["-p", String(candidate.pid), "-o", fields], { timeout: 3000, maxBuffer: 64 * 1024, encoding: "utf8", env: { ...process.env, LC_ALL: "C" } })));
  const latest = parseRuntimeProcesses(metadata.stdout, command.stdout)[0];
  return matches(latest);
}

export async function inspectRuntimeSocket(endpoint: string, uid = process.getuid?.()): Promise<SocketEvidence> {
  try {
    const socket = await lstat(endpoint);
    if (!socket.isSocket() || socket.isSymbolicLink()) return { owner: "unknown", permissions: "denied", reason: t("端点不是 Unix socket") };
    const parent = await stat(path.dirname(endpoint));
    const owner = uid !== undefined && socket.uid === uid && parent.uid === uid ? "verified" : uid === undefined ? "unknown" : "denied";
    const permissions = parent.isDirectory() && !(socket.mode & 0o022) && !(parent.mode & 0o022) ? "verified" : "denied";
    return { owner, permissions, identity: `${socket.dev}:${socket.ino}:${socket.ctimeMs}`,
      reason: owner !== "verified" ? t("socket 或父目录 owner 未确认") : permissions !== "verified" ? t("socket 或父目录允许其他用户写入") : undefined };
  } catch (error) { return { owner: "unknown", permissions: "unknown", reason: t("socket 检查失败（{0}）", errorCode(error)) }; }
}

export class RuntimeDiscoveryProvider {
  private cached?: RuntimeDiscoveryResult;
  private pending?: Promise<RuntimeDiscoveryResult>;
  private commandsCache?: Promise<RuntimeCommands>;
  private readonly now: () => number;
  constructor(private readonly options: RuntimeDiscoveryOptions) { this.now = options.now ?? Date.now; }

  discover(force = false): Promise<RuntimeDiscoveryResult> {
    if (this.pending) return this.pending.then(result => structuredClone(result));
    if (!force && this.cached && this.now() - this.cached.discoveredAt < (this.options.cacheMs ?? 30_000)) return Promise.resolve(structuredClone(this.cached));
    this.pending = this.scan().then(result => { this.cached = result; return result; }).finally(() => { this.pending = undefined; });
    return this.pending.then(result => structuredClone(result));
  }

  private async commands(): Promise<RuntimeCommands> {
    const binary = this.options.runtime.codexBinary;
    if (!binary) return { stdio: false, proxy: false, daemon: false, daemonStart: false, daemonVersion: false };
    const env = { ...(this.options.env ?? process.env), CODEX_HOME: this.options.runtime.codexHome };
    const help = (await execute(binary, ["app-server", "--help"], { timeout: 3000, maxBuffer: 128 * 1024, encoding: "utf8", env })).stdout;
    const daemon = /^\s+daemon\s/mu.test(help);
    const daemonHelp = daemon ? (await execute(binary, ["app-server", "daemon", "--help"], { timeout: 3000, maxBuffer: 128 * 1024, encoding: "utf8", env })).stdout : "";
    return { stdio: help.includes("--stdio"), proxy: /^\s+proxy\s/mu.test(help), daemon,
      daemonStart: /^\s+start\s/mu.test(daemonHelp), daemonVersion: /^\s+version\s/mu.test(daemonHelp) };
  }

  private async processes(): Promise<RuntimeProcess[]> {
    return readRuntimeProcesses();
  }

  private async processVersion(item: RuntimeProcess): Promise<string | undefined> {
    if (!item.startedAt || !path.isAbsolute(item.executable)) return undefined;
    const before = await stat(item.executable);
    const started = Date.parse(item.startedAt);
    if (!before.isFile() || !Number.isFinite(started) || before.mtimeMs > started || before.ctimeMs > started || before.mode & 0o022) return undefined;
    const result = await execute(item.executable, ["--version"], { timeout: 2000, maxBuffer: 16 * 1024, encoding: "utf8" });
    const after = await stat(item.executable);
    if (before.ino !== after.ino || before.ctimeMs !== after.ctimeMs) return undefined;
    return /^codex-cli (\d+\.\d+\.\d+(?:[-+][\w.-]+)?)\s*$/u.exec(result.stdout)?.[1];
  }

  private async scan(): Promise<RuntimeDiscoveryResult> {
    const result: RuntimeDiscoveryResult = { candidates: [], status: "not-found", discoveredAt: this.now(),
      commands: { stdio: false, proxy: false, daemon: false, daemonStart: false, daemonVersion: false }, managed: "unknown",
      socket: "unknown", processScan: "unavailable", issues: [] };
    const issue = (message: string) => { if (result.issues.length < 20) result.issues.push(message); };
    const expired = () => {
      if (this.now() - result.discoveredAt <= 15_000) return false;
      issue(t("runtime 发现达到 15 秒总时间上限")); return true;
    };
    const commands = this.commandsCache ??= (this.options.commands?.() ?? this.commands()).catch(error => { this.commandsCache = undefined; throw error; });
    const tasks = await Promise.allSettled([commands, this.options.processes?.() ?? this.processes()]);
    if (tasks[0].status === "fulfilled") result.commands = tasks[0].value;
    else issue(t("运行命令能力未确认（{0}）", errorCode(tasks[0].reason)));
    const processes = tasks[1].status === "fulfilled" ? tasks[1].value : [];
    if (tasks[1].status === "fulfilled") result.processScan = "complete";
    else issue(t("无法读取 runtime 进程身份（{0}）", errorCode(tasks[1].reason)));
    if (expired()) { result.status = "error"; return result; }
    const paths = new Set<string>(), pidHints = new Map<string, number>();
    let filesystemComplete = true;
    try {
      const root = await readdir(this.options.runtime.codexHome, { withFileTypes: true });
      if (root.length > 512) throw new Error(t("home 条目超过安全上限"));
      result.socket = "absent";
      for (const entry of root) {
        if (expired()) throw new Error(t("发现超时"));
        const full = path.join(this.options.runtime.codexHome, entry.name);
        if (entry.isSocket() || entry.name.endsWith(".sock")) paths.add(full);
        if (!entry.isDirectory() || !/^(?:app[-_]server|daemon)(?:[-_.].*)?$/iu.test(entry.name)) continue;
        const children = await readdir(full, { withFileTypes: true });
        if (children.length > 64) { filesystemComplete = false; issue(t("runtime 状态目录条目超过安全上限")); continue; }
        for (const child of children) {
          if (expired()) throw new Error(t("发现超时"));
          const target = path.join(full, child.name);
          if (child.isSocket() || child.name.endsWith(".sock")) paths.add(target);
          // PID 只作为旁证；不解析未公开的 daemon 状态 JSON 或数据库。
          if (child.isFile() && /^(?:.*\.pid|pid)$/u.test(child.name)) {
            const file = await open(target, constants.O_RDONLY | constants.O_NOFOLLOW);
            try {
              const info = await file.stat();
              if (!info.isFile() || info.uid !== process.getuid?.() || info.size > 64 || info.mode & 0o022) { issue(t("PID 文件权限或大小不安全")); continue; }
              const buffer = Buffer.alloc(65), { bytesRead } = await file.read(buffer, 0, 65, 0);
              const value = buffer.subarray(0, bytesRead).toString("utf8").trim();
              if (bytesRead <= 64 && /^[1-9]\d{0,9}$/u.test(value)) pidHints.set(full, Number(value));
              else issue(t("PID 文件格式未确认"));
            } finally { await file.close(); }
          }
        }
      }
    } catch (error) { filesystemComplete = false; issue(t("runtime 文件发现失败（{0}）", errorCode(error))); }
    for (const item of processes) {
      if (item.transport === "unix-socket" && item.endpoint) paths.add(item.endpoint);
      for (const socket of item.socketPaths) paths.add(socket);
    }
    if (paths.size > 16) { issue(t("socket 候选超过 16 项，未自动选择")); result.status = "error"; return result; }
    const matchedPids = new Set<number>();
    for (const endpoint of paths) {
      if (expired()) { result.status = "error"; return result; }
      const evidence = await inspectRuntimeSocket(endpoint);
      if (evidence.identity) result.socket = "present";
      const canonical = await realpath(endpoint).catch(() => endpoint);
      const matches = processes.filter(item => item.socketPaths.some(socket => socket === endpoint || socket === canonical));
      const item = matches.length === 1 ? matches[0] : undefined;
      const hinted = pidHints.get(path.dirname(endpoint));
      const validProcess = !!item?.appServer && item.commandReadable && (!hinted || hinted === item.pid);
      if (item) matchedPids.add(item.pid);
      const candidate: RuntimeCandidate = { id: runtimeIdentity([endpoint, evidence.identity, item?.pid, item?.startedAt]),
        kind: item?.executable.includes(".app/") ? "desktop-managed" : item ? "standalone" : "unknown", transport: "unix-socket",
        ownership: "external", endpoint, pid: item?.pid, executable: item?.executable, processStartedAt: item?.startedAt,
        state: validProcess ? "running" : "unknown", source: item ? "process" : "filesystem",
        owner: evidence.owner === "verified" && item && item.uid !== process.getuid?.() ? "denied" : evidence.owner,
        permissions: evidence.permissions, socketIdentity: evidence.identity, endpointVerified: matches.length === 1,
        process: validProcess ? "verified" : hinted || item ? "mismatch" : "unknown", health: "unknown", compatibility: "unknown",
        reason: evidence.reason ?? (!validProcess ? t("socket 未与可确认的 Codex app-server 进程对应") : undefined) };
      if (item && validProcess && candidate.owner === "verified" && candidate.permissions === "verified") {
        try { candidate.codexVersion = await (this.options.processVersion?.(item) ?? this.processVersion(item)); }
        catch (error) { issue(t("运行进程 binary 版本未确认（{0}）", errorCode(error))); }
        if (candidate.codexVersion) candidate.versionSource = "process-binary";
        if (result.commands.daemonVersion && path.basename(endpoint) === "app-server-control.sock"
          && path.basename(path.dirname(endpoint)) === "app-server-control"
          && await realpath(path.dirname(path.dirname(endpoint))) === await realpath(this.options.runtime.codexHome)) {
          try {
            const managed = this.options.managedStatus ? await this.options.managedStatus() : await execute(this.options.runtime.codexBinary!,
              ["app-server", "daemon", "version"], { env: { ...(this.options.env ?? process.env), CODEX_HOME: this.options.runtime.codexHome },
                timeout: 3000, maxBuffer: 64 * 1024, encoding: "utf8" }).then(() => true);
            if (managed) { candidate.kind = "managed-daemon"; result.managed = "running"; }
          } catch { issue(t("官方 daemon 版本查询未成功，保留现有 runtime 候选")); }
        }
      }
      result.candidates.push(candidate);
    }
    for (const item of processes) if (!matchedPids.has(item.pid)) {
      if (result.candidates.length >= 32) { issue(t("runtime 候选超过安全上限")); break; }
      result.candidates.push({ id: runtimeIdentity([item.pid, item.startedAt, item.executable]), kind: item.executable.includes(".app/") ? "desktop-managed" : "standalone",
        transport: item.transport, endpoint: item.endpoint, ownership: "external", pid: item.pid, executable: item.executable,
        processStartedAt: item.startedAt, source: "process", state: item.appServer ? "running" : "unknown",
        owner: item.uid === process.getuid?.() ? "verified" : "denied", permissions: "unknown", endpointVerified: false,
        process: item.appServer && item.commandReadable ? "verified" : "unknown", compatibility: "unknown", health: "unknown",
        reason: item.transport === "stdio" ? t("外部 stdio runtime 未暴露可共享端点") : t("未取得可验证的共享 socket") });
    }
    if (expired()) { result.status = "error"; return result; }
    if (!filesystemComplete) result.socket = "unknown";
    if (result.socket === "absent") result.managed = "not-running";
    result.status = result.processScan === "unavailable" || result.socket === "unknown" ? "error" : result.candidates.length ? "found" : "not-found";
    return result;
  }
}
