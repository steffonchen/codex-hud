import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import { RolloutReader } from "../../src/providers/codex/RolloutReader.js";

const { watchMock } = vi.hoisted(() => ({ watchMock: vi.fn() }));
vi.mock("node:fs", async importOriginal => ({ ...await importOriginal<typeof import("node:fs")>(), watch: watchMock }));

let watcher: EventEmitter & { close: ReturnType<typeof vi.fn> };
let change: (event: string, file: string | null) => void;
const stops: Array<() => void> = [];
beforeEach(() => {
  vi.useFakeTimers();
  watcher = Object.assign(new EventEmitter(), { close: vi.fn() });
  watchMock.mockImplementation((_directory, listener) => { change = listener; return watcher; });
});
afterEach(() => {
  for (const stop of stops.splice(0)) stop();
  vi.useRealTimers();
});

describe("RolloutReader 监听生命周期", () => {
  it("拒绝会使 Node 定时器溢出为每毫秒轮询的间隔", () => {
    expect(() => new RolloutReader().watch("/sessions/rollout.jsonl", vi.fn(), vi.fn(), 2_147_483_648)).toThrow("2147483647");
  });

  it("监听父目录，追加与替换都会通知，其他文件被过滤", async () => {
    const updated = vi.fn();
    const diagnostic = vi.fn();
    const stop = new RolloutReader().watch("/sessions/rollout.jsonl", updated, diagnostic);
    stops.push(stop);
    expect(watchMock).toHaveBeenCalledWith("/sessions", expect.any(Function));
    change("change", "other.jsonl");
    expect(updated).not.toHaveBeenCalled();
    change("change", "rollout.jsonl");
    await Promise.resolve();
    change("rename", "rollout.jsonl");
    await Promise.resolve();
    change("change", null);
    await Promise.resolve();
    expect(updated).toHaveBeenCalledTimes(3);
    stop();
    change("change", "rollout.jsonl");
    await vi.advanceTimersByTimeAsync(3000);
    expect(updated).toHaveBeenCalledTimes(3);
    expect(watcher.close).toHaveBeenCalledTimes(1);
    expect(diagnostic).not.toHaveBeenCalled();
  });

  it("异步 watcher 错误关闭 watcher，并继续低频补查", async () => {
    const updated = vi.fn();
    const diagnostic = vi.fn();
    stops.push(new RolloutReader().watch("/sessions/rollout.jsonl", updated, diagnostic));
    watcher.emit("error", { code: "EMFILE" });
    expect(watcher.close).toHaveBeenCalledTimes(1);
    expect(diagnostic).toHaveBeenCalledWith(expect.objectContaining({ code: "watch-unavailable" }));
    await vi.advanceTimersByTimeAsync(3000);
    expect(updated).toHaveBeenCalledTimes(1);
  });

  it("通知风暴在消费者忙碌时合并，避免无限排队", async () => {
    let finish!: () => void;
    const busy = new Promise<void>(resolve => { finish = resolve; });
    const updated = vi.fn().mockReturnValueOnce(busy);
    stops.push(new RolloutReader().watch("/sessions/rollout.jsonl", updated, vi.fn()));
    for (let i = 0; i < 100; i++) change("change", "rollout.jsonl");
    expect(updated).toHaveBeenCalledTimes(1);
    finish();
    await vi.advanceTimersByTimeAsync(0);
    expect(updated).toHaveBeenCalledTimes(2);
  });

  it("消费者错误可见，不产生未处理的 Promise rejection", async () => {
    const diagnostic = vi.fn();
    stops.push(new RolloutReader().watch("/sessions/rollout.jsonl", async () => { throw { code: "EIO" }; }, diagnostic));
    change("change", "rollout.jsonl");
    await vi.advanceTimersByTimeAsync(0);
    expect(diagnostic).toHaveBeenCalledWith(expect.objectContaining({ code: "watch-consumer", severity: "error" }));
  });
});
