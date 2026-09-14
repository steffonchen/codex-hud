import { chmod, mkdir, mkdtemp, rm } from "node:fs/promises";
import { createServer, type Server } from "node:net";
import os from "node:os";
import path from "node:path";
import type { CodexRuntime } from "../../src/providers/codex/CodexDiscoveryProvider.js";
import type { RuntimeCandidate, RuntimeDiscoveryResult } from "../../src/providers/codex/runtime/RuntimeCandidate.js";
import type { RpcServerRequest } from "../../src/providers/codex/app-server/AppServerProtocol.js";
import { inspectRuntimeSocket } from "../../src/providers/codex/runtime/RuntimeDiscoveryProvider.js";
import { FakeAppServer } from "../app-server/helpers.js";

const directories: string[] = [], sockets: Server[] = [];
export async function makeHome(): Promise<string> {
  const directory = await mkdtemp(path.join(process.platform === "darwin" ? "/private/tmp" : os.tmpdir(), "hud-p9-")); directories.push(directory); return directory;
}
export async function cleanupRuntimeFixtures(): Promise<void> {
  const closed = await Promise.allSettled(sockets.splice(0).filter(server => server.listening).map(server =>
    new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))));
  await Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true, force: true })));
  const errors = closed.flatMap(result => result.status === "rejected" ? [result.reason] : []);
  if (errors.length) throw new AggregateError(errors, "测试 socket 清理失败");
}
export const codexRuntime = (home: string): CodexRuntime => ({ codexHome: home, userHome: home, sessionsPath: path.join(home, "sessions"),
  codexBinary: "/fixture/codex", version: "codex-cli 0.154.0", workingDirectory: home,
  currentSessionId: "thread-a", activeThreadId: "thread-a", attachmentSource: "explicit", checks: [], diagnostics: [] });
export const candidate = (overrides: Partial<RuntimeCandidate> = {}): RuntimeCandidate => ({ id: "runtime-a", kind: "standalone", transport: "unix-socket",
  ownership: "external", endpoint: "/fixture/control.sock", pid: 101, executable: "/fixture/codex", processStartedAt: "Sun Sep 13 08:00:00 2026",
  codexVersion: "0.154.0", versionSource: "process-binary", source: "process", state: "running", owner: "verified", permissions: "verified",
  process: "verified", endpointVerified: true, socketIdentity: "fixture-identity", homeMatch: true, compatibility: "compatible", health: "healthy",
  thread: "loaded", ...overrides });
export const discovery = (candidates: RuntimeCandidate[] = [], overrides: Partial<RuntimeDiscoveryResult> = {}): RuntimeDiscoveryResult => ({
  candidates, status: candidates.length ? "found" : "not-found", discoveredAt: 0, processScan: "complete", issues: [],
  socket: candidates.some(item => item.endpoint) ? "present" : "absent", managed: "not-running",
  commands: { stdio: true, proxy: true, daemon: true, daemonStart: true, daemonVersion: true }, ...overrides });
export async function unixSocket(home: string, relative = "app-server/shared.sock") {
  const endpoint = path.join(home, relative);
  await mkdir(path.dirname(endpoint), { recursive: true, mode: 0o700 });
  const server = createServer(); sockets.push(server);
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(endpoint, resolve); });
  await chmod(endpoint, 0o600);
  const evidence = await inspectRuntimeSocket(endpoint);
  return { server, endpoint, candidate: candidate({ endpoint, socketIdentity: evidence.identity }) };
}

export class RuntimeClient extends FakeAppServer {
  respond?: (method: string, params: Record<string, unknown>) => unknown | Promise<unknown>;
  requests = new Set<(request: RpcServerRequest) => void>();
  constructor(home: string, pid = 101) {
    super();
    this.override = async (method, params) => {
      const response = await this.respond?.(method, params);
      if (response !== undefined) return response;
      if (method === "initialize") return { userAgent: "自定义客户端描述", codexHome: home, platformFamily: "unix", platformOs: "macos" };
      if (method === "server/diagnostics") return { process: { id: pid } };
      if (method === "account/read") return { account: { type: "chatgpt", email: "不得输出@example.test", planType: "pro" }, requiresOpenaiAuth: true };
    };
  }
  onRequest(listener: (request: RpcServerRequest) => void) { this.requests.add(listener); return () => { this.requests.delete(listener); }; }
  emitRequest(request: RpcServerRequest) { for (const listener of this.requests) listener(request); }
}
export function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
