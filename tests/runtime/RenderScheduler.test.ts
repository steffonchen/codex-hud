import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RenderScheduler } from "../../src/runtime/RenderScheduler.js";

beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => { vi.useRealTimers(); });

describe("RenderScheduler", () => {
  it("错误回调返回 stop Promise 时不会环形等待", async () => {
    let stopping: Promise<void> | undefined;
    const scheduler = new RenderScheduler(() => { throw new Error("输出故障"); }, 150,
      () => { stopping = scheduler.stop(); return stopping; });
    scheduler.start();
    scheduler.invalidate();
    await scheduler.flush();
    await stopping;
    expect(vi.getTimerCount()).toBe(0);
  });

  it("合并连续更新并按间隔限流", async () => {
    const render = vi.fn();
    const scheduler = new RenderScheduler(render, 150, vi.fn());
    scheduler.start();
    for (let index = 0; index < 10; index++) scheduler.invalidate();
    await vi.advanceTimersByTimeAsync(0);
    expect(render).toHaveBeenCalledTimes(1);
    for (let index = 0; index < 10; index++) scheduler.invalidate();
    await vi.advanceTimersByTimeAsync(149);
    expect(render).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(render).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(render).toHaveBeenCalledTimes(2);
    await scheduler.stop();
  });

  it("flush 立即提交待渲染状态，没有更新则不重绘", async () => {
    const render = vi.fn();
    const scheduler = new RenderScheduler(render, 150, vi.fn());
    scheduler.start();
    scheduler.invalidate();
    await scheduler.flush();
    scheduler.invalidate();
    await scheduler.flush();
    await scheduler.flush();
    expect(render).toHaveBeenCalledTimes(2);
    await scheduler.stop();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("慢输出期间只保留一次待更新，不并发渲染", async () => {
    let finish!: () => void;
    const render = vi.fn().mockImplementationOnce(() => new Promise<void>(resolve => { finish = resolve; }));
    const scheduler = new RenderScheduler(render, 150, vi.fn());
    scheduler.start();
    scheduler.invalidate();
    await vi.advanceTimersByTimeAsync(0);
    for (let index = 0; index < 100; index++) scheduler.invalidate();
    await vi.advanceTimersByTimeAsync(500);
    expect(render).toHaveBeenCalledTimes(1);
    finish();
    await vi.advanceTimersByTimeAsync(0);
    expect(render).toHaveBeenCalledTimes(2);
    await scheduler.stop();
  });

  it("stop 清除待更新并等待在途输出，随后可以重新启动", async () => {
    let finish!: () => void;
    const render = vi.fn().mockImplementationOnce(() => new Promise<void>(resolve => { finish = resolve; }));
    const scheduler = new RenderScheduler(render, 150, vi.fn());
    scheduler.start();
    scheduler.invalidate();
    await vi.advanceTimersByTimeAsync(0);
    scheduler.invalidate();
    let stopped = false;
    const stopping = scheduler.stop().then(() => { stopped = true; });
    await Promise.resolve();
    expect(stopped).toBe(false);
    finish();
    await stopping;
    scheduler.invalidate();
    await vi.advanceTimersByTimeAsync(1000);
    expect(render).toHaveBeenCalledTimes(1);
    scheduler.start();
    scheduler.invalidate();
    await scheduler.flush();
    expect(render).toHaveBeenCalledTimes(2);
    await scheduler.stop();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("渲染异常报告给调用方，后续更新仍可处理", async () => {
    const error = new Error("渲染失败");
    const render = vi.fn().mockRejectedValueOnce(error).mockResolvedValue(undefined);
    const report = vi.fn();
    const scheduler = new RenderScheduler(render, 150, report);
    scheduler.start();
    scheduler.invalidate();
    await scheduler.flush();
    expect(report).toHaveBeenCalledWith(error);
    scheduler.invalidate();
    await scheduler.flush();
    expect(render).toHaveBeenCalledTimes(2);
    await scheduler.stop();
  });
});
