import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Writable } from "node:stream";
import stringWidth from "string-width";
import { createProgram } from "../src/cli/Program.js";
import { runHud, type HudOutput, type HudProvider } from "../src/cli/RunHud.js";
import type { SetupPrompter } from "../src/cli/Setup.js";
import { createDefaultConfig, loadConfig, saveConfig } from "../src/config/Config.js";
import { testDetector, testSessionSnapshot } from "./fixtures.js";
import { StateStore } from "../src/core/StateStore.js";
import type { CodexSessionHandlers } from "../src/providers/codex/CodexSessionProvider.js";

let directory: string;
let configFile: string;
beforeEach(async () => {
  directory = await mkdtemp(path.join(os.tmpdir(), "codex-hud-cli-test-"));
  configFile = path.join(directory, "config.toml");
});
afterEach(async () => { await rm(directory, { recursive: true, force: true }); });

function capture() {
  let text = "";
  const stream: HudOutput = new Writable({ write(chunk, _encoding, callback) { text += String(chunk); callback(); } });
  stream.isTTY = false;
  return { stream, text: () => text };
}

function command(prompt?: SetupPrompter, detector = testDetector(), provider: HudProvider = { refresh: testSessionSnapshot }) {
  const stdout = capture();
  const stderr = capture();
  const program = createProgram({ configFile, output: stdout.stream, errorOutput: stderr.stream, prompt, detector, provider });
  return { stdout, stderr, program, run: (args: string[]) => program.parseAsync(args, { from: "user" }) };
}

async function liveProvider() {
  const snapshot = await testSessionSnapshot();
  const store = new StateStore();
  return {
    store, refresh: async () => snapshot,
    start: async (handlers: CodexSessionHandlers) => { store.replace(snapshot.state); handlers.onSnapshot(snapshot); },
    stop: vi.fn(async () => {}),
  };
}

describe("CLI", () => {
  it("提供全部要求的命令和中文帮助", async () => {
    const config = createDefaultConfig();
    config.display.language = "zh-CN";
    await saveConfig(config, configFile);
    const cli = command();
    expect(cli.program.commands.map(command => command.name())).toEqual(expect.arrayContaining(["start", "setup", "language", "doctor", "debug", "config", "version"]));
    await expect(cli.run(["--help"])).rejects.toMatchObject({ exitCode: 0 });
    expect(cli.stdout.text()).toContain("用法：");
    expect(cli.stdout.text()).toContain("选择显示模块");
    expect(cli.stdout.text()).not.toContain("--mode");
  });

  it.each(["", "start", "setup", "debug", "demo"])("命令 %s 不接受旧 mode 选项", async name => {
    const cli = command();
    await expect(cli.run([...(name ? [name] : []), "--mode", "compact"])).rejects.toMatchObject({ exitCode: 1 });
    expect(cli.stderr.text()).toContain("unknown option");
  });

  it.each(["--width", "--height"])("%s 缺少参数时给出中文错误", async option => {
    const config = createDefaultConfig();
    config.display.language = "zh-CN";
    await saveConfig(config, configFile);
    const cli = command();
    await expect(cli.run(["debug", option])).rejects.toMatchObject({ exitCode: 1 });
    expect(cli.stderr.text()).toContain("缺少参数");
    expect(cli.stderr.text()).not.toContain("option");
  });

  it("拒绝无效终端尺寸", async () => {
    const cli = command();
    await expect(cli.run(["debug", "--width", "0"])).rejects.toMatchObject({ exitCode: 1 });
    expect(cli.stderr.text()).toContain("positive integer");
  });

  it("参数错误中的原始参数也经过脱敏", async () => {
    const cli = command();
    await expect(cli.run(["debug", "--width", "sk-secret123"])).rejects.toMatchObject({ exitCode: 1 });
    expect(cli.stderr.text()).not.toContain("sk-secret123");
    expect(cli.stderr.text()).toContain("redacted");
  });

  it.each([140, 80, 50, 30])("debug 以 %i 列渲染真实快照，诊断与 HUD 分别输出", async width => {
    const cli = command();
    await cli.run(["debug", "--width", String(width), "--height", "24"]);
    expect(cli.stdout.text()).toContain("7%");
    expect(cli.stderr.text()).toContain("Real Codex rollout snapshot");
    expect(cli.stderr.text()).toContain("6475285");
    expect(cli.stdout.text().trimEnd().split("\n").every(line => stringWidth(line) <= width)).toBe(true);
    expect(await loadConfig(configFile)).toBeNull();
  });

  it("无配置且非交互终端时不挂起或擅自写配置", async () => {
    const cli = command();
    await expect(cli.run([])).rejects.toThrow("Setup requires an interactive terminal");
    expect(await loadConfig(configFile)).toBeNull();
  });

  it("首次运行先检测能力，再交互保存并启动 HUD", async () => {
    const events: string[] = [];
    const detector = testDetector();
    const report = detector.detectRollout(await testSessionSnapshot());
    vi.spyOn(detector, "detectRollout").mockImplementation(() => { events.push("detect"); return report; });
    const prompt: SetupPrompter = {
      choose: async () => { events.push("choose"); return "recommended"; },
      modules: async () => { throw new Error("不应进入自定义"); },
    };
    const cli = command(prompt, detector);
    await cli.run([]);
    expect(events).toEqual(["detect", "choose"]);
    expect(await loadConfig(configFile)).toEqual({ ...createDefaultConfig(), display: { language: "en", enabled: ["model", "reasoning", "context", "five-hour-usage", "weekly-usage", "token-details", "cache"] } });
    expect(cli.stdout.text()).toContain("Configuration saved");
    expect(cli.stdout.text()).toContain("gpt-6-astra");
    expect(cli.stderr.text()).toContain("real snapshot");
    expect(cli.stderr.text()).not.toContain("Demo data");
  });

  it("以后直接使用已保存配置启动，不重复 setup 或能力检测", async () => {
    const config = createDefaultConfig();
    config.display.enabled = ["git"];
    await saveConfig(config, configFile);
    const detector = testDetector();
    const detect = vi.spyOn(detector, "detectRollout");
    const cli = command(undefined, detector);
    await cli.run([]);
    expect(cli.stdout.text()).toContain("No real data available for the enabled modules");
    expect(cli.stdout.text()).not.toContain("main *");
    expect(detect).not.toHaveBeenCalled();
  });

  it("config 展示选择和修改入口，version 返回实际项目版本", async () => {
    const config = createDefaultConfig();
    config.display.enabled = ["context"];
    await saveConfig(config, configFile);
    const cli = command();
    await cli.run(["config"]);
    expect(cli.stdout.text()).toContain("✓ Context");
    expect(cli.stdout.text()).toContain("○ Model");
    expect(cli.stdout.text()).toContain("codex-hud setup");
    const version = command();
    await version.run(["version"]);
    expect(version.stdout.text()).toMatch(/^\d+\.\d+\.\d+\n$/u);
  });

  it("start 无配置时使用默认模块，不接管 stdin 或写入配置", async () => {
    const cli = command();
    await cli.run(["start"]);
    expect(cli.stdout.text()).toContain("7%");
    expect(cli.stdout.text()).not.toContain("\x1b");
    expect(cli.stderr.text()).toContain("printing one real snapshot and exiting");
    expect(await loadConfig(configFile)).toBeNull();
  });

  it("start 无会话时给出等待提示，非 TTY 正常退出", async () => {
    const snapshot = await testSessionSnapshot();
    snapshot.state = {};
    snapshot.runtime.currentRolloutPath = undefined;
    snapshot.read.status = "missing";
    const cli = command(undefined, testDetector(), { refresh: async () => snapshot });
    await cli.run(["start"]);
    expect(cli.stdout.text()).toContain("Waiting for a Codex session");
    expect(cli.stdout.text()).not.toContain("\x1b");
  });

  it("非 TTY 在明确空闲时仍尊重隐藏配置", async () => {
    const config = createDefaultConfig();
    config.behavior.hide_when_idle = true;
    await saveConfig(config, configFile);
    const snapshot = await testSessionSnapshot();
    snapshot.state.activity = { status: "idle" };
    const cli = command(undefined, testDetector(), { refresh: async () => snapshot });
    await cli.run(["start"]);
    expect(cli.stdout.text()).toBe("");
  });

  it("doctor 逐项报告真实来源，缺少额度不异常中止", async () => {
    const cli = command();
    await cli.run(["doctor"]);
    expect(cli.stdout.text()).toContain("Codex rollout");
    expect(cli.stdout.text()).toContain("✓ token_count");
    expect(cli.stdout.text()).toContain("✗ 额度窗口");
    expect(cli.stdout.text()).toContain("⚠ Non-interactive terminal");
    expect(cli.stdout.text()).toContain("✓ stdout writable");
    expect(cli.stdout.text()).toContain("✓ Renderer");
    expect(cli.stdout.text()).not.toContain("Demo data");
    const snapshot = await testSessionSnapshot();
    snapshot.diagnostics = [{ code: "rollout-read", severity: "error", message: "rollout 读取失败（EACCES）" }];
    snapshot.read.status = "error";
    const failed = command(undefined, testDetector(), { refresh: async () => snapshot });
    await failed.run(["doctor"]);
    expect(failed.stdout.text()).toContain("rollout 读取失败（EACCES）");
    expect(failed.stdout.text()).toContain("No configuration file yet");
  });

  it("doctor 的损坏配置单独报告，不覆盖其他检查结果", async () => {
    await writeFile(configFile, "invalid = [");
    const cli = command();
    await cli.run(["doctor"]);
    expect(cli.stdout.text()).toContain("✓ token_count");
    expect(cli.stdout.text()).toContain("✗ Configuration");
  });

  it("doctor 无工具事件是提示，短时监听失败显示真实原因和增量补查配置", async () => {
    const snapshot = await testSessionSnapshot();
    snapshot.checks.push({ id: "tool-events", label: "工具事件", ok: false, warning: true, detail: "尚未观察到工具事件" });
    const probeWatcher = vi.fn(async () => ({ mode: "polling" as const, activeWatchers: 0, fallback: true, fallbackMs: 3000, reason: "EMFILE" }));
    const cli = command(undefined, testDetector(), { refresh: async () => snapshot, probeWatcher });
    await cli.run(["doctor"]);
    expect(cli.stdout.text()).toContain("⚠ 工具事件：尚未观察到工具事件");
    expect(cli.stdout.text()).toContain("Native file watcher unavailable: EMFILE");
    expect(cli.stdout.text()).toContain("Incremental polling: stat/offset check every 3000 ms");
    expect(probeWatcher).toHaveBeenCalledOnce();
  });

  it("debug 接入工具和活动白名单，输出摘要脱敏且不声称监听其他进程", async () => {
    const config = createDefaultConfig();
    config.display.enabled = ["tools", "current-activity"];
    await saveConfig(config, configFile);
    const snapshot = await testSessionSnapshot();
    snapshot.state.tools = { active: [{ id: "a", name: "shell", type: "shell", status: "running", inputSummary: "curl --token private-tool-token" }], recent: [] };
    snapshot.state.activity = { status: "running", toolId: "a", description: "MY_PASSWORD=private-activity" };
    Object.assign(snapshot.state.tools.active![0], { rawInput: "private-raw-input", rawOutput: "private-raw-output" });
    const cli = command(undefined, testDetector(), { refresh: async () => snapshot });
    await cli.run(["debug", "--width", "140"]);
    const output = cli.stdout.text() + cli.stderr.text();
    expect(cli.stdout.text()).toContain("Current activity");
    expect(cli.stdout.text().match(/curl/gu)).toHaveLength(1);
    expect(cli.stderr.text()).toContain('"mode": "inactive"');
    expect(cli.stderr.text()).toContain("does not query other start processes");
    expect(output).not.toMatch(/private-tool-token|private-activity|private-raw-input|private-raw-output/u);
  });

  it("demo 保留演示数据，且不读取真实 Provider", async () => {
    const provider = { refresh: vi.fn(testSessionSnapshot) };
    const cli = command(undefined, testDetector(), provider);
    await cli.run(["demo"]);
    expect(cli.stdout.text()).toContain("74%");
    expect(cli.stderr.text()).toContain("Demo data");
    expect(provider.refresh).not.toHaveBeenCalled();
  });

  it("debug 在 stdout 和 stderr 都脱敏，不输出未知原始字段", async () => {
    const snapshot = await testSessionSnapshot();
    snapshot.state.model = "模型 Bearer credential-abc";
    snapshot.state.reasoningEffort = "api_key=credential-def";
    Object.assign(snapshot.state, { rawPayload: { message: "私密正文" } });
    Object.assign(snapshot.runtime, { authorization: "认证私密内容" });
    snapshot.runtime.codexHome = "https://user:private-password@example.test";
    const cli = command(undefined, testDetector(), { refresh: async () => snapshot });
    await cli.run(["debug"]);
    const output = cli.stdout.text() + cli.stderr.text();
    for (const secret of ["credential-abc", "credential-def", "私密正文", "认证私密内容", "private-password"]) expect(output).not.toContain(secret);
    expect(output).toContain("redacted");
  });

  it("debug 没有会话时报告缺失，有读取错误时向调用方报告失败", async () => {
    const snapshot = await testSessionSnapshot();
    snapshot.state = {};
    snapshot.read.status = "missing";
    snapshot.runtime.currentRolloutPath = undefined;
    const cli = command(undefined, testDetector(), { refresh: async () => snapshot });
    await cli.run(["debug"]);
    expect(cli.stdout.text()).toBe("");
    expect(cli.stderr.text()).toContain("No readable");
    snapshot.read.status = "error";
    const failed = command(undefined, testDetector(), { refresh: async () => snapshot });
    await expect(failed.run(["debug"])).rejects.toThrow("Real data contains read or parse errors");
  });

  it("管道异步写入失败向调用方报告", async () => {
    const stdout: HudOutput = new Writable({ write(_chunk, _encoding, callback) { callback(Object.assign(new Error("管道已关闭"), { code: "EPIPE" })); } });
    const stderr = capture();
    await expect(runHud(createDefaultConfig(), stdout, stderr.stream, { refresh: testSessionSnapshot })).rejects.toThrow("Terminal output failed");
  });

  it("TTY 刷新响应 resize，退出后恢复终端并移除监听器", async () => {
    const stdout = capture();
    stdout.stream.isTTY = true;
    stdout.stream.columns = 140;
    stdout.stream.rows = 24;
    const before = process.listenerCount("SIGINT");
    const provider = await liveProvider();
    const running = runHud(createDefaultConfig(), stdout.stream, capture().stream, provider);
    expect(stdout.text()).toContain("\x1b[?1049h\x1b[?25l");
    await vi.waitFor(() => expect(stdout.text()).toContain("gpt-6-astra"));
    stdout.stream.columns = 30;
    stdout.stream.emit("resize");
    await vi.waitFor(() => expect(stdout.text()).toContain("\x1b[24;1H\x1b[2K"));
    process.emit("SIGINT");
    await running;
    expect(stdout.text()).toMatch(/\x1b\[\?25h\x1b\[\?1049l$/u);
    expect(stdout.stream.listenerCount("resize")).toBe(0);
    expect(process.listenerCount("SIGINT")).toBe(before);
    expect(provider.stop).toHaveBeenCalledOnce();
  });

  it("TTY 输出失败也会结束刷新和清理监听器", async () => {
    const stdout: HudOutput = new Writable({ write(_chunk, _encoding, callback) { callback(new Error("模拟终端故障")); } });
    stdout.isTTY = true;
    stdout.columns = 80;
    stdout.rows = 24;
    const before = process.listenerCount("SIGINT");
    await expect(runHud(createDefaultConfig(), stdout, capture().stream, await liveProvider())).rejects.toThrow("模拟终端故障");
    expect(stdout.listenerCount("resize")).toBe(0);
    expect(process.listenerCount("SIGINT")).toBe(before);
  });
});
