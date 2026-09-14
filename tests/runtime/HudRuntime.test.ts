import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import stringWidth from "string-width";
import { createDefaultConfig } from "../../src/config/Config.js";
import { HudRuntime } from "../../src/runtime/HudRuntime.js";
import { SignalHandler } from "../../src/runtime/SignalHandler.js";
import { testSessionSnapshot } from "../fixtures.js";
import { FakeCodexProvider, FakeTerminal } from "./fixtures.js";

const runtimes: HudRuntime[] = [];
beforeEach(() => { vi.useFakeTimers(); });
afterEach(async () => {
  await Promise.allSettled(runtimes.splice(0).map(runtime => runtime.stop()));
  vi.useRealTimers();
});

async function fixture(enabled = ["model", "reasoning", "context", "session", "token-details"]) {
  const config = createDefaultConfig();
  config.display.enabled = enabled;
  const terminal = new FakeTerminal();
  const provider = new FakeCodexProvider(await testSessionSnapshot());
  const signals = new EventEmitter();
  const runtime = new HudRuntime(config, { provider, terminal, signals: new SignalHandler(signals) });
  runtimes.push(runtime);
  return { runtime, terminal, provider, signals, config };
}

describe("HudRuntime", () => {
  it.each([false, true])("旧启动的迟到结果不会进入新生命周期（拒绝=%s）", async reject => {
    const { runtime, terminal, provider } = await fixture();
    let finish!: () => void;
    let fail!: (error: Error) => void;
    terminal.start.mockImplementationOnce(() => new Promise<void>((resolve, reject) => { finish = resolve; fail = reject; }));
    const first = runtime.start();
    const rejected = reject ? expect(first).rejects.toThrow("旧启动失败") : undefined;
    await runtime.stop();
    await runtime.start();
    expect(runtime.getStatus()).toBe("running");
    if (reject) { fail(new Error("旧启动失败")); await rejected; }
    else { finish(); await first; }
    expect(runtime.getStatus()).toBe("running");
    expect(provider.start).toHaveBeenCalledOnce();
    await runtime.stop();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("start/stop 幂等，可重新启动，停止后不再接受状态或计时更新", async () => {
    const { runtime, terminal, provider, signals } = await fixture();
    expect(runtime.getStatus()).toBe("created");
    await runtime.start();
    await runtime.start();
    expect(runtime.getStatus()).toBe("running");
    expect(provider.start).toHaveBeenCalledOnce();
    expect(terminal.frames.at(-1)).toContain("7%");
    expect(terminal.frames.at(-1)).toContain("Total 6.5M");
    await Promise.all([runtime.stop(), runtime.stop()]);
    await runtime.waitForStop();
    expect(runtime.getStatus()).toBe("stopped");
    expect(provider.stop).toHaveBeenCalledOnce();
    expect(terminal.dispose).toHaveBeenCalledOnce();
    expect(terminal.events).toBeUndefined();
    for (const event of ["SIGINT", "SIGTERM", "exit"]) expect(signals.listenerCount(event)).toBe(0);
    const frames = terminal.frames.length;
    provider.store.patch({ model: "停止后的模型" });
    await vi.advanceTimersByTimeAsync(10_000);
    expect(terminal.frames).toHaveLength(frames);
    expect(vi.getTimerCount()).toBe(0);
    await runtime.start();
    expect(provider.start).toHaveBeenCalledTimes(2);
    expect(terminal.frames.at(-1)).toContain("gpt-6-astra");
    await runtime.stop();
  });

  it("只显示配置选择，连续 resize 后每行宽度和总高度都合规", async () => {
    const { runtime, terminal } = await fixture(["model", "context"]);
    await runtime.start();
    for (const [width, height] of [[140, 20], [100, 15], [80, 10], [60, 8], [50, 5], [40, 4], [120, 15]]) {
      terminal.size = { width, height };
      terminal.events!.resize();
      await vi.advanceTimersByTimeAsync(0);
      const frame = terminal.frames.at(-1)!;
      expect(frame.split("\n").length).toBeLessThanOrEqual(height);
      expect(frame.split("\n").every(line => stringWidth(line) <= width)).toBe(true);
      expect(frame).not.toMatch(/Session |Token |undefined|NaN|5h|7d/u);
    }
  });

  it.each(["rollout", "none"] as const)("来源降级在 idle 和窄屏仍可见（%s），恢复后按配置隐藏", async active => {
    const { runtime, terminal, provider, config } = await fixture(["model"]);
    config.behavior.hide_when_idle = true;
    provider.snapshot.state.activity = { status: "idle" };
    provider.snapshot.state.agentSummary = undefined;
    provider.snapshot.state.dataSources = { preferred: "app-server", active, degraded: true, rolloutAvailable: active === "rollout",
      deduplicated: 0, issues: ["连接不可用 api_key=private-secret"] };
    await runtime.start();
    for (const [width, height] of [[80, 8], [30, 3], [12, 1]]) {
      terminal.size = { width, height }; terminal.events!.resize(); await vi.advanceTimersByTimeAsync(0);
      const frame = terminal.frames.at(-1)!;
      expect(frame).toMatch(/degraded/iu); expect(frame).not.toContain("private-secret");
      expect(frame.split("\n").length).toBeLessThanOrEqual(height); expect(frame.split("\n").every(line => stringWidth(line) <= width)).toBe(true);
      if (width === 12) expect(frame).toContain(active === "rollout" ? "RL" : "—");
    }
    provider.snapshot.state.dataSources.degraded = false; provider.publish(provider.snapshot); await vi.advanceTimersByTimeAsync(150);
    expect(terminal.frames.at(-1)).toBe("");
  });

  it("会话时长更新独立于 Provider 读取", async () => {
    const { runtime, terminal, provider } = await fixture(["session"]);
    provider.snapshot.state.session!.startedAt = Date.now();
    await runtime.start();
    expect(terminal.frames.at(-1)).toContain("Session 0s");
    await vi.advanceTimersByTimeAsync(1100);
    expect(terminal.frames.at(-1)).toContain("Session 1s");
    expect(provider.refresh).not.toHaveBeenCalled();
    expect(provider.start).toHaveBeenCalledOnce();
  });

  it("启动仍在读取时连续信号只清理一次，并隔离迟到回调", async () => {
    const { runtime, terminal, provider, signals } = await fixture();
    let finish!: () => void;
    const pending = new Promise<void>(resolve => { finish = resolve; });
    provider.start.mockImplementationOnce(async handlers => {
      await pending;
      provider.store.replace(provider.snapshot.state);
      handlers.onSnapshot(provider.snapshot);
    });
    provider.stop.mockImplementationOnce(() => pending);
    const starting = runtime.start();
    await vi.waitFor(() => expect(provider.start).toHaveBeenCalledOnce());
    signals.emit("SIGINT");
    signals.emit("SIGINT");
    signals.emit("SIGTERM");
    await vi.advanceTimersByTimeAsync(0);
    expect(provider.stop).toHaveBeenCalledOnce();
    expect(signals.listenerCount("SIGINT")).toBe(1);
    const frames = terminal.frames.length;
    finish();
    await starting;
    await runtime.waitForStop();
    expect(terminal.frames).toHaveLength(frames);
    expect(signals.listenerCount("SIGINT")).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("首帧渲染失败仍恢复终端并向调用方报告失败", async () => {
    const { runtime, terminal, signals } = await fixture();
    terminal.render.mockRejectedValueOnce(new Error("首帧输出失败"));
    await runtime.start();
    await expect(runtime.waitForStop()).rejects.toThrow("首帧输出失败");
    expect(terminal.dispose).toHaveBeenCalledOnce();
    expect(signals.listenerCount("exit")).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("Provider 清理同步抛错仍继续恢复终端、移除信号", async () => {
    const { runtime, terminal, provider, signals } = await fixture();
    await runtime.start();
    provider.stop.mockImplementationOnce(() => { throw new Error("关闭监听失败"); });
    await expect(runtime.stop()).rejects.toThrow("HUD resource cleanup failed");
    await expect(runtime.waitForStop()).rejects.toThrow("HUD resource cleanup failed");
    expect(terminal.dispose).toHaveBeenCalledOnce();
    expect(signals.listenerCount("SIGINT")).toBe(0);
  });

  it("输出关闭结束运行；异常进程退出触发同步终端恢复", async () => {
    const { runtime, terminal, signals } = await fixture();
    await runtime.start();
    signals.emit("exit");
    expect(terminal.restoreSync).toHaveBeenCalledOnce();
    terminal.events!.close();
    await runtime.waitForStop();
    expect(runtime.getStatus()).toBe("stopped");
  });

  it("恢复错误显示在 HUD 内且脱敏，新的成功快照清除临时错误", async () => {
    const { runtime, terminal, provider } = await fixture();
    provider.snapshot.state.model = "模型 Bearer private-credential";
    await runtime.start();
    provider.handlers!.onDiagnostic({ code: "live-refresh", severity: "error", message: "读取失败 api_key=private-secret" });
    await vi.advanceTimersByTimeAsync(150);
    expect(runtime.getStatus()).toBe("recovering");
    expect(terminal.frames.at(-1)).toContain("Error：");
    expect(terminal.frames.join("\n")).not.toMatch(/private-credential|private-secret/u);
    expect(JSON.stringify(runtime.getDiagnostics())).not.toContain("private-secret");
    provider.publish(provider.snapshot);
    await vi.advanceTimersByTimeAsync(150);
    expect(runtime.getStatus()).toBe("running");
    expect(runtime.getDiagnostics()).toEqual([]);
  });

  it("切换会话后不保留旧文件的监听故障", async () => {
    const { runtime, provider } = await fixture();
    await runtime.start();
    provider.handlers!.onDiagnostic({ code: "watch-unavailable", severity: "warning", path: provider.snapshot.runtime.currentRolloutPath,
      message: "旧会话文件监听不可用" });
    expect(runtime.getDiagnostics()).toHaveLength(1);
    const next = structuredClone(provider.snapshot);
    next.runtime.currentRolloutPath = "/fixture/rollout-b.jsonl";
    next.runtime.currentSessionId = "session-b";
    provider.publish(next);
    expect(runtime.getDiagnostics()).toEqual([]);
  });
});
