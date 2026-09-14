import { createServer, createConnection } from "node:net";
import { createInterface } from "node:readline";
import { chmod } from "node:fs/promises";

// 进程生命周期替身：JSONL socket 仅用于测试，不代表 Codex 的 WebSocket 协议或真实验收。
const [mode, endpoint, codexHome, externalPid] = process.argv.slice(2);
const thread = { id: "thread-a", parentThreadId: null, source: "cli", createdAt: 1789257600, status: { type: "idle" },
  cwd: codexHome, cliVersion: "0.154.0", model: "gpt-6-astra", reasoningEffort: "medium", turns: [] };
function serve(input, output) {
  createInterface({ input }).on("line", line => {
    const request = JSON.parse(line);
    if (request.id === undefined) return;
    const values = { initialize: { userAgent: "生命周期替身", codexHome, platformFamily: "unix", platformOs: process.platform },
      "server/diagnostics": { process: { id: process.pid } }, "thread/loaded/list": { data: ["thread-a"], nextCursor: null },
      "thread/read": { thread }, "thread/resume": { thread }, "thread/turns/list": { data: [], nextCursor: null },
      "account/read": { account: null, requiresOpenaiAuth: true },
      "account/rateLimits/read": { rateLimits: { limitId: null, primary: null, secondary: null } } };
    output.write(JSON.stringify(Object.hasOwn(values, request.method) ? { id: request.id, result: values[request.method] }
      : { id: request.id, error: { code: -32601, message: "测试未提供此方法" } }) + "\n");
  });
}

if (mode === "external") {
  const connections = new Set();
  const server = createServer(socket => { connections.add(socket); socket.once("close", () => connections.delete(socket)); serve(socket, socket); });
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(endpoint, resolve); });
  await chmod(endpoint, 0o600);
  process.stdout.write(JSON.stringify({ ready: true, pid: process.pid }) + "\n");
  process.once("SIGTERM", () => { for (const socket of connections) socket.destroy(); server.close(() => process.exit(0)); });
} else if (mode === "proxy") {
  const connection = createConnection(endpoint);
  connection.once("connect", () => { process.stdin.pipe(connection); connection.pipe(process.stdout); });
  connection.once("error", () => { process.exitCode = 1; process.stdin.destroy(); });
  connection.once("close", () => process.stdin.destroy());
} else if (mode === "owned") {
  serve(process.stdin, process.stdout);
} else {
  const { RuntimeConnectionManager } = await import("../../src/providers/codex/runtime/RuntimeConnectionManager.ts");
  const { AppServerSource } = await import("../../src/providers/codex/app-server/AppServerSource.ts");
  const { AppServerProtocol } = await import("../../src/providers/codex/app-server/AppServerProtocol.ts");
  const { runtimeIdentity } = await import("../../src/providers/codex/runtime/RuntimeCandidate.ts");
  const { inspectRuntimeSocket } = await import("../../src/providers/codex/runtime/RuntimeDiscoveryProvider.ts");
  const external = mode === "hud-external";
  const evidence = external ? await inspectRuntimeSocket(endpoint) : undefined;
  const candidate = { id: runtimeIdentity(["生命周期替身", endpoint, externalPid]), kind: "standalone", transport: "unix-socket", ownership: "external",
    endpoint, pid: Number(externalPid), executable: process.execPath, processStartedAt: "生命周期替身", codexVersion: "0.154.0",
    state: "running", source: "process", owner: "verified", permissions: "verified", process: "verified", endpointVerified: true,
    socketIdentity: evidence?.identity, compatibility: "unknown", health: "unknown" };
  let client;
  const manager = new RuntimeConnectionManager({ runtime: { codexHome, sessionsPath: codexHome, checks: [], diagnostics: [],
    codexBinary: process.execPath, version: "codex-cli 0.154.0" }, verifyProcess: async () => true,
    discovery: { discover: async () => ({ candidates: external ? [candidate] : [], status: external ? "found" : "not-found",
      discoveredAt: Date.now(), managed: "not-running", socket: external ? "present" : "absent", processScan: "complete", issues: [],
      commands: { stdio: true, proxy: true, daemon: false, daemonStart: false, daemonVersion: false } }) },
    createClient: item => client = new AppServerProtocol({ executable: process.execPath,
      args: [process.argv[1], item.ownership === "external" ? "proxy" : "owned", endpoint, codexHome] }) });
  const source = new AppServerSource({ connectionManager: manager, maxReconnectAttempts: 1 });
  await source.selectThread("thread-a"); await source.start();
  if (!source.getStatus().live) throw new Error("合成来源未附着");
  let stopping = false;
  const stop = async () => { if (stopping) return; stopping = true; await source.stop(); process.exit(0); };
  process.once("SIGINT", stop); process.once("SIGTERM", stop);
  createInterface({ input: process.stdin }).on("line", line => {
    if (line === "crash") throw new Error("合成异常退出");
    if (line === "stop") void stop();
  });
  process.stdout.write(JSON.stringify({ ready: true, childPid: client.getProcessId(), ownership: manager.getState().ownership,
    runtimeId: manager.getState().runtimeId }) + "\n");
}
