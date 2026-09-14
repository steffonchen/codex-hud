import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import { mkdir, open, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { Writable } from "node:stream";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { createDefaultConfig } from "../dist/config/Config.js";
import { debugHudDiagnostics } from "../dist/cli/Diagnostics.js";
import { CodexDiscoveryProvider } from "../dist/providers/codex/CodexDiscoveryProvider.js";
import { CodexSessionProvider } from "../dist/providers/codex/CodexSessionProvider.js";
import { HudRuntime } from "../dist/runtime/HudRuntime.js";
import { SignalHandler } from "../dist/runtime/SignalHandler.js";
import { TerminalController } from "../dist/terminal/TerminalController.js";
import { flattenAgentTree } from "../dist/core/AgentTree.js";
import { redactSummary } from "../dist/core/Redaction.js";

// 只读真实来源；禁止生成会话、模型请求、启动 daemon 或 spawn 独立 Codex 来凑验收。
const minutes = Number(process.argv[2] ?? 30), destination = process.argv[3];
if (!Number.isFinite(minutes) || minutes < 0.1 || minutes > 1440 || !destination) throw new Error("用法：node --expose-gc scripts/phase10-soak.mjs <分钟数 0.1–1440> <报告路径>");
const outputFile = path.resolve(destination), project = fileURLToPath(new URL("../", import.meta.url));
const build = createHash("sha256");
for (const name of (await readdir(path.join(project, "dist"), { recursive: true })).filter(name => name.endsWith(".js")).sort()) {
  build.update(name).update(await readFile(path.join(project, "dist", name)));
}
const config = createDefaultConfig();
config.display.enabled = ["model", "reasoning", "context", "token-details", "cache", "cost", "tools", "current-activity", "agents", "plan", "session", "mcp", "skills", "runtime-status"];
config.runtime.allow_spawn = false; config.runtime.auto_start_managed = false;
const discovery = new CodexDiscoveryProvider();
const initial = await discovery.discover();
if (!initial.activeThreadId || initial.currentSessionId !== initial.activeThreadId) throw new Error("未取得当前真实任务的明确线程与 rollout 关联，停止观测");
let bytesWritten = 0, writes = 0;
const output = new Writable({ write(chunk, _encoding, done) { bytesWritten += chunk.length; writes++; done(); } });
output.isTTY = true; output.columns = 120; output.rows = 30;
const signals = new EventEmitter();
const provider = new CodexSessionProvider({ discovery, providers: config.providers, runtime: config.runtime });
const runtime = new HudRuntime(config, { provider, terminal: new TerminalController(output), signals: new SignalHandler(signals) });
const report = { evidence: "真实 Codex 当前任务的只读观测；完整渲染至内存终端，不代表物理 TTY 或未发生的 runtime 重启已验证",
  node: process.version, os: process.platform, arch: process.arch, codex: initial.version, rollout: initial.rolloutVersion,
  buildSha256: build.digest("hex"), gcAvailable: !!global.gc, requestedMinutes: minutes, samples: [], interruptions: [] };
const violations = new Set();
let interrupted = false;
const interrupt = () => { interrupted = true; };
process.once("SIGINT", interrupt); process.once("SIGTERM", interrupt);
await mkdir(path.dirname(outputFile), { recursive: true });
const persist = () => writeFile(outputFile, JSON.stringify(report, null, 2) + "\n", "utf8");
const resources = () => Object.fromEntries([...new Set(process.getActiveResourcesInfo())].map(name => [name, process.getActiveResourcesInfo().filter(value => value === name).length]));

async function parity(snapshot) {
  if (!snapshot.runtime.currentRolloutPath || !snapshot.read.offset) return { checked: false };
  const file = await open(snapshot.runtime.currentRolloutPath, "r");
  try {
    const start = Math.max(0, snapshot.read.offset - 1024 * 1024), data = Buffer.alloc(snapshot.read.offset - start);
    const { bytesRead } = await file.read(data, 0, data.length, start);
    const lines = data.subarray(0, bytesRead).toString("utf8").split("\n"); if (start) lines.shift();
    for (const line of lines.reverse()) {
      let event;
      try { event = JSON.parse(line); } catch { continue; }
      if (event.type !== "event_msg" || event.payload?.type !== "token_count" || !event.payload.info?.total_token_usage) continue;
      const raw = event.payload.info.total_token_usage, normalized = snapshot.state.tokenUsage;
      const fields = { input_tokens: "inputTokens", cached_input_tokens: "cachedInputTokens", output_tokens: "outputTokens", reasoning_output_tokens: "reasoningOutputTokens", total_tokens: "totalTokens" };
      return { checked: true, equal: !!normalized && Object.entries(fields).every(([a, b]) => raw[a] === normalized[b]),
        rawTotal: raw.total_tokens, stateTotal: normalized?.totalTokens };
    }
    return { checked: false };
  } finally { await file.close(); }
}

let observedAt, cpu;
try {
  await runtime.start(); global.gc?.(); observedAt = performance.now(); cpu = process.cpuUsage();
  report.startedAt = new Date().toISOString();
  let nextSample = 0;
  while (!interrupted) {
    const elapsedMs = performance.now() - observedAt;
    if (elapsedMs >= nextSample || elapsedMs >= minutes * 60_000) {
      const snapshot = await provider.refresh(), state = snapshot.state, diagnostics = provider.getHudDiagnostics();
      const total = state.tokenUsage, agents = state.agentSummary && flattenAgentTree([...state.agentSummary.tree, ...state.agentSummary.orphans]);
      const tokenInvariant = !total || total.cachedInputTokens <= total.inputTokens && total.reasoningOutputTokens <= total.outputTokens
        && total.totalTokens === total.inputTokens + total.outputTokens;
      const rootMatches = state.session?.id === initial.activeThreadId;
      const comparison = await parity(snapshot);
      if (!rootMatches) violations.add("主会话身份不一致");
      if (!tokenInvariant) violations.add("Token 子集或总量不变量失败");
      if (comparison.checked && !comparison.equal && diagnostics.source.kind === "rollout") violations.add("Rollout 累计 Token 与已读取 offset 的 HudState 不一致");
      if (diagnostics.memory.activeWatchers > 1) violations.add("根 watcher 超过一个");
      if (diagnostics.memory.retainedTurns > 2048 || diagnostics.memory.historySize > 512 || diagnostics.memory.dedupEntries > 2048) violations.add("历史缓存超过边界");
      if (state.usage?.cost.sessionEstimatedCost.value !== undefined && state.cost?.estimated !== true) violations.add("费用未标记估算");
      const usage = process.cpuUsage(cpu);
      report.samples.push({ elapsedMs, cpuMs: (usage.user + usage.system) / 1000, rootMatches, tokenInvariant, parity: comparison,
        rawBytesThisRefresh: snapshot.read.bytesRead, rawOffset: snapshot.read.offset, model: redactSummary(state.model ?? "未知", 80),
        context: state.context, usageRequests: state.usage?.requestCount, totalTokens: total?.totalTokens,
        costEstimated: state.cost?.estimated, activity: state.activity?.status, toolActive: state.tools?.active?.length, toolRecent: state.tools?.recent?.length,
        agentCount: agents?.length, childCount: agents?.filter(({ agent }) => agent.isSubagent).length,
        planSteps: state.planSummary?.execution?.totalCount, mcpCount: state.mcpSummary?.runtimeCount, skillCount: state.skillSummary?.count,
        runtime: { authority: snapshot.state.dataSources?.appServer?.runtime?.authority, discovery: snapshot.state.dataSources?.appServer?.runtime?.discovery,
          candidates: snapshot.state.dataSources?.appServer?.runtime?.candidateCount, ownership: snapshot.state.dataSources?.appServer?.runtime?.ownership },
        diagnostics: debugHudDiagnostics(diagnostics), activeResources: resources(), bytesWritten, writes,
        errors: [...new Set(snapshot.diagnostics.filter(item => item.severity === "error").map(item => item.code))] });
      report.violations = [...violations]; await persist();
      process.stdout.write(JSON.stringify({ sample: report.samples.length, elapsedSeconds: Math.round(elapsedMs / 1000), source: diagnostics.source.kind,
        events: diagnostics.events.processed, heapMiB: Math.round(diagnostics.memory.heapUsed / 1024 / 1024), violations: violations.size }) + "\n");
      nextSample += 60_000;
    }
    if (elapsedMs >= minutes * 60_000) break;
    await delay(Math.min(1000, Math.max(1, minutes * 60_000 - elapsedMs)));
  }
  report.durationMs = performance.now() - observedAt;
  report.completedRequestedDuration = !interrupted && report.durationMs >= minutes * 60_000;
  if (interrupted) report.interruptions.push("收到停止信号，提前结束");
} catch (error) {
  report.failure = redactSummary(error instanceof Error ? error.message : "观测失败"); process.exitCode = 1;
} finally {
  try { await runtime.stop(); await runtime.waitForStop(); }
  catch (error) { report.cleanupFailure = redactSummary(error instanceof Error ? error.message : "清理失败"); process.exitCode = 1; }
  process.off("SIGINT", interrupt); process.off("SIGTERM", interrupt);
  global.gc?.(); await delay(20);
  report.finishedAt = new Date().toISOString(); report.afterStop = debugHudDiagnostics(provider.getHudDiagnostics());
  report.resourcesAfterStop = resources(); report.violations = [...violations];
  report.outputListenersAfterStop = output.eventNames().map(name => String(name));
  if (violations.size || !report.completedRequestedDuration) process.exitCode = 1;
  await persist();
  process.stdout.write(JSON.stringify({ complete: report.completedRequestedDuration === true, violations: violations.size, report: outputFile }) + "\n");
}
