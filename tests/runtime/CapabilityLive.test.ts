import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import { appendFile, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { Writable } from "node:stream";
import { CodexDiscoveryProvider } from "../../src/providers/codex/CodexDiscoveryProvider.js";
import { CodexSessionProvider } from "../../src/providers/codex/CodexSessionProvider.js";
import { HudRuntime } from "../../src/runtime/HudRuntime.js";
import { SignalHandler } from "../../src/runtime/SignalHandler.js";
import { HudRenderer } from "../../src/renderer/HudRenderer.js";
import { createDefaultConfig, loadConfig, saveConfig } from "../../src/config/Config.js";
import { createProgram } from "../../src/cli/Program.js";
import { CapabilityDiscovery } from "../../src/providers/codex/CapabilityDiscovery.js";
import { capabilityFixture, mcpResult } from "../capabilities.js";
import { agentFixture, agentsOf } from "../agents.js";
import { FakeTerminal } from "./fixtures.js";

const { watchMock } = vi.hoisted(() => ({ watchMock: vi.fn() }));
vi.mock("node:fs", async original => ({ ...await original<typeof import("node:fs")>(), watch: watchMock }));
let directory: string, home: string, project: string, rootFile: string;
let discovery: CodexDiscoveryProvider, provider: CodexSessionProvider;
let active = 0, maximum = 0;
const providers: CodexSessionProvider[] = [];
const runtimes: HudRuntime[] = [];
const config = () => { const value = createDefaultConfig(); value.display.enabled = ["mcp", "skills", "agents", "current-activity", "tools"]; return value; };
const newProvider = () => { const value = new CodexSessionProvider({ discovery }); providers.push(value); return value; };

async function root(id = "root", name = "root"): Promise<string> {
  const meta = JSON.parse((await agentFixture("parallel-agents"))[0]);
  meta.payload.id = id; meta.payload.session_id = id; meta.payload.cwd = project;
  const file = path.join(home, "sessions", `rollout-${name}.jsonl`); await writeFile(file, JSON.stringify(meta) + "\n"); return file;
}
async function tool(kind: string, thread = "root", turn = "mcp-turn"): Promise<string> {
  const raw = await mcpResult(kind); raw.payload.thread_id = thread; raw.payload.turn_id = turn;
  // 相同调用 ID 与线程重映射用于隔离测试；时间调整到测试轮次之后，保持实际字段结构。
  const at = Date.now(); raw.timestamp = new Date(at).toISOString(); raw.payload.completed_at_ms = at; raw.payload.started_at_ms = at - 1000;
  return JSON.stringify(raw) + "\n";
}
async function child(id: string, kind: string): Promise<string> {
  const rows = (await agentFixture("single-agent")).slice(0, 3).map(line => {
    const raw = JSON.parse(line);
    if (raw.type === "session_meta") {
      raw.payload.id = id; raw.payload.cwd = project; raw.payload.agent_path = `/root/${id}`;
      raw.payload.source.subagent.thread_spawn.agent_path = `/root/${id}`;
    }
    return raw;
  });
  const file = path.join(home, "sessions", `rollout-${id}.jsonl`);
  await writeFile(file, rows.map(row => JSON.stringify(row)).join("\n") + "\n" + await tool(kind, id, rows[1].payload.turn_id)); return file;
}
async function putSkill(name = "review"): Promise<string> {
  const file = path.join(directory, ".agents", "skills", name, "SKILL.md");
  await mkdir(path.dirname(file), { recursive: true }); await writeFile(file, await capabilityFixture("skills", "single-skill.md")); return file;
}
function capture() {
  let text = ""; const stream = new Writable({ write(chunk, _encoding, done) { text += String(chunk); done(); } });
  return { stream, text: () => text };
}

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "setTimeout", "clearTimeout"] });
  directory = await mkdtemp(path.join(os.tmpdir(), "codex-hud-capability-live-"));
  home = path.join(directory, ".codex"); project = path.join(directory, "project");
  await mkdir(path.join(home, "sessions"), { recursive: true }); await mkdir(project); await writeFile(path.join(project, ".git"), "测试边界");
  await writeFile(path.join(home, "config.toml"), await capabilityFixture("mcp", "multiple-servers.toml"));
  active = 0; maximum = 0;
  watchMock.mockReset(); watchMock.mockImplementation(() => {
    active++; maximum = Math.max(maximum, active); return Object.assign(new EventEmitter(), { close: vi.fn(() => { active--; }) });
  });
  discovery = new CodexDiscoveryProvider({ codexHome: home, userHome: directory, cwd: project, env: { PATH: "" } });
  provider = newProvider(); rootFile = await root();
});
afterEach(async () => {
  for (const runtime of runtimes.splice(0)) await runtime.stop();
  for (const value of providers.splice(0)) await value.stop();
  vi.restoreAllMocks(); vi.useRealTimers(); await rm(directory, { recursive: true, force: true });
});

describe("Phase 5 完整数据链路", () => {
  it("真实 MCP 结果进入能力、工具和 Current Activity，调用不是 ready", async () => {
    await appendFile(rootFile, await tool("tool-completed")); const snapshot = await provider.refresh();
    expect(snapshot.state.mcpSummary).toMatchObject({ configuredCount: 2, runtimeCount: 1, readyCount: 0 });
    expect(snapshot.state.activity?.mcp).toMatchObject({ serverName: "codex_app", toolName: "open_in_codex" });
    expect(snapshot.state.tools?.recent?.[0].status).toBe("completed"); expect(snapshot.detections.mcp).toBe(true);
    const value = config(); value.display.enabled = ["tools", "current-activity"];
    const output = new HudRenderer().render(snapshot.state, { width: 140, height: 24 }, value);
    expect(output.match(/codex_app\.open_in_codex/gu)).toHaveLength(1);
  });
  it("全局配置在会话 A→B→A 保持一致，运行观察隔离", async () => {
    await appendFile(rootFile, await tool("tool-completed"));
    const b = await root("b", "b"); await appendFile(b, await tool("tool-failed", "b"));
    let selected = rootFile;
    vi.spyOn(discovery, "discover").mockImplementation(async () => ({ codexHome: home, userHome: directory, sessionsPath: path.join(home, "sessions"),
      workingDirectory: project, sessionCwd: project, currentRolloutPath: selected, currentSessionId: selected === b ? "b" : "root", checks: [], diagnostics: [] }));
    const a = await provider.refresh(); selected = b; const switched = await provider.refresh(); selected = rootFile; const restored = await provider.refresh();
    expect(a.state.mcpSummary?.servers.filter(server => server.runtimeObserved).map(server => server.name)).toEqual(["codex_app"]);
    expect(switched.state.mcpSummary?.servers.filter(server => server.runtimeObserved).map(server => server.name)).toEqual(["cua_repl"]);
    expect(restored.state.mcpSummary).toEqual(a.state.mcpSummary);
    expect([a, switched, restored].every(snapshot => snapshot.state.mcpSummary?.configuredCount === 2)).toBe(true);
  });
  it("并行 Agent 同调用 ID 的 MCP 结果不会串线，失败不影响 Agent 或服务", async () => {
    await child("explorer", "tool-completed"); await child("tester", "tool-failed");
    const snapshot = await provider.refresh(); const agents = agentsOf(snapshot.state);
    expect(agents.find(agent => agent.id === "explorer")?.activity?.mcp?.serverName).toBe("codex_app");
    expect(agents.find(agent => agent.id === "tester")?.activity).toMatchObject({ toolStatus: "failed", mcp: { serverName: "cua_repl" } });
    expect(agents.find(agent => agent.id === "tester")?.status).toBe("running");
    expect(snapshot.state.mcpSummary).toMatchObject({ runtimeCount: 2, failedCount: 0 });
    expect(snapshot.state.tools?.recent).toEqual([]);
    const value = config(); value.display.enabled = ["agents"];
    expect(new HudRenderer().render(snapshot.state, { width: 140, height: 30 }, value)).toContain("MCP cua_repl.js");
  });
  it("移除子线程只清除该线程的 MCP 观察", async () => {
    const a = await child("explorer", "tool-completed"); await child("tester", "tool-failed"); await provider.refresh(); await rm(a);
    const snapshot = await provider.refresh();
    expect(snapshot.state.mcpSummary?.servers.filter(server => server.runtimeObserved).map(server => server.name)).toEqual(["cua_repl"]);
  });
  it("新 HUD Provider 重启恢复相同能力身份和状态", async () => {
    await appendFile(rootFile, await tool("tool-completed")); await putSkill();
    const before = await provider.refresh(), after = await newProvider().refresh();
    expect(after.state.mcpSummary).toEqual(before.state.mcpSummary); expect(after.state.skillSummary).toEqual(before.state.skillSummary);
  });
  it("没有 rollout 新字节时配置和技能变化仍刷新", async () => {
    const firstSkill = await putSkill(); await provider.refresh(); await writeFile(path.join(home, "config.toml"), '[mcp_servers.replacement]');
    await rm(path.dirname(firstSkill), { recursive: true }); await putSkill("replacement"); const snapshot = await provider.refresh();
    expect(snapshot.read.bytesRead).toBe(0); expect(snapshot.state.mcpSummary?.servers.map(server => server.name)).toEqual(["replacement"]);
    expect(snapshot.state.skillSummary?.skills.map(skill => skill.path)).toEqual([await realpath(path.join(directory, ".agents", "skills", "replacement", "SKILL.md"))]);
  });
  it("技能运行目录切换替换 advertised，不把工具当成 Skill", async () => {
    const file = await putSkill(); const raw = JSON.parse(await capabilityFixture("skills", "runtime-catalog.jsonl"));
    raw.payload.content[0].text = `<skills_instructions>\n### Available skills\n- review: 描述。 (file: ${file})\n</skills_instructions>`;
    await appendFile(rootFile, JSON.stringify(raw) + "\n" + await tool("tool-failed"));
    const snapshot = await provider.refresh(); expect(snapshot.state.skillSummary).toMatchObject({ count: 1, availableCount: 1, failedCount: 0, activeCount: 0 });
    raw.payload.content[0].text = '<skills_instructions>\n### Available skills\n</skills_instructions>';
    await appendFile(rootFile, JSON.stringify(raw) + "\n");
    expect((await provider.refresh()).state.skillSummary?.availableCount).toBe(0);
  });
  it.each(["sync", "async"])("%s EMFILE 保持既有轮询，新增能力没有 watcher 或 timer", async mode => {
    if (mode === "sync") watchMock.mockImplementation(() => { throw Object.assign(new Error("监听失败"), { code: "EMFILE" }); });
    const snapshots = vi.fn(), diagnostic = vi.fn(); await provider.start({ onSnapshot: snapshots, onDiagnostic: diagnostic });
    if (mode === "async") watchMock.mock.results[0].value.emit("error", { code: "EMFILE" });
    expect(vi.getTimerCount()).toBe(2);
    await appendFile(rootFile, await tool("tool-failed")); await writeFile(path.join(home, "config.toml"), '[mcp_servers.updated]');
    await putSkill(); await vi.advanceTimersByTimeAsync(3000);
    await vi.waitFor(() => expect(provider.store.get().mcpSummary?.servers.some(server => server.name === "updated")).toBe(true));
    expect(provider.store.get().mcpSummary).toMatchObject({ runtimeCount: 1, failedCount: 0 });
    expect(provider.store.get().skillSummary?.count).toBe(1); expect(diagnostic).toHaveBeenCalledWith(expect.objectContaining({ code: "watch-unavailable" }));
    await provider.stop(); expect(vi.getTimerCount()).toBe(0); expect(active).toBe(0); expect(maximum).toBeLessThanOrEqual(1);
  });
  it("MCP/Skills 的 SIGINT 清理与重启释放全部资源", async () => {
    await putSkill(); const signals = new EventEmitter(), terminal = new FakeTerminal(); const value = config(); value.display.enabled = ["mcp", "skills"];
    const runtime = new HudRuntime(value, { provider, terminal, signals: new SignalHandler(signals) }); runtimes.push(runtime);
    for (let index = 0; index < 2; index++) {
      await runtime.start(); expect(terminal.frames.join("\n")).toContain("MCP 2"); signals.emit("SIGINT"); await runtime.waitForStop();
      expect(vi.getTimerCount()).toBe(0); expect(active).toBe(0); expect(signals.listenerCount("SIGINT")).toBe(0);
    }
    expect(maximum).toBe(1);
  });
  it("重复渲染只消费 State，来源无变化时不重新读取", async () => {
    await putSkill(); const snapshot = await provider.refresh(); const unchanged = await provider.refresh(); expect(unchanged.discoveryIO?.filesRead).toBe(0);
    const refresh = vi.spyOn(CapabilityDiscovery.prototype, "refresh");
    for (let index = 0; index < 100; index++) new HudRenderer().render(snapshot.state, { width: 80, height: 24 }, config());
    expect(refresh).not.toHaveBeenCalled();
  });
  it("无主会话也能 setup 选择 MCP/Skills，保存只写 HUD 配置", async () => {
    await rm(rootFile); await putSkill(); const before = await readFile(path.join(home, "config.toml"), "utf8");
    const hudConfig = path.join(directory, "hud.toml"), output = capture();
    const program = createProgram({ provider, configFile: hudConfig, output: output.stream, errorOutput: capture().stream, prompt: {
      choose: async () => "customize", modules: async choices => {
        for (const id of ["mcp", "skills"]) expect(choices.find(choice => choice.id === id)).toMatchObject({ disabled: false, checked: false });
        return ["mcp", "skills"];
      },
    } });
    await program.parseAsync(["setup"], { from: "user" });
    expect((await loadConfig(hudConfig))?.display.enabled).toEqual(["mcp", "skills"]); expect(await readFile(path.join(home, "config.toml"), "utf8")).toBe(before);
  });
  it("实际 CLI debug 与 verbose 分别输出摘要和脱敏清单", async () => {
    await putSkill(); const hudConfig = path.join(directory, "hud.toml"); await saveConfig(config(), hudConfig);
    for (const verbose of [false, true]) {
      const output = capture(), errors = capture(); const program = createProgram({ provider, configFile: hudConfig, output: output.stream, errorOutput: errors.stream });
      await program.parseAsync(["debug", "--width", "140", ...(verbose ? ["--verbose"] : [])], { from: "user" });
      expect(output.text()).toContain("MCP 2"); expect(errors.text()).toContain("\"MCP discovery\"");
      expect(errors.text().includes('"skillSummary"')).toBe(verbose); expect(errors.text()).not.toContain(skillPathPrefix());
    }
  });
  it("doctor 区分配置与运行；debug 遇到坏配置明确失败", async () => {
    vi.useRealTimers();
    await writeFile(path.join(home, "config.toml"), '[mcp_servers. private-secret');
    const output = capture(), errors = capture(); const program = createProgram({ provider, configFile: path.join(directory, "hud.toml"), output: output.stream, errorOutput: errors.stream });
    await program.parseAsync(["doctor"], { from: "user" }); expect(output.text()).toContain("MCP configuration：Configuration read or parse failed"); expect(output.text()).toContain("connection state not observed");
    await expect(program.parseAsync(["debug"], { from: "user" })).rejects.toThrow("Real data contains read or parse errors");
    expect(output.text() + errors.text()).not.toContain("private-secret");
  });
});

function skillPathPrefix(): string { return path.join(directory, ".agents", "skills"); }
