import { EventEmitter } from "node:events";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Writable } from "node:stream";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { createDefaultConfig } from "../dist/config/Config.js";
import { HudDiagnosticsTracker } from "../dist/core/HudDiagnostics.js";
import { HudStateReducer } from "../dist/core/HudStateReducer.js";
import { StateStore } from "../dist/core/StateStore.js";
import { SourceDeduplicator } from "../dist/core/source/SourceDeduplicator.js";
import { SourceAuthorityPolicy } from "../dist/core/source/SourceAuthorityPolicy.js";
import { CodexDiscoveryProvider } from "../dist/providers/codex/CodexDiscoveryProvider.js";
import { CodexSessionProvider } from "../dist/providers/codex/CodexSessionProvider.js";
import { RolloutEventParser } from "../dist/providers/codex/RolloutEventParser.js";
import { AppServerSource } from "../dist/providers/codex/app-server/AppServerSource.js";
import { AppServerProtocol } from "../dist/providers/codex/app-server/AppServerProtocol.js";
import { HudRenderer } from "../dist/renderer/HudRenderer.js";
import { HudRuntime } from "../dist/runtime/HudRuntime.js";
import { SignalHandler } from "../dist/runtime/SignalHandler.js";
import { TerminalController } from "../dist/terminal/TerminalController.js";
import { debugHudDiagnostics } from "../dist/cli/Diagnostics.js";

const requests = Number(process.argv[2] ?? 10_000);
if (!Number.isSafeInteger(requests) || requests < 100 || requests > 100_000) throw new Error("请求数必须是 100–100000 的整数");
const home = await mkdtemp(path.join(os.tmpdir(), "codex-hud-phase10-bench-"));
const report = { evidence: "合成回放与本地测试协议进程；不是实际 Codex Runtime 验收", node: process.version, os: process.platform, arch: process.arch, requests };
const config = createDefaultConfig(); config.display.enabled = ["model", "context", "token-details", "cache", "cost", "tools", "current-activity", "session"];
const line = (type, payload, n = 0) => JSON.stringify({ timestamp: new Date(1789257600000 + n).toISOString(), type, payload });
const total = n => ({ input_tokens: n * 100, cached_input_tokens: n * 20, output_tokens: n * 10, reasoning_output_tokens: n * 2, total_tokens: n * 110 });
const token = n => line("event_msg", { type: "token_count", info: { total_token_usage: total(n), last_token_usage: total(1), model_context_window: 258400 } }, n);
let bytes = 0, frames = 0;
const output = new Writable({ write(chunk, _encoding, done) { bytes += chunk.length; frames++; done(); } }); output.isTTY = true; output.columns = 120; output.rows = 24;
const clients = [];
const source = new AppServerSource({ reconnectDelayMs: 10, createClient: () => {
  const client = new AppServerProtocol({ executable: process.execPath, args: [fileURLToPath(new URL("../tests/fixtures/app-server/protocol-child.mjs", import.meta.url))] });
  clients.push(client); return client;
} });
const discovery = new CodexDiscoveryProvider({ codexHome: home, userHome: home, cwd: home, env: { PATH: "" }, threadId: "thread-a" });
const provider = new CodexSessionProvider({ discovery, appServerSource: source });
const runtime = new HudRuntime(config, { provider, terminal: new TerminalController(output), signals: new SignalHandler(new EventEmitter()) });
try {
  await mkdir(path.join(home, "sessions"));
  await writeFile(path.join(home, "sessions", "rollout-bench.jsonl"), [line("session_meta", { id: "thread-a", cwd: home, source: "cli", cli_version: "0.154.0" }),
    line("turn_context", { model: "gpt-6-astra" }), token(1)].join("\n") + "\n");
  const started = performance.now(); await runtime.start();
  report.startupWallMs = performance.now() - started;
  const stable = await provider.refresh(); report.stableRolloutBytes = stable.read.bytesRead;
  const reconnectStarted = performance.now(); await clients[0].stop();
  while (!source.getStatus().live || source.getStatus().reconnectCount < 1) {
    if (performance.now() - reconnectStarted > 5000) throw new Error("合成重连超时");
    await delay(2);
  }
  report.reconnectWallMs = performance.now() - reconnectStarted;
  await runtime.stop(); await delay(20);
  report.pipeline = debugHudDiagnostics(provider.getHudDiagnostics()); report.terminal = { bytes, frames };
  report.protocolClients = clients.length; report.protocolPendingAfterStop = clients.map(client => client.getDiagnostics().pending);

  // 压力回放使用同一个 parser/dedup/reducer/store/renderer；不保存完整事件或每帧历史。
  const parser = new RolloutEventParser(), dedup = new SourceDeduplicator(new SourceAuthorityPolicy(false));
  const reducer = new HudStateReducer(), store = new StateStore(), renderer = new HudRenderer(), metrics = new HudDiagnosticsTracker();
  let sequence = 0, parseMs = 0, storeMs = 0;
  const apply = raw => {
    const parsedAt = performance.now(), parsed = parser.parse(raw, ++sequence); parseMs += performance.now() - parsedAt;
    metrics.raw("received");
    for (const [index, event] of parsed.events.entries()) {
      const normalized = { ...event, source: "rollout", threadId: "thread-a", sourceOrdinal: sequence, eventId: `${sequence}-${index}`, generation: 1, phase: "history" };
      const normalizedAt = performance.now(), accepted = dedup.consume(normalized);
      metrics.measure("eventToReducer", performance.now() - normalizedAt);
      for (const event of accepted) { metrics.received("rollout", "history", event.at); const at = performance.now(); reducer.apply(event); metrics.processed(at); }
    }
  };
  apply(line("session_meta", { id: "thread-a", source: "cli" })); apply(line("turn_context", { model: "gpt-6-astra" }));
  global.gc?.(); const before = process.memoryUsage(), cpu = process.cpuUsage(), startedReplay = performance.now(), heap = [];
  for (let n = 1; n <= requests; n++) {
    apply(line("event_msg", { type: "task_started", turn_id: `turn-${n}` }, n));
    apply(token(n)); apply(token(n));
    apply(line("event_msg", { type: "task_complete", turn_id: `turn-${n}` }, n));
    if (n % 100 === 0) {
      const stateAt = performance.now(); store.replace(reducer.getState(1789257600000 + n)); storeMs += performance.now() - stateAt;
      const renderAt = performance.now(); renderer.render(store.get(), { width: 120, height: 24 }, config); metrics.rendered(renderAt);
      if (renderer.getIssues().length) throw new Error("压力回放渲染失败");
    }
    if (n % 1000 === 0) { global.gc?.(); heap.push({ requests: n, heapUsed: process.memoryUsage().heapUsed }); }
  }
  const durationMs = performance.now() - startedReplay, cpuUsage = process.cpuUsage(cpu), state = reducer.getState(1789257600000 + requests);
  metrics.observe(state, true, dedup.getStatistics(), { ...reducer.getResourceCounts(), ...dedup.getResourceCounts(), ...store.getResourceCounts() });
  global.gc?.();
  report.replay = { durationMs, parseMs, storeMs, cpuMs: (cpuUsage.user + cpuUsage.system) / 1000, gcAvailable: !!global.gc,
    heapBefore: before.heapUsed, heapAfter: process.memoryUsage().heapUsed, rssAfter: process.memoryUsage().rss, heapSamples: heap,
    requestsCounted: state.usage?.requestCount, finalTokens: state.tokenUsage?.totalTokens, turnsCounted: state.session?.turnCount,
    diagnostics: debugHudDiagnostics(metrics.snapshot()) };
  if (state.usage?.requestCount !== requests || state.tokenUsage?.totalTokens !== requests * 110 || state.session?.turnCount !== requests
    || state.usage.retainedRecords > 512 || reducer.getResourceCounts().retainedTurns > 2048 || dedup.getResourceCounts().dedupEntries > 2048) throw new Error("压力回放计数或资源边界校验失败");
  process.stdout.write(JSON.stringify(report, null, 2) + "\n");
} finally {
  await runtime.stop(); await provider.stop();
  await rm(home, { recursive: true, force: true });
}
